import { chmod, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
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
type OwnProfile = Omit<ProfileFile, 'autolinks' | 'rulesets' | 'environments' | 'drafts'> & {
  autolinks?: AutolinkEntry[] | undefined;
  rulesets?: RulesetEntry[] | undefined;
  environments?: EnvironmentEntry[] | undefined;
};

/**
 * A profile's drafts: settings by section, as the profile's `drafts` holds
 * them, and the autolinks, rulesets and environments marked `draft: true`.
 * Plan and apply leave every draft out.
 */
export interface Drafts extends Partial<Record<SettingsSection, Readonly<Record<string, unknown>> | undefined>> {
  autolinks?: DraftAutolink[] | undefined;
  rulesets?: DraftEntry[] | undefined;
  environments?: DraftEntry[] | undefined;
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

function parseProfileFile(text: string, source: string): { own: OwnProfile; drafts: Drafts; extends?: string } {
  let data: unknown;
  try {
    data = parse(text) ?? {};
  } catch (error) {
    throw new ProfileError(`${source} is not valid YAML`, { cause: error });
  }
  const result = profileFile.safeParse(data);
  if (!result.success) {
    throw new ProfileError(`${source} is not a valid profile:\n${describe(result.error)}`);
  }
  const { autolinks, rulesets, environments, drafts, ...settings } = result.data;
  const [ownAutolinks, draftAutolinks] = partition<AutolinkEntry, DraftAutolink>(autolinks, isDraftAutolink);
  const [ownRulesets, draftRulesets] = partition<RulesetEntry, DraftEntry>(rulesets, isDraftEntry);
  const [ownEnvironments, draftEnvironments] = partition<EnvironmentEntry, DraftEntry>(environments, isDraftEntry);
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
  ];
  if (problems.length > 0) {
    throw new ProfileError(`${source} is not a valid profile:\n${problems.map((line) => `✖ ${line}`).join('\n')}`);
  }
  return {
    own: { ...settings, autolinks: ownAutolinks, rulesets: ownRulesets, environments: ownEnvironments },
    drafts: { ...drafts, autolinks: draftAutolinks, rulesets: draftRulesets, environments: draftEnvironments },
    ...(settings.extends === undefined ? {} : { extends: settings.extends }),
  };
}

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

/** The sections that hold settings, which merge key by key. */
const settingsSections = ['repository', 'merge', 'actions', 'security', 'custom_properties', 'pages'] as const;

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

/** A section's settings by path, as `has_wiki` or `selected_actions.verified_allowed`. */
type SourcedSettings = Map<string, Sourced<unknown>>;

/** A profile mid-merge: each setting and entry carries the file that sets it. */
interface SourcedProfile {
  settings: Partial<Record<SettingsSection, SourcedSettings>>;
  autolinks?: Sourced<AutolinkEntry>[] | undefined;
  rulesets?: Sourced<RulesetEntry>[] | undefined;
  environments?: Sourced<EnvironmentEntry>[] | undefined;
}

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
    return new Map([['absent', { entry: true, file }]]);
  }
  const merged = new Map(base);
  merged.delete('absent');
  for (const [key, entry] of Object.entries(override)) {
    if (groupKeys[section].has(key) && isRecord(entry)) {
      for (const [inner, value] of Object.entries(entry)) {
        merged.set(`${key}.${inner}`, { entry: value, file });
      }
    } else {
      merged.set(key, { entry, file });
    }
  }
  return merged;
}

function sourced<Entry>(entries: Entry[] | undefined, file: string): Sourced<Entry>[] | undefined {
  return entries?.map((entry) => ({ entry, file }));
}

const autolinkKey = (entry: { key_prefix: string }): string => entry.key_prefix;
const rulesetKey = (entry: { name: string }): string => entry.name;
const environmentEntryKey = (entry: { name: string }): string => environmentKey(entry.name);

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
 * Lays `override` over `base`. Settings merge key by key, and so do the
 * settings inside a group such as `selected_actions`; an autolink, ruleset
 * or environment in the override replaces the base entry of the same name
 * whole.
 */
