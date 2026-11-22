import { readFile, realpath } from 'node:fs/promises';

import { parse } from 'yaml';
import { z } from 'zod';

import type { OwnerType } from './owner.js';
import { profileFields } from './profile-fields.js';
import {
  type Drafts,
  ProfileError,
  type ResolvedProfile,
  resolveProfile,
  settingPath,
  settingsSections,
} from './profile.js';
import { draftSettings, profile, profileFile, profileReferences } from './schema.js';

const lists = ['autolinks', 'actions_policies', 'rulesets', 'environments', 'labels'] as const;
type EntryList = (typeof lists)[number];
type Entry = Readonly<Record<string, unknown>>;

export interface ConfigurationProblem {
  readonly file: string;
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

/** Invalid configuration is data in the editor, never a profile that can be planned. */
export interface EditableProfile extends Omit<ResolvedProfile, 'profile'> {
  readonly profile: Readonly<Record<string, unknown>> & { readonly owner_type?: OwnerType | undefined };
  readonly problems?: readonly ConfigurationProblem[];
  readonly rawText?: string;
  readonly unknownFields?: readonly string[];
  readonly entryPositions?: Partial<Record<EntryList, readonly (number | undefined)[]>>;
  readonly draftEntryPositions?: Partial<Record<EntryList, readonly (number | undefined)[]>>;
}

function isRecord(value: unknown): value is Entry {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function issues(schema: z.ZodType, value: unknown, file: string): ConfigurationProblem[] {
  return (schema.safeParse(value).error?.issues ?? []).map((issue) => ({
    file,
    path: issue.path,
    message: issue.message,
  }));
}

type EditingSources = { -readonly [Key in keyof ResolvedProfile['sources']]: ResolvedProfile['sources'][Key] };

function emptySources(): EditingSources {
  const sections = () => ({
    repository: {},
    merge: {},
    actions: {},
    security: {},
    custom_properties: {},
    pages: {},
    autolinks: {},
    actions_policies: {},
    rulesets: {},
    environments: {},
    labels: {},
  });
  return { ...sections(), drafts: { ...sections(), unset: {} } };
}

function nameOf(list: EntryList, entry: Entry): string {
  const value = entry[list === 'autolinks' ? 'key_prefix' : 'name'];
  const name = typeof value === 'string' ? value : '';
  return list === 'labels' || list === 'environments' ? name.toLowerCase() : name;
}

function mergeSettings(
  target: Record<string, unknown>,
  sources: Pick<EditingSources, (typeof settingsSections)[number]>,
  data: Entry,
  file: string,
): void {
  for (const section of settingsSections) {
    const own = data[section];
    if (!isRecord(own)) {
      continue;
    }
    const previous = target[section];
    const merged: Record<string, unknown> = isRecord(previous) ? { ...previous } : {};
    if (section === 'pages' && own['absent'] === true) {
      target[section] = { absent: true };
      sources.pages = { absent: file };
      continue;
    }
    delete merged['absent'];
    delete sources[section]['absent'];
    for (const [key, value] of Object.entries(own)) {
      if (settingPath([section, key]) === 'group' && isRecord(value)) {
        const base = merged[key];
        merged[key] = { ...(isRecord(base) ? base : {}), ...value };
        for (const inner of Object.keys(value)) {
          sources[section][`${key}.${inner}`] = file;
        }
      } else {
        merged[key] = value;
        sources[section][key] = file;
      }
    }
    target[section] = merged;
  }
}

/** A readable YAML file always opens, even when its configuration or a definition it references is broken. */
export async function readProfileForEditing(file: string, replacementText?: string): Promise<EditableProfile> {
  const original = replacementText ?? (await readFile(file, 'utf8'));
  let failure: unknown;
  let unknownFields: readonly string[] = [];
  try {
    const fields = profileFields(parse(original) ?? {});
    unknownFields = fields.unknown.map((path) => z.core.toDotPath([...path]));
    return { ...(await resolveProfile(file, original)), rawText: original, unknownFields };
  } catch (error) {
    failure = error;
    // The tolerant read below preserves known values and reports configuration errors by path.
  }
  const sources = emptySources();
  const problems: ConfigurationProblem[] = [];
  const resolved = await realpath(file);
  let parsed: unknown;
  try {
    parsed = parse(original) ?? {};
  } catch (error) {
    throw new ProfileError(`${resolved} is not valid YAML`, { cause: error });
  }
  const known = profileFields(parsed).known;
  const data = isRecord(known) ? known : {};
  problems.push(...issues(profileFile, known, resolved));
  const merged: Record<string, unknown> = {};
  const drafts: Drafts = {};
  const positions: EditableProfile['entryPositions'] = {};
  const draftPositions: EditableProfile['draftEntryPositions'] = {};
  mergeSettings(merged, sources, data, resolved);
  const type = data['owner_type'];
  const owner: { readonly type: OwnerType; readonly file: string } | undefined =
    type === 'user' || type === 'organization' ? { type, file: resolved } : undefined;
  const rawDrafts = data['drafts'];
  const validDrafts = !isRecord(rawDrafts)
    ? {}
    : Object.fromEntries(
        Object.entries(rawDrafts).filter(([key, value]) => {
          const field: unknown = Reflect.get(draftSettings.shape, key);
          return field instanceof z.ZodType && field.safeParse(value).success;
        }),
      );
  const parsedDrafts = draftSettings.safeParse(validDrafts);
  if (parsedDrafts.success) {
    const settings: Record<string, unknown> = {};
    mergeSettings(settings, sources.drafts, parsedDrafts.data, resolved);
    Object.assign(drafts, settings);
    if (parsedDrafts.data.unset !== undefined) {
      drafts.unset = parsedDrafts.data.unset;
      for (const key of drafts.unset) {
        sources.drafts.unset[key] = resolved;
      }
    }
  }
  for (const list of lists) {
    const raw = data[list];
    const own = Array.isArray(raw) ? raw : [];
    const applying = own.flatMap((entry, index) =>
      isRecord(entry) && entry['draft'] !== true ? [{ entry, index }] : [],
    );
    if (raw !== undefined) {
      merged[list] = applying.map(({ entry }) => entry);
      positions[list] = applying.map(({ index }) => index);
    }
    for (const { entry } of applying) {
      sources[list][nameOf(list, entry)] = resolved;
    }
    // Draft entries already accept unfinished values; only their identity is required here.
    const ownDrafts = own.flatMap((entry, index) =>
      isRecord(entry) && entry['draft'] === true
        ? [
            {
              entry: { ...entry, name: typeof entry['name'] === 'string' ? entry['name'] : '', draft: true as const },
              index,
            },
          ]
        : [],
    );
    if (list !== 'autolinks' && ownDrafts.length > 0) {
      drafts[list] = ownDrafts.map(({ entry }) => entry);
      draftPositions[list] = ownDrafts.map(({ index }) => index);
      for (const { entry } of ownDrafts) {
        sources.drafts[list][nameOf(list, entry)] = resolved;
      }
    }
  }
  if (owner !== undefined) {
    merged['owner_type'] = owner.type;
  }
  const finalProblems = issues(profile, merged, resolved).map((problem) => {
    const [section, key, inner] = problem.path;
    const settings = settingsSections.find((known) => known === section);
    const source =
      settings === undefined || typeof key !== 'string'
        ? undefined
        : sources[settings][typeof inner === 'string' ? `${key}.${inner}` : key];
    return source === undefined ? problem : { ...problem, file: source };
  });
  const unique = [...problems, ...finalProblems].filter(
    (problem, index, all) =>
      all.findIndex(
        (other) =>
          other.file === problem.file &&
          other.path.join('.') === problem.path.join('.') &&
          other.message === problem.message,
      ) === index,
  );
  if (unique.length === 0 && failure instanceof ProfileError) {
    unique.push(
      ...(failure.problems.length === 0 ? [{ file: resolved, path: [], message: failure.message }] : failure.problems),
    );
  }
  const declaredReferences = data['references'];
  const references: Record<string, unknown> = {};
  const referencePath = z.string().min(1);
  if (isRecord(declaredReferences)) {
    for (const section of ['actions_policies', 'rulesets', 'environments'] as const) {
      const paths = declaredReferences[section];
      if (Array.isArray(paths)) {
        references[section] = paths.filter((named) => referencePath.safeParse(named).success);
      }
    }
  }
  return {
    chain: [resolved],
    profile: { ...merged, ...(owner === undefined ? {} : { owner_type: owner.type }) },
    drafts,
    sources,
    ...(Object.keys(references).length === 0 ? {} : { references: profileReferences.parse(references) }),
    warnings: [],
    owner_source: owner?.file ?? null,
    owner_changes: { user: [], organization: [] },
    problems: unique,
    rawText: original,
    unknownFields,
    entryPositions: positions,
    draftEntryPositions: draftPositions,
  };
}
