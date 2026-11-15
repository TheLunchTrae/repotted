import type { Dirent } from 'node:fs';
import { readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import {
  type Document,
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  parse,
  type Scalar,
  parseDocument,
  stringify,
  visit,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml';
import { z } from 'zod';

import { isDeepEqual } from '../shared/equal.js';
import { replaceFile } from '../shared/files.js';
import { describeOwnerType, draftOwnerConflicts, type OwnerConflict, ownerConflicts, type OwnerType } from './owner.js';
import {
  actionsSettings,
  type AutolinkEntry,
  autolinkEntry,
  customProperties,
  type DraftAutolink,
  type DraftEntry,
  environmentEntry,
  environmentKey,
  type EnvironmentEntry,
  labelEntry,
  type LabelEntry,
  labelKey,
  mergeSettings as mergeSettingsSchema,
  pagesSite,
  profile,
  type Profile,
  profileFile,
  type ProfileFile,
  repositorySettings,
  rulesetEntry,
  type RulesetEntry,
  securitySettings,
} from './schema.js';

export class ProfileError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProfileError';
  }
}

function describe(error: z.ZodError): string {
  return z.prettifyError(error);
}

type OwnProfile = Omit<ProfileFile, 'autolinks' | 'rulesets' | 'environments' | 'labels' | 'drafts'> & {
  autolinks?: AutolinkEntry[] | undefined;
  rulesets?: RulesetEntry[] | undefined;
  environments?: EnvironmentEntry[] | undefined;
  labels?: LabelEntry[] | undefined;
};

export interface Drafts extends Partial<Record<SettingsSection, Readonly<Record<string, unknown>> | undefined>> {
  autolinks?: DraftAutolink[] | undefined;
  rulesets?: DraftEntry[] | undefined;
  environments?: DraftEntry[] | undefined;
  labels?: DraftEntry[] | undefined;
  unset?: string[] | undefined;
}

function isDraft(entry: object): boolean {
  return 'draft' in entry && entry.draft === true;
}

function isDraftEntry(entry: object): entry is DraftEntry {
  return isDraft(entry);
}

function isDraftAutolink(entry: object): entry is DraftAutolink {
  return isDraft(entry);
}

function partition<Entry extends object, Draft extends object>(
  list: readonly (Entry | Draft)[] | undefined,
  draft: (item: Entry | Draft) => item is Draft,
): [Entry[] | undefined, Draft[] | undefined] {
  const entries: Entry[] = [];
  const drafts: Draft[] = [];
  for (const item of list ?? []) {
    if (draft(item)) {
      drafts.push(item);
    } else {
      entries.push(item);
    }
  }
  // An empty list stays as written, but a list of only drafts names nothing that applies.
  return [
    list === undefined || (entries.length === 0 && drafts.length > 0) ? undefined : entries,
    drafts.length > 0 ? drafts : undefined,
  ];
}

function duplicateKeys<Entry>(
  list: readonly Entry[] | undefined,
  label: (entry: Entry) => string,
  key: (entry: Entry) => string,
): string[] {
  const keys = new Set<string>();
  const problems: string[] = [];
  for (const entry of list ?? []) {
    if (keys.has(key(entry))) {
      problems.push(`${label(entry)} appears more than once`);
    }
    keys.add(key(entry));
  }
  return problems;
}

/**
 * Changes a chain's merged profile before it is checked, so only the result
 * has to be a valid profile. `unmatched` names each part of the change that
 * changed nothing.
 */
export type Adjust = (data: unknown) => { readonly data: unknown; readonly unmatched: readonly string[] };

export interface LayerRead {
  readonly layer: ProfileFile;
  readonly adjust?: Adjust | undefined;
  /**
   * The profiles the file builds on, in order, each resolved from the file's
   * folder; later ones override earlier ones. The layer's own `extends` when
   * left out.
   */
  readonly listedProfiles?: readonly string[] | undefined;
}

/** Checks the whole file and yields its layer, its adjust, and anything else the file says, from one parse. */
export type LayerSchema<Read extends LayerRead> = z.ZodType<Read>;

export interface Layer<Read extends LayerRead> {
  /** As `profile` or `staged apply`, in errors. */
  readonly noun: string;
  readonly schema: LayerSchema<Read>;
  readonly ownTopLevelKeys: ReadonlySet<string>;
  /** Throws when the edited file, resolved, is not one to save. */
  readonly check: (edited: ResolvedLayer<Read>) => void;
}

const profileLayer: Layer<LayerRead> = {
  noun: 'profile',
  schema: profileFile.transform((layer) => ({ layer })),
  ownTopLevelKeys: new Set(),
  check: () => undefined,
};

interface Sourced<Entry> {
  readonly entry: Entry;
  readonly file: string;
}

function mergeByKey<Entry>(
  base: Sourced<Entry>[] | undefined,
  override: Sourced<Entry>[] | undefined,
  key: (entry: Entry) => string,
): Sourced<Entry>[] | undefined {
  if (base === undefined || override === undefined) {
    return override ?? base;
  }
  const replacements = new Map(override.map((item) => [key(item.entry), item]));
  const merged = base.map((item) => replacements.get(key(item.entry)) ?? item);
  const baseKeys = new Set(base.map((item) => key(item.entry)));
  return [...merged, ...override.filter((item) => !baseKeys.has(key(item.entry)))];
}

type Settings = Record<string, unknown>;

type EntryList = 'autolinks' | 'rulesets' | 'environments' | 'labels';

export const settingsSections = ['repository', 'merge', 'actions', 'security', 'custom_properties', 'pages'] as const;

export type SettingsSection = (typeof settingsSections)[number];

function keysHoldingAnObjectOfSettings(schema: z.ZodObject): ReadonlySet<string> {
  return new Set(
    Object.entries(schema.shape)
      .filter(([, field]) => (field instanceof z.ZodOptional ? field.unwrap() : field) instanceof z.ZodObject)
      .map(([key]) => key),
  );
}

/**
 * Keys whose value is itself an object of settings, such as
 * `selected_actions`, merge key by key, one level down, so an override can
 * change one of them and keep the rest.
 */
const groupKeys: Readonly<Record<SettingsSection, ReadonlySet<string>>> = {
  repository: keysHoldingAnObjectOfSettings(repositorySettings),
  merge: new Set(),
  actions: keysHoldingAnObjectOfSettings(actionsSettings),
  security: keysHoldingAnObjectOfSettings(securitySettings),
  custom_properties: new Set(),
  pages: keysHoldingAnObjectOfSettings(pagesSite),
};

const sectionSchemas: Readonly<Record<SettingsSection, z.ZodObject | undefined>> = {
  repository: repositorySettings,
  merge: mergeSettingsSchema,
  actions: actionsSettings,
  security: securitySettings,
  // Custom properties are named by the organization, so any name goes.
  custom_properties: undefined,
  pages: pagesSite.extend({ absent: z.literal(true) }),
};

