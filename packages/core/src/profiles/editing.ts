import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { parse } from 'yaml';
import { z } from 'zod';

import type { OwnerType } from './owner.js';
import {
  type Drafts,
  ProfileError,
  type ResolvedProfile,
  resolveProfile,
  settingPath,
  settingsSections,
} from './profile.js';
import { draftSettings, profile, profileFile } from './schema.js';

const lists = ['autolinks', 'rulesets', 'environments', 'labels'] as const;
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
  readonly entryPositions?: Partial<Record<EntryList, readonly (number | undefined)[]>>;
  readonly draftEntryPositions?: Partial<Record<EntryList, readonly (number | undefined)[]>>;
}

function isRecord(value: unknown): value is Entry {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function acceptsDiscriminator(schema: z.core.$ZodType, key: string, value: unknown): boolean {
  if (schema instanceof z.ZodDiscriminatedUnion) {
    return schema.options.some((option) => acceptsDiscriminator(option, key, value));
  }
  const field: unknown = schema instanceof z.ZodObject ? schema.shape[key] : undefined;
  return field instanceof z.ZodType && field.safeParse(value).success;
}

/** Keeps invalid values for correction, while applying the schema's unknown-key policy. */
function knownFields(schema: z.core.$ZodType, value: unknown): unknown {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return knownFields(schema.unwrap(), value);
  }
  if (schema instanceof z.ZodObject && isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, item]) => {
        const field: unknown = schema.shape[key];
        return field instanceof z.ZodType
          ? [[key, knownFields(field, item)]]
          : schema.def.catchall instanceof z.ZodUnknown
            ? [[key, item]]
            : [];
      }),
    );
  }
  if (schema instanceof z.ZodArray && Array.isArray(value)) {
    return value.map((item) => knownFields(schema.element, item));
  }
  if (schema instanceof z.ZodDiscriminatedUnion && isRecord(value)) {
    const key = schema.def.discriminator;
    const branch = schema.options.find((option) => acceptsDiscriminator(option, key, value[key]));
    return branch instanceof z.ZodType ? knownFields(branch, value) : value;
  }
  return value;
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

/** A readable YAML file always opens, even when a base or its configuration is broken. */
export async function readProfileForEditing(file: string, replacementText?: string): Promise<EditableProfile> {
  const original = replacementText ?? (await readFile(file, 'utf8'));
  let failure: unknown;
  try {
    return { ...(await resolveProfile(file, original)), rawText: original };
  } catch (error) {
    failure = error;
    // The tolerant read below preserves known values and reports configuration errors by path.
  }
  const sources = emptySources();
  const chain: string[] = [];
  const problems: ConfigurationProblem[] = [];
  const layers: { readonly file: string; readonly data: Entry }[] = [];
  let next: string | undefined = file;
  while (next !== undefined) {
    let resolved: string;
    let text: string;
    try {
      resolved = await realpath(next);
      text = layers.length === 0 ? original : await readFile(resolved, 'utf8');
    } catch (error) {
      if (layers.length === 0) {
        throw error;
      }
      problems.push({ file: chain[0] ?? file, path: ['extends'], message: `Cannot read base profile ${next}` });
      break;
    }
    if (chain.includes(resolved)) {
      problems.push({ file: chain[0] ?? file, path: ['extends'], message: `Profile ${resolved} extends itself` });
      break;
    }
    let parsed: unknown;
    try {
      parsed = parse(text) ?? {};
    } catch (error) {
      if (layers.length === 0) {
        throw new ProfileError(`${resolved} is not valid YAML`, { cause: error });
      }
      problems.push({
        file: resolved,
        path: [],
        message: 'The base profile is not valid YAML. Open it to correct its syntax.',
      });
      break;
    }
    const known = knownFields(profileFile, parsed);
    const data = isRecord(known) ? known : {};
    chain.push(resolved);
    layers.push({ file: resolved, data });
    problems.push(...issues(profileFile, known, resolved));
    const parent = data['extends'];
    next = typeof parent === 'string' && parent !== '' ? path.resolve(path.dirname(resolved), parent) : undefined;
  }
  const merged: Record<string, unknown> = {};
  const drafts: Drafts = {};
  const positions: EditableProfile['entryPositions'] = {};
  const draftPositions: EditableProfile['draftEntryPositions'] = {};
  let owner: { readonly type: OwnerType; readonly file: string } | undefined;
  for (const layer of layers.toReversed()) {
    mergeSettings(merged, sources, layer.data, layer.file);
    const type = layer.data['owner_type'];
    if (type === 'user' || type === 'organization') {
      if (owner !== undefined && owner.type !== type) {
        problems.push({
          file: layer.file,
          path: ['owner_type'],
          message: 'The owner type must match the base profile.',
        });
      }
      owner = { type, file: layer.file };
    }
    const rawDrafts = layer.data['drafts'];
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
      const settings: Record<string, unknown> = { ...drafts };
      mergeSettings(settings, sources.drafts, parsedDrafts.data, layer.file);
      Object.assign(drafts, settings);
      if (parsedDrafts.data.unset !== undefined) {
        drafts.unset = parsedDrafts.data.unset;
        for (const key of drafts.unset) {
          sources.drafts.unset[key] = layer.file;
        }
      }
    }
    for (const list of lists) {
      const raw = layer.data[list];
      const own = Array.isArray(raw) ? raw : [];
      const applying = own.flatMap((entry, index) =>
        isRecord(entry) && entry['draft'] !== true ? [{ entry, index }] : [],
      );
      const before = merged[list];
      const base = Array.isArray(before) ? before.filter(isRecord) : [];
      const overrides = new Set(applying.map(({ entry }) => nameOf(list, entry)));
      const kept = base.filter((entry) => !overrides.has(nameOf(list, entry)));
      if (raw !== undefined || base.length > 0) {
        merged[list] = [...kept, ...applying.map(({ entry }) => entry)];
        positions[list] = [
          ...kept.map(() => undefined),
          ...applying.map(({ index }) => (layer.file === chain[0] ? index : undefined)),
        ];
      }
      for (const { entry } of applying) {
        sources[list][nameOf(list, entry)] = layer.file;
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
        const keptDrafts = (drafts[list] ?? []).filter(
          (entry) => !ownDrafts.some((ownEntry) => nameOf(list, ownEntry.entry) === nameOf(list, entry)),
        );
        drafts[list] = [...keptDrafts, ...ownDrafts.map(({ entry }) => entry)];
        draftPositions[list] = [
          ...keptDrafts.map(() => undefined),
          ...ownDrafts.map(({ index }) => (layer.file === chain[0] ? index : undefined)),
        ];
        for (const { entry } of ownDrafts) {
          sources.drafts[list][nameOf(list, entry)] = layer.file;
        }
      }
    }
  }
  if (owner !== undefined) {
    merged['owner_type'] = owner.type;
  }
  const finalProblems = issues(profile, merged, chain[0] ?? file).map((problem) => {
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
      ...(failure.problems.length === 0
        ? [{ file: chain[0] ?? file, path: [], message: failure.message }]
        : failure.problems),
    );
  }
  return {
    chain,
    profile: { ...merged, ...(owner === undefined ? {} : { owner_type: owner.type }) },
    drafts,
    sources,
    warnings: [],
    owner_source: owner?.file ?? null,
    owner_changes: { user: [], organization: [] },
    problems: unique,
    rawText: original,
    entryPositions: positions,
    draftEntryPositions: draftPositions,
  };
}
