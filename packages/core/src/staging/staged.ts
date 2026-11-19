import { readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parse, stringify } from 'yaml';
import { z } from 'zod';

import { type GitHub, parseRepo, repoPattern } from '../github/client.js';
import { authoritativeSchema, type AuthoritativeSection } from '../plan/ownership.js';
import { createPlan, type Plan, skippedDrafts } from '../plan/plan.js';
import {
  type Adjust,
  type Drafts,
  editLayer,
  editProfile,
  flattenSettings,
  type Layer,
  previewLayer,
  type ProfileEdit,
  ProfileError,
  type ProfileSources,
  type ResolvedLayer,
  resolveLayer,
  resolveProfile,
  resolveProfilesTogether,
  settingPath,
  settingsSections,
} from '../profiles/profile.js';
import { environmentKey, labelKey, type Profile, profileFile, type ProfileFile } from '../profiles/schema.js';
import { isDeepEqual } from '../shared/equal.js';

const entryKeyByExcludableList = {
  autolinks: (entry: Record<string, unknown>) => String(entry['key_prefix']),
  actions_policies: (entry: Record<string, unknown>) => String(entry['name']),
  rulesets: (entry: Record<string, unknown>) => String(entry['name']),
  environments: (entry: Record<string, unknown>) => environmentKey(String(entry['name'])),
  labels: (entry: Record<string, unknown>) => labelKey(String(entry['name'])),
} as const;

type List = keyof typeof entryKeyByExcludableList;

