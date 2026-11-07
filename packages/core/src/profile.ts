import { chmod, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { isMap, parse, parseDocument, stringify } from 'yaml';
import { z } from 'zod';

import {
  actionsSettings,
  environmentKey,
  type EnvironmentEntry,
  mergeFields,
  profile,
  type Profile,
  profileFile,
  type ProfileFile,
  repositoryFields,
  type RulesetEntry,
  selectedActions,
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

function parseProfileFile(text: string, source: string): ProfileFile {
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
  return result.data;
}

/** A value of a merged profile, with the file that sets it. */
interface Sourced<Entry> {
  readonly entry: Entry;
  readonly file: string;
}

function mergeByName<Entry extends { name: string }>(
  base: Sourced<Entry>[] | undefined,
  override: Sourced<Entry>[] | undefined,
  key: (name: string) => string = (name) => name,
): Sourced<Entry>[] | undefined {
  if (base === undefined || override === undefined) {
    return override ?? base;
  }
  const replacements = new Map(override.map((item) => [key(item.entry.name), item]));
  const merged = base.map((item) => replacements.get(key(item.entry.name)) ?? item);
  const baseNames = new Set(base.map((item) => key(item.entry.name)));
  return [...merged, ...override.filter((item) => !baseNames.has(key(item.entry.name)))];
}

type Settings = Record<string, unknown>;

/** A profile mid-merge: each setting and entry carries the file that sets it. */
interface SourcedProfile {
  repository?: Map<string, Sourced<unknown>> | undefined;
  merge?: Map<string, Sourced<unknown>> | undefined;
  actions?: Map<string, Sourced<unknown>> | undefined;
  selected_actions?: Map<string, Sourced<unknown>> | undefined;
  rulesets?: Sourced<RulesetEntry>[] | undefined;
  environments?: Sourced<EnvironmentEntry>[] | undefined;
}

function mergeSettings(
  base: Map<string, Sourced<unknown>> | undefined,
  override: Settings | undefined,
  file: string,
): Map<string, Sourced<unknown>> | undefined {
  if (override === undefined) {
    return base;
  }
  const merged = new Map(base);
  for (const [key, entry] of Object.entries(override)) {
    merged.set(key, { entry, file });
  }
  return merged;
}

function sourced<Entry>(entries: Entry[] | undefined, file: string): Sourced<Entry>[] | undefined {
  return entries?.map((entry) => ({ entry, file }));
}

/**
 * Lays `override` over `base`. Settings merge key by key, and so does
 * `selected_actions`; a ruleset or environment in the override replaces the
 * base entry of the same name whole.
 */
function mergeProfiles(base: SourcedProfile, override: ProfileFile, file: string): SourcedProfile {
  const { selected_actions: selected, ...actions } = override.actions ?? {};
  return {
    repository: mergeSettings(base.repository, override.repository, file),
    merge: mergeSettings(base.merge, override.merge, file),
    actions: mergeSettings(base.actions, override.actions === undefined ? undefined : actions, file),
    selected_actions: mergeSettings(base.selected_actions, selected, file),
    rulesets: mergeByName(base.rulesets, sourced(override.rulesets, file)),
    environments: mergeByName(base.environments, sourced(override.environments, file), environmentKey),
  };
}

function values(settings: Map<string, Sourced<unknown>> | undefined): Settings | undefined {
  return settings === undefined ? undefined : Object.fromEntries([...settings].map(([key, item]) => [key, item.entry]));
}

function files(settings: Map<string, Sourced<unknown>> | undefined): Record<string, string> {
  return Object.fromEntries([...(settings ?? [])].map(([key, item]) => [key, item.file]));
}

function entries<Entry>(list: Sourced<Entry>[] | undefined): Entry[] | undefined {
  return list?.map((item) => item.entry);
}

function entryFiles(list: Sourced<{ name: string }>[] | undefined): Record<string, string> {
  return Object.fromEntries((list ?? []).map((item) => [item.entry.name, item.file]));
}

function toProfile(merged: SourcedProfile): unknown {
  const actions = values(merged.actions);
  const selected = values(merged.selected_actions);
  const data: Record<string, unknown> = {
    repository: values(merged.repository),
    merge: values(merged.merge),
    actions:
      actions === undefined && selected === undefined
        ? undefined
        : { ...actions, ...(selected === undefined ? {} : { selected_actions: selected }) },
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

/**
 * The file that sets each value of a resolved profile. Settings go by key,
 * `selected_actions` settings by `selected_actions.<key>` under `actions`,
 * and rulesets and environments by name.
 */
export interface ProfileSources {
  readonly repository: Record<string, string>;
  readonly merge: Record<string, string>;
  readonly actions: Record<string, string>;
  readonly rulesets: Record<string, string>;
  readonly environments: Record<string, string>;
}

/** A profile file laid over every profile it extends. */
export interface ResolvedProfile {
  /** The profile file, then each one it extends, as real paths. */
  readonly chain: readonly string[];
  readonly profile: Profile;
  readonly sources: ProfileSources;
}

interface Link {
  /** The file's real path, so the same file always has the same name. */
  readonly file: string;
  readonly parsed: ProfileFile;
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
    chain.push({ file: resolved, parsed });
    next = parsed.extends === undefined ? undefined : path.resolve(path.dirname(resolved), parsed.extends);
  }
  const [own, ...base] = chain;
  if (own === undefined) {
    throw new ProfileError(`Cannot read profile ${file}`);
  }
  return [own, ...base];
}

function resolveChain(chain: readonly Link[], source: string): ResolvedProfile {
  const merged = chain
    .toReversed()
    .reduce<SourcedProfile>((base, { file, parsed }) => mergeProfiles(base, parsed, file), {});
  return {
    chain: chain.map((link) => link.file),
    profile: validate(toProfile(merged), source),
    sources: {
      repository: files(merged.repository),
      merge: files(merged.merge),
      actions: {
        ...files(merged.actions),
        ...Object.fromEntries(
          Object.entries(files(merged.selected_actions)).map(([key, from]) => [`selected_actions.${key}`, from]),
        ),
      },
      rulesets: entryFiles(merged.rulesets),
      environments: entryFiles(merged.environments),
    },
  };
}

/** Reads a profile file and every profile it extends, and says which file sets each value. */
export async function resolveProfile(file: string): Promise<ResolvedProfile> {
  return resolveChain(await readChain(file), path.resolve(file));
}

/** Reads a profile file and every profile it extends, base first. */
export async function loadProfile(file: string): Promise<Profile> {
  return (await resolveProfile(file)).profile;
}

/**
 * Parses profile YAML that is not in a file, such as text an agent sends.
 * `extends` resolves from `directory`.
 */
export async function parseProfile(text: string, directory: string): Promise<Profile> {
  const parsed = parseProfileFile(text, 'The profile');
  const base = parsed.extends === undefined ? [] : await readChain(path.resolve(directory, parsed.extends));
  return resolveChain([{ file: 'The profile', parsed }, ...base], 'The profile').profile;
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
export interface ProfileEdit {
  /** The section and key, such as `['repository', 'has_wiki']` or `['actions', 'selected_actions', 'verified_allowed']`. */
  readonly path: readonly string[];
  readonly value: unknown;
}

const editableKeys = new Set([
  ...Object.keys(repositoryFields).map((key) => `repository.${key}`),
  ...Object.keys(mergeFields).map((key) => `merge.${key}`),
  ...Object.keys(actionsSettings.shape)
    .filter((key) => key !== 'selected_actions')
    .map((key) => `actions.${key}`),
  ...Object.keys(selectedActions.shape).map((key) => `actions.selected_actions.${key}`),
]);

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
 * Changes settings in one profile file and keeps its comments, line endings
 * and indent width; YAML layout such as quoting and list indentation may be
 * normalized. The file changes only when the result, laid over the profiles it extends, is a valid
 * profile.
 */
export async function editProfile(file: string, edits: readonly ProfileEdit[]): Promise<ResolvedProfile> {
  const [own, ...base] = await readChain(file);
  const original = await readFile(own.file, 'utf8');
  const document = parseDocument(original);
  const seen = new Set<string>();
  for (const edit of edits) {
    const key = edit.path.join('.');
    if (!editableKeys.has(key)) {
      throw new ProfileError(`Cannot edit ${key}: it is not a repository, merge or actions setting`);
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
  const resolved = resolveChain([{ file: own.file, parsed: parseProfileFile(text, own.file) }, ...base], own.file);
  await replaceFile(own.file, original.includes('\r\n') ? text.replaceAll('\n', '\r\n') : text);
  return resolved;
}

export function stringifyProfile(value: Profile): string {
  return stringify(value, { lineWidth: 0 });
}
