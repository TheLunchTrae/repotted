import { computed, signal } from '@preact/signals';
import { type AuthoritativeSection, resolveProfile, stringifyProfile } from '@repotted/core';
import * as z from 'zod/mini';

import { basename, join, relative } from '../../engine/path.js';
import { foldersIn, repositoryFoldersKey, sameName } from '../preferences/preference-changes.js';
import type { Change } from '../preferences/shared-preferences.js';
import type { ProfileListing } from '../profiles/profiles.js';
import type { ProfileAssignments } from './assignment-review.js';
import {
  type AppliedVersion,
  type Assignment,
  assignmentsIn,
  type OwnableSection,
  ownableSections,
  repositoryProfilesKey,
} from './saved-assignments.js';

/** By profile path, the tags people chose; every other profile has one made from its name. */
export const profileTagsKey = 'profile-tags';
export const longestTag = 12;

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
      /** Applied last time and taken out of the list since, so an apply of the list now gives something else. */
      readonly removed: readonly string[];
      readonly reordered: boolean;
      readonly ownershipChanged?: true;
    }
  | { readonly kind: 'current' };

export interface PreferenceStore {
  read(key: string): unknown;
  save(key: string, change: Change, notify?: boolean): Promise<boolean>;
}

export interface ProfilesInFolder {
  readonly listings: { readonly value: readonly ProfileListing[] };
  readonly folder: { readonly value: string };
}

const savedTags = z.record(z.string(), z.string());

function keyOf(repository: string): string {
  return repository.toLowerCase();
}

function tagOverridesIn(value: unknown): Readonly<Record<string, string>> {
  const parsed = savedTags.safeParse(value);
  return parsed.success ? parsed.data : {};
}

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

/** What the profile sets, with what it references, so an edit to a draft changes nothing. */
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
export class RepositoryProfiles implements ProfileAssignments {
  readonly #preferences: PreferenceStore;
  readonly #profiles: ProfilesInFolder;
  /** By profile path, the version of what it sets now, once read. */
  readonly #versions = signal<ReadonlyMap<string, string>>(new Map());
  /** Listed as readable, but they stopped resolving when their versions were read. */
  readonly #unresolvable = signal<ReadonlySet<string>>(new Set());
  #checkTurn = 0;

  constructor(preferences: PreferenceStore, profiles: ProfilesInFolder) {
    this.#preferences = preferences;
    this.#profiles = profiles;
  }

  readonly #assignments = computed(() => assignmentsIn(this.#preferences.read(repositoryProfilesKey)));
  readonly #tagOverrides = computed(() => tagOverridesIn(this.#preferences.read(profileTagsKey)));
  readonly #folders = computed(() => foldersIn(this.#preferences.read(repositoryFoldersKey)));

