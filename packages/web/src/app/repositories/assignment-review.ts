import type { AuthoritativeSection, Plan, StagedApply } from '@repotted/core';

import { profileName, profileVersion } from './repository-profiles.js';
import type { AppliedVersion } from './saved-assignments.js';

type AssignableProfiles = { readonly kind: 'own' } | { readonly kind: 'add'; readonly profileName: string };

type AssignmentSource = { readonly kind: 'none' } | AssignableProfiles;

/** A full apply may record the assigned versions or offer to add a single profile. */
export type AssignmentOffer = { readonly kind: 'none' } | (AssignableProfiles & { readonly recordsVersions: boolean });

export interface ProfileAssignments {
  profilesOf(repository: string): readonly string[];
  authoritativeOf(repository: string): readonly AuthoritativeSection[];
  fileOf(profilePath: string): string;
  /** Undefined for a profile kept outside the profiles folder. */
  pathOf(file: string): string | undefined;
  recordApplied(
    repository: string,
    applied: readonly AppliedVersion[],
    authoritative: readonly AuthoritativeSection[],
    notify?: boolean,
  ): Promise<boolean>;
  recordAdded(repository: string, profilePath: string, version: string | undefined, notify?: boolean): Promise<boolean>;
}

export const noAssignments: ProfileAssignments = {
  profilesOf: () => [],
  authoritativeOf: () => [],
  fileOf: (path) => path,
  pathOf: () => undefined,
  recordApplied: () => Promise.resolve(true),
  recordAdded: () => Promise.resolve(true),
};

export function assignmentKey(assignments: ProfileAssignments, repository: string): string {
  return JSON.stringify([assignments.profilesOf(repository), [...assignments.authoritativeOf(repository)].toSorted()]);
}

function isSameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function profilesApplyFully(staged: StagedApply, plan: Plan): boolean {
  const { drafts: _drafts, ...settled } = staged.sources;
  return (
    staged.exclude.length === 0 &&
    !Object.values(settled).some((setBy) => Object.values(setBy).includes(staged.file)) &&
    !plan.warnings.some((warning) => warning.cause === 'refused')
  );
}

export function assignmentSource(
  assignments: ProfileAssignments,
  repository: string,
  files: readonly string[],
  emptyIsAssigned: boolean,
): AssignmentSource {
  const paths = files.map((file) => assignments.pathOf(file));
  const inFolder = paths.filter((path) => path !== undefined);
  if ((inFolder.length === 0 && !emptyIsAssigned) || inFolder.length !== paths.length) {
    return { kind: 'none' };
  }
  const own = assignments.profilesOf(repository);
  const [only] = inFolder;
  return isSameList(inFolder, own)
    ? { kind: 'own' }
    : inFolder.length === 1 && only !== undefined && !own.includes(only)
      ? { kind: 'add', profileName: profileName(only) }
      : { kind: 'none' };
}

export function canRecordAssignment(
  assignments: ProfileAssignments,
  repository: string,
  staged: StagedApply,
  plan: Plan,
): boolean {
  // A refused read compared nothing there; granting access can change the plan.
  return (
    profilesApplyFully(staged, plan) &&
    isSameList([...staged.authoritative].toSorted(), [...assignments.authoritativeOf(repository)].toSorted())
  );
}

/** The baseline can record only versions that still match the inputs read before planning. */
export async function reviewedProfileVersions(
  assignments: ProfileAssignments,
  files: readonly string[],
  before: readonly (string | undefined)[],
  repository?: string,
): Promise<readonly AppliedVersion[]> {
  const versions = await Promise.all(
    files.map(async (file) => ({ profile: assignments.pathOf(file) ?? file, version: await profileVersion(file) })),
  );
  if (before.length !== versions.length || versions.some((source, index) => source.version !== before[index])) {
    throw new Error(
      `${repository === undefined ? 'The' : `${repository}'s`} profile sources changed during review. Review again before applying.`,
    );
  }
  return versions;
}