function unwrapObject(field: unknown): z.ZodObject | undefined {
  const inner = field instanceof z.ZodOptional ? field.unwrap() : field;
  return inner instanceof z.ZodObject ? inner : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSettingsSection(name: string | undefined): name is SettingsSection {
  return settingsSections.some((section) => section === name);
}

/**
 * One setting, such as `repository.has_wiki` or
 * `actions.selected_actions.verified_allowed`; a group of settings, such as
 * `actions.selected_actions`; or nothing.
 */
export function settingPath(path: readonly string[]): 'setting' | 'group' | undefined {
  const [section, key, inner, ...rest] = path;
  if (!isSettingsSection(section) || key === undefined || rest.length > 0) {
    return undefined;
  }
  const schema = sectionSchemas[section];
  if (schema === undefined) {
    return inner === undefined ? 'setting' : undefined;
  }
  const field: unknown = schema.shape[key];
  if (field === undefined) {
    return undefined;
  }
  const group = groupKeys[section].has(key) ? unwrapObject(field) : undefined;
  if (inner === undefined) {
    return group === undefined ? 'setting' : 'group';
  }
  return group?.shape[inner] === undefined ? undefined : 'setting';
}

type Unset =
  | { readonly kind: 'setting'; readonly path: readonly string[] }
  | { readonly kind: 'entry'; readonly list: EntryList; readonly name: string };

const entryKeys: Readonly<Record<EntryList, (name: string) => string>> = {
  autolinks: (name) => name,
  rulesets: (name) => name,
  environments: environmentKey,
  labels: labelKey,
};

function isEntryList(name: string): name is EntryList {
  return Object.hasOwn(entryKeys, name);
}

function parseUnset(key: string): Unset | undefined {
  const slash = key.indexOf('/');
  if (slash !== -1) {
    const list = key.slice(0, slash);
    const name = key.slice(slash + 1);
    return isEntryList(list) && name !== '' ? { kind: 'entry', list, name } : undefined;
  }
  const parts = key.split('.');
  return settingPath(parts) === 'setting' ? { kind: 'setting', path: parts } : undefined;
}

/** Two spellings of one environment's or label's name are one unset. */
function unsetKey(unset: Unset): string {
  return unset.kind === 'setting' ? unset.path.join('.') : `${unset.list}/${entryKeys[unset.list](unset.name)}`;
}

function getIn(value: unknown, keys: readonly string[]): unknown {
  return keys.reduce<unknown>((current, key) => (isRecord(current) ? current[key] : undefined), value);
}

function names(layer: Readonly<Record<string, unknown>>, unset: Unset): boolean {
  if (unset.kind === 'setting') {
    return getIn(layer, unset.path) !== undefined;
  }
  const key = entryKeys[unset.list];
  const entries: unknown = layer[unset.list];
  return (
    Array.isArray(entries) &&
    entries.some((entry) => {
      const name: unknown = isRecord(entry)
        ? unset.list === 'autolinks'
          ? entry['key_prefix']
          : entry['name']
        : undefined;
      return typeof name === 'string' && key(name) === key(unset.name);
    })
  );
}

function unsetProblems(keys: readonly string[] | undefined, drafts: Readonly<Record<string, unknown>>): string[] {
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const key of keys ?? []) {
    const unset = parseUnset(key);
    if (unset === undefined) {
      problems.push(
        `${key} in drafts.unset names no setting or list entry, as in repository.has_wiki or rulesets/Main`,
      );
      continue;
    }
    if (seen.has(unsetKey(unset))) {
      problems.push(`${key} is in drafts.unset more than once`);
    }
    seen.add(unsetKey(unset));
    if (names(drafts, unset)) {
      problems.push(`${key} is both in drafts.unset and changed by a draft; keep one`);
    }
  }
  return problems;
}

/** Finishing a draft whose `drafts.unset` names what the file itself does not set would change nothing there. */
function unsetWarnings(link: Link): string[] {
  return (link.drafts.unset ?? []).flatMap((key) => {
    const unset = parseUnset(key);
    return unset === undefined || names(link.parsed, unset)
      ? []
      : [
          `Draft unset ${key} in ${path.basename(link.file)}: the file does not set it, so finishing the draft changes nothing`,
        ];
  });
}

interface ParsedLayer<Read extends LayerRead> {
  readonly read: Read;
  readonly own: OwnProfile;
  readonly drafts: Drafts;
  readonly extends: readonly string[];
}

function parseLayer<Read extends LayerRead>(text: string, source: string, kind: Layer<Read>): ParsedLayer<Read> {
  let data: unknown;
  try {
    data = parse(text) ?? {};
  } catch (error) {
    throw new ProfileError(`${source} is not valid YAML`, { cause: error });
  }
  const result = kind.schema.safeParse(data);
  if (!result.success) {
    throw new ProfileError(`${source} is not a valid ${kind.noun}:\n${describe(result.error)}`);
  }
  const { autolinks, rulesets, environments, labels, drafts, ...settings } = result.data.layer;
  const [ownAutolinks, draftAutolinks] = partition<AutolinkEntry, DraftAutolink>(autolinks, isDraftAutolink);
  const [ownRulesets, draftRulesets] = partition<RulesetEntry, DraftEntry>(rulesets, isDraftEntry);
  const [ownEnvironments, draftEnvironments] = partition<EnvironmentEntry, DraftEntry>(environments, isDraftEntry);
  const [ownLabels, draftLabels] = partition<LabelEntry, DraftEntry>(labels, isDraftEntry);
  // Checked in each file, since a merge pairs entries by name and would keep only the last of two.
  const problems = [
    ...duplicateKeys(
      draftAutolinks,
      (entry) => `Draft autolink "${entry.key_prefix}"`,
      (entry) => entry.key_prefix,
    ),
    ...duplicateKeys(
      draftRulesets,
      (entry) => `Draft ruleset "${entry.name}"`,
      (entry) => entry.name,
    ),
    ...duplicateKeys(
      draftEnvironments,
      (entry) => `Draft environment "${entry.name}"`,
      (entry) => environmentKey(entry.name),
    ),
    ...duplicateKeys(
      draftLabels,
      (entry) => `Draft label "${entry.name}"`,
      (entry) => labelKey(entry.name),
    ),
    ...unsetProblems(drafts?.unset, {
      ...drafts,
      autolinks: draftAutolinks,
      rulesets: draftRulesets,
      environments: draftEnvironments,
      labels: draftLabels,
    }),
  ];
  if (problems.length > 0) {
    throw new ProfileError(`${source} is not a valid ${kind.noun}:\n${problems.map((line) => `✖ ${line}`).join('\n')}`);
  }
  return {
    read: result.data,
    own: {
      ...settings,
      autolinks: ownAutolinks,
      rulesets: ownRulesets,
      environments: ownEnvironments,
      labels: ownLabels,
    },
    drafts: {
      ...drafts,
      autolinks: draftAutolinks,
      rulesets: draftRulesets,
      environments: draftEnvironments,
      labels: draftLabels,
    },
    extends: result.data.listedProfiles ?? (settings.extends === undefined ? [] : [settings.extends]),
  };
}

/** `[key]`, or `[group, key]` inside a group such as `selected_actions`. */
type SettingPath = readonly [string] | readonly [string, string];

function isGroup(section: SettingsSection, key: string, value: unknown): value is Readonly<Record<string, unknown>> {
  return groupKeys[section].has(key) && isRecord(value);
}

export function flattenSettings(
  section: SettingsSection,
  settings: Readonly<Record<string, unknown>>,
): [SettingPath, unknown][] {
  return Object.entries(settings).flatMap(([key, value]): [SettingPath, unknown][] =>
    isGroup(section, key, value)
      ? Object.entries(value).map(([inner, setting]) => [[key, inner], setting])
      : [[[key], value]],
  );
}

function unflattenSettings(settings: Iterable<readonly [SettingPath, unknown]>): Settings {
  const result: Settings = {};
  for (const [[key, inner], value] of settings) {
    if (inner === undefined) {
      result[key] = value;
    } else {
      const current = result[key];
      result[key] = { ...(isRecord(current) ? current : {}), [inner]: value };
    }
  }
  return result;
}

interface SourcedSetting extends Sourced<unknown> {
  readonly path: SettingPath;
}

/** By path joined with dots, as `has_wiki` or `selected_actions.verified_allowed`. */
type SourcedSettings = Map<string, SourcedSetting>;

interface SourcedLayer<Autolink, Ruleset, Environment, Label> {
  settings: Partial<Record<SettingsSection, SourcedSettings>>;
  autolinks?: Sourced<Autolink>[] | undefined;
  rulesets?: Sourced<Ruleset>[] | undefined;
  environments?: Sourced<Environment>[] | undefined;
  labels?: Sourced<Label>[] | undefined;
}

type SourcedProfile = SourcedLayer<AutolinkEntry, RulesetEntry, EnvironmentEntry, LabelEntry>;