function mergeProfiles(base: SourcedProfile, override: OwnProfile, file: string): SourcedProfile {
  return {
    settings: mergeSections(base.settings, override, file),
    autolinks: mergeByKey(base.autolinks, sourced(override.autolinks, file), autolinkKey),
    rulesets: mergeByKey(base.rulesets, sourced(override.rulesets, file), rulesetKey),
    environments: mergeByKey(base.environments, sourced(override.environments, file), environmentEntryKey),
  };
}

/** Drafts mid-merge, as a profile is: each draft carries the file that holds it. */
interface SourcedDrafts {
  settings: Partial<Record<SettingsSection, SourcedSettings>>;
  autolinks?: Sourced<DraftAutolink>[] | undefined;
  rulesets?: Sourced<DraftEntry>[] | undefined;
  environments?: Sourced<DraftEntry>[] | undefined;
}

/**
 * Lays `override`'s drafts over `base`'s as a profile merges: a draft
 * setting replaces the base's draft of that setting, and a draft entry the
 * base's draft of that name. Drafts never merge with what applies.
 */
function mergeDrafts(base: SourcedDrafts, override: Drafts, file: string): SourcedDrafts {
  return {
    settings: mergeSections(base.settings, override, file),
    autolinks: mergeByKey(base.autolinks, sourced(override.autolinks, file), autolinkKey),
    rulesets: mergeByKey(base.rulesets, sourced(override.rulesets, file), rulesetKey),
    environments: mergeByKey(base.environments, sourced(override.environments, file), environmentEntryKey),
  };
}

function values(settings: SourcedSettings | undefined): Settings | undefined {
  if (settings === undefined) {
    return undefined;
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of settings) {
    const [group, inner] = key.split('.', 2);
    if (inner === undefined || group === undefined) {
      result[key] = item.entry;
    } else {
      const current = result[group];
      result[group] = { ...(isRecord(current) ? current : {}), [inner]: item.entry };
    }
  }
  return result;
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
  return error.issues.map((issue) =>
    issue.path.length === 0 ? issue.message : `${issue.message} at ${z.core.toDotPath(issue.path)}`,
  );
}

function toDrafts(merged: SourcedDrafts): Drafts {
  const drafts: Drafts = {
    ...Object.fromEntries(settingsSections.map((section) => [section, values(merged.settings[section])])),
    autolinks: entries(merged.autolinks),
    rulesets: entries(merged.rulesets),
    environments: entries(merged.environments),
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

/**
 * What stops one draft entry from applying as it stands, if anything. It is
 * checked against the entry that removes, when it has `absent`, or the one
 * that describes, so a problem names its field rather than failing both.
 */
function entryProblems(
  [absent, present]: readonly [z.ZodType, z.ZodType],
  { draft: _draft, ...entry }: Readonly<Record<string, unknown>>,
): string[] {
  const result = (Object.hasOwn(entry, 'absent') ? absent : present).safeParse(entry);
  return result.success ? [] : issueLines(result.error);
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
      ...entryProblems(autolinkEntry.options, entry).map((line) => `Draft autolink "${entry.key_prefix}": ${line}`),
    );
  }
  for (const entry of drafts.rulesets ?? []) {
    warnings.push(
      ...entryProblems(rulesetEntry.options, entry).map((line) => `Draft ruleset "${entry.name}": ${line}`),
    );
  }
  for (const entry of drafts.environments ?? []) {
    warnings.push(
      ...entryProblems(environmentEntry.options, entry).map((line) => `Draft environment "${entry.name}": ${line}`),
    );
  }
  return warnings;
}

/**
 * The file that sets each value of a resolved profile. Settings go by key,
 * and a setting inside a group by `<group>.<key>`, as
 * `selected_actions.verified_allowed` under `actions`. Autolinks go by
 * prefix, and rulesets and environments by name.
 */
