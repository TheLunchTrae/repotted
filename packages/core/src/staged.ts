import { readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parse, stringify } from 'yaml';
import { z } from 'zod';

import { type GitHub, parseRepo, repoPattern } from './github.js';
import { createPlan, type Plan, skippedDrafts } from './plan.js';
import {
  type Drafts,
  editLayer,
  editProfile,
  type Layer,
  type ProfileEdit,
  ProfileError,
  type ProfileSources,
  type ResolvedProfile,
  resolveProfile,
  settingPath,
  settingsSections,
} from './profile.js';
import { environmentKey, profile, type Profile, profileFile, type ProfileFile } from './schema.js';

// A staged apply is a profile layer of its own: a file that names the
// repository it applies to, extends the profile it starts from, if any, and
// sets one-off edits over it. It resolves and plans with the same engine as
// any profile, so its plan is reviewed and applied like any other, and the
// profile it extends never changes unless its edits are saved to it.

/** The lists an exclusion can name an entry of, and the key each entry is known by. */
const lists = {
  autolinks: (entry: Record<string, unknown>) => String(entry['key_prefix']),
  rulesets: (entry: Record<string, unknown>) => String(entry['name']),
  environments: (entry: Record<string, unknown>) => environmentKey(String(entry['name'])),
} as const;

type List = keyof typeof lists;

function isList(name: string): name is List {
  return Object.hasOwn(lists, name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One thing a staged apply leaves out of the profile it starts from: a whole
 * section, as `pages`; a setting or a group of settings, as
 * `repository.has_wiki` or `actions.selected_actions`; or one entry of a
 * list, by its list and name, as `rulesets/Main`.
 */
type Exclusion =
  | { readonly kind: 'section'; readonly section: string }
  | { readonly kind: 'setting'; readonly path: readonly string[] }
  | { readonly kind: 'entry'; readonly list: List; readonly name: string };

function parseExclusion(key: string): Exclusion | undefined {
  const slash = key.indexOf('/');
  if (slash !== -1) {
    const list = key.slice(0, slash);
    const name = key.slice(slash + 1);
    return isList(list) && name !== '' ? { kind: 'entry', list, name } : undefined;
  }
  if (Object.hasOwn(profileFile.shape, key) && key !== 'extends' && key !== 'drafts') {
    return { kind: 'section', section: key };
  }
  const parts = key.split('.');
  return settingPath(parts) === undefined ? undefined : { kind: 'setting', path: parts };
}

function getIn(value: unknown, keys: readonly string[]): unknown {
  return keys.reduce<unknown>((current, key) => (isRecord(current) ? current[key] : undefined), value);
}

/** Whether a profile layer sets what `exclusion` names. */
function sets(layer: ProfileFile, exclusion: Exclusion): boolean {
  if (exclusion.kind === 'section') {
    return getIn(layer, [exclusion.section]) !== undefined;
  }
  if (exclusion.kind === 'setting') {
    return getIn(layer, exclusion.path) !== undefined;
  }
  const key = lists[exclusion.list];
  const wanted = key({ name: exclusion.name, key_prefix: exclusion.name });
  const entries: unknown = layer[exclusion.list];
  return Array.isArray(entries) && entries.some((entry) => isRecord(entry) && key(entry) === wanted);
}

const stagedFields = {
  /** The repository the staged apply applies to. */
  apply_to: z.string().regex(repoPattern, 'Use owner/name'),
  exclude: z.array(z.string().min(1)).optional(),
};

/** A staged apply file, checked whole: its own keys, its edits, and exclusions that clash with neither. */
const stagedFile = profileFile
  .extend(stagedFields)
  .strict()
  .superRefine((value, context) => {
    // Everything a staged apply sets is applied; drafts belong in a profile.
    if (value.drafts !== undefined) {
      context.addIssue({ code: 'custom', message: 'A staged apply cannot hold drafts', path: ['drafts'] });
    }
    for (const list of ['autolinks', 'rulesets', 'environments'] as const) {
      for (const [index, entry] of (value[list] ?? []).entries()) {
        if ('draft' in entry) {
          context.addIssue({ code: 'custom', message: 'A staged apply cannot hold drafts', path: [list, index] });
        }
      }
    }
    const seen = new Set<string>();
    for (const [index, key] of (value.exclude ?? []).entries()) {
      const exclusion = parseExclusion(key);
      if (exclusion === undefined) {
        context.addIssue({
          code: 'custom',
          message: `${key} names no section, setting, or list entry, as in repository.has_wiki or rulesets/Main`,
          path: ['exclude', index],
        });
        continue;
      }
      if (seen.has(key)) {
        context.addIssue({ code: 'custom', message: `${key} is excluded more than once`, path: ['exclude', index] });
      }
      seen.add(key);
      if (sets(value, exclusion)) {
        context.addIssue({
          code: 'custom',
          message: `${key} is both excluded and edited; keep one`,
          path: ['exclude', index],
        });
      }
    }
  });

type StagedFile = z.infer<typeof stagedFile>;

/** The staged file's profile layer, which the profile engine reads as the first file of a chain. */
const stagedLayer = stagedFile.transform(
  ({ apply_to: _repository, exclude: _exclude, ...layer }): ProfileFile => layer,
);

/** `value` without the key at `keys`; a record left empty by it goes too. */
function without(value: unknown, keys: readonly string[]): unknown {
  const [first, ...rest] = keys;
  if (!isRecord(value) || first === undefined) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, inner]): [string, unknown][] => {
      if (key !== first) {
        return [[key, inner]];
      }
      if (rest.length === 0) {
        return [];
      }
      const kept = without(inner, rest);
      return isRecord(kept) && Object.keys(kept).length === 0 ? [] : [[key, kept]];
    }),
  );
}