type SourcedDrafts = SourcedLayer<DraftAutolink, DraftEntry, DraftEntry, DraftEntry>;

function mergeSettings(
  section: SettingsSection,
  base: SourcedSettings | undefined,
  override: Settings | undefined,
  file: string,
): SourcedSettings | undefined {
  if (override === undefined) {
    return base;
  }
  // `absent: true` turns the Pages site off whatever the base sets, and a
  // site the override describes replaces a base's `absent`.
  if (section === 'pages' && override['absent'] === true) {
    return new Map([['absent', { entry: true, file, path: ['absent'] }]]);
  }
  const merged = new Map(base);
  merged.delete('absent');
  // A group replaces a base's value that was not one, as a draft's may be, even a group that sets nothing.
  for (const [key, value] of Object.entries(override)) {
    if (isGroup(section, key, value)) {
      merged.delete(key);
    }
  }
  for (const [path, entry] of flattenSettings(section, override)) {
    const [key] = path;
    // A value for a group key that is not a group replaces each of a base's settings in it.
    if (path.length === 1) {
      for (const [joined, item] of merged) {
        if (item.path.length > 1 && item.path[0] === key) {
          merged.delete(joined);
        }
      }
    }
    merged.set(path.join('.'), { entry, file, path });
  }
  return merged;
}

function sourced<Entry>(entries: Entry[] | undefined, file: string): Sourced<Entry>[] | undefined {
  return entries?.map((entry) => ({ entry, file }));
}

const autolinkKey = (entry: { key_prefix: string }): string => entry.key_prefix;
const rulesetKey = (entry: { name: string }): string => entry.name;
const environmentEntryKey = (entry: { name: string }): string => environmentKey(entry.name);
const labelEntryKey = (entry: { name: string }): string => labelKey(entry.name);

function mergeSections(
  base: Partial<Record<SettingsSection, SourcedSettings>>,
  override: Readonly<Partial<Record<SettingsSection, Settings | undefined>>>,
  file: string,
): Partial<Record<SettingsSection, SourcedSettings>> {
  const settings: Partial<Record<SettingsSection, SourcedSettings>> = {};
  for (const section of settingsSections) {
    const merged = mergeSettings(section, base[section], override[section], file);
    if (merged !== undefined) {
      settings[section] = merged;
    }
  }
  return settings;
}

/**
 * Settings merge key by key, and so do the settings inside a group such as
 * `selected_actions`; an autolink, ruleset, environment or label in the
 * override replaces the base entry of the same name whole. Drafts never merge
 * with what applies.
 */
function mergeLayers<
  Autolink extends { key_prefix: string },
  Ruleset extends { name: string },
  Environment extends { name: string },
  Label extends { name: string },
>(
  base: SourcedLayer<Autolink, Ruleset, Environment, Label>,
  override: Readonly<Partial<Record<SettingsSection, Settings | undefined>>> & {
    readonly autolinks?: Autolink[] | undefined;
    readonly rulesets?: Ruleset[] | undefined;
    readonly environments?: Environment[] | undefined;
    readonly labels?: Label[] | undefined;
  },
  file: string,
): SourcedLayer<Autolink, Ruleset, Environment, Label> {
  return {
    settings: mergeSections(base.settings, override, file),
    autolinks: mergeByKey(base.autolinks, sourced(override.autolinks, file), autolinkKey),
    rulesets: mergeByKey(base.rulesets, sourced(override.rulesets, file), rulesetKey),
    environments: mergeByKey(base.environments, sourced(override.environments, file), environmentEntryKey),
    labels: mergeByKey(base.labels, sourced(override.labels, file), labelEntryKey),
  };
}

function values(settings: SourcedSettings | undefined): Settings | undefined {
  return settings === undefined
    ? undefined
    : unflattenSettings([...settings.values()].map((item) => [item.path, item.entry] as const));
}

function files(settings: SourcedSettings | undefined): Record<string, string> {
  return Object.fromEntries([...(settings ?? [])].map(([key, item]) => [key, item.file]));
}

function entries<Entry>(list: Sourced<Entry>[] | undefined): Entry[] | undefined {
  return list?.map((item) => item.entry);
}

function entryFiles<Entry>(list: Sourced<Entry>[] | undefined, key: (entry: Entry) => string): Record<string, string> {
  return Object.fromEntries((list ?? []).map((item) => [key(item.entry), item.file]));
}

function toProfile(merged: SourcedProfile): unknown {
  const data: Record<string, unknown> = {
    ...Object.fromEntries(settingsSections.map((section) => [section, values(merged.settings[section])])),
    autolinks: entries(merged.autolinks),
    rulesets: entries(merged.rulesets),
    environments: entries(merged.environments),
    labels: entries(merged.labels),
  };
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
}

function validate(data: unknown, source: string): Profile {
  const result = profile.safeParse(data);
  if (!result.success) {
    throw new ProfileError(`${source} is not a valid profile:\n${describe(result.error)}`);
  }
  return result.data;
}

function issueLines(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const at = z.core.toDotPath(issue.path);
    return at === '' ? issue.message : `${issue.message} at ${at}`;
  });
}

function toDrafts(merged: SourcedDrafts, unset: ReadonlyMap<string, Sourced<string>>): Drafts {
  const drafts: Drafts = {
    ...Object.fromEntries(settingsSections.map((section) => [section, values(merged.settings[section])])),
    autolinks: entries(merged.autolinks),
    rulesets: entries(merged.rulesets),
    environments: entries(merged.environments),
    labels: entries(merged.labels),
    unset: [...unset.values()].map((item) => item.entry),
  };
  // A section or list with no drafts is left out.
  return Object.fromEntries(
    Object.entries(drafts).filter(([, value]: [string, unknown]) =>
      isRecord(value) ? Object.keys(value).length > 0 : Array.isArray(value) && value.length > 0,
    ),
  );
}

function settingProblems(section: SettingsSection, key: string, value: unknown): string[] {
  const schema = sectionSchemas[section];
  const field: unknown = schema === undefined ? customProperties : schema.shape[key];
  if (!(field instanceof z.ZodType)) {
    return [`${section} has no setting ${key}`];
  }
  const result = field.safeParse(schema === undefined ? { [key]: value } : value);
  return result.success ? [] : issueLines(result.error);
}

function entryProblems(schema: z.ZodType, { draft: _draft, ...entry }: Readonly<Record<string, unknown>>): string[] {
  const result = schema.safeParse(entry);
  return result.success ? [] : issueLines(result.error);
}

/**
 * A draft label that a label of the profile renames from: the rename applies,
 * since drafts never change what applies, so the draft's label is renamed
 * away, and finishing the draft would be refused.
 */
function renamedDraftWarnings(applied: Profile, drafts: Drafts): string[] {
  return (drafts.labels ?? []).flatMap((draft) => {
    const renaming = (applied.labels ?? []).find(
      (entry) =>
        entry.absent !== true && (entry.renamed_from ?? []).some((old) => labelKey(old) === labelKey(draft.name)),
    );
    return renaming === undefined
      ? []
      : [
          `Draft label "${draft.name}": label "${renaming.name}" is renamed from it, so applying renames "${draft.name}" and finishing this draft would be refused`,
        ];
  });
}

/** A draft may be unfinished, so these are warnings; finishing a draft makes them errors. */
function draftWarnings(drafts: Drafts): string[] {
  const warnings: string[] = [];
  for (const section of settingsSections) {
    for (const [key, value] of Object.entries(drafts[section] ?? {})) {
      warnings.push(...settingProblems(section, key, value).map((line) => `Draft ${section}.${key}: ${line}`));
    }
  }
  for (const entry of drafts.autolinks ?? []) {
    warnings.push(
      ...entryProblems(autolinkEntry, entry).map((line) => `Draft autolink "${entry.key_prefix}": ${line}`),
    );
  }
  for (const entry of drafts.rulesets ?? []) {
    warnings.push(...entryProblems(rulesetEntry, entry).map((line) => `Draft ruleset "${entry.name}": ${line}`));
  }
  for (const entry of drafts.environments ?? []) {
    warnings.push(
      ...entryProblems(environmentEntry, entry).map((line) => `Draft environment "${entry.name}": ${line}`),
    );
  }
  for (const entry of drafts.labels ?? []) {
    warnings.push(...entryProblems(labelEntry, entry).map((line) => `Draft label "${entry.name}": ${line}`));
  }
  return warnings;
}