export type ProfileSources = Readonly<
  Record<SettingsSection | 'autolinks' | 'rulesets' | 'environments', Record<string, string>> & {
    /** The same for drafts, by section and then key, prefix or name. */
    drafts: Readonly<Record<SettingsSection | 'autolinks' | 'rulesets' | 'environments', Record<string, string>>>;
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

async function readChain(file: string): Promise<[Link, ...Link[]]> {
  const chain: Link[] = [];
  const seen = new Set<string>();
  let next: string | undefined = path.resolve(file);
  while (next !== undefined) {
    let resolved: string;
    let text: string;
    try {
      resolved = await realpath(next);
      text = await readFile(resolved, 'utf8');
    } catch (error) {
      throw new ProfileError(`Cannot read profile ${next}`, { cause: error });
    }
    if (seen.has(resolved)) {
      throw new ProfileError(`Profile ${resolved} extends itself`);
    }
    seen.add(resolved);
    const parsed = parseProfileFile(text, resolved);
    chain.push({ file: resolved, parsed: parsed.own, drafts: parsed.drafts });
    next = parsed.extends === undefined ? undefined : path.resolve(path.dirname(resolved), parsed.extends);
  }
  const [own, ...base] = chain;
  if (own === undefined) {
    throw new ProfileError(`Cannot read profile ${file}`);
  }
  return [own, ...base];
}

/** The file that sets each setting and entry of a merge, by section. */
function sourcesOf(
  merged: SourcedProfile | SourcedDrafts,
): Record<SettingsSection | 'autolinks' | 'rulesets' | 'environments', Record<string, string>> {
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
  };
}

function resolveChain(chain: readonly Link[], source: string): ResolvedProfile {
  const merged = chain
    .toReversed()
    .reduce<SourcedProfile>((base, { file, parsed }) => mergeProfiles(base, parsed, file), { settings: {} });
  const mergedDrafts = chain
    .toReversed()
    .reduce<SourcedDrafts>((base, { file, drafts }) => mergeDrafts(base, drafts, file), { settings: {} });
  const drafts = toDrafts(mergedDrafts);
  return {
    chain: chain.map((link) => link.file),
    profile: validate(toProfile(merged), source),
    drafts,
    warnings: draftWarnings(drafts),
    sources: { ...sourcesOf(merged), drafts: sourcesOf(mergedDrafts) },
  };
}

/** Reads a profile file and every profile it extends, and says which file sets each value. */
export async function resolveProfile(file: string): Promise<ResolvedProfile> {
  return resolveChain(await readChain(file), path.resolve(file));
}

/**
 * Parses profile YAML that is not in a file, such as text an agent sends.
 * `extends` resolves from `directory`.
 */
export async function parseProfile(text: string, directory: string): Promise<ResolvedProfile> {
  const parsed = parseProfileFile(text, 'The profile');
  const base = parsed.extends === undefined ? [] : await readChain(path.resolve(directory, parsed.extends));
  return resolveChain([{ file: 'The profile', parsed: parsed.own, drafts: parsed.drafts }, ...base], 'The profile');
}

/** A profile file in a folder of profiles, for the desktop app's list. */
export interface ProfileListing {
  /** The file name without its extension. */
  readonly name: string;
  /** The file's real path, as \`resolveProfile\` reports it in its chain. */
  readonly file: string;
  /** The real path of the profile this one extends, or null when it extends none or cannot be read. */
  readonly extends: string | null;
  /** Why the profile cannot be used, or null when it resolves. */
  readonly problem: string | null;
}

/** Lists the YAML profiles directly in a folder, by name, and whether each resolves. */
export async function listProfiles(directory: string): Promise<ProfileListing[]> {
  const folder = path.resolve(directory);
  let names: string[];
  try {
    names = await readdir(folder);
  } catch (error) {
    throw new ProfileError(`Cannot read the profiles folder ${folder}`, { cause: error });
  }
  const listings: ProfileListing[] = [];
  for (const name of names.filter((entry) => /\.ya?ml$/iu.test(entry)).sort()) {
    let file = path.join(folder, name);
    let base: string | null = null;
    let problem: string | null = null;
    try {
      const chain = await readChain(file);
      file = chain[0].file;
      base = chain[1]?.file ?? null;
      resolveChain(chain, file);
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    }
    listings.push({ name: name.replace(/\.ya?ml$/iu, ''), file, extends: base, problem });
  }
  return listings;
}

