import type { Dirent } from 'node:fs';
import { readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  type Document,
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  parse,
  parseDocument,
  stringify,
  visit,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml';
import { z } from 'zod';

import { replaceFile } from './files.js';
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

/** A profile file without its drafts: what it adds to the profile that applies. */
type OwnProfile = Omit<ProfileFile, 'autolinks' | 'rulesets' | 'environments' | 'labels' | 'drafts'> & {
  autolinks?: AutolinkEntry[] | undefined;
  rulesets?: RulesetEntry[] | undefined;
  environments?: EnvironmentEntry[] | undefined;
  labels?: LabelEntry[] | undefined;
};

/**
 * A profile's drafts: settings by section, as the profile's `drafts` holds
 * them, the autolinks, rulesets, environments and labels marked `draft: true`,
 * and `unset`, what finishing the drafts stops managing, as
 * `repository.has_wiki` or `rulesets/Legacy`. Plan and apply leave every
 * draft out.
 */
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

/** Splits a list into its entries and its drafts; a list left empty is left out. */
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

/** The names that appear more than once in a list of drafts, as problems. */
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
 * Changes a chain's merged profile before it is checked, as a staged apply
 * leaves out what it excludes, so only the result has to be a valid profile.
 * It names, as `unmatched`, each part of the change that changed nothing.
 */
export type Adjust = (data: unknown) => { readonly data: unknown; readonly unmatched: readonly string[] };

/** What one parse of a chain's first file yields: its profile layer, and what changes the merged profile. */
export interface LayerRead {
  readonly layer: ProfileFile;
  readonly adjust?: Adjust | undefined;
}

/**
 * How a chain's first file reads: a profile file, or a file that carries a
 * profile layer with keys of its own, such as a staged apply. The schema
 * checks the whole file and yields its layer, its adjust, and anything else
 * the file says, from one parse.
 */
export type LayerSchema<Read extends LayerRead> = z.ZodType<Read>;

/**
 * A kind of file a chain starts with: what it is called, how it reads, keys
 * of its own that an edit may set, and a last check before an edit is saved.
 */
export interface Layer<Read extends LayerRead> {
  /** What the file is called in errors, as `profile` or `staged apply`. */
  readonly noun: string;
  readonly schema: LayerSchema<Read>;
  /** Top-level keys of the file's own, which a setting edit may set or remove whole. */
  readonly paths: ReadonlySet<string>;
  /** Throws when the edited file, resolved, is not one to save. */
  readonly check: (edited: ResolvedLayer<Read>) => void;
}

const profileLayer: Layer<LayerRead> = {
  noun: 'profile',
  schema: profileFile.transform((layer) => ({ layer })),
  paths: new Set(),
  check: () => undefined,
};

/** A value of a merged profile, with the file that sets it. */
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

/** The lists of entries a profile holds, each known by its prefix or name. */
type EntryList = 'autolinks' | 'rulesets' | 'environments' | 'labels';

/** The sections that hold settings, which merge key by key. */
export const settingsSections = ['repository', 'merge', 'actions', 'security', 'custom_properties', 'pages'] as const;

export type SettingsSection = (typeof settingsSections)[number];

/** The keys of a section's schema whose value is an object of settings. */
function groups(schema: z.ZodObject): ReadonlySet<string> {
  return new Set(
    Object.entries(schema.shape)
      .filter(([, field]) => (field instanceof z.ZodOptional ? field.unwrap() : field) instanceof z.ZodObject)
      .map(([key]) => key),
  );
}

/**
 * Keys whose value is itself an object of settings, such as
 * `selected_actions`. They merge key by key, one level down, so an override
 * can change one of them and keep the rest.
 */
const groupKeys: Readonly<Record<SettingsSection, ReadonlySet<string>>> = {
  repository: groups(repositorySettings),
  merge: new Set(),
  actions: groups(actionsSettings),
  security: groups(securitySettings),
  custom_properties: new Set(),
  pages: groups(pagesSite),
};

/** Each section's schema, by which a setting in it is checked. */
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

/**
 * Whether a path names one setting: a section's key, or a key inside one of
 * its groups, as `actions.selected_actions.verified_allowed`.
 */
function isSettingsSection(name: string | undefined): name is SettingsSection {
  return settingsSections.some((section) => section === name);
}

/**
 * What a path under a settings section names: one setting, such as
 * `repository.has_wiki` or `actions.selected_actions.verified_allowed`, a
 * group of settings, such as `actions.selected_actions`, or nothing.
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

/** What a key of `drafts.unset` names: one setting or group of settings, or one entry of a list. */
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

/** Reads a key of `drafts.unset`, as `repository.has_wiki` or `rulesets/Legacy`, or undefined when it names nothing. */
function parseUnset(key: string): Unset | undefined {
  const slash = key.indexOf('/');
  if (slash !== -1) {
    const list = key.slice(0, slash);
    const name = key.slice(slash + 1);
    return isEntryList(list) && name !== '' ? { kind: 'entry', list, name } : undefined;
  }
  const parts = key.split('.');
  return settingPath(parts) === undefined ? undefined : { kind: 'setting', path: parts };
}

/** The key an unset is known by, so two spellings of one environment's or label's name are one. */
function unsetKey(unset: Unset): string {
  return unset.kind === 'setting' ? unset.path.join('.') : `${unset.list}/${entryKeys[unset.list](unset.name)}`;
}

function getIn(value: unknown, keys: readonly string[]): unknown {
  return keys.reduce<unknown>((current, key) => (isRecord(current) ? current[key] : undefined), value);
}

/** Whether a file's settings or entries, its own or its drafts, name what `unset` names. */
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

/**
 * What is wrong with a file's `drafts.unset`: a key that names nothing, one
 * named twice, or one that a draft of the same file also changes.
 */
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

/**
 * A file's `drafts.unset` that names what the file itself does not set:
 * finishing the draft would change nothing there.
 */
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

/** A file's layer read and split into what applies and its drafts. */
interface ParsedLayer<Read extends LayerRead> {
  readonly read: Read;
  readonly own: OwnProfile;
  readonly drafts: Drafts;
  readonly extends: string | undefined;
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
    extends: settings.extends,
  };
}

