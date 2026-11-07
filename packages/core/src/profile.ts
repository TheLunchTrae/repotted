import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { parse, stringify } from 'yaml';
import { z } from 'zod';

import { environmentKey, profile, type Profile, profileFile, type ProfileFile } from './schema.js';

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

function mergeByName<Entry extends { name: string }>(
  base: Entry[] | undefined,
  override: Entry[] | undefined,
  key: (name: string) => string = (name) => name,
): Entry[] | undefined {
  if (base === undefined || override === undefined) {
    return override ?? base;
  }
  const replacements = new Map(override.map((entry) => [key(entry.name), entry]));
  const merged = base.map((entry) => replacements.get(key(entry.name)) ?? entry);
  const baseNames = new Set(base.map((entry) => key(entry.name)));
  return [...merged, ...override.filter((entry) => !baseNames.has(key(entry.name)))];
}

/**
 * Lays `override` over `base`. Settings merge key by key; a ruleset or
 * environment in the override replaces the base entry of the same name whole.
 */
function mergeProfiles(base: Profile, override: ProfileFile): Profile {
  const merged: Profile = {};
  if (base.repository !== undefined || override.repository !== undefined) {
    merged.repository = { ...base.repository, ...override.repository };
  }
  if (base.merge !== undefined || override.merge !== undefined) {
    merged.merge = { ...base.merge, ...override.merge };
  }
  if (base.actions !== undefined || override.actions !== undefined) {
    merged.actions = { ...base.actions, ...override.actions };
    const selected = base.actions?.selected_actions;
    if (selected !== undefined && override.actions?.selected_actions !== undefined) {
      merged.actions.selected_actions = { ...selected, ...override.actions.selected_actions };
    }
  }
  const rulesets = mergeByName(base.rulesets, override.rulesets);
  if (rulesets !== undefined) {
    merged.rulesets = rulesets;
  }
  const environments = mergeByName(base.environments, override.environments, environmentKey);
  if (environments !== undefined) {
    merged.environments = environments;
  }
  return merged;
}

function validate(data: unknown, source: string): Profile {
  const result = profile.safeParse(data);
  if (!result.success) {
    throw new ProfileError(`${source} is not a valid profile:\n${describe(result.error)}`);
  }
  return result.data;
}

/** Reads a profile file and every profile it extends, base first. */
export async function loadProfile(file: string): Promise<Profile> {
  const chain: ProfileFile[] = [];
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
    chain.unshift(parsed);
    next = parsed.extends === undefined ? undefined : path.resolve(path.dirname(resolved), parsed.extends);
  }
  const merged = chain.reduce<Profile>((base, override) => mergeProfiles(base, override), {});
  return validate(merged, path.resolve(file));
}

/**
 * Parses profile YAML that is not in a file, such as text an agent sends.
 * `extends` resolves from `directory`.
 */
export async function parseProfile(text: string, directory: string): Promise<Profile> {
  const parsed = parseProfileFile(text, 'The profile');
  if (parsed.extends === undefined) {
    return validate(parsed, 'The profile');
  }
  const base = await loadProfile(path.resolve(directory, parsed.extends));
  return validate(mergeProfiles(base, parsed), 'The profile');
}

export function stringifyProfile(value: Profile): string {
  return stringify(value, { lineWidth: 0 });
}