/**
 * What a file's drafts lose as they merge: a Pages draft with `absent: true`
 * turns the site off, so the other keys beside it are left out, though the
 * file keeps them and finishing the draft would then fail.
 */
function fileDraftWarnings(drafts: Drafts, file: string): string[] {
  const pages = drafts.pages;
  if (pages?.['absent'] !== true) {
    return [];
  }
  const others = Object.keys(pages).filter((key) => key !== 'absent');
  return others.length === 0
    ? []
    : [
        `Draft pages in ${path.basename(file)}: absent turns the Pages site off, so ${others.join(', ')} ${others.length === 1 ? 'is' : 'are'} left out`,
      ];
}

/**
 * Settings go by key, and a setting inside a group by `<group>.<key>`, as
 * `selected_actions.verified_allowed` under `actions`. Autolinks go by prefix,
 * and rulesets, environments and labels by name.
 */
export type ProfileSources = Readonly<
  Record<SettingsSection | EntryList, Record<string, string>> & {
    /**
     * The same for drafts, by section and then key, prefix or name, and
     * under `unset`, by each key of `drafts.unset`.
     */
    drafts: Readonly<Record<SettingsSection | EntryList | 'unset', Record<string, string>>>;
  }
>;

export interface ResolvedProfile {
  /** The profile file, then each one it extends, as real paths. */
  readonly chain: readonly string[];
  readonly profile: Profile;
  readonly drafts: Drafts;
  /** What stops each draft from applying as it stands. */
  readonly warnings: readonly string[];
  readonly sources: ProfileSources;
  /** Null when no file in the chain sets the owner type. */
  readonly owner_source: string | null;
  /**
   * What changing the first file's owner type to each type would leave not
   * managed in that file, as `changeOwnerType` does: settings by their path,
   * as `repository.allow_forking` or `drafts.pages.public`, and rulesets and
   * environments by `rulesets/<name>`, which it drops or writes without what
   * the type doesn't have.
   */
  readonly owner_changes: Readonly<Record<OwnerType, readonly string[]>>;
}

interface Link {
  /** The file's real path, so the same file always has the same name. */
  readonly file: string;
  readonly parsed: OwnProfile;
  readonly drafts: Drafts;
  /**
   * Which of the profiles the first file lists reach this file through their
   * own chains, by their places in that list. Empty for the first file itself.
   */
  readonly listedIn: ReadonlySet<number>;
}

interface Chain<Read extends LayerRead> {
  readonly head: Read;
  readonly text: string;
  /** The first file, then every file it builds on, nearest first. */
  readonly links: readonly [Link, ...Link[]];
  /** The real path of each profile the first file lists, in its order. */
  readonly listedProfiles: readonly string[];
}

async function readText(file: string, noun: string): Promise<{ file: string; text: string }> {
  try {
    const resolved = await realpath(file);
    return { file: resolved, text: await readFile(resolved, 'utf8') };
  } catch (error) {
    throw new ProfileError(`Cannot read ${noun} ${file}`, { cause: error });
  }
}

/** A profile and the one it extends, and so on, nearest first. */
async function readExtendsChain(start: string, listingFile: string | undefined): Promise<Link[]> {
  const links: Link[] = [];
  const seen = new Set(listingFile === undefined ? [] : [listingFile]);
  let next: string | undefined = start;
  while (next !== undefined) {
    const { file: resolved, text } = await readText(next, profileLayer.noun);
    if (seen.has(resolved)) {
      throw new ProfileError(`Profile ${resolved} extends itself`);
    }
    seen.add(resolved);
    const parsed = parseLayer(text, resolved, profileLayer);
    links.push({ file: resolved, parsed: parsed.own, drafts: parsed.drafts, listedIn: new Set() });
    const [parent] = parsed.extends;
    next = parent === undefined ? undefined : path.resolve(path.dirname(resolved), parent);
  }
  return links;
}

interface Listed {
  /** Applied first, later ones overriding earlier ones. */
  readonly appliedFirst: readonly Link[];
  readonly listedProfiles: readonly string[];
}

/**
 * Each listed profile brings the profiles it extends, and they apply in the
 * order the profiles are listed. A file that more than one of them builds on,
 * such as a shared starting point, applies once, at its first place. So a
 * profile listed after one that already builds on it would change nothing,
 * and is refused.
 */
async function readListed(
  listed: readonly string[],
  folder: string | undefined,
  listingFile: string | undefined,
  namedTwice: (named: string) => string,
): Promise<Listed> {
  const chains: { readonly named: string; readonly chain: readonly Link[] }[] = [];
  for (const profile of listed) {
    const start = folder === undefined ? path.resolve(profile) : path.resolve(folder, profile);
    const chain = await readExtendsChain(start, listingFile);
    const named = chain[0]?.file ?? start;
    if (chains.some((earlier) => earlier.named === named)) {
      throw new ProfileError(namedTwice(named));
    }
    const through = chains.find((earlier) => earlier.chain.some((link) => link.file === named));
    if (through !== undefined) {
      throw new ProfileError(
        `${named} is already applied through ${through.named}, so listing it after that changes nothing`,
      );
    }
    chains.push({ named, chain });
  }
  const listedIn = (file: string): ReadonlySet<number> =>
    new Set(chains.flatMap(({ chain }, index) => (chain.some((link) => link.file === file) ? [index] : [])));
  const appliedFirst: Link[] = [];
  const included = new Set<string>();
  for (const { chain } of chains) {
    for (const link of chain.toReversed()) {
      if (!included.has(link.file)) {
        included.add(link.file);
        appliedFirst.push({ ...link, listedIn: listedIn(link.file) });
      }
    }
  }
  return { appliedFirst, listedProfiles: chains.map(({ named }) => named) };
}

async function readChain<Read extends LayerRead>(file: string, kind: Layer<Read>): Promise<Chain<Read>> {
  const first = await readText(path.resolve(file), kind.noun);
  const head = parseLayer(first.text, first.file, kind);
  const { appliedFirst, listedProfiles } = await readListed(
    head.extends,
    path.dirname(first.file),
    first.file,
    (named) => `${first.file} names ${named} more than once in extends`,
  );
  return {
    head: head.read,
    text: first.text,
    links: [
      { file: first.file, parsed: head.own, drafts: head.drafts, listedIn: new Set() },
      ...appliedFirst.toReversed(),
    ],
    listedProfiles,
  };
}

function sourcesOf(
  merged: SourcedProfile | SourcedDrafts,
): Record<SettingsSection | EntryList, Record<string, string>> {
  return {
    repository: files(merged.settings.repository),
    merge: files(merged.settings.merge),
    actions: files(merged.settings.actions),
    security: files(merged.settings.security),
    custom_properties: files(merged.settings.custom_properties),
    pages: files(merged.settings.pages),
    autolinks: entryFiles<{ key_prefix: string }>(merged.autolinks, (entry) => entry.key_prefix),
    rulesets: entryFiles<{ name: string }>(merged.rulesets, (entry) => entry.name),
    environments: entryFiles<{ name: string }>(merged.environments, (entry) => entry.name),
    labels: entryFiles<{ name: string }>(merged.labels, (entry) => entry.name),
  };
}

export interface ResolvedLayer<Read extends LayerRead> {
  readonly head: Read;
  readonly resolved: ResolvedProfile;
  /** Each part of the first file's adjust that changed nothing. */
  readonly unmatched: readonly string[];
  readonly listedProfiles: readonly string[];
  /** Where a later listed profile removes what an earlier one adds, which is easy to miss. */
  readonly overrideWarnings: readonly OverrideWarning[];
}

