import { type ConfigChange, configCommitMessage, profileDisplayName } from '@repotted/core';

import { type AppliedVersion, type Assignment, assignmentsIn } from '../repositories/saved-assignments.js';

export interface ProfileTarget {
  readonly kind: 'repository' | 'folder';
  readonly name: string;
}

type ProfileVerb = 'Assign' | 'Apply' | 'Remove';

/** A change to a repository's or folder's profiles as a whole. */
export type ProfileSettingChange =
  | 'reorder'
  | 'ownership'
  | 'apply-again'
  | 'apply-on-move-turned-on'
  | 'apply-on-move-turned-off';

interface TargetChanges {
  readonly target: ProfileTarget;
  readonly profilesByVerb: Map<ProfileVerb, string[]>;
  readonly settings: ProfileSettingChange[];
}

/** By target, in the order first changed. */
export type ProfileChanges = Map<string, TargetChanges>;

const verbOrder: readonly ProfileVerb[] = ['Assign', 'Apply', 'Remove'];
const prepositionOf: Readonly<Record<ProfileVerb, string>> = {
  Assign: 'to',
  Apply: 'to',
  Remove: 'from',
};
const targetNouns = {
  repository: { noun: 'repository', nouns: 'repositories' },
  folder: { noun: 'folder', nouns: 'folders' },
} as const;

/** `clause` stands alone before the target, as in `Reorder profiles for repository: a`; `part` joins others for one target. */
const settingWording: Readonly<Record<ProfileSettingChange, { readonly clause: string; readonly part: string }>> = {
  reorder: { clause: 'Reorder profiles for', part: 'reorder' },
  ownership: { clause: 'Change full section ownership for', part: 'change full section ownership' },
  'apply-again': { clause: 'Apply profiles to', part: 'apply profiles' },
  'apply-on-move-turned-on': {
    clause: 'Apply profiles on move into',
    part: 'apply profiles on move',
  },
  'apply-on-move-turned-off': {
    clause: 'Stop applying profiles on move into',
    part: 'stop applying profiles on move',
  },
};

export function emptyProfileChanges(): ProfileChanges {
  return new Map();
}

function changesFor(changes: ProfileChanges, target: ProfileTarget): TargetChanges {
  const key = `${target.kind}\n${target.name}`;
  const existing = changes.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const made: TargetChanges = { target, profilesByVerb: new Map(), settings: [] };
  changes.set(key, made);
  return made;
}

function addProfile(changes: ProfileChanges, target: ProfileTarget, verb: ProfileVerb, profile: string): void {
  const { profilesByVerb } = changesFor(changes, target);
  profilesByVerb.set(verb, [...(profilesByVerb.get(verb) ?? []), profile]);
}

export function addProfileSettingChange(
  changes: ProfileChanges,
  target: ProfileTarget,
  setting: ProfileSettingChange,
): void {
  changesFor(changes, target).settings.push(setting);
}

function commonOrder(list: readonly string[], other: readonly string[]): string[] {
  return list.filter((item) => other.includes(item));
}

function isSameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function isSameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item) => right.includes(item));
}

/**
 * The profiles assigned to and taken off a target, and its reorder. Profiles
 * in `appliedNow` are named as applied rather than assigned.
 */
export function addProfileListChanges(
  changes: ProfileChanges,
  target: ProfileTarget,
  before: readonly string[],
  after: readonly string[],
  appliedNow: readonly string[] = [],
): void {
  for (const profile of after) {
    if (!before.includes(profile) && !appliedNow.includes(profile)) {
      addProfile(changes, target, 'Assign', profile);
    }
  }
  for (const profile of appliedNow) {
    addProfile(changes, target, 'Apply', profile);
  }
  for (const profile of before) {
    if (!after.includes(profile)) {
      addProfile(changes, target, 'Remove', profile);
    }
  }
  if (!isSameList(commonOrder(before, after), commonOrder(after, before))) {
    addProfileSettingChange(changes, target, 'reorder');
  }
}