  /** By path in the profiles folder, the profiles that can be read. */
  readonly #listed = computed<ReadonlyMap<string, ProfileListing>>(
    () =>
      new Map(
        this.#profiles.listings.value.map((listing) => [relative(this.#profiles.folder.value, listing.file), listing]),
      ),
  );

  readonly tags = computed(() =>
    tagsFor(
      [
        ...this.#listed.value.keys(),
        ...Object.values(this.#assignments.value).flatMap((item) => item.profiles),
        ...this.#folders.value.flatMap((folder) => folder.profiles ?? []),
      ],
      this.#tagOverrides.value,
    ),
  );

  /** The repositories, in lower case, that use any profile. */
  readonly repositoriesWithProfiles = computed(() => [
    ...new Set([
      ...Object.entries(this.#assignments.value).flatMap(([repository, item]) =>
        item.profiles.length > 0 || (item.authoritative?.length ?? 0) > 0 ? [repository] : [],
      ),
      ...this.#folders.value.flatMap((folder) =>
        (folder.profiles ?? []).length > 0 ? folder.repositories.map(keyOf) : [],
      ),
    ]),
  ]);

  assignment(repository: string): Assignment | undefined {
    return this.#assignments.value[keyOf(repository)];
  }

  profilesOf(repository: string): readonly string[] {
    return [...new Set([...this.inheritedProfilesOf(repository), ...this.ownProfilesOf(repository)])];
  }

  authoritativeOf(repository: string): readonly OwnableSection[] {
    return this.assignment(repository)?.authoritative ?? [];
  }

  inheritedProfilesOf(repository: string): readonly string[] {
    return (
      this.#folders.value.find((folder) => folder.repositories.some((name) => sameName(name, repository)))?.profiles ??
      []
    );
  }

  ownProfilesOf(repository: string): readonly string[] {
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
    const used = new Set([
      ...Object.values(this.#assignments.peek()).flatMap((item) => item.profiles),
      ...this.#folders.peek().flatMap((folder) => folder.profiles ?? []),
    ]);
    const versions = new Map<string, string>();
    const unresolvable = new Set<string>();
    for (const profilePath of used) {
      if (!this.isListed(profilePath)) {
        continue;
      }
      try {
        versions.set(profilePath, await profileVersion(this.fileOf(profilePath)));
      } catch {
        unresolvable.add(profilePath);
      }
    }
    if (turn === this.#checkTurn) {
      this.#versions.value = versions;
      this.#unresolvable.value = unresolvable;
    }
  }

  status(repository: string): AssignmentStatus {
    const assignment = { ...this.assignment(repository), profiles: this.profilesOf(repository) };
    const authoritative = this.authoritativeOf(repository);
    if (assignment.profiles.length === 0 && authoritative.length === 0) {
      return { kind: 'none' };
    }
    const missing = assignment.profiles.filter((profilePath) => !this.#listed.value.has(profilePath));
    const unreadable = assignment.profiles.filter(
      (profilePath) =>
        this.#listed.value.has(profilePath) &&
        (!this.isListed(profilePath) || this.#unresolvable.value.has(profilePath)),
    );
    if (missing.length > 0 || unreadable.length > 0) {
      return { kind: 'missing', missing, unreadable };
    }
    const versions = this.#versions.value;
    if (assignment.profiles.some((profilePath) => !versions.has(profilePath))) {
      return { kind: 'checking' };
    }
    const applied = assignment.applied ?? [];
    if (assignment.applied === undefined || (applied.length === 0 && assignment.profiles.length > 0)) {
      return { kind: 'not-applied' };
    }
    const appliedVersion = new Map(applied.map((item) => [item.profile, item.version]));
    const notApplied = assignment.profiles.filter((profilePath) => !appliedVersion.has(profilePath));
    const changed = assignment.profiles.filter(
      (profilePath) => appliedVersion.has(profilePath) && appliedVersion.get(profilePath) !== versions.get(profilePath),
    );
    const removed = applied
      .map((item) => item.profile)
      .filter((profilePath) => !assignment.profiles.includes(profilePath));
    const reordered = !isSameList(
      applied.map((item) => item.profile).filter((profilePath) => assignment.profiles.includes(profilePath)),
      assignment.profiles.filter((profilePath) => appliedVersion.has(profilePath)),
    );
    const ownershipChanged = !isSameList(
      ownableSections.filter((section) => authoritative.includes(section)),
      ownableSections.filter((section) => assignment.appliedAuthoritative?.includes(section) === true),
    );
    return changed.length === 0 && notApplied.length === 0 && removed.length === 0 && !reordered && !ownershipChanged
      ? { kind: 'current' }
      : {
          kind: 'changed',
          changed,
          notApplied,
          removed,
          reordered,
          ...(ownershipChanged ? { ownershipChanged: true } : {}),
        };
  }

  /** Keep the applied baseline with inherited layers, so removing own layers still reports drift. */
  setProfiles(repository: string, profiles: readonly string[], authoritative?: readonly AuthoritativeSection[]): void {
    const owned = ownableSections.filter((section) =>
      (authoritative ?? this.authoritativeOf(repository)).includes(section),
    );
    const unique = [...new Set(profiles)];
    this.#change(repository, (current) =>
      unique.length === 0 && this.inheritedProfilesOf(repository).length === 0 && owned.length === 0
        ? undefined
        : { ...current, profiles: unique, authoritative: owned },
    ).catch(() => undefined);
  }

  /** Records the effective layers without copying inherited ones into the repository's own list. */
  recordApplied(
    repository: string,
    applied: readonly AppliedVersion[],
    authoritative: readonly AuthoritativeSection[] = [],
    notify = true,
  ): Promise<boolean> {
    const inherits = this.inheritedProfilesOf(repository).length > 0;
    return this.#change(
      repository,
      (current) =>
        current === undefined && !inherits
          ? undefined
          : {
              ...current,
              profiles: current?.profiles ?? [],
              applied: [...applied],
              appliedAuthoritative: ownableSections.filter((section) => authoritative.includes(section)),
            },
      notify,
    );
  }

  /**
   * One profile applied by itself, added to the end of the repository's list.
   * Without a version, as after an apply that left some of it out, it counts as not applied yet.
   */
  recordAdded(repository: string, profilePath: string, version: string | undefined, notify = true): Promise<boolean> {
    return this.#change(
      repository,
      (current) => {
        const applied = (current?.applied ?? []).filter((item) => item.profile !== profilePath);
        return {
          ...current,
          profiles: [...(current?.profiles ?? []).filter((other) => other !== profilePath), profilePath],
          applied: version === undefined ? applied : [...applied, { profile: profilePath, version }],
        };
      },
      notify,
    );
  }

  /** The repositories, in lower case, whose profiles changed since they were last applied. */
  readonly changedRepositories = computed(() =>
    this.repositoriesWithProfiles.value.filter((repository) => this.status(repository).kind === 'changed'),
  );

  #change(
    repository: string,
    change: (current: Assignment | undefined) => Assignment | undefined,
    notify = true,
  ): Promise<boolean> {
    const key = keyOf(repository);
    return this.#preferences.save(
      repositoryProfilesKey,
      (saved) => {
        const all = assignmentsIn(saved);
        const next = change(all[key]);
        const kept = Object.fromEntries(Object.entries(all).filter(([other]) => other !== key));
        if (next !== undefined) {
          kept[key] = {
            profiles: next.profiles,
            ...((next.authoritative?.length ?? 0) > 0 ? { authoritative: next.authoritative } : {}),
            ...(next.applied === undefined ? {} : { applied: next.applied }),
            ...((next.appliedAuthoritative?.length ?? 0) > 0
              ? { appliedAuthoritative: next.appliedAuthoritative }
              : {}),
          };
        }
        return Object.keys(kept).length > 0 ? kept : undefined;
      },
      notify,
    );
  }
}