/** Whether one listed profile's chain holds both, or either is the first file itself. */
function sharesListedProfile(left: Link, right: Link): boolean {
  return (
    left.listedIn.size === 0 ||
    right.listedIn.size === 0 ||
    [...left.listedIn].some((index) => right.listedIn.has(index))
  );
}

/**
 * The nearest file that names an owner type sets it. Files that name different
 * ones cannot extend each other or apply together.
 */
function chainOwnerType(chain: readonly Link[]): { type: OwnerType; file: string } | undefined {
  const typed = chain.flatMap((link) =>
    link.parsed.owner_type === undefined ? [] : [{ type: link.parsed.owner_type, file: link.file, link }],
  );
  const [first] = typed;
  const other = typed.find((link) => link.type !== first?.type);
  if (first !== undefined && other !== undefined && !sharesListedProfile(first.link, other.link)) {
    throw new ProfileError(
      `${first.file} is for ${describeOwnerType(first.type)}, but ${other.file}, applied with it, is for ${describeOwnerType(other.type)}`,
    );
  }
  if (first !== undefined && other !== undefined) {
    throw new ProfileError(
      `${first.file} is for ${describeOwnerType(first.type)}, but it builds on ${other.file}, which is for ${describeOwnerType(other.type)}`,
    );
  }
  return first;
}

function conflictTarget({ edit }: OwnerConflict): string {
  return 'list' in edit ? `${edit.draft === true ? 'drafts.' : ''}${edit.list}/${edit.name}` : edit.path.join('.');
}

function conflictTargets(conflicts: readonly OwnerConflict[]): string[] {
  return [...new Set(conflicts.map(conflictTarget))];
}

function ownerTypeEdits(layer: ProfileFile, type: OwnerType | undefined): ProfileEdit[] {
  const conflicts = [...ownerConflicts(layer, type, { drafts: true }), ...draftOwnerConflicts(layer.drafts, type)];
  const edits = new Map<string, ProfileEdit>();
  for (const conflict of conflicts) {
    const { edit } = conflict;
    if ('list' in edit) {
      // A ruleset or environment with several conflicts is written once, without all of them.
      edits.set(conflictTarget(conflict), edit);
      continue;
    }
    // A group such as code_quality_setup goes setting by setting, as an edit names one setting.
    const value = getIn(layer, edit.path);
    const group = settingPath(edit.path[0] === 'drafts' ? edit.path.slice(1) : edit.path) === 'group';
    for (const key of group && isRecord(value) ? Object.keys(value) : [undefined]) {
      const at = key === undefined ? edit.path : [...edit.path, key];
      edits.set(at.join('.'), { path: at, value: undefined });
    }
  }
  // A drafts.unset key that names what the change takes out of the file, or a setting in it, names nothing then.
  const removed = [...edits.values()].flatMap((edit) =>
    'list' in edit
      ? edit.draft !== true && edit.entry === undefined
        ? [unsetKey({ kind: 'entry', list: edit.list, name: edit.name })]
        : []
      : edit.path[0] === 'drafts'
        ? []
        : [edit.path.join('.')],
  );
  const unset = layer.drafts?.unset ?? [];
  const kept = unset.filter((key) => {
    const parsed = parseUnset(key);
    if (parsed === undefined) {
      return true;
    }
    const name = unsetKey(parsed);
    return !removed.some((gone) => name === gone || (parsed.kind === 'setting' && name.startsWith(`${gone}.`)));
  });
  const unsetEdits: ProfileEdit[] =
    kept.length === unset.length ? [] : [{ path: ['drafts', 'unset'], value: kept.length === 0 ? undefined : kept }];
  return [{ path: ['owner_type'], value: type }, ...edits.values(), ...unsetEdits];
}

function draftEntryOwnerConflicts(drafts: Drafts, type: OwnerType | undefined): OwnerConflict[] {
  return ownerConflicts({ rulesets: drafts.rulesets, environments: drafts.environments }, type, { drafts: true });
}

function ownerChanges(head: Link | undefined): Record<OwnerType, string[]> {
  const targets = (type: OwnerType): string[] =>
    head === undefined
      ? []
      : conflictTargets([
          ...ownerConflicts(head.parsed, type),
          ...draftOwnerConflicts(head.drafts, type),
          ...draftEntryOwnerConflicts(head.drafts, type),
        ]);
  return { user: targets('user'), organization: targets('organization') };
}

interface RemovableEntry {
  readonly section: EntryList;
  readonly name: string;
  readonly key: string;
  readonly described: string;
  readonly absent: boolean;
}

function removableEntries(parsed: OwnProfile): RemovableEntry[] {
  return [
    ...(parsed.autolinks ?? []).map((entry) => ({
      section: 'autolinks' as const,
      name: entry.key_prefix,
      key: `autolinks/${entry.key_prefix}`,
      described: `autolink "${entry.key_prefix}"`,
      absent: entry.absent === true,
    })),
    ...(parsed.rulesets ?? []).map((entry) => ({
      section: 'rulesets' as const,
      name: entry.name,
      key: `rulesets/${entry.name}`,
      described: `ruleset "${entry.name}"`,
      absent: entry.absent === true,
    })),
    ...(parsed.environments ?? []).map((entry) => ({
      section: 'environments' as const,
      name: entry.name,
      key: `environments/${environmentKey(entry.name)}`,
      described: `environment "${entry.name}"`,
      absent: entry.absent === true,
    })),
    ...(parsed.labels ?? []).map((entry) => ({
      section: 'labels' as const,
      name: entry.name,
      key: `labels/${labelKey(entry.name)}`,
      described: `label "${entry.name}"`,
      absent: entry.absent === true,
    })),
  ];
}

export interface OverrideWarning {
  readonly section: EntryList | 'pages';
  /** The entry's name; none for the Pages site. */
  readonly key?: string;
  readonly message: string;
}

/**
 * A listed profile that removes an entry, or the Pages site, that an earlier
 * one adds wins, since later profiles override earlier ones. A profile
 * removing what a profile in its own chain adds is how a profile drops an
 * entry, so only removals across listed profiles are named.
 */
function removalWarnings(links: readonly Link[]): OverrideWarning[] {
  const warnings: OverrideWarning[] = [];
  const appliedBaseFirst = links.filter((link) => link.listedIn.size > 0).toReversed();
  const adders = new Map<string, Link>();
  for (const link of appliedBaseFirst) {
    for (const entry of removableEntries(link.parsed)) {
      const adder = adders.get(entry.key);
      if (!entry.absent) {
        adders.set(entry.key, link);
        continue;
      }
      adders.delete(entry.key);
      if (adder !== undefined && !sharesListedProfile(adder, link)) {
        warnings.push({
          section: entry.section,
          key: entry.name,
          message: `${path.basename(link.file)} removes the ${entry.described} that ${path.basename(adder.file)} adds, since later profiles override earlier ones`,
        });
      }
    }
  }
  let pagesAdder: Link | undefined;
  for (const link of appliedBaseFirst) {
    const pages = link.parsed.pages;
    if (pages === undefined) {
      continue;
    }
    if (pages.absent !== true) {
      pagesAdder = link;
    } else if (pagesAdder !== undefined) {
      if (!sharesListedProfile(pagesAdder, link)) {
        warnings.push({
          section: 'pages',
          message: `${path.basename(link.file)} removes the Pages site that ${path.basename(pagesAdder.file)} sets up, since later profiles override earlier ones`,
        });
      }
      pagesAdder = undefined;
    }
  }
  return warnings;
}

