import { mkdir, readFile, realpath, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parse, stringify } from 'yaml';
import { z } from 'zod';

import { type GitHub, GitHubError, parseRepo, repoPattern } from '../github/client.js';
import { type Access, type Lock, lockChanges } from '../github/permissions.js';
import { readAccess } from '../github/repositories.js';
import { ApplyError, applyPlan, StalePlanError } from '../plan/apply.js';
import type { Change } from '../plan/change.js';
import { describeFailure, failureReason } from '../plan/format.js';
import { OwnerMismatchError, type Plan } from '../plan/plan.js';
import { parsePlan } from '../plan/saved-plan.js';
import { ProfileError, resolveProfile, resolveProfilesTogether } from '../profiles/profile.js';
import { hexDigest } from '../shared/bytes.js';
import { replaceFile } from '../shared/files.js';
import {
  createStagedApply,
  editStagedApply,
  isExclusionKey,
  type PlanExclusion,
  planStagedApply,
  resolveStagedApply,
  type StagedApply,
  stagedExcludes,
  stagedRepository,
  stagedSets,
} from './staged.js';

// Repositories are planned a few at a time and applied one at a time, in the
// manifest's order, so a failure is easy to follow and a stop is clean.

export const batchManifest = 'batch.yaml';

const planningConcurrency = 4;

const manifestChangeAttemptLimit = 5;

const savedMember = z
  .object({
    repository: z.string().regex(repoPattern, 'Use owner/name'),
    /** Relative to the batch folder unless it is elsewhere on another drive. */
    file: z.string().min(1),
    left_out: z.boolean().optional(),
    /** A staged apply that was in progress before the batch, which discarding the batch leaves as it is. */
    joined: z.boolean().optional(),
    /** The profiles it started from, when they are its own rather than the batch's, each stored as `profiles` is. */
    profiles: z.array(z.string().min(1)).optional(),
  })
  .strict();

const savedManifest = z
  .object({
    /** Tells this batch from another started later in the same folder, so a plan of one never applies to the other. */
    id: z.string().min(1),
    /** Each relative to the folder, in the order they apply; empty for the repository as it is. */
    profiles: z.array(z.string().min(1)).optional(),
    /**
     * One profile, or null for none, which reads as a list of one, or of
     * none, and is saved as `profiles`. Published versions of the CLI write
     * it, so both are read.
     */
    profile: z.string().min(1).nullable().optional(),
    members: z.array(savedMember),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.profiles !== undefined && value.profile !== undefined) {
      context.addIssue({ code: 'custom', message: 'A batch has profiles or profile, not both', path: ['profile'] });
    }
    const seen = new Set<string>();
    for (const [index, member] of value.members.entries()) {
      const key = member.repository.toLowerCase();
      if (seen.has(key)) {
        context.addIssue({
          code: 'custom',
          message: `${member.repository} is in the batch more than once`,
          path: ['members', index],
        });
      }
      seen.add(key);
    }
  });

type SavedManifest = z.infer<typeof savedManifest>;

export interface BatchMember {
  readonly repository: string;
  /** Absolute. */
  readonly file: string;
  readonly left_out: boolean;
  readonly joined: boolean;
  /**
   * Absolute, in the order they apply, when the repository started from
   * profiles of its own rather than the batch's; null otherwise.
   */
  readonly profiles: readonly string[] | null;
}

export interface Batch {
  readonly folder: string;
  readonly id: string;
  /** Absolute, in the order they apply; empty for each repository as it is. */
  readonly profiles: readonly string[];
  readonly members: readonly BatchMember[];
}

function memberProfiles(batch: Batch, member: BatchMember): readonly string[] {
  return member.profiles ?? batch.profiles;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined;
}

async function removeEmptyFolders(topFolder: string, deepestFolder: string, keepTopFolder = false): Promise<void> {
  const relative = path.relative(topFolder, deepestFolder);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return;
  }
  for (let current = deepestFolder; !(keepTopFolder && current === topFolder); current = path.dirname(current)) {
    try {
      await rmdir(current);
    } catch {
      return;
    }
    if (current === topFolder) {
      return;
    }
  }
}