/**
 * Where a setting is in its section: `[key]`, or `[group, key]` inside a
 * group such as `selected_actions`, which an override can change one key of
 * and keep the rest.
 */
type SettingPath = readonly [string] | readonly [string, string];

/** Whether `value` is a group of settings at `key`, such as `selected_actions`. */
function isGroup(section: SettingsSection, key: string, value: unknown): value is Readonly<Record<string, unknown>> {
  return groupKeys[section].has(key) && isRecord(value);
}

/** A section's settings, each with its path. */
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

/** A section's settings from their paths, as `flattenSettings` gives them. */
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

/** A setting of a merge, with its path as `flattenSettings` gives it and the file that sets it. */
interface SourcedSetting extends Sourced<unknown> {
  readonly path: SettingPath;
}

/** A section's settings by their path joined with dots, as `has_wiki` or `selected_actions.verified_allowed`. */
type SourcedSettings = Map<string, SourcedSetting>;

/**
 * A profile or its drafts mid-merge: each setting and entry carries the file
 * that sets it.
 */
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

/** Lays each section's settings in `override` over `base`'s. */
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
 * Lays `override` over `base`, a profile over a profile or drafts over
 * drafts. Settings merge key by key, and so do the settings inside a group
 * such as `selected_actions`; an autolink, ruleset, environment or label in the
 * override replaces the base entry of the same name whole. Drafts never
 * merge with what applies.
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

/** What stops one draft setting from applying as it stands, if anything. */
function settingProblems(section: SettingsSection, key: string, value: unknown): string[] {
  const schema = sectionSchemas[section];
  const field: unknown = schema === undefined ? customProperties : schema.shape[key];
  if (!(field instanceof z.ZodType)) {
    return [`${section} has no setting ${key}`];
  }
  const result = field.safeParse(schema === undefined ? { [key]: value } : value);
  return result.success ? [] : issueLines(result.error);
}

/** What stops one draft entry from applying as it stands, if anything. */
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

/**
 * What stops each draft from applying as it stands: a key the section does
 * not have, or a value or entry the profile would reject. A draft may be
 * unfinished, so these are warnings; finishing a draft makes them errors.
 */
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
 * The file that sets each value of a resolved profile. Settings go by key,
 * and a setting inside a group by `<group>.<key>`, as
 * `selected_actions.verified_allowed` under `actions`. Autolinks go by
 * prefix, and rulesets, environments and labels by name.
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

/** A profile file laid over every profile it extends. */
export interface ResolvedProfile {
  /** The profile file, then each one it extends, as real paths. */
  readonly chain: readonly string[];
  /** What applies: the profile without its drafts. */
  readonly profile: Profile;
  readonly drafts: Drafts;
  /** What stops each draft from applying as it stands. */
  readonly warnings: readonly string[];
  readonly sources: ProfileSources;
}

interface Link {
  /** The file's real path, so the same file always has the same name. */
  readonly file: string;
  readonly parsed: OwnProfile;
  readonly drafts: Drafts;
}

/** A chain as read: each file read once, its first file's text, and what one parse of that text yields. */
interface Chain<Read extends LayerRead> {
  readonly head: Read;
  /** The first file's text, which an edit changes. */
  readonly text: string;
  readonly links: readonly [Link, ...Link[]];
}