function resolveChain(
  chain: readonly Link[],
  source: string,
  adjust?: Adjust,
): { resolved: ResolvedProfile; unmatched: readonly string[] } {
  const owner = chainOwnerType(chain);
  const merged = chain
    .toReversed()
    .reduce<SourcedProfile>((base, { file, parsed }) => mergeLayers(base, parsed, file), { settings: {} });
  const mergedDrafts = chain
    .toReversed()
    .reduce<SourcedDrafts>((base, { file, drafts }) => mergeLayers(base, drafts, file), { settings: {} });
  // A file's unset stands in for the same key in the files it extends.
  const unset = new Map<string, Sourced<string>>();
  for (const { file, drafts: own } of chain.toReversed()) {
    for (const key of own.unset ?? []) {
      const parsed = parseUnset(key);
      if (parsed !== undefined) {
        unset.set(unsetKey(parsed), { entry: key, file });
      }
    }
  }
  const drafts = toDrafts(mergedDrafts, unset);
  // The owner type comes first, as a profile file has it.
  const data: unknown =
    owner === undefined ? toProfile(merged) : Object.assign({ owner_type: owner.type }, toProfile(merged));
  const adjusted = adjust === undefined ? { data, unmatched: [] } : adjust(data);
  const applied = validate(adjusted.data, source);
  // Draft settings must suit the owner type too, as they apply once finished.
  const draftConflicts = draftOwnerConflicts(drafts, owner?.type);
  if (draftConflicts.length > 0) {
    throw new ProfileError(
      `${source} is not a valid profile:\n${draftConflicts.map(({ message, path: at }) => `✖ ${message}\n  → at ${at.join('.')}`).join('\n')}`,
    );
  }
  return {
    resolved: {
      chain: chain.map((link) => link.file),
      profile: applied,
      drafts,
      warnings: [
        ...chain.flatMap((link) => [...fileDraftWarnings(link.drafts, link.file), ...unsetWarnings(link)]),
        ...draftWarnings(drafts),
        ...renamedDraftWarnings(applied, drafts),
        // A draft entry may be unfinished, so what its owner type lacks is a warning until it is finished.
        ...draftEntryOwnerConflicts(drafts, owner?.type).map(({ message }) => message),
      ],
      sources: {
        ...sourcesOf(merged),
        drafts: {
          ...sourcesOf(mergedDrafts),
          unset: Object.fromEntries([...unset.values()].map((item) => [item.entry, item.file])),
        },
      },
      owner_source: owner?.file ?? null,
      owner_changes: ownerChanges(chain[0]),
    },
    unmatched: adjusted.unmatched,
  };
}

export async function resolveLayer<Read extends LayerRead>(
  file: string,
  kind: Layer<Read>,
): Promise<ResolvedLayer<Read>> {
  const { head, links, listedProfiles } = await readChain(file, kind);
  return {
    head,
    ...resolveChain(links, path.resolve(file), head.adjust),
    listedProfiles,
    overrideWarnings: removalWarnings(links),
  };
}

export async function resolveProfile(file: string): Promise<ResolvedProfile> {
  return (await resolveLayer(file, profileLayer)).resolved;
}

/** For profile YAML that is not in a file, such as text an agent sends. `extends` resolves from `directory`. */
export async function parseProfile(text: string, directory: string): Promise<ResolvedProfile> {
  const parsed = parseLayer(text, 'The profile', profileLayer);
  const [parent] = parsed.extends;
  const base = parent === undefined ? [] : (await readChain(path.resolve(directory, parent), profileLayer)).links;
  return resolveChain(
    [{ file: 'The profile', parsed: parsed.own, drafts: parsed.drafts, listedIn: new Set() }, ...base],
    'The profile',
  ).resolved;
}

/**
 * The profiles as one, applied in the order given with later ones overriding
 * earlier ones, as a staged apply that lists them applies them.
 */
export async function resolveProfilesTogether(profiles: readonly string[]): Promise<ResolvedProfile> {
  const { appliedFirst } = await readListed(
    profiles,
    undefined,
    undefined,
    (named) => `${named} is given more than once`,
  );
  const [last, ...rest] = appliedFirst.toReversed();
  if (last === undefined) {
    throw new ProfileError('Name at least one profile to apply together');
  }
  return resolveChain([last, ...rest], last.file).resolved;
}

export interface ProfileListing {
  /** The file name without its extension. */
  readonly name: string;
  /** The subfolder the file is in, from the listed folder, with `/` separators; '' for the folder itself. */
  readonly folder: string;
  readonly file: string;
  /** Null when it extends none or the profile it extends cannot be read. */
  readonly extends: string | null;
  /** Null when it resolves. */
  readonly problem: string | null;
  /** Null when it is for any owner or doesn't resolve. */
  readonly owner_type: OwnerType | null;
}

async function listFolder(root: string, folder: string, entries: Dirent[], listings: ProfileListing[]): Promise<void> {
  const byName = (a: Dirent, b: Dirent): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const entry of entries.filter((item) => /\.ya?ml$/iu.test(item.name) && !item.isDirectory()).sort(byName)) {
    let file = path.join(root, folder, entry.name);
    let base: string | null = null;
    let problem: string | null = null;
    let owner: OwnerType | null = null;
    try {
      const { links } = await readChain(file, profileLayer);
      file = links[0].file;
      base = links[1]?.file ?? null;
      owner = resolveChain(links, file).resolved.profile.owner_type ?? null;
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    }
    listings.push({
      name: entry.name.replace(/\.ya?ml$/iu, ''),
      folder,
      file,
      extends: base,
      problem,
      owner_type: owner,
    });
  }
  for (const entry of entries.filter((item) => item.isDirectory() && !item.name.startsWith('.')).sort(byName)) {
    const sub = folder === '' ? entry.name : `${folder}/${entry.name}`;
    let inside: Dirent[];
    try {
      inside = await readdir(path.join(root, sub), { withFileTypes: true });
    } catch {
      // A subfolder that cannot be read lists nothing, rather than hiding the rest.
      continue;
    }
    await listFolder(root, sub, inside, listings);
  }
}

/** Hidden subfolders, such as .git, and linked ones are left out, as a sync leaves them out. */
export async function listProfiles(directory: string): Promise<ProfileListing[]> {
  const root = path.resolve(directory);
  const listings: ProfileListing[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    throw new ProfileError(`Cannot read the profiles folder ${root}`, { cause: error });
  }
  await listFolder(root, '', entries, listings);
  return listings;
}

/** An undefined `value` removes the setting. */
export interface SettingEdit {
  /** As `['repository', 'has_wiki']` or `['actions', 'selected_actions', 'verified_allowed']`. */
  readonly path: readonly string[];
  readonly value: unknown;
}

/**
 * An undefined `entry` stops naming it here, so the entry of that name in a
 * base profile, if any, applies again. An entry with another name renames the
 * file's entry in place.
 *
 * A file may hold a draft and an entry of the same name, so `draft` says
 * which one the edit finds. The entry written is a draft when it has
 * `draft: true`, so writing an entry without it over a draft finishes the
 * draft in place.
 */
export interface EntryEdit {
  readonly list: 'rulesets' | 'environments' | 'labels';
  readonly name: string;
  readonly draft?: boolean;
  readonly entry: Readonly<Record<string, unknown>> | undefined;
}

export type ProfileEdit = SettingEdit | EntryEdit;

/**
 * A draft may name a key the section does not have yet, so any key goes, and
 * a key inside a group such as `selected_actions` goes by the group's key as
 * settings do.
 */
function isDraftPath(path: readonly string[]): boolean {
  const [section, key, inner, ...rest] = path;
  return (
    isSettingsSection(section) &&
    key !== undefined &&
    rest.length === 0 &&
    (inner === undefined || groupKeys[section].has(key))
  );
}

function isEditable(path: readonly string[]): boolean {
  if (path.length === 1 && path[0] === 'owner_type') {
    return true;
  }
  if (path[0] !== 'drafts') {
    return settingPath(path) === 'setting';
  }
  return (path.length === 2 && path[1] === 'unset') || isDraftPath(path.slice(1));
}