function verbsOf(targetChanges: TargetChanges): ProfileVerb[] {
  return verbOrder.filter((verb) => (targetChanges.profilesByVerb.get(verb)?.length ?? 0) > 0);
}

/** One clause for each target, as in `Assign profiles to repository a: base, web`. */
function namedByTarget(changes: ProfileChanges): ConfigChange[] {
  return [...changes.values()].flatMap((targetChanges): ConfigChange[] => {
    const { target, profilesByVerb, settings } = targetChanges;
    const { noun, nouns } = targetNouns[target.kind];
    const verbs = verbsOf(targetChanges);
    const [onlyVerb] = verbs;
    const [onlySetting] = settings;
    if (verbs.length === 1 && onlyVerb !== undefined && settings.length === 0) {
      return (profilesByVerb.get(onlyVerb) ?? []).map((profile) => ({
        action: onlyVerb,
        noun: 'profile',
        nouns: 'profiles',
        nounQualifier: `${prepositionOf[onlyVerb]} ${noun} ${target.name}`,
        name: profileDisplayName(profile),
      }));
    }
    if (verbs.length === 0 && settings.length === 1 && onlySetting !== undefined) {
      return [{ action: settingWording[onlySetting].clause, noun, nouns, name: target.name }];
    }
    return [
      ...verbs.flatMap((verb) =>
        (profilesByVerb.get(verb) ?? []).map((profile) => `${verb.toLowerCase()} ${profileDisplayName(profile)}`),
      ),
      ...settings.map((setting) => settingWording[setting].part),
    ].map((part) => ({
      action: 'Update',
      noun: 'profiles',
      nouns: 'profiles',
      nounQualifier: `for ${noun} ${target.name}`,
      name: part,
      counted: { action: 'Make', noun: 'profile change', nouns: 'profile changes' },
    }));
  });
}

/**
 * The profiles that share a change and the targets they share it with in one
 * clause, as in `Apply profiles base, web to repositories: a, b`.
 */
function namedByProfile(changes: ProfileChanges): ConfigChange[] {
  const targetsByProfile = new Map<string, { verb: ProfileVerb; profile: string; targets: ProfileTarget[] }>();
  for (const { target, profilesByVerb } of changes.values()) {
    for (const verb of verbOrder) {
      for (const profile of profilesByVerb.get(verb) ?? []) {
        const key = `${verb}\n${target.kind}\n${profile}`;
        const entry = targetsByProfile.get(key) ?? { verb, profile, targets: [] };
        entry.targets.push(target);
        targetsByProfile.set(key, entry);
      }
    }
  }
  const profilesBySharedTargets = new Map<
    string,
    { verb: ProfileVerb; kind: ProfileTarget['kind']; profiles: string[]; targets: ProfileTarget[] }
  >();
  for (const { verb, profile, targets } of targetsByProfile.values()) {
    const [first] = targets;
    if (first === undefined) {
      continue;
    }
    const key = `${verb}\n${first.kind}\n${targets.map((target) => target.name).join('\n')}`;
    const entry = profilesBySharedTargets.get(key) ?? { verb, kind: first.kind, profiles: [], targets };
    entry.profiles.push(profile);
    profilesBySharedTargets.set(key, entry);
  }
  const layerChanges = [...profilesBySharedTargets.values()]
    .toSorted((left, right) => verbOrder.indexOf(left.verb) - verbOrder.indexOf(right.verb))
    .flatMap(({ verb, kind, profiles, targets }) => {
      const profileWord = profiles.length === 1 ? 'profile' : 'profiles';
      const action = `${verb} ${profileWord} ${profiles.map(profileDisplayName).join(', ')} ${prepositionOf[verb]}`;
      return targets.map((target): ConfigChange => ({ action, ...targetNouns[kind], name: target.name }));
    });
  const settingChanges = [...changes.values()].flatMap(({ target, settings }) =>
    settings.map((setting): ConfigChange => ({
      action: settingWording[setting].clause,
      ...targetNouns[target.kind],
      name: target.name,
    })),
  );
  return [...layerChanges, ...settingChanges];
}