// The batch folder itself stays, since only ending the batch, or a failed start that made it, removes it.
async function removeFiles(folder: string, files: readonly string[]): Promise<void> {
  for (const file of files) {
    await rm(file, { force: true });
    await removeEmptyFolders(folder, path.dirname(file), true);
  }
}

function sameRepository(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * Checked before a discard removes the file, so a manifest edited by hand
 * never has Repotted remove another file. False when the file is already gone.
 */
async function isMemberFile(member: BatchMember): Promise<boolean> {
  let repository: string;
  try {
    repository = await stagedRepository(member.file);
  } catch (error) {
    if (error instanceof ProfileError && errorCode(error.cause) === 'ENOENT') {
      return false;
    }
    throw new ProfileError(`${member.file} is not a staged apply, so Repotted leaves it as it is`, { cause: error });
  }
  if (!sameRepository(repository, member.repository)) {
    throw new ProfileError(
      `${member.file} applies to ${repository}, not ${member.repository}, so Repotted leaves it as it is`,
    );
  }
  return true;
}

async function endBatch(batch: Batch): Promise<void> {
  await rm(path.join(batch.folder, batchManifest), { force: true });
  await removeEmptyFolders(batch.folder, batch.folder);
}

function storedPath(folder: string, target: string): string {
  const relative = path.relative(folder, target);
  return path.isAbsolute(relative) ? target : relative.split(path.sep).join('/');
}

async function realFolder(folder: string): Promise<string> {
  return realpath(path.resolve(folder)).catch(() => path.resolve(folder));
}

function fromSaved(folder: string, saved: SavedManifest): Batch {
  const profiles = saved.profiles ?? (saved.profile === undefined || saved.profile === null ? [] : [saved.profile]);
  return {
    folder,
    id: saved.id,
    profiles: profiles.map((profile) => path.resolve(folder, profile)),
    members: saved.members.map((member) => ({
      repository: member.repository,
      file: path.resolve(folder, member.file),
      left_out: member.left_out === true,
      joined: member.joined === true,
      profiles: member.profiles?.map((profile) => path.resolve(folder, profile)) ?? null,
    })),
  };
}

function toSaved(batch: Batch): SavedManifest {
  return {
    id: batch.id,
    profiles: batch.profiles.map((profile) => storedPath(batch.folder, profile)),
    members: batch.members.map((member) => ({
      repository: member.repository,
      file: storedPath(batch.folder, member.file),
      ...(member.left_out ? { left_out: true } : {}),
      ...(member.joined ? { joined: true } : {}),
      ...(member.profiles === null
        ? {}
        : { profiles: member.profiles.map((profile) => storedPath(batch.folder, profile)) }),
    })),
  };
}

const manifestHeader = [
  '# A batch: profiles applied to several repositories, each through a staged apply of its own.',
  '# Change it with repotted stage <folder>; a repository is planned and applied as its staged apply is.',
].join('\n');

function manifestText(batch: Batch): string {
  return `${manifestHeader}\n${stringify(toSaved(batch), { lineWidth: 0 })}`;
}

export async function isBatch(folder: string): Promise<boolean> {
  return stat(path.join(folder, batchManifest)).then(
    (found) => found.isFile(),
    () => false,
  );
}

async function readManifest(folder: string): Promise<{ batch: Batch; text: string }> {
  const real = await realFolder(folder);
  const file = path.join(real, batchManifest);
  let text: string;
  let data: unknown;
  try {
    text = await readFile(file, 'utf8');
    data = parse(text) ?? {};
  } catch (error) {
    throw new ProfileError(
      errorCode(error) === 'ENOENT' ? `${folder} holds no batch` : `Cannot read the batch in ${folder}`,
      { cause: error },
    );
  }
  const result = savedManifest.safeParse(data);
  if (!result.success) {
    throw new ProfileError(`${file} is not a valid batch:\n${z.prettifyError(result.error)}`);
  }
  return { batch: fromSaved(real, result.data), text };
}

export async function readBatch(folder: string): Promise<Batch> {
  return (await readManifest(folder)).batch;
}

/**
 * When another program changed the manifest after the read, the change starts
 * over from the manifest as it is then, so neither change is lost. `change`
 * may run more than once.
 */
async function changeBatch(folder: string, change: (batch: Batch) => Batch | Promise<Batch>): Promise<Batch> {
  for (let attempt = 1; ; attempt += 1) {
    const { batch, text } = await readManifest(folder);
    const changed = await change(batch);
    const file = path.join(batch.folder, batchManifest);
    const now = await readFile(file, 'utf8').catch(() => undefined);
    if (now === text) {
      await replaceFile(file, manifestText(changed), { create: false });
      return changed;
    }
    if (attempt === manifestChangeAttemptLimit) {
      throw new ProfileError(`The batch in ${folder} kept changing while Repotted changed it, so try again`);
    }
  }
}

/** A repository that starts from profiles of its own, in the order they apply, rather than the batch's. */
export interface RepositoryWithProfiles {
  readonly repository: string;
  readonly profiles: readonly string[];
}

export interface BatchAdditions {
  readonly repositories?: readonly (string | RepositoryWithProfiles)[];
  readonly join?: readonly string[];
  /** New staged applies go in as `<owner>/<name>.yaml` in lower case. The batch folder by default. */
  readonly stagedFolder?: string;
}

// GitHub names are not case sensitive, so the path is in lower case, and a
// repository has one staged apply there however its name is written.
function newStagedFile(folder: string, repository: string): string {
  const repo = parseRepo(repository);
  return path.join(folder, repo.owner.toLowerCase(), `${repo.name.toLowerCase()}.yaml`);
}

// The staged applies it starts are removed again when any addition fails.
async function addMembers(batch: Batch, additions: BatchAdditions): Promise<BatchMember[]> {
  const added: BatchMember[] = [];
  const started: string[] = [];
  const claim = (repository: string): void => {
    const taken = [...batch.members, ...added].find((member) => sameRepository(member.repository, repository));
    if (taken !== undefined) {
      throw new ProfileError(`${repository} is already in the batch, through ${taken.file}`);
    }
  };
  try {
    for (const file of additions.join ?? []) {
      const staged = await resolveStagedApply(file);
      claim(staged.repository);
      added.push({ repository: staged.repository, file: staged.file, left_out: false, joined: true, profiles: null });
    }
    const stagedFolder = path.resolve(additions.stagedFolder ?? batch.folder);
    for (const addition of additions.repositories ?? []) {
      const repo = parseRepo(typeof addition === 'string' ? addition : addition.repository);
      const name = `${repo.owner}/${repo.name}`;
      claim(name);
      const file = newStagedFile(stagedFolder, name);
      await mkdir(path.dirname(file), { recursive: true });
      let staged: StagedApply;
      try {
        staged = await createStagedApply(file, name, typeof addition === 'string' ? batch.profiles : addition.profiles);
      } catch (error) {
        if (error instanceof ProfileError && errorCode(error.cause) === 'EEXIST') {
          throw new ProfileError(
            `${name} already has a staged apply in ${file}; add it as it is with --join, or discard it first`,
            { cause: error },
          );
        }
        throw error;
      }
      started.push(file);
      added.push({
        repository: name,
        file: path.resolve(file),
        left_out: false,
        joined: false,
        profiles: typeof addition === 'string' ? null : staged.profiles,
      });
    }
  } catch (error) {
    await removeFiles(batch.folder, started);
    throw error;
  }
  return added;
}

export interface BatchStart extends BatchAdditions {
  /** In the order they apply, later ones overriding earlier ones; none for each repository as it is. */
  readonly profiles?: readonly string[];
}

/** Nothing is left behind when any member fails to start. */
export async function createBatch(folder: string, start: BatchStart): Promise<Batch> {
  if ((start.repositories ?? []).length + (start.join ?? []).length === 0) {
    throw new ProfileError('A batch needs at least one repository');
  }
  if (await isBatch(folder)) {
    throw new ProfileError(`${folder} already holds a batch`);
  }
  // Resolving first means a batch never starts from a broken profile.
  const profiles: string[] = [];
  for (const profile of start.profiles ?? []) {
    profiles.push((await resolveProfile(profile)).chain[0] ?? path.resolve(profile));
  }
  if (profiles.length > 1) {
    await resolveProfilesTogether(profiles);
  }
  // The first folder mkdir made, if any, so a failed start removes what it made and nothing more.
  const made = await mkdir(folder, { recursive: true });
  const real = await realFolder(folder);
  const empty: Batch = { folder: real, id: crypto.randomUUID(), profiles, members: [] };
  try {
    const members = await addMembers(empty, start);
    const batch = { ...empty, members };
    try {
      await writeFile(path.join(real, batchManifest), manifestText(batch), { flag: 'wx' });
    } catch (error) {
      await removeFiles(
        real,
        members.filter((member) => !member.joined).map((member) => member.file),
      );
      throw new ProfileError(`Cannot start a batch in ${folder}`, { cause: error });
    }
    return batch;
  } catch (error) {
    if (made !== undefined) {
      await removeEmptyFolders(path.resolve(made), path.resolve(folder));
    }
    throw error;
  }
}

export async function addToBatch(folder: string, additions: BatchAdditions): Promise<Batch> {
  const batch = await readBatch(folder);
  const added = await addMembers(batch, additions);
  try {
    return await changeBatch(folder, (current) => {
      // Another program may have added one of them since the batch was read.
      for (const member of added) {
        if (current.members.some((item) => sameRepository(item.repository, member.repository))) {
          throw new ProfileError(`${member.repository} is already in the batch`);
        }
      }
      return { ...current, members: [...current.members, ...added] };
    });
  } catch (error) {
    await removeFiles(
      batch.folder,
      added.filter((member) => !member.joined).map((member) => member.file),
    );
    throw error;
  }
}

function findMember(batch: Batch, repository: string): BatchMember {
  const member = batch.members.find((item) => sameRepository(item.repository, repository));
  if (member === undefined) {
    throw new ProfileError(`${repository} is not in the batch in ${batch.folder}`);
  }
  return member;
}

export async function batchMemberFile(folder: string, repository: string): Promise<string> {
  return findMember(await readBatch(folder), repository).file;
}

export async function leaveOut(folder: string, repositories: readonly string[], leftOut: boolean): Promise<Batch> {
  return changeBatch(folder, (batch) => {
    for (const repository of repositories) {
      findMember(batch, repository);
    }
    return {
      ...batch,
      members: batch.members.map((member) =>
        repositories.some((repository) => sameRepository(repository, member.repository))
          ? { ...member, left_out: leftOut }
          : member,
      ),
    };
  });
}

export interface EverywhereResult {
  readonly batch: Batch;
  readonly changed: readonly string[];
  /** A member it had nothing to do in is in neither list. */
  readonly refused: readonly { readonly repository: string; readonly message: string }[];
}

/** Members left out of the batch change too, so putting one back finds it as the rest. */
export async function editEverywhere(folder: string, key: string, excluded: boolean): Promise<EverywhereResult> {
  if (!isExclusionKey(key)) {
    throw new ProfileError(
      `Cannot ${excluded ? 'exclude' : 'include'} ${key}: it names no section, setting, or list entry, as in repository.has_wiki or rulesets/Main`,
    );
  }
  const batch = await readBatch(folder);
  const changed: string[] = [];
  const refused: { repository: string; message: string }[] = [];
  let already = 0;
  for (const member of batch.members) {
    try {
      const staged = await resolveStagedApply(member.file);
      if (excluded && stagedExcludes(staged, key)) {
        already += 1;
      }
      if (excluded ? !stagedSets(staged, key) : !stagedExcludes(staged, key)) {
        continue;
      }
      await editStagedApply(member.file, [{ exclude: key, excluded }]);
      changed.push(member.repository);
    } catch (error) {
      refused.push({ repository: member.repository, message: error instanceof Error ? error.message : String(error) });
    }
  }
  if (changed.length === 0 && refused.length === 0) {
    if (!excluded) {
      throw new ProfileError(`No repository in the batch excludes ${key}`);
    }
    throw new ProfileError(
      already === batch.members.length
        ? `Every repository in the batch already excludes ${key}`
        : `Cannot exclude ${key}: no repository's profile in the batch sets what it names`,
    );
  }
  return { batch, changed, refused };
}

export interface MemberDiscard {
  readonly file: string;
  /** A staged apply that joined the batch stays; one the batch started is discarded. */
  readonly kept: boolean;
  /** Null when that was its last member and the batch ended. */
  readonly batch: Batch | null;
}

export async function discardBatchMember(folder: string, repository: string): Promise<MemberDiscard> {
  const member = findMember(await readBatch(folder), repository);
  const remove = !member.joined && (await isMemberFile(member));
  const left = await changeBatch(folder, (current) => ({
    ...current,
    members: current.members.filter((item) => !sameRepository(item.repository, member.repository)),
  }));
  if (remove) {
    await removeFiles(left.folder, [member.file]);
  }
  if (left.members.length === 0) {
    await endBatch(left);
  }
  return { file: member.file, kept: member.joined, batch: left.members.length === 0 ? null : left };
}

interface DiscardWarning {
  readonly repository: string;
  readonly file: string;
  readonly message: string;
}

/** Files that cannot be verified stay where they are, without keeping the batch alive. */
export async function discardBatch(folder: string): Promise<readonly DiscardWarning[]> {
  const batch = await readBatch(folder);
  const files: string[] = [];
  const keptFiles = new Set<string>();
  const warnings: DiscardWarning[] = [];
  for (const member of batch.members) {
    if (member.joined) {
      keptFiles.add(member.file);
      continue;
    }
    try {
      if (await isMemberFile(member)) {
        files.push(member.file);
      }
    } catch (error) {
      if (!(error instanceof ProfileError)) {
        throw error;
      }
      keptFiles.add(member.file);
      warnings.push({ repository: member.repository, file: member.file, message: error.message });
    }
  }
  // A manifest can list a file more than once; any reason to keep it wins.
  await removeFiles(
    batch.folder,
    files.filter((file) => !keptFiles.has(file)),
  );
  await endBatch(batch);
  return warnings;
}

export interface MemberError {
  readonly kind: 'signed_out' | 'owner_mismatch' | 'error';
  readonly message: string;
  /** Null when the failure was not GitHub's answer. */
  readonly status: number | null;
}

function memberError(error: unknown): MemberError {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof OwnerMismatchError) {
    return { kind: 'owner_mismatch', message, status: null };
  }
  for (let current = error; current instanceof Error; current = current.cause) {
    if (current instanceof GitHubError) {
      return { kind: current.status === 401 ? 'signed_out' : 'error', message, status: current.status };
    }
  }
  return { kind: 'error', message, status: null };
}