/**
 * What a list item is known by: a pattern's name and type, a status check's
 * context, a reviewer's id and type, or a rule's type.
 */
function identity(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of ['name', 'context', 'id']) {
    if (value[key] !== undefined) {
      return JSON.stringify([key, value[key], value['type'] ?? null]);
    }
  }
  return value['type'] === undefined ? undefined : JSON.stringify(['type', value['type']]);
}

/**
 * Changes only the keys that differ, so the rest keep their place and
 * comments. A scalar keeps its comment when only its value changes, and a list
 * keeps the items it still holds.
 */
function updateMap(document: Document, map: YAMLMap, value: Readonly<Record<string, unknown>>): void {
  // A list reuses each item that is the same, then each known by the same
  // name, so those keep their comments wherever they move.
  const updateSeq = (seq: YAMLSeq, items: readonly unknown[]): void => {
    const unused = [...seq.items];
    const take = (matches: (current: unknown, next: unknown) => boolean, next: unknown): unknown => {
      const at = unused.findIndex((item) => matches(isNode(item) ? item.toJSON() : item, next));
      return at === -1 ? undefined : unused.splice(at, 1)[0];
    };
    const same = items.map((next) => take(isDeepEqual, next));
    seq.items = items.map((next, index) => {
      const item =
        same[index] ??
        take((current, wanted) => identity(wanted) !== undefined && identity(current) === identity(wanted), next);
      if (item === undefined) {
        return document.createNode(next);
      }
      if (isMap(item) && isRecord(next)) {
        updateMap(document, item, next);
      }
      return item;
    });
  };
  map.items = map.items.filter((pair) => {
    const name = isScalar(pair.key) ? pair.key.value : pair.key;
    return typeof name === 'string' && Object.hasOwn(value, name);
  });
  for (const [name, next] of Object.entries(value)) {
    const current: unknown = map.get(name, true);
    if (isMap(current) && isRecord(next)) {
      updateMap(document, current, next);
    } else if (isSeq(current) && Array.isArray(next)) {
      updateSeq(current, next);
    } else if (!isNode(current) || !isDeepEqual(current.toJSON(), next)) {
      map.set(
        name,
        isScalar(current) && (next === null || typeof next !== 'object') ? next : document.createNode(next),
      );
    }
  }
}

/** An edit could leave a YAML anchor or alias dangling, or expand it. */
function holdsYamlAnchorOrAlias(node: YAMLSeq): boolean {
  let shares = false;
  visit(node, (_, item) => {
    if (isAlias(item) || (isNode(item) && item.anchor !== undefined)) {
      shares = true;
      return visit.BREAK;
    }
    return undefined;
  });
  return shares;
}

/** A written entry takes the place of the one it replaces, and a new name goes at the end. */
function editEntry(document: Document, edit: EntryEdit, seen: Set<string>): void {
  const key = { rulesets: (name: string) => name, environments: environmentKey, labels: labelKey }[edit.list];
  const from = edit.draft === true;
  const to = edit.entry === undefined ? from : edit.entry['draft'] === true;
  const kind = { rulesets: 'ruleset', environments: 'environment', labels: 'label' }[edit.list];
  const noun = (draft: boolean): string => (draft ? `draft ${kind}` : kind);
  const name = edit.entry === undefined ? edit.name : edit.entry['name'];
  if (typeof name !== 'string') {
    throw new ProfileError(`The entry for ${edit.name} needs a name`);
  }
  const touched = new Map([
    [`${edit.list}:${String(from)}:${key(edit.name)}`, `${noun(from)} ${edit.name}`],
    [`${edit.list}:${String(to)}:${key(name)}`, `${noun(to)} ${name}`],
  ]);
  for (const [each, label] of touched) {
    if (seen.has(each)) {
      throw new ProfileError(`The ${label} is edited more than once`);
    }
    seen.add(each);
  }
  const found: unknown = document.get(edit.list, true);
  if (found !== undefined && !isSeq(found)) {
    throw new ProfileError(`Cannot edit ${edit.list}: it is not a list`);
  }
  const list = isSeq(found) ? found : undefined;
  if (list !== undefined && holdsYamlAnchorOrAlias(list)) {
    throw new ProfileError(`Cannot edit ${edit.list}: the file shares parts of them with YAML anchors and aliases`);
  }
  const find = (wanted: string, draft: boolean): number =>
    list?.items.findIndex(
      (item) => isMap(item) && key(String(item.get('name'))) === key(wanted) && (item.get('draft') === true) === draft,
    ) ?? -1;
  const index = find(edit.name, from);
  if (edit.entry === undefined) {
    if (list !== undefined && index !== -1) {
      list.items.splice(index, 1);
      if (list.items.length === 0) {
        document.delete(edit.list);
      }
    }
    return;
  }
  const other = find(name, to);
  if (other !== -1 && other !== index) {
    const action =
      key(name) !== key(edit.name)
        ? `rename ${edit.name}`
        : to
          ? `make ${edit.name} a draft`
          : `finish the draft ${edit.name}`;
    throw new ProfileError(`Cannot ${action}: the file already has a ${noun(to)} named ${name}`);
  }
  const item: unknown = list?.items[index];
  if (list === undefined) {
    document.set(edit.list, document.createNode([edit.entry]));
  } else if (isMap(item)) {
    updateMap(document, item, edit.entry);
  } else {
    // An empty list can only be written as `[]`. Its first entry is written as a block, as a list is by default.
    if (list.items.length === 0) {
      list.flow = false;
    }
    list.items.push(document.createNode(edit.entry));
  }
}

function moveLeadingCommentAndBlankLine(from: Scalar, to: Scalar): void {
  if (from.commentBefore !== undefined && from.commentBefore !== null) {
    // A comment the key already has stays, under the one that moves.
    to.commentBefore =
      to.commentBefore === undefined || to.commentBefore === null
        ? from.commentBefore
        : `${from.commentBefore}\n${to.commentBefore}`;
    from.commentBefore = null;
  }
  if (from.spaceBefore === true) {
    to.spaceBefore = true;
    from.spaceBefore = false;
  }
}

/**
 * A file that doesn't name `owner_type` yet gets it first, or right after
 * `extends`, with any comment over the file's first key kept above it.
 */
function setOwnerType(document: Document, value: unknown): void {
  const contents = document.contents;
  if (document.has('owner_type') || !isMap(contents)) {
    document.set('owner_type', value);
    return;
  }
  const at = contents.items.findIndex((pair) => isScalar(pair.key) && pair.key.value === 'extends') + 1;
  const pair = document.createPair('owner_type', value);
  const first = contents.items[0]?.key;
  if (at === 0 && isScalar(first) && isScalar(pair.key)) {
    moveLeadingCommentAndBlankLine(first, pair.key);
  }
  contents.items.splice(at, 0, pair);
}

/** The comment over `owner_type` goes to the key after it. */
function removeOwnerType(document: Document): void {
  const contents = document.contents;
  if (isMap(contents)) {
    const at = contents.items.findIndex((pair) => isScalar(pair.key) && pair.key.value === 'owner_type');
    const key = contents.items[at]?.key;
    const next = contents.items[at + 1]?.key;
    if (isScalar(key) && isScalar(next)) {
      moveLeadingCommentAndBlankLine(key, next);
    }
  }
  document.delete('owner_type');
}

interface EditedLayer<Read extends LayerRead> {
  /**
   * Resolves the chain as it was read. Only a preview needs it, and an edit
   * can fix a chain that no longer resolves, so it is not resolved up front.
   */
  readonly before: () => ResolvedProfile;
  readonly result: ResolvedLayer<Read>;
  readonly file: string;
  readonly original: string;
  readonly text: string;
}