function isList(name: string): name is List {
  return Object.hasOwn(entryKeyByExcludableList, name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * An exclusion key names a whole section, as `pages`; a setting or a group of
 * settings, as `repository.has_wiki` or `actions.selected_actions`; or one
 * entry of a list, as `rulesets/Main`.
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
  if (
    Object.hasOwn(profileFile.shape, key) &&
    !['extends', 'drafts', 'owner_type', 'kind', 'references'].includes(key)
  ) {
    return { kind: 'section', section: key };
  }
  const parts = key.split('.');
  return settingPath(parts) === undefined ? undefined : { kind: 'setting', path: parts };
}

/** Two spellings of one environment's or label's name are one exclusion. */
function exclusionKey(key: string): string {
  const exclusion = parseExclusion(key);
  if (exclusion?.kind !== 'entry') {
    return key;
  }
  return `${exclusion.list}/${entryKeyByExcludableList[exclusion.list]({ name: exclusion.name, key_prefix: exclusion.name })}`;
}

function getIn(value: unknown, keys: readonly string[]): unknown {
  return keys.reduce<unknown>((current, key) => (isRecord(current) ? current[key] : undefined), value);
}

function sets(layer: Readonly<Record<string, unknown>>, exclusion: Exclusion): boolean {
  if (exclusion.kind === 'section') {
    return getIn(layer, [exclusion.section]) !== undefined;
  }
  if (exclusion.kind === 'setting') {
    return getIn(layer, exclusion.path) !== undefined;
  }
  const key = entryKeyByExcludableList[exclusion.list];
  const wanted = key({ name: exclusion.name, key_prefix: exclusion.name });
  const entries: unknown = layer[exclusion.list];
  return Array.isArray(entries) && entries.some((entry) => isRecord(entry) && key(entry) === wanted);
}

const stagedFields = {
  authoritative: authoritativeSchema.optional(),
  apply_to: z.string().regex(repoPattern, 'Use owner/name'),
  exclude: z.array(z.string().min(1)).optional(),
  /** One profile, or several applied in order, later ones overriding earlier ones. */
  extends: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
};

const stagedFile = profileFile
  .extend(stagedFields)
  .strict()
  .superRefine((value, context) => {
    // Everything a staged apply sets is applied; drafts belong in a profile.
    if (value.drafts !== undefined) {
      context.addIssue({ code: 'custom', message: 'A staged apply cannot hold drafts', path: ['drafts'] });
    }
    for (const list of ['autolinks', 'actions_policies', 'rulesets', 'environments', 'labels'] as const) {
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
      if (seen.has(exclusionKey(key))) {
        context.addIssue({ code: 'custom', message: `${key} is excluded more than once`, path: ['exclude', index] });
      }
      seen.add(exclusionKey(key));
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

function withoutKeyPruningEmptyRecords(value: unknown, keys: readonly string[]): unknown {
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
      const kept = withoutKeyPruningEmptyRecords(inner, rest);
      return isRecord(kept) && Object.keys(kept).length === 0 ? [] : [[key, kept]];
    }),
  );
}

function namesEntry(exclusion: Exclusion, list: string, entry: Record<string, unknown>): boolean {
  if (exclusion.kind !== 'entry' || exclusion.list !== list) {
    return false;
  }
  const key = entryKeyByExcludableList[exclusion.list];
  return key(entry) === key({ name: exclusion.name, key_prefix: exclusion.name });
}

function withoutExclusion(data: unknown, exclusion: Exclusion): unknown {
  if (exclusion.kind === 'section') {
    return withoutKeyPruningEmptyRecords(data, [exclusion.section]);
  }
  if (exclusion.kind === 'setting') {
    return withoutKeyPruningEmptyRecords(data, exclusion.path);
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

function excluding(exclude: readonly string[], aliases: string[]): Adjust {
  return (data) => {
    aliases.length = 0;
    const labels = isRecord(data) && Array.isArray(data['labels']) ? data['labels'] : [];
    for (const entry of labels) {
      if (!isRecord(entry) || typeof entry['name'] !== 'string') {
        continue;
      }
      const previous = Array.isArray(entry['renamed_from'])
        ? entry['renamed_from'].filter((name): name is string => typeof name === 'string')
        : [];
      const names = [entry['name'], ...previous];
      if (names.some((name) => exclude.some((key) => exclusionKey(key) === `labels/${labelKey(name)}`))) {
        aliases.push(...names.map((name) => `labels/${name}`));
      }
    }
    const unmatched: string[] = [];
    const left = [...new Set([...exclude, ...aliases])].reduce<unknown>((current, key) => {
      const exclusion = parseExclusion(key);
      const next = exclusion === undefined ? current : withoutExclusion(current, exclusion);
      if (isDeepEqual(next, current)) {
        unmatched.push(key);
      }
      return next;
    }, data);
    return { data: left, unmatched: unmatched.filter((key) => exclude.includes(key)) };
  };
}

interface StagedRead {
  readonly own: StagedFile;
  readonly aliases: readonly string[];
  readonly layer: ProfileFile;
  readonly adjust: Adjust;
  readonly listedProfiles: readonly string[];
}

const stagedLayer: Layer<StagedRead> = {
  noun: 'staged apply',
  schema: stagedFile.transform((own): StagedRead => {
    const { apply_to: _repository, authoritative: _ownership, exclude = [], extends: listed, ...layer } = own;
    const aliases: string[] = [];
    return {
      own,
      aliases,
      layer,
      adjust: excluding(exclude, aliases),
      listedProfiles: listed === undefined ? [] : typeof listed === 'string' ? [listed] : listed,
    };
  }),
  ownTopLevelKeys: new Set(['exclude', 'authoritative']),
  check: () => undefined,
};

function unmatchedWarning(key: string): string {
  return `Excluding ${key} leaves nothing out, since the profile sets nothing it names`;
}

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
    actions_policies: keep('actions_policies'),
    rulesets: keep('rulesets'),
    environments: keep('environments'),
    labels: keep('labels'),
  };
}

export interface StagedApply {
  readonly authoritative: readonly AuthoritativeSection[];
  readonly file: string;
  readonly repository: string;
  /**
   * The profiles it starts from, as real paths, in the order they apply; later
   * ones override earlier ones. Empty when it starts from the repository as it is.
   */
  readonly profiles: readonly string[];
  readonly exclude: readonly string[];
  readonly chain: readonly string[];
  readonly profile: Profile;
  /** The drafts of the profile it starts from. The staged apply itself holds none. */
  readonly drafts: Drafts;
  /** What stops each of those drafts from applying as it stands. */
  readonly warnings: readonly string[];
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

function staged({
  head: { own },
  resolved,
  unmatched,
  listedProfiles,
  overrideWarnings,
}: ResolvedLayer<StagedRead>): StagedApply {
  const exclude = own.exclude ?? [];
  const exclusions = exclude.flatMap((key) => parseExclusion(key) ?? []);
  const { drafts, ...settled } = resolved.sources;
  return {
    file: resolved.chain[0] ?? '',
    repository: own.apply_to,
    authoritative: own.authoritative ?? [],
    profiles: listedProfiles,
    exclude,
    chain: resolved.chain,
    profile: resolved.profile,
    drafts: resolved.drafts,
    warnings: [
      ...resolved.warnings,
      ...overrideWarnings.map((warning) => warning.message),
      ...unmatched.map(unmatchedWarning),
    ],
    sources: { ...sourcesWithoutExclusions(settled, exclusions), drafts },
  };
}

/** A profile that changes after an exclusion was added may set nothing it names, which is a warning. */
export async function resolveStagedApply(file: string): Promise<StagedApply> {
  return staged(await resolveLayer(file, stagedLayer));
}

/**
 * `profiles` apply in order, later ones overriding earlier ones; none starts
 * from the repository as it is. The file must not exist yet, so a staged apply
 * in progress is never lost, and nothing is written when the profiles don't
 * resolve, alone or together.
 */
export async function createStagedApply(
  file: string,
  repository: string,
  profiles: readonly string[],
  authoritative: readonly AuthoritativeSection[] = [],
): Promise<StagedApply> {
  authoritativeSchema.parse(authoritative);
  const repo = parseRepo(repository);
  const lines = [
    '# A staged apply: one-off edits for one apply to one repository.',
    profiles.length > 1
      ? '# The profiles it extends apply in order and stay as they are.'
      : '# The profile it extends stays as it is unless these edits are saved to it.',
  ];
  const data: Record<string, unknown> = {
    apply_to: `${repo.owner}/${repo.name}`,
    ...(authoritative.length === 0 ? {} : { authoritative }),
  };
  if (profiles.length > 1) {
    await resolveProfilesTogether(profiles);
  }
  if (profiles.length > 0) {
    const folder = await realpath(path.dirname(path.resolve(file))).catch(() => path.dirname(path.resolve(file)));
    const relativePaths: string[] = [];
    for (const profile of profiles) {
      // Resolving first means a staged apply never starts from a broken profile.
      const base = (await resolveProfile(profile)).chain[0] ?? path.resolve(profile);
      const relative = path.relative(folder, base);
      relativePaths.push(path.isAbsolute(relative) ? base : relative.split(path.sep).join('/'));
    }
    data['extends'] = relativePaths.length === 1 ? relativePaths[0] : relativePaths;
  }
  try {
    await writeFile(file, `${lines.join('\n')}\n${stringify(data, { lineWidth: 0 })}`, { flag: 'wx' });
  } catch (error) {
    throw new ProfileError(`Cannot start a staged apply in ${file}`, { cause: error });
  }
  try {
    return await resolveStagedApply(file);
  } catch (error) {
    await rm(file, { force: true });
    throw error;
  }
}

function isSameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

export type StagedEdit =
  | ProfileEdit
  | { readonly exclude: string; readonly excluded: boolean }
  | { readonly authoritative: readonly AuthoritativeSection[] };

/** The file changes only when the result is a valid staged apply. */
export async function editStagedApply(file: string, edits: readonly StagedEdit[]): Promise<StagedApply> {
  const fileEdits = ({ own }: StagedRead): ProfileEdit[] => {
    const exclude = [...(own.exclude ?? [])];
    const profileEdits: ProfileEdit[] = [];
    for (const edit of edits) {
      if ('authoritative' in edit) {
        profileEdits.push({ path: ['authoritative'], value: authoritativeSchema.parse(edit.authoritative) });
        continue;
      }
      if (!('exclude' in edit)) {
        profileEdits.push(edit);
        continue;
      }
      if (parseExclusion(edit.exclude) === undefined) {
        throw new ProfileError(
          `Cannot exclude ${edit.exclude}: it names no section, setting, or list entry, as in repository.has_wiki or rulesets/Main`,
        );
      }
      const index = exclude.findIndex((key) => exclusionKey(key) === exclusionKey(edit.exclude));
      if (edit.excluded && index === -1) {
        exclude.push(edit.exclude);
      } else if (!edit.excluded && index !== -1) {
        exclude.splice(index, 1);
      }
    }
    if (!isSameList(exclude, own.exclude ?? [])) {
      profileEdits.push({ path: ['exclude'], value: exclude.length === 0 ? undefined : exclude });
    }
    return profileEdits;
  };
  const added = new Set(
    edits.flatMap((edit) => ('exclude' in edit && edit.excluded ? [exclusionKey(edit.exclude)] : [])),
  );
  return staged(
    await editLayer(file, fileEdits, {
      ...stagedLayer,
      check: ({ unmatched, head }) => {
        // A new exclusion that leaves nothing out is most likely a mistyped name.
        const missed = unmatched.find(
          (key) =>
            added.has(exclusionKey(key)) &&
            head.own.authoritative?.some(
              (section) => key === section || key.startsWith(`${section}/`) || key.startsWith(`${section}.`),
            ) !== true,
        );
        if (missed !== undefined) {
          throw new ProfileError(`Cannot exclude ${missed}: the profile it starts from sets nothing it names`);
        }
      },
    }),
  );
}

const copiedEditKeys = [
  'owner_type',
  ...settingsSections,
  'autolinks',
  'actions_policies',
  'rulesets',
  'environments',
  'labels',
] as const;

/**
 * `to` takes the one-off edits of `from` in place of its own. What it applies
 * to, starts from, leaves out, and owns stays. The file changes only when the
 * result is a valid staged apply.
 */
export async function copyStagedEdits(from: string, to: string): Promise<StagedApply> {
  const { layer } = (await resolveLayer(from, stagedLayer)).head;
  const uncopied = Object.keys(layer).filter(
    (key) => key !== 'extends' && !(copiedEditKeys as readonly string[]).includes(key),
  );
  if (uncopied.length > 0) {
    throw new ProfileError(`Cannot copy the edits of ${from}: it sets ${uncopied.join(', ')}`);
  }
  const edits = copiedEditKeys.map((key): ProfileEdit => ({ path: [key], value: layer[key] }));
  return staged(await editLayer(to, edits, stagedLayer));
}

/** Nothing is written, so an editor can show what its unsaved edits give before it saves them. */
export async function previewStagedApply(
  file: string,
  edits: readonly ProfileEdit[],
): Promise<{ before: StagedApply; after: StagedApply }> {
  const { before, after } = await previewLayer(file, () => edits, stagedLayer);
  return { before: staged(before), after: staged(after) };
}

function layerEdits(layer: ProfileFile, clear: boolean): ProfileEdit[] {
  const edits: ProfileEdit[] = [];
  for (const section of settingsSections) {
    const settings: unknown = layer[section];
    if (!isRecord(settings)) {
      continue;
    }
    for (const [setting, value] of flattenSettings(section, settings)) {
      edits.push({ path: [section, ...setting], value: clear ? undefined : value });
    }
  }
  if (layer.autolinks !== undefined) {
    throw new ProfileError('Cannot save autolinks to a profile from a staged apply; copy them into the profile file');
  }
  for (const list of ['actions_policies', 'rulesets', 'environments', 'labels'] as const) {
    for (const entry of layer[list] ?? []) {
      edits.push({ list, name: entry.name, entry: clear ? undefined : entry });
    }
  }
  return edits;
}

/**
 * Exclusions stay in the staged apply: they say what this apply leaves out,
 * which a profile cannot say. When the second write fails, the profile already
 * holds the edits and the staged apply still sets the same values, so it
 * resolves the same either way. The second write is refused, as a failed one,
 * when another program changed the staged apply's edits after the first read,
 * since clearing them would lose a change no profile holds.
 */
export async function saveStagedEdits(file: string): Promise<StagedApply> {
  const read = await resolveLayer(file, stagedLayer);
  const before = staged(read);
  const [base, ...more] = before.profiles;
  if (base === undefined) {
    throw new ProfileError(`${file} starts from the repository as it is, so it has no profile to save edits to`);
  }
  if (more.length > 0) {
    throw new ProfileError(
      `${file} starts from ${before.profiles.length} profiles, so it has no one profile to save edits to; copy them into the profile they belong in`,
    );
  }
  const layer = read.head.layer;
  const edits = layerEdits(layer, false);
  if (edits.length === 0) {
    return before;
  }
  // `absent` replaces a whole Pages site when files merge, but an edit sets one key of the profile.
  const pages = (await resolveProfile(base)).profile.pages;
  if (layer.pages !== undefined && pages !== undefined && (layer.pages.absent === true) !== (pages.absent === true)) {
    throw new ProfileError(
      'Cannot save a change between a Pages site and no Pages site to a profile; change pages in the profile file',
    );
  }
  await editProfile(base, edits);
  const cleared = await editLayer(
    file,
    (head) => {
      if (!isDeepEqual(head.layer, read.head.layer)) {
        throw new ProfileError(
          `${file} changed after its edits were read, so they are saved to ${base} but not cleared from ${file}`,
        );
      }
      return layerEdits(layer, true);
    },
    stagedLayer,
  );
  return staged(cleared);
}

export interface PlanExclusion {
  /** The change's index in the plan's changes. */
  readonly change: number;
  /** Null for the whole change, as for a ruleset. */
  readonly field: string | null;
  readonly key: string;
  /**
   * Whether the staged apply's own edits set what the key names. Such a value
   * is left out by undoing the edit, since a staged apply refuses to exclude
   * what it edits.
   */
  readonly edited: boolean;
}

export interface StagedPlan {
  readonly staged: StagedApply;
  readonly plan: Plan;
  readonly exclusions: readonly PlanExclusion[];
}

/**
 * A field in a group gives the whole group, which GitHub writes at once and
 * may tie together, as it ties the OIDC subject's claim keys to its default.
 */
function settingKey(section: string, field: string): string | undefined {
  const [key] = field.split('.');
  return key !== undefined && settingPath([section, key]) !== undefined ? `${section}.${key}` : undefined;
}

function planExclusions(plan: Plan, own: StagedFile): PlanExclusion[] {
  const exclusion = (change: number, field: string | null, key: string | undefined): PlanExclusion[] => {
    const parsed = key === undefined ? undefined : parseExclusion(key);
    return key === undefined || parsed === undefined ? [] : [{ change, field, key, edited: sets(own, parsed) }];
  };
  return plan.changes.flatMap((change, index) => {
    // A branch policy leaves out with its environment.
    if (change.entry !== undefined) {
      return exclusion(index, null, `${change.section}/${change.entry.name}`);
    }
    if (change.section === 'pages') {
      return exclusion(index, null, 'pages');
    }
    return change.fields.flatMap((field) => exclusion(index, field.field, settingKey(change.section, field.field)));
  });
}

/**
 * `accept` sees the staged apply as the plan's one read of its file finds it,
 * before GitHub is read, and throws to refuse it.
 */
export async function planStagedApply(
  github: GitHub,
  file: string,
  accept: (staged: StagedApply) => void = () => undefined,
): Promise<StagedPlan> {
  const read = await resolveLayer(file, stagedLayer);
  const resolved = staged(read);
  accept(resolved);
  const created = await createPlan(
    github,
    parseRepo(resolved.repository),
    resolved.profile,
    skippedDrafts(resolved.drafts),
    {
      ...(resolved.authoritative.length === 0 ? {} : { authoritative: resolved.authoritative }),
      ...([...resolved.exclude, ...read.head.aliases].length === 0
        ? {}
        : { exclude: [...new Set([...resolved.exclude, ...read.head.aliases])] }),
    },
  );
  // Live reads can overlap a source edit. Do not return a plan whose inputs
  // have already changed, including rename aliases protected by exclusions.
  const latest = await resolveLayer(file, stagedLayer);
  const current = staged(latest);
  const inputs = (value: StagedApply, aliases: readonly string[]): unknown => [
    value.repository,
    value.profiles,
    value.profile,
    value.authoritative,
    value.exclude,
    aliases,
  ];
  if (!isDeepEqual(inputs(resolved, read.head.aliases), inputs(current, latest.head.aliases))) {
    throw new ProfileError('The staged apply or its sources changed while GitHub was being read. Review a fresh plan.');
  }
  const plan = {
    ...created,
    source: { staged: resolved.file },
    warnings: [
      ...created.warnings,
      ...read.overrideWarnings,
      ...read.unmatched.map((exclusion) => ({ exclusion, message: unmatchedWarning(exclusion) })),
    ],
  };
  return { staged: resolved, plan, exclusions: planExclusions(plan, read.head.own) };
}

/** False for a key excluded already, since the profile then no longer sets what it names. */
export function stagedSets(staged: StagedApply, key: string): boolean {
  const exclusion = parseExclusion(key);
  return exclusion !== undefined && sets(staged.profile, exclusion);
}

export function stagedExcludes(staged: StagedApply, key: string): boolean {
  return staged.exclude.some((excluded) => exclusionKey(excluded) === exclusionKey(key));
}

export async function discardStagedApply(file: string): Promise<void> {
  await readStagedFile(file);
  await rm(file);
}

export async function stagedRepository(file: string): Promise<string> {
  return (await readStagedFile(file)).apply_to;
}

export function isExclusionKey(key: string): boolean {
  return parseExclusion(key) !== undefined;
}