export interface MemberPlan extends Plan {
  readonly file: string;
  /**
   * The staged apply file's SHA-256 when it was planned. A member is applied
   * only while its file is still the same, so a plan reviewed before an edit
   * is never applied.
   */
  readonly digest: string;
  readonly access: Access;
  readonly locks: readonly Lock[];
  readonly staged: Pick<StagedApply, 'file' | 'repository' | 'profiles' | 'exclude'>;
  /**
   * What the batch starts the repository from, which its staged apply's own
   * profiles may differ from when it was in progress before the batch.
   */
  readonly batch_profiles: readonly string[];
  readonly exclusions: readonly PlanExclusion[];
}

export interface BatchPlan {
  readonly batch: string;
  readonly id: string;
  readonly profiles: readonly string[];
  readonly plans: readonly MemberPlan[];
  readonly left_out: readonly { readonly repository: string; readonly file: string }[];
  readonly failures: readonly { readonly repository: string; readonly file: string; readonly error: MemberError }[];
}

async function planMember(github: GitHub, batch: Batch, member: BatchMember): Promise<MemberPlan> {
  // Read before the plan reads the file: an edit in between gives a digest
  // the file no longer has, so the plan is refused rather than applied.
  const digest = await hexDigest('SHA-256', await readFile(member.file));
  const planned = await planStagedApply(github, member.file, ({ repository }) => {
    if (!sameRepository(repository, member.repository)) {
      throw new ProfileError(`${member.file} applies to ${repository}, not ${member.repository}`);
    }
  });
  const access = await readAccess(github, parseRepo(planned.staged.repository));
  const { file, repository, profiles, exclude } = planned.staged;
  return {
    ...planned.plan,
    file: member.file,
    digest,
    access,
    locks: lockChanges(access, planned.plan.changes),
    staged: { file, repository, profiles, exclude },
    batch_profiles: memberProfiles(batch, member),
    exclusions: planned.exclusions,
  };
}