async function editChain<Read extends LayerRead>(
  file: string,
  edits: (head: Read) => readonly ProfileEdit[],
  layer: Layer<Read>,
): Promise<EditedLayer<Read>> {
  const { head, text: original, links, listedProfiles } = await readChain(file, layer);
  const [own, ...base] = links;
  const document = parseDocument(original);
  const seen = new Set<string>();
  for (const edit of edits(head)) {
    if ('list' in edit) {
      editEntry(document, edit, seen);
      continue;
    }
    const key = edit.path.join('.');
    if (!isEditable(edit.path) && !layer.ownTopLevelKeys.has(key)) {
      throw new ProfileError(`Cannot edit ${key}: it is not one setting of a profile section, or a draft of one`);
    }
    if (seen.has(key)) {
      throw new ProfileError(`${key} is edited more than once`);
    }
    seen.add(key);
    if (edit.value !== undefined && edit.path.length === 1 && edit.path[0] === 'owner_type') {
      setOwnerType(document, edit.value);
      continue;
    }
    if (edit.value !== undefined) {
      document.setIn(
        edit.path,
        edit.value !== null && typeof edit.value === 'object' ? document.createNode(edit.value) : edit.value,
      );
      continue;
    }
    if (!document.hasIn(edit.path)) {
      continue;
    }
    if (edit.path.length === 1 && edit.path[0] === 'owner_type') {
      removeOwnerType(document);
      continue;
    }
    document.deleteIn(edit.path);
    // A section left empty goes too, so removing a setting leaves no trace.
    for (let depth = edit.path.length - 1; depth > 0; depth -= 1) {
      const parent = document.getIn(edit.path.slice(0, depth));
      if (isMap(parent) && parent.items.length === 0) {
        document.deleteIn(edit.path.slice(0, depth));
      }
    }
  }
  const indent = /^( +)\S/mu.exec(original)?.[1]?.length ?? 2;
  const text = document.toString({ lineWidth: 0, indent });
  const edited = parseLayer(text, own.file, layer);
  const editedLinks = [{ file: own.file, parsed: edited.own, drafts: edited.drafts, listedIn: own.listedIn }, ...base];
  const result = {
    head: edited.read,
    ...resolveChain(editedLinks, own.file, edited.read.adjust),
    listedProfiles,
    overrideWarnings: removalWarnings(editedLinks),
  };
  layer.check(result);
  return { before: () => resolveChain(links, own.file, head.adjust).resolved, result, file: own.file, original, text };
}

/**
 * The file is read once, and `edits` says what to change from what that read
 * yields, so the edits and the text they change agree.
 */
export async function editLayer<Read extends LayerRead>(
  file: string,
  edits: (head: Read) => readonly ProfileEdit[],
  layer: Layer<Read>,
): Promise<ResolvedLayer<Read>> {
  const edited = await editChain(file, edits, layer);
  try {
    await replaceFile(
      edited.file,
      edited.original.includes('\r\n') ? edited.text.replaceAll('\n', '\r\n') : edited.text,
      { create: false },
    );
  } catch (error) {
    throw new ProfileError(`Cannot save ${layer.noun} ${edited.file}`, { cause: error });
  }
  return edited.result;
}

/**
 * Keeps the file's comments, line endings and indent width; YAML layout such
 * as quoting and list indentation may be normalized. The file changes only
 * when the result, laid over the profiles it extends, is a valid profile.
 */
export async function editProfile(file: string, edits: readonly ProfileEdit[]): Promise<ResolvedProfile> {
  return (await editLayer(file, () => edits, profileLayer)).resolved;
}

export async function previewLayer<Read extends LayerRead>(
  file: string,
  edits: (head: Read) => readonly ProfileEdit[],
  layer: Layer<Read>,
): Promise<{ before: ResolvedLayer<Read>; after: ResolvedLayer<Read> }> {
  const { result } = await editChain(file, edits, layer);
  return { before: await resolveLayer(file, layer), after: result };
}

export interface ProfilePreview {
  readonly before: ResolvedProfile;
  readonly after: ResolvedProfile;
}

export async function previewProfile(file: string, edits: readonly ProfileEdit[]): Promise<ProfilePreview> {
  const { before, result } = await editChain(file, () => edits, profileLayer);
  return { before: before(), after: result.resolved };
}

function overrides(own: Link, { edit }: OwnerConflict): boolean {
  if ('list' in edit) {
    const entries = edit.draft === true ? own.drafts[edit.list] : own.parsed[edit.list];
    const key = edit.list === 'rulesets' ? (name: string) => name : environmentKey;
    return (entries ?? []).some((entry) => key(entry.name) === key(edit.name));
  }
  const [section, ...rest] = edit.path;
  const root: unknown = section === 'drafts' ? own.drafts : own.parsed;
  const at = section === 'drafts' ? rest : edit.path;
  return at.reduce<unknown>((value, key) => (isRecord(value) ? value[key] : undefined), root) !== undefined;
}

/**
 * A base the file builds on sets what the type lacks and the file doesn't
 * override it: the change edits only the file, so only the base can drop it.
 */
async function blockingBase(file: string, type: OwnerType | undefined, error: unknown): Promise<Error | undefined> {
  if (type === undefined || !(error instanceof ProfileError)) {
    return undefined;
  }
  // A file that no longer reads keeps the error it gave.
  const chain = await readChain(file, profileLayer).catch(() => undefined);
  if (chain === undefined) {
    return undefined;
  }
  const [own, ...base] = chain.links;
  // What the change removes from the file no longer overrides the base.
  const removed = new Set(
    [
      ...ownerConflicts(own.parsed, type),
      ...draftOwnerConflicts(own.drafts, type),
      ...draftEntryOwnerConflicts(own.drafts, type),
    ]
      .filter((conflict) => !('list' in conflict.edit) || conflict.edit.entry === undefined)
      .map(conflictTarget),
  );
  for (const link of base) {
    const targets = conflictTargets(
      [...ownerConflicts(link.parsed, type), ...draftOwnerConflicts(link.drafts, type)].filter(
        (conflict) => removed.has(conflictTarget(conflict)) || !overrides(own, conflict),
      ),
    );
    if (targets.length > 0) {
      return new ProfileError(
        `${own.file} can't be for ${describeOwnerType(type)}, because ${link.file}, which it builds on, sets ${targets.join(', ')}, which ${describeOwnerType(type)} don't have. Change ${path.basename(link.file)} first.`,
        { cause: error },
      );
    }
  }
  return undefined;
}

/** The base profiles stay as they are, so the file changes only when they agree with the type. */
export async function changeOwnerType(file: string, type: OwnerType | undefined): Promise<ResolvedProfile> {
  try {
    return (await editLayer(file, (head) => ownerTypeEdits(head.layer, type), profileLayer)).resolved;
  } catch (error) {
    throw (await blockingBase(file, type, error)) ?? error;
  }
}

/** As written, whether or not the file it names reads; undefined for none, or for text that isn't YAML. */
export function declaredExtends(text: string): string | undefined {
  const document = parseDocument(text);
  const base: unknown = document.errors.length > 0 ? undefined : document.get('extends');
  return typeof base === 'string' ? base : undefined;
}

/**
 * Points `extends` at `base`, as a move of the profile or of its base needs.
 * Only the value's own text changes, so the rest of the file stays as written.
 */
export function withExtends(text: string, base: string): string {
  const document = parseDocument(text);
  const value = document.get('extends', true);
  const written = /^[\w./-]+$/u.test(base) ? base : JSON.stringify(base);
  const inline =
    isScalar(value) && (value.type === 'PLAIN' || value.type === 'QUOTE_SINGLE' || value.type === 'QUOTE_DOUBLE');
  if (document.errors.length === 0 && inline && value.range !== undefined && value.range !== null) {
    const [start, end] = value.range;
    return text.slice(0, start) + written + text.slice(end);
  }
  document.set('extends', base);
  const edited = document.toString({ lineWidth: 0 });
  return text.includes('\r\n') ? edited.replaceAll('\n', '\r\n') : edited;
}

export function stringifyProfile(value: Profile): string {
  return stringify(value, { lineWidth: 0 });
}