function clauseCount(changes: readonly ConfigChange[]): number {
  return new Set(changes.map((change) => `${change.action}\n${change.nounQualifier ?? ''}`)).size;
}

function needsBody(changes: readonly ConfigChange[]): boolean {
  return configCommitMessage(changes).includes('\n');
}

/** Lower is better: a body, then each clause, then each change left out of the clauses' lists. */
function readingCost(changes: readonly ConfigChange[]): readonly number[] {
  return [needsBody(changes) ? 1 : 0, clauseCount(changes), -changes.length];
}

/**
 * Named by profile or by repository or folder, whichever has a subject that
 * names every change, then whichever needs fewer clauses, then whichever
 * lists more in them, so its subject can name some and count the rest; by
 * profile when both read alike.
 */
export function profileConfigChanges(changes: ProfileChanges): ConfigChange[] {
  const byProfile = namedByProfile(changes);
  const byTarget = namedByTarget(changes);
  const profileCost = readingCost(byProfile);
  const targetCost = readingCost(byTarget);
  const firstDifference = targetCost.findIndex((cost, index) => cost !== profileCost[index]);
  const targetReadsBetter =
    firstDifference !== -1 && (targetCost[firstDifference] ?? 0) < (profileCost[firstDifference] ?? 0);
  return targetReadsBetter ? byTarget : byProfile;
}

/** Each profile whose version this save records for the first time, or anew. */
function profilesAppliedNow(
  before: readonly AppliedVersion[] | undefined,
  after: readonly AppliedVersion[] | undefined,
): string[] {
  return (after ?? [])
    .filter(
      (item) => !(before ?? []).some((earlier) => earlier.profile === item.profile && earlier.version === item.version),
    )
    .map((item) => item.profile);
}

/** An apply records which profiles it applied and the sections it fully owned, even when no version is new. */
function isNewApplyRecord(before: Assignment | undefined, after: Assignment | undefined): boolean {
  if (after?.applied === undefined) {
    return false;
  }
  if (before?.applied === undefined) {
    return true;
  }
  return (
    !isSameList(
      before.applied.map((item) => item.profile),
      after.applied.map((item) => item.profile),
    ) || !isSameSet(before.appliedAuthoritative ?? [], after.appliedAuthoritative ?? [])
  );
}

/**
 * What saving `repository-profiles` changes. An apply records the version of
 * each profile it applied, so only a profile whose version is new is named as
 * applied. An apply that records no new version is named by repository, unless
 * the same save assigns or takes off a profile, as an apply that left part of
 * a profile out does.
 */
export function assignmentChanges(beforeValue: unknown, afterValue: unknown): ConfigChange[] {
  const before = assignmentsIn(beforeValue);
  const after = assignmentsIn(afterValue);
  const changes = emptyProfileChanges();
  const repositories = [...new Set([...Object.keys(before), ...Object.keys(after)])].toSorted();
  for (const repository of repositories) {
    const target: ProfileTarget = { kind: 'repository', name: repository };
    const assignmentBefore = before[repository];
    const assignmentAfter = after[repository];
    const appliedNow = profilesAppliedNow(assignmentBefore?.applied, assignmentAfter?.applied);
    const profilesBefore = assignmentBefore?.profiles ?? [];
    const profilesAfter = assignmentAfter?.profiles ?? [];
    addProfileListChanges(changes, target, profilesBefore, profilesAfter, appliedNow);
    if (!isSameSet(assignmentBefore?.authoritative ?? [], assignmentAfter?.authoritative ?? [])) {
      addProfileSettingChange(changes, target, 'ownership');
    }
    const listChanged = !isSameSet(profilesBefore, profilesAfter);
    if (appliedNow.length === 0 && !listChanged && isNewApplyRecord(assignmentBefore, assignmentAfter)) {
      addProfileSettingChange(changes, target, 'apply-again');
    }
  }
  return profileConfigChanges(changes);
}