/** Whether `exclusion` names the entry `entry` of `list`. */
function namesEntry(exclusion: Exclusion, list: string, entry: Record<string, unknown>): boolean {
  if (exclusion.kind !== 'entry' || exclusion.list !== list) {
    return false;
  }
  const key = lists[exclusion.list];
  return key(entry) === key({ name: exclusion.name, key_prefix: exclusion.name });
}

function withoutExclusion(data: unknown, exclusion: Exclusion): unknown {
  if (exclusion.kind === 'section') {
    return without(data, [exclusion.section]);
  }
  if (exclusion.kind === 'setting') {
    return without(data, exclusion.path);
  }
  if (!isRecord(data)) {
    return data;
  }
  const entries = data[exclusion.list];
  return Array.isArray(entries)
    ? {
        ...data,
        [exclusion.list]: entries.filter(
          (entry: unknown) => !isRecord(entry) || !namesEntry(exclusion, exclusion.list, entry),
        ),
      }
    : data;
}

/** A profile without what `exclusions` name. */
function withoutExclusions(value: Profile, exclusions: readonly Exclusion[]): Profile {
  const result = profile.safeParse(exclusions.reduce<unknown>(withoutExclusion, value));
  if (!result.success) {
    throw new ProfileError(`The staged apply's exclusions leave an invalid profile:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/** Whether `exclusion` names the value that `sources` lists under `section` as `name`. */
function namesSource(exclusion: Exclusion, section: string, name: string): boolean {
  if (exclusion.kind === 'section') {
    return exclusion.section === section;
  }
  if (exclusion.kind === 'entry') {
    return namesEntry(exclusion, section, { name, key_prefix: name });
  }
  const [owner, ...rest] = exclusion.path;
  const named = rest.join('.');
  return owner === section && (name === named || name.startsWith(`${named}.`));
}

type Sources = Omit<ProfileSources, 'drafts'>;

/** The sources of what the exclusions leave, so an excluded value names no file. */
function sourcesWithoutExclusions(sources: Sources, exclusions: readonly Exclusion[]): Sources {
  const keep = (section: keyof Sources): Record<string, string> =>
    Object.fromEntries(
      Object.entries(sources[section]).filter(
        ([name]) => !exclusions.some((exclusion) => namesSource(exclusion, section, name)),
      ),
    );
  return {
    repository: keep('repository'),
    merge: keep('merge'),
    actions: keep('actions'),
    security: keep('security'),
    custom_properties: keep('custom_properties'),
    pages: keep('pages'),
    autolinks: keep('autolinks'),
    rulesets: keep('rulesets'),
    environments: keep('environments'),
  };
}

/** A staged apply as it resolves: what it applies to, and the profile its plan brings the repository to. */
export interface StagedApply {
  /** The staged apply file's real path, first in `chain`. */
  readonly file: string;
  readonly repository: string;
  /** The real path of the profile it starts from, or null when it starts from the repository as it is. */
  readonly base: string | null;
  /** What it leaves out of the profile it starts from, as the file lists it. */
  readonly exclude: readonly string[];
  /** The staged file, then each profile it extends, as real paths. */
  readonly chain: readonly string[];
  /** The profile laid under its edits, without its exclusions: what the plan brings the repository to. */
  readonly profile: Profile;
  /**
   * The drafts of the profile it starts from, which its plan leaves out as
   * any plan does. The staged apply itself holds none.
   */
  readonly drafts: Drafts;
  /** What stops each of those drafts from applying as it stands. */
  readonly warnings: readonly string[];
  /** The file that sets each value of `profile` and each draft, as `resolveProfile` reports it. */
  readonly sources: ProfileSources;
}

async function readStagedFile(file: string): Promise<StagedFile> {
  let data: unknown;
  try {
    data = parse(await readFile(file, 'utf8')) ?? {};
  } catch (error) {
    throw new ProfileError(`Cannot read staged apply ${file}`, { cause: error });
  }
  const result = stagedFile.safeParse(data);
  if (!result.success) {
    throw new ProfileError(`${file} is not a valid staged apply:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

function staged(own: StagedFile, resolved: ResolvedProfile): StagedApply {
  const exclude = own.exclude ?? [];
  const exclusions = exclude.flatMap((key) => parseExclusion(key) ?? []);
  const { drafts, ...settled } = resolved.sources;
  return {
    file: resolved.chain[0] ?? '',
    repository: own.apply_to,
    base: resolved.chain[1] ?? null,
    exclude,
    chain: resolved.chain,
    profile: withoutExclusions(resolved.profile, exclusions),
    drafts: resolved.drafts,
    warnings: resolved.warnings,
    sources: { ...sourcesWithoutExclusions(settled, exclusions), drafts },
  };
}

/** Reads a staged apply over the profile it starts from. */
export async function resolveStagedApply(file: string): Promise<StagedApply> {
  const own = await readStagedFile(file);
  return staged(own, await resolveProfile(file, stagedLayer));
}

/**
 * Starts a staged apply in a new file: one apply to `repository`, from the
 * profile `from` names, or from the repository as it is when it names none.
 * The file must not exist yet, so a staged apply in progress is never lost.
 */
export async function createStagedApply(
  file: string,
  repository: string,
  from: string | undefined,
): Promise<StagedApply> {
  const repo = parseRepo(repository);
  const lines = [
    '# A staged apply: one-off edits for one apply to one repository.',
    '# The profile it extends stays as it is unless these edits are saved to it.',
  ];
  const data: Record<string, unknown> = { apply_to: `${repo.owner}/${repo.name}` };
  if (from !== undefined) {
    // Resolving first means a staged apply never starts from a broken profile.
    const base = (await resolveProfile(from)).chain[0] ?? path.resolve(from);
    const folder = await realpath(path.dirname(path.resolve(file))).catch(() => path.dirname(path.resolve(file)));
    const relative = path.relative(folder, base);
    data['extends'] = path.isAbsolute(relative) ? base : relative.split(path.sep).join('/');
  }
  try {
    await writeFile(file, `${lines.join('\n')}\n${stringify(data, { lineWidth: 0 })}`, { flag: 'wx' });
  } catch (error) {
    throw new ProfileError(`Cannot start a staged apply in ${file}`, { cause: error });
  }
  return resolveStagedApply(file);
}

function isSameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

/** A change to a staged apply: a one-off edit, as a profile edit, or a value to exclude or stop excluding. */
export type StagedEdit = ProfileEdit | { readonly exclude: string; readonly excluded: boolean };

/**
 * Changes a staged apply's one-off edits and exclusions, as `editProfile` changes
 * a profile. The file changes only when the result is a valid staged apply.
 */
export async function editStagedApply(file: string, edits: readonly StagedEdit[]): Promise<StagedApply> {
  const own = await readStagedFile(file);
  const exclude = [...(own.exclude ?? [])];
  const profileEdits: ProfileEdit[] = [];
  for (const edit of edits) {
    if (!('exclude' in edit)) {
      profileEdits.push(edit);
      continue;
    }
    if (parseExclusion(edit.exclude) === undefined) {
      throw new ProfileError(
        `Cannot exclude ${edit.exclude}: it names no section, setting, or list entry, as in repository.has_wiki or rulesets/Main`,
      );
    }
    const index = exclude.indexOf(edit.exclude);
    if (edit.excluded && index === -1) {
      exclude.push(edit.exclude);
    } else if (!edit.excluded && index !== -1) {
      exclude.splice(index, 1);
    }
  }
  if (!isSameList(exclude, own.exclude ?? [])) {
    profileEdits.push({ path: ['exclude'], value: exclude.length === 0 ? undefined : exclude });
  }
  let result: StagedApply | undefined;
  const layer: Layer = {
    schema: stagedLayer,
    paths: new Set(['exclude']),
    check: (resolved, text) => {
      result = staged(stagedFile.parse(parse(text) ?? {}), resolved);
    },
  };
  await editLayer(file, profileEdits, layer);
  if (result === undefined) {
    throw new ProfileError(`Cannot edit staged apply ${file}`);
  }
  return result;
}

/** The edits that write a profile layer's own settings and entries into another file, or clear them. */
function layerEdits(layer: ProfileFile, clear: boolean): ProfileEdit[] {
  const edits: ProfileEdit[] = [];
  for (const section of settingsSections) {
    const settings: unknown = layer[section];
    if (!isRecord(settings)) {
      continue;
    }
    for (const [key, value] of Object.entries(settings)) {
      if (settingPath([section, key]) === 'group' && isRecord(value)) {
        for (const [inner, setting] of Object.entries(value)) {
          edits.push({ path: [section, key, inner], value: clear ? undefined : setting });
        }
      } else {
        edits.push({ path: [section, key], value: clear ? undefined : value });
      }
    }
  }
  if (layer.autolinks !== undefined) {
    throw new ProfileError('Cannot save autolinks to a profile from a staged apply; copy them into the profile file');
  }
  for (const list of ['rulesets', 'environments'] as const) {
    for (const entry of layer[list] ?? []) {
      edits.push({ list, name: entry.name, entry: clear ? undefined : entry });
    }
  }
  return edits;
}

/**
 * Saves a staged apply's one-off edits to the profile it starts from, then
 * clears them from the staged apply, which resolves the same afterwards.
 * Exclusions stay in the staged apply: they say what this apply leaves out, which
 * a profile cannot say. When the second write fails, the profile already
 * holds the edits and the staged apply still sets the same values, so it
 * resolves the same either way.
 */
export async function saveStagedEdits(file: string): Promise<StagedApply> {
  const before = await resolveStagedApply(file);
  if (before.base === null) {
    throw new ProfileError(`${file} starts from the repository as it is, so it has no profile to save edits to`);
  }
  const { apply_to: _repository, exclude: _exclude, extends: _base, ...layer } = await readStagedFile(file);
  const edits = layerEdits(layer, false);
  if (edits.length === 0) {
    return before;
  }
  await editProfile(before.base, edits);
  return editStagedApply(file, layerEdits(layer, true));
}

/**
 * What leaves one change of a staged apply's plan out, or one field of it:
 * the key to exclude, as `stage --exclude` takes it.
 */
export interface PlanExclusion {
  /** The change's index in the plan's changes. */
  readonly change: number;
  /** The field it leaves out, or null for the whole change, as for a ruleset. */
  readonly field: string | null;
  readonly key: string;
  /**
   * Whether the staged apply's own edits set what the key names. Such a
   * value is left out by undoing the edit, since a staged apply refuses to
   * exclude what it edits.
   */
  readonly edited: boolean;
}

/** A staged apply's plan, with what leaves each of its changes out. */
export interface StagedPlan {
  readonly staged: StagedApply;
  readonly plan: Plan;
  readonly exclusions: readonly PlanExclusion[];
}

/**
 * The setting, or the group of settings, that a settings change's field
 * falls under, if a profile names it. A field in a group gives the whole
 * group, which GitHub writes at once and may tie together, as it ties the
 * OIDC subject's claim keys to its default.
 */
function settingKey(section: string, field: string): string | undefined {
  const [key] = field.split('.');
  return key !== undefined && settingPath([section, key]) !== undefined ? `${section}.${key}` : undefined;
}

/** The exclusion that leaves out a change to a list entry: the entry its target names. */
function entryKey(change: Plan['changes'][number], desired: Profile): string | undefined {
  if (change.section === 'rulesets' || change.section === 'autolinks') {
    return `${change.section}/${change.target}`;
  }
  if (change.section !== 'environments') {
    return undefined;
  }
  // A branch policy's target is its environment's name, then ": " and the policy.
  const target = environmentKey(change.target);
  const entry = (desired.environments ?? []).find((environment) => {
    const name = environmentKey(environment.name);
    return target === name || target.startsWith(`${name}: `);
  });
  return entry === undefined ? undefined : `environments/${entry.name}`;
}

/** What leaves each change of `plan`, or each field of a settings change, out of the staged apply `own`. */
function planExclusions(plan: Plan, own: StagedFile): PlanExclusion[] {
  const exclusion = (change: number, field: string | null, key: string | undefined): PlanExclusion[] => {
    const parsed = key === undefined ? undefined : parseExclusion(key);
    return key === undefined || parsed === undefined ? [] : [{ change, field, key, edited: sets(own, parsed) }];
  };
  return plan.changes.flatMap((change, index) => {
    if (change.section === 'rulesets' || change.section === 'environments' || change.section === 'autolinks') {
      return exclusion(index, null, entryKey(change, plan.desired));
    }
    if (change.section === 'pages') {
      return exclusion(index, null, 'pages');
    }
    return change.fields.flatMap((field) => exclusion(index, field.field, settingKey(change.section, field.field)));
  });
}

/** Plans a staged apply: the changes that bring its repository to its profile, and what leaves each out. */
export async function planStagedApply(github: GitHub, file: string): Promise<StagedPlan> {
  const own = await readStagedFile(file);
  const resolved = staged(own, await resolveProfile(file, stagedLayer));
  const plan = await createPlan(
    github,
    parseRepo(resolved.repository),
    resolved.profile,
    skippedDrafts(resolved.drafts),
  );
  return { staged: resolved, plan, exclusions: planExclusions(plan, own) };
}

/** Ends a staged apply by removing its file; the profile it starts from stays as it is. */
export async function discardStagedApply(file: string): Promise<void> {
  await readStagedFile(file);
  await rm(file);
}