/** `map` must not throw. */
async function mapLimited<T, R>(items: readonly T[], limit: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  const queue = [...items.entries()];
  const worker = async (): Promise<void> => {
    for (let entry = queue.shift(); entry !== undefined; entry = queue.shift()) {
      const [index, item] = entry;
      results[index] = await map(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * A member that cannot be planned, as when the App is not installed on it or
 * its staged apply no longer resolves, is a failure of its own, and the rest
 * are planned all the same.
 */
export async function planBatch(github: GitHub, folder: string): Promise<BatchPlan> {
  const batch = await readBatch(folder);
  const included = batch.members.filter((member) => !member.left_out);
  const planned = await mapLimited(included, planningConcurrency, async (member) => {
    try {
      return { member, plan: await planMember(github, batch, member) };
    } catch (error) {
      return { member, error: memberError(error) };
    }
  });
  return {
    batch: batch.folder,
    id: batch.id,
    profiles: batch.profiles,
    plans: planned.flatMap((item) => ('plan' in item ? [item.plan] : [])),
    left_out: batch.members
      .filter((member) => member.left_out)
      .map((member) => ({ repository: member.repository, file: member.file })),
    failures: planned.flatMap((item) =>
      'error' in item ? [{ repository: item.member.repository, file: item.member.file, error: item.error }] : [],
    ),
  };
}

const savedMemberPlan = z.object({
  repository: z.string().regex(repoPattern),
  file: z.string().min(1),
  digest: z.string(),
  locks: z.array(z.object({ change: z.number().int(), reason: z.string() })),
});

const savedBatchPlan = z.object({
  batch: z.string().min(1),
  id: z.string().min(1),
  plans: z.array(z.unknown()),
});

interface ReviewedMember {
  readonly repository: string;
  readonly file: string;
  readonly digest: string;
  readonly plan: Plan;
  readonly locks: readonly Lock[];
}

export interface ReviewedBatch {
  readonly batch: string;
  readonly id: string;
  readonly plans: readonly ReviewedMember[];
}

export function isBatchPlan(data: unknown): boolean {
  return typeof data === 'object' && data !== null && Array.isArray((data as { plans?: unknown }).plans);
}

export function parseBatchPlan(data: unknown): ReviewedBatch {
  const saved = savedBatchPlan.parse(data);
  return {
    batch: saved.batch,
    id: saved.id,
    plans: saved.plans.map((member) => ({ ...savedMemberPlan.parse(member), plan: parsePlan(member) })),
  };
}

export type MemberResult = {
  readonly repository: string;
  /** Whether the member's staged apply ended and it left the batch. */
  readonly ended: boolean;
} & (
  | { readonly status: 'applied'; readonly applied: readonly Change[] }
  | { readonly status: 'in_line' }
  | { readonly status: 'locked'; readonly locks: readonly Lock[] }
  | { readonly status: 'left_out' }
  | { readonly status: 'changed' }
  | { readonly status: 'stopped' }
  | { readonly status: 'stale'; readonly message: string; readonly current: Plan }
  | {
      readonly status: 'apply_failed';
      readonly message: string;
      readonly applied: readonly Change[];
      readonly failed: Change;
      readonly reason: string | null;
      readonly cause: unknown;
    }
  | { readonly status: 'failed'; readonly error: MemberError }
);

export function isFailure(result: MemberResult): boolean {
  return result.status === 'stale' || result.status === 'apply_failed' || result.status === 'failed';
}

export function isUnfinished(result: MemberResult): boolean {
  return isFailure(result) || result.status === 'locked' || result.status === 'changed' || result.status === 'stopped';
}

export interface BatchApplyOptions {
  readonly only?: readonly string[];
  /** The members after the first failure are `stopped`. */
  readonly stopOnFailure?: boolean;
  readonly onResult?: (result: MemberResult) => void;
  /** Checks assignment state after revalidation and before the member writes. */
  readonly beforeApply?: (repository: string) => void;
}

function listsMember(batch: Batch, reviewed: ReviewedBatch, member: ReviewedMember): boolean {
  return (
    batch.id === reviewed.id &&
    batch.members.some(
      (item) =>
        sameRepository(item.repository, member.repository) && item.file === path.resolve(member.file) && !item.left_out,
    )
  );
}

async function isReviewedFile(member: ReviewedMember): Promise<boolean> {
  const content = await readFile(member.file).catch(() => undefined);
  return content !== undefined && (await hexDigest('SHA-256', content)) === member.digest;
}

async function endMember(reviewed: ReviewedBatch, member: ReviewedMember): Promise<boolean> {
  if (!(await isReviewedFile(member))) {
    return false;
  }
  // Set by the change, which sees the batch as it is now, each time it runs.
  const outcome = { ended: false };
  const left = await changeBatch(reviewed.batch, (batch) => {
    outcome.ended = listsMember(batch, reviewed, member);
    return outcome.ended
      ? { ...batch, members: batch.members.filter((item) => !sameRepository(item.repository, member.repository)) }
      : batch;
  });
  if (outcome.ended) {
    await removeFiles(left.folder, [member.file]);
    if (left.members.length === 0) {
      await endBatch(left);
    }
  }
  return outcome.ended;
}

async function resultIfNotTried(reviewed: ReviewedBatch, member: ReviewedMember): Promise<MemberResult | undefined> {
  const { repository } = member;
  // A batch that ended, moved or started over no longer holds the reviewed member.
  const listed = (await isBatch(reviewed.batch)) && listsMember(await readBatch(reviewed.batch), reviewed, member);
  if (!listed) {
    return { repository, ended: false, status: 'left_out' };
  }
  if (member.locks.length > 0) {
    return { repository, ended: false, status: 'locked', locks: member.locks };
  }
  if (!(await isReviewedFile(member))) {
    return { repository, ended: false, status: 'changed' };
  }
  return undefined;
}

async function applyMember(
  github: GitHub,
  reviewed: ReviewedBatch,
  member: ReviewedMember,
  beforeApply: BatchApplyOptions['beforeApply'],
): Promise<MemberResult> {
  const { repository } = member;
  let applied: readonly Change[];
  try {
    const resultWithoutTrying = await resultIfNotTried(reviewed, member);
    if (resultWithoutTrying !== undefined) {
      return resultWithoutTrying;
    }
    // Even a plan with no changes is planned again, so a member is never called in line on an old read.
    applied = await applyPlan(github, member.plan, () => beforeApply?.(repository));
  } catch (error) {
    if (error instanceof StalePlanError) {
      return { repository, ended: false, status: 'stale', message: error.message, current: error.current };
    }
    if (error instanceof ApplyError) {
      return {
        repository,
        ended: false,
        status: 'apply_failed',
        message: describeFailure(error),
        applied: error.applied,
        failed: error.failed,
        reason: failureReason(error),
        cause: error.cause,
      };
    }
    return { repository, ended: false, status: 'failed', error: memberError(error) };
  }
  // The repository is in line now; a failure to end its staged apply only leaves it to plan again.
  const ended = await endMember(reviewed, member).catch(() => false);
  return member.plan.changes.length > 0
    ? { repository, ended, status: 'applied', applied }
    : { repository, ended, status: 'in_line' };
}

export function chosenMembers(reviewed: ReviewedBatch, only: readonly string[] | undefined): readonly ReviewedMember[] {
  if (only === undefined) {
    return reviewed.plans;
  }
  for (const repository of only) {
    if (!reviewed.plans.some((member) => sameRepository(member.repository, repository))) {
      throw new ProfileError(`The batch plan has no plan for ${repository}`);
    }
  }
  return reviewed.plans.filter((member) => only.some((repository) => sameRepository(repository, member.repository)));
}

/**
 * Each member is applied as `applyPlan` applies one plan, so it is planned
 * again and written only when its changes are the reviewed ones. A member with
 * locks is not tried, and neither is one the batch no longer holds as
 * reviewed, nor one whose staged apply changed since the review.
 */
export async function applyBatch(
  github: GitHub,
  reviewed: ReviewedBatch,
  options: BatchApplyOptions = {},
): Promise<MemberResult[]> {
  const { only, stopOnFailure = false, onResult } = options;
  const results: MemberResult[] = [];
  let stopped = false;
  for (const member of chosenMembers(reviewed, only)) {
    const result: MemberResult = stopped
      ? { repository: member.repository, ended: false, status: 'stopped' }
      : await applyMember(github, reviewed, member, options.beforeApply);
    stopped ||= stopOnFailure && isFailure(result);
    results.push(result);
    onResult?.(result);
  }
  return results;
}