/** One setting to change in a profile file: a value to set, or undefined to remove it. */
export interface SettingEdit {
  /** The section and key, such as `['repository', 'has_wiki']` or `['actions', 'selected_actions', 'verified_allowed']`. */
  readonly path: readonly string[];
  readonly value: unknown;
}

/**
 * One ruleset or environment to change in a profile file, by name: the entry
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
  readonly list: 'rulesets' | 'environments';
  readonly name: string;
  readonly draft?: boolean;
  readonly entry: Readonly<Record<string, unknown>> | undefined;
}

export type ProfileEdit = SettingEdit | EntryEdit;

/**
 * Whether a path names one setting: a section's key, or a key inside one of
 * its groups, as `actions.selected_actions.verified_allowed`.
 */
function isSettingsSection(name: string | undefined): name is SettingsSection {
  return settingsSections.some((section) => section === name);
}

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
  if (path[0] === 'drafts') {
    return isDraftPath(path.slice(1));
  }
  const [section, key, inner, ...rest] = path;
  if (!isSettingsSection(section) || key === undefined || rest.length > 0) {
    return false;
  }
  const schema = sectionSchemas[section];
  if (schema === undefined) {
    return inner === undefined;
  }
  const field: unknown = schema.shape[key];
  if (field === undefined) {
    return false;
  }
  const group = groupKeys[section].has(key) ? unwrapObject(field) : undefined;
  return inner === undefined ? group === undefined : group?.shape[inner] !== undefined;
}

const retriedCodes = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * Replaces a file through a temporary file beside it, so a failure never
 * leaves half a profile, and keeps the file's permissions. On Windows another
 * program reading the file can hold the move up briefly, so it is tried again.
 */
async function replaceFile(file: string, text: string): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, text);
    // Set after writing, since the mode a write asks for passes through the umask.
    await chmod(temporary, (await stat(file)).mode);
    for (let attempt = 1; ; attempt += 1) {
      try {
        await rename(temporary, file);
        return;
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? String(error.code) : '';
        if (attempt === 5 || !retriedCodes.has(code)) {
          throw error;
        }
        await new Promise((done) => setTimeout(done, attempt * 50));
      }
    }
  } catch (error) {
    await rm(temporary, { force: true });
    throw new ProfileError(`Cannot save profile ${file}`, { cause: error });
  }
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
  const key = edit.list === 'environments' ? environmentKey : (name: string) => name;
  const from = edit.draft === true;
  const to = edit.entry === undefined ? from : edit.entry['draft'] === true;
  const kind = edit.list === 'rulesets' ? 'ruleset' : 'environment';
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

/**
 * Changes settings in one profile file and keeps its comments, line endings
 * and indent width; YAML layout such as quoting and list indentation may be
 * normalized. The file changes only when the result, laid over the profiles
 * it extends, is a valid profile.
 */
export async function editProfile(file: string, edits: readonly ProfileEdit[]): Promise<ResolvedProfile> {
  const [own, ...base] = await readChain(file);
  const original = await readFile(own.file, 'utf8');
  const document = parseDocument(original);
  const seen = new Set<string>();
  for (const edit of edits) {
    if ('list' in edit) {
      editEntry(document, edit, seen);
      continue;
    }
    const key = edit.path.join('.');
    if (!isEditable(edit.path)) {
      throw new ProfileError(`Cannot edit ${key}: it is not one setting of a profile section, or a draft of one`);
    }
    if (seen.has(key)) {
      throw new ProfileError(`${key} is edited more than once`);
    }
    seen.add(key);
    if (edit.value !== undefined) {
      document.setIn(edit.path, edit.value);
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
  const edited = parseProfileFile(text, own.file);
  const resolved = resolveChain([{ file: own.file, parsed: edited.own, drafts: edited.drafts }, ...base], own.file);
  await replaceFile(own.file, original.includes('\r\n') ? text.replaceAll('\n', '\r\n') : text);
  return resolved;
}

export function stringifyProfile(value: Profile): string {
  return stringify(value, { lineWidth: 0 });
}
