import { computed, signal } from '@preact/signals';
import { resolveProfile, stringifyProfile } from '@repotted/core';
import * as z from 'zod/mini';

import { basename, join, relative } from '../../engine/path.js';
import type { Change } from '../preferences/shared-preferences.js';
import type { ProfileListing } from '../profiles/profiles.js';

/**
 * By repository, in lower case, the profiles it uses in the order they apply,
 * each by its path in the profiles folder, and the version of each last applied.
 */
export const repositoryProfilesKey = 'repository-profiles';
/** By profile path, the tags people chose; every other profile has one made from its name. */
export const profileTagsKey = 'profile-tags';
export const longestTag = 12;

export interface AppliedVersion {
  readonly profile: string;
  readonly version: string;
}

export interface Assignment {
  readonly profiles: readonly string[];
  /** In the order they were applied. Undefined until one of them is. */
  readonly applied?: readonly AppliedVersion[] | undefined;
}

export type AssignmentStatus =
  | { readonly kind: 'none' }
  /** Until each profile's version is read. */
  | { readonly kind: 'checking' }
  /** Deleted or renamed outside Repotted, or not readable as a profile. */
  | { readonly kind: 'missing'; readonly missing: readonly string[]; readonly unreadable: readonly string[] }
  | { readonly kind: 'not-applied' }
  | {
      readonly kind: 'changed';
      readonly changed: readonly string[];
      readonly notApplied: readonly string[];
      readonly reordered: boolean;
    }
  | { readonly kind: 'current' };

export interface PreferenceStore {
  read(key: string): unknown;
  update(key: string, change: Change): void;
}

export interface ProfilesInFolder {
  readonly listings: { readonly value: readonly ProfileListing[] };
  readonly folder: { readonly value: string };
}

const savedAssignments = z.record(
  z.string(),
  z.object({
    profiles: z.array(z.string()),
    applied: z.optional(z.array(z.object({ profile: z.string(), version: z.string() }))),
  }),
);
const savedTags = z.record(z.string(), z.string());

function keyOf(repository: string): string {
  return repository.toLowerCase();
}

function assignmentsIn(value: unknown): Readonly<Record<string, Assignment>> {
  const parsed = savedAssignments.safeParse(value);
  return parsed.success ? parsed.data : {};
}

function tagOverridesIn(value: unknown): Readonly<Record<string, string>> {
  const parsed = savedTags.safeParse(value);
  return parsed.success ? parsed.data : {};
}

/** Its name without the folder or `.yaml`. */
export function profileName(profilePath: string): string {
  return basename(profilePath).replace(/\.ya?ml$/iu, '');
}

function tagCandidates(profilePath: string): string[] {
  const name = profileName(profilePath);
  const words = name.split(/[-_.\s]+/u).filter((word) => word !== '');
  const candidates = words.map((_, index) => words.slice(0, index + 1).join('-'));
  return [...new Set([...candidates, name].map((candidate) => candidate.slice(0, longestTag)))];
}

/**
 * A tag people chose comes first; the rest take the first word of the name,
 * or more of it when that is taken, and a number as a last resort, so every
 * profile's tag is its own.
 */