async function readText(file: string, noun: string): Promise<{ file: string; text: string }> {
  try {
    const resolved = await realpath(file);
    return { file: resolved, text: await readFile(resolved, 'utf8') };
  } catch (error) {
    throw new ProfileError(`Cannot read ${noun} ${file}`, { cause: error });
  }
}

async function readChain<Read extends LayerRead>(file: string, kind: Layer<Read>): Promise<Chain<Read>> {
  const first = await readText(path.resolve(file), kind.noun);
  const head = parseLayer(first.text, first.file, kind);
  const links: [Link, ...Link[]] = [{ file: first.file, parsed: head.own, drafts: head.drafts }];
  const seen = new Set([first.file]);
  let next = head.extends === undefined ? undefined : path.resolve(path.dirname(first.file), head.extends);
  while (next !== undefined) {
    const { file: resolved, text } = await readText(next, profileLayer.noun);
    if (seen.has(resolved)) {
      throw new ProfileError(`Profile ${resolved} extends itself`);
    }
    seen.add(resolved);
    const parsed = parseLayer(text, resolved, profileLayer);
    links.push({ file: resolved, parsed: parsed.own, drafts: parsed.drafts });
    next = parsed.extends === undefined ? undefined : path.resolve(path.dirname(resolved), parsed.extends);
  }
  return { head: head.read, text: first.text, links };
}

/** The file that sets each setting and entry of a merge, by section. */
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

/** A chain resolved from what one read of its first file yields. */
export interface ResolvedLayer<Read extends LayerRead> {
  readonly head: Read;
  readonly resolved: ResolvedProfile;
  /** Each part of the first file's adjust that changed nothing. */
  readonly unmatched: readonly string[];
}

function resolveChain(
  chain: readonly Link[],
  source: string,
  adjust?: Adjust,
): { resolved: ResolvedProfile; unmatched: readonly string[] } {
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
  const adjusted = adjust === undefined ? { data: toProfile(merged), unmatched: [] } : adjust(toProfile(merged));
  const applied = validate(adjusted.data, source);
  return {
    resolved: {
      chain: chain.map((link) => link.file),
      profile: applied,
      drafts,
      warnings: [
        ...chain.flatMap((link) => [...fileDraftWarnings(link.drafts, link.file), ...unsetWarnings(link)]),
        ...draftWarnings(drafts),
        ...renamedDraftWarnings(applied, drafts),
      ],
      sources: {
        ...sourcesOf(merged),
        drafts: {
          ...sourcesOf(mergedDrafts),
          unset: Object.fromEntries([...unset.values()].map((item) => [item.entry, item.file])),
        },
      },
    },
    unmatched: adjusted.unmatched,
  };
}

/** Reads a chain whose first file is of `kind`, reading each file once, and resolves it. */
export async function resolveLayer<Read extends LayerRead>(
  file: string,
  kind: Layer<Read>,
): Promise<ResolvedLayer<Read>> {
  const { head, links } = await readChain(file, kind);
  return { head, ...resolveChain(links, path.resolve(file), head.adjust) };
}

/** Reads a profile file and every profile it extends, and says which file sets each value. */
export async function resolveProfile(file: string): Promise<ResolvedProfile> {
  return (await resolveLayer(file, profileLayer)).resolved;
}

/**
 * Parses profile YAML that is not in a file, such as text an agent sends.
 * `extends` resolves from `directory`.
 */
export async function parseProfile(text: string, directory: string): Promise<ResolvedProfile> {
  const parsed = parseLayer(text, 'The profile', profileLayer);
  const base =
    parsed.extends === undefined ? [] : (await readChain(path.resolve(directory, parsed.extends), profileLayer)).links;
  return resolveChain([{ file: 'The profile', parsed: parsed.own, drafts: parsed.drafts }, ...base], 'The profile')
    .resolved;
}

/** A profile file in a folder of profiles, for the desktop app's list. */
export interface ProfileListing {
  /** The file name without its extension. */
  readonly name: string;
  /** The subfolder the file is in, from the listed folder, with `/` separators; '' for the folder itself. */
  readonly folder: string;
  /** The file's real path, as \`resolveProfile\` reports it in its chain. */
  readonly file: string;
  /** The real path of the profile this one extends, or null when it extends none or cannot be read. */
  readonly extends: string | null;
  /** Why the profile cannot be used, or null when it resolves. */
  readonly problem: string | null;
}