export function tagsFor(
  profilePaths: readonly string[],
  overrides: Readonly<Record<string, string>>,
): ReadonlyMap<string, string> {
  const tags = new Map<string, string>();
  const taken = new Set<string>();
  const sorted = [...new Set(profilePaths)].toSorted();
  for (const profilePath of sorted) {
    const chosen = overrides[profilePath]?.trim().slice(0, longestTag);
    if (chosen !== undefined && chosen !== '' && !taken.has(chosen.toLowerCase())) {
      tags.set(profilePath, chosen);
      taken.add(chosen.toLowerCase());
    }
  }
  for (const profilePath of sorted) {
    if (tags.has(profilePath)) {
      continue;
    }
    const candidates = tagCandidates(profilePath);
    let tag = candidates.find((candidate) => !taken.has(candidate.toLowerCase()));
    const stem = (candidates[0] ?? 'profile').slice(0, longestTag - 2);
    for (let number = 2; tag === undefined; number += 1) {
      const numbered = `${stem}${number}`;
      tag = taken.has(numbered.toLowerCase()) ? undefined : numbered;
    }
    tags.set(profilePath, tag);
    taken.add(tag.toLowerCase());
  }
  return tags;
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** What the profile sets, with what it extends, so an edit to a draft changes nothing. */
export async function profileVersion(file: string): Promise<string> {
  return sha256(stringifyProfile((await resolveProfile(file)).profile));
}

function isSameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

/**
 * Which profiles each repository uses, kept in the shared preferences so they
 * follow the profiles to their config repository. Saving a list applies
 * nothing: an apply records the version of each profile it applied, which is
 * how a repository whose profiles changed since is told apart.
 */
export class RepositoryProfiles {
  readonly #preferences: PreferenceStore;
  readonly #profiles: ProfilesInFolder;
  /** By profile path, the version of what it sets now, once read. */
  readonly #versions = signal<ReadonlyMap<string, string>>(new Map());
  #checkTurn = 0;

  constructor(preferences: PreferenceStore, profiles: ProfilesInFolder) {
    this.#preferences = preferences;
    this.#profiles = profiles;
  }

  readonly #assignments = computed(() => assignmentsIn(this.#preferences.read(repositoryProfilesKey)));
  readonly #tagOverrides = computed(() => tagOverridesIn(this.#preferences.read(profileTagsKey)));

  /** By path in the profiles folder, the profiles that can be read. */
  readonly #listed = computed<ReadonlyMap<string, ProfileListing>>(
    () =>
      new Map(
        this.#profiles.listings.value.map((listing) => [relative(this.#profiles.folder.value, listing.file), listing]),
      ),
  );

  readonly tags = computed(() =>
    tagsFor(
      [...this.#listed.value.keys(), ...Object.values(this.#assignments.value).flatMap((item) => item.profiles)],
      this.#tagOverrides.value,
    ),
  );

  /** The repositories, in lower case, that use any profile. */
  readonly repositoriesWithProfiles = computed(() =>
    Object.entries(this.#assignments.value).flatMap(([repository, item]) =>
      item.profiles.length > 0 ? [repository] : [],
    ),
  );

  assignment(repository: string): Assignment | undefined {
    return this.#assignments.value[keyOf(repository)];
  }

  /** In the order they apply. */
  profilesOf(repository: string): readonly string[] {
    return this.assignment(repository)?.profiles ?? [];
  }

  tagOf(profilePath: string): string {
    return this.tags.value.get(profilePath) ?? profileName(profilePath).slice(0, longestTag);
  }

  /** Undefined for a file outside the profiles folder, such as one built into Repotted. */
  pathOf(file: string): string | undefined {
    const folder = this.#profiles.folder.value;
    const path = relative(folder, file);
    return path.startsWith('..') || path.startsWith('/') ? undefined : path;
  }

  fileOf(profilePath: string): string {
    return join(this.#profiles.folder.value, profilePath);
  }

  isListed(profilePath: string): boolean {
    return this.#listed.value.get(profilePath)?.problem === null;
  }

  /** Reads the version of every profile a repository uses, so each repository's status can be told. */
  async check(): Promise<void> {
    const turn = (this.#checkTurn += 1);
    const used = new Set(Object.values(this.#assignments.peek()).flatMap((item) => item.profiles));
    const versions = new Map<string, string>();
    for (const profilePath of used) {
      if (!this.isListed(profilePath)) {
        continue;
      }
      try {
        versions.set(profilePath, await profileVersion(this.fileOf(profilePath)));
      } catch {
        // A profile that stops resolving between the list and the read shows as unreadable.
      }
    }
    if (turn === this.#checkTurn) {
      this.#versions.value = versions;
    }
  }

  status(repository: string): AssignmentStatus {
    const assignment = this.assignment(repository);
    if (assignment === undefined || assignment.profiles.length === 0) {
      return { kind: 'none' };
    }
    const missing = assignment.profiles.filter((profilePath) => !this.#listed.value.has(profilePath));
    const unreadable = assignment.profiles.filter(
      (profilePath) => this.#listed.value.has(profilePath) && !this.isListed(profilePath),
    );
    if (missing.length > 0 || unreadable.length > 0) {
      return { kind: 'missing', missing, unreadable };
    }
    const versions = this.#versions.value;
    if (assignment.profiles.some((profilePath) => !versions.has(profilePath))) {
      return { kind: 'checking' };
    }
    const applied = assignment.applied ?? [];
    if (applied.length === 0) {
      return { kind: 'not-applied' };
    }
    const appliedVersion = new Map(applied.map((item) => [item.profile, item.version]));
    const notApplied = assignment.profiles.filter((profilePath) => !appliedVersion.has(profilePath));
    const changed = assignment.profiles.filter(
      (profilePath) => appliedVersion.has(profilePath) && appliedVersion.get(profilePath) !== versions.get(profilePath),
    );
    const reordered = !isSameList(
      applied.map((item) => item.profile).filter((profilePath) => assignment.profiles.includes(profilePath)),
      assignment.profiles.filter((profilePath) => appliedVersion.has(profilePath)),
    );
    return changed.length === 0 && notApplied.length === 0 && !reordered
      ? { kind: 'current' }
      : { kind: 'changed', changed, notApplied, reordered };
  }

  /** Saving the same list again changes nothing; an empty one forgets the repository. */
  setProfiles(repository: string, profiles: readonly string[]): void {
    const unique = [...new Set(profiles)];
    this.#change(repository, (current) =>
      unique.length === 0 ? undefined : { ...current, profiles: unique, applied: current?.applied },
    );
  }

  /** The profiles applied are the repository's own, in its order. */
  recordApplied(repository: string, applied: readonly AppliedVersion[]): void {
    this.#change(repository, (current) =>
      current === undefined ? undefined : { profiles: current.profiles, applied: [...applied] },
    );
  }

  /** One profile applied by itself, and added to the end of the repository's list. */
  recordAdded(repository: string, added: AppliedVersion): void {
    this.#change(repository, (current) => ({
      profiles: [...(current?.profiles ?? []).filter((profilePath) => profilePath !== added.profile), added.profile],
      applied: [...(current?.applied ?? []).filter((item) => item.profile !== added.profile), added],
    }));
  }

  #change(repository: string, change: (current: Assignment | undefined) => Assignment | undefined): void {
    const key = keyOf(repository);
    this.#preferences.update(repositoryProfilesKey, (saved) => {
      const all = assignmentsIn(saved);
      const next = change(all[key]);
      const kept = Object.fromEntries(Object.entries(all).filter(([other]) => other !== key));
      if (next !== undefined) {
        kept[key] = next.applied === undefined ? { profiles: next.profiles } : next;
      }
      return Object.keys(kept).length > 0 ? kept : undefined;
    });
  }
}