/** Adds the profiles in one folder, then those in its subfolders, to `listings`. */
async function listFolder(root: string, folder: string, entries: Dirent[], listings: ProfileListing[]): Promise<void> {
  const byName = (a: Dirent, b: Dirent): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const entry of entries.filter((item) => /\.ya?ml$/iu.test(item.name) && !item.isDirectory()).sort(byName)) {
    let file = path.join(root, folder, entry.name);
    let base: string | null = null;
    let problem: string | null = null;
    try {
      const { links } = await readChain(file, profileLayer);
      file = links[0].file;
      base = links[1]?.file ?? null;
      resolveChain(links, file);
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    }
    listings.push({ name: entry.name.replace(/\.ya?ml$/iu, ''), folder, file, extends: base, problem });
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

/**
 * Lists the YAML profiles in a folder and its subfolders, by folder and then
 * name, and whether each resolves. Hidden subfolders, such as .git, and linked
 * ones are left out, as a sync leaves them out.
 */
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

/** One setting to change in a profile file: a value to set, or undefined to remove it. */
export interface SettingEdit {
  /** The section and key, such as `['repository', 'has_wiki']` or `['actions', 'selected_actions', 'verified_allowed']`. */
  readonly path: readonly string[];
  readonly value: unknown;
}

/**
 * One ruleset, environment or label to change in a profile file, by name: the entry
 * to write, or undefined to stop naming it here, so the entry of that name in
 * a base profile, if any, applies again. An entry with another name renames
 * the file's entry in place.
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
 * Whether a path under `drafts` names one draft setting. A draft may name a
 * key the section does not have yet, so any key goes, and a key inside a
 * group such as `selected_actions` goes by the group's key as settings do.
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
 * Makes `map` hold `value` and changes only the keys that differ, so the
 * rest keep their place and comments. A scalar keeps its comment when only
 * its value changes, and a list keeps the items it still holds.
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
    const same = items.map((next) => take(isDeepStrictEqual, next));
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
    } else if (!isNode(current) || !isDeepStrictEqual(current.toJSON(), next)) {
      map.set(
        name,
        isScalar(current) && (next === null || typeof next !== 'object') ? next : document.createNode(next),
      );
    }
  }
}

/** Whether `node` holds a YAML anchor or alias, which an edit could leave dangling or expand. */
function sharesNodes(node: YAMLSeq): boolean {
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

/**
 * Writes, renames or removes the file's own entry of the edit's name. A
 * written entry takes the place of the one it replaces, and a new name goes
 * at the end.
 */
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
  if (list !== undefined && sharesNodes(list)) {
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
    list.items.push(document.createNode(edit.entry));
  }
}

/** A chain's first file with edits made to its text, resolved, and not yet saved. */
interface EditedLayer<Read extends LayerRead> {
  /** The chain as it was read, resolved. */
  readonly before: ResolvedProfile;
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
  const { head, text: original, links } = await readChain(file, layer);
  const [own, ...base] = links;
  const document = parseDocument(original);
  const seen = new Set<string>();
  for (const edit of edits(head)) {
    if ('list' in edit) {
      editEntry(document, edit, seen);
      continue;
    }
    const key = edit.path.join('.');
    if (!isEditable(edit.path) && !layer.paths.has(key)) {
      throw new ProfileError(`Cannot edit ${key}: it is not one setting of a profile section, or a draft of one`);
    }
    if (seen.has(key)) {
      throw new ProfileError(`${key} is edited more than once`);
    }
    seen.add(key);
    if (edit.value !== undefined) {
      document.setIn(
        edit.path,
        edit.value !== null && typeof edit.value === 'object' ? document.createNode(edit.value) : edit.value,
      );
      continue;
    }
    // Nothing to remove when the file does not name the setting.
    if (!document.hasIn(edit.path)) {
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
  const result = {
    head: edited.read,
    ...resolveChain(
      [{ file: own.file, parsed: edited.own, drafts: edited.drafts }, ...base],
      own.file,
      edited.read.adjust,
    ),
  };
  layer.check(result);
  return { before: resolveChain(links, own.file, head.adjust).resolved, result, file: own.file, original, text };
}

/**
 * Edits the first file of a chain, as `editProfile` does, for any kind of
 * layer. The file is read once, and `edits` says what to change from what
 * that read yields, so the edits and the text they change agree.
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
 * Changes settings in one profile file and keeps its comments, line endings
 * and indent width; YAML layout such as quoting and list indentation may be
 * normalized. The file changes only when the result, laid over the profiles
 * it extends, is a valid profile.
 */
export async function editProfile(file: string, edits: readonly ProfileEdit[]): Promise<ResolvedProfile> {
  return (await editLayer(file, () => edits, profileLayer)).resolved;
}

/** What a profile resolves to before and after edits that are not saved. */
export interface ProfilePreview {
  readonly before: ResolvedProfile;
  readonly after: ResolvedProfile;
}

/**
 * Resolves a profile as it is and as `editProfile` would leave it, and saves
 * nothing. The edits are checked as `editProfile` checks them.
 */
export async function previewProfile(file: string, edits: readonly ProfileEdit[]): Promise<ProfilePreview> {
  const { before, result } = await editChain(file, () => edits, profileLayer);
  return { before, after: result.resolved };
}

export function stringifyProfile(value: Profile): string {
  return stringify(value, { lineWidth: 0 });
}
