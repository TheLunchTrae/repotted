import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parse, stringify } from 'yaml';
import { z } from 'zod';

import type { Change } from './change.js';
import { replaceFile } from './files.js';
import { type GitHub, GitHubError, parseRepo, repoPattern } from './github.js';
import { type Access, type Lock, lockChanges } from './permissions.js';
import { ApplyError, applyPlan, failureReason, parsePlan, type Plan, StalePlanError } from './plan.js';
import { ProfileError, resolveProfile } from './profile.js';
import { readAccess } from './repositories.js';
import {
  createStagedApply,
  editStagedApply,
  type PlanExclusion,
  planStagedApply,
  resolveStagedApply,
  type StagedApply,
  stagedExcludes,
  stagedSets,
} from './staged.js';

// A batch applies one profile to several repositories through a staged apply
// for each, so each repository is reviewed, edited and applied as one staged
// apply is, and still has one apply in progress at a time. The batch itself
// is a folder holding a manifest, batch.yaml, that lists its staged applies.
// Repositories are planned a few at a time and applied one at a time, in the
// manifest's order, so a failure is easy to follow and a stop is clean.

/** The manifest's name in a batch folder. */
export const batchManifest = 'batch.yaml';

/** How many members a batch plans at once. */
const planningConcurrency = 4;

const savedMember = z
  .object({
    repository: z.string().regex(repoPattern, 'Use owner/name'),
    /** The staged apply file, relative to the batch folder unless it is elsewhere on another drive. */
    file: z.string().min(1),
    /** Left out of the batch's plans and applies until it is put back. */
    left_out: z.boolean().optional(),
    /** A staged apply that was in progress before the batch, which discarding the batch leaves as it is. */
    joined: z.boolean().optional(),
  })
  .strict();

const savedManifest = z
  .object({
    /** The profile new members start from, relative to the folder, or null for the repository as it is. */
    profile: z.string().min(1).nullable(),
    members: z.array(savedMember),
  })
  .strict()
  .superRefine((value, context) => {
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

/** One repository of a batch, and the staged apply that brings it to the batch's profile. */
export interface BatchMember {
  readonly repository: string;
  /** The staged apply file's absolute path. */
  readonly file: string;
  readonly left_out: boolean;
  readonly joined: boolean;
}

/** A batch as its manifest lists it. */
export interface Batch {
  /** The batch folder's real path. */
  readonly folder: string;
  /** The absolute path of the profile new members start from, or null for the repository as it is. */
  readonly profile: string | null;
  readonly members: readonly BatchMember[];
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined;
}

/** Removes `from` and the folders above it while they are empty, up to and including `folder`. */
async function removeEmptyFolders(folder: string, from: string): Promise<void> {
  const relative = path.relative(folder, from);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return;
  }
  for (let current = from; ; current = path.dirname(current)) {
    try {
      await rmdir(current);
    } catch {
      return;
    }
    if (current === folder) {
      return;
    }
  }
}

/** Removes staged applies a batch started, and the folders in the batch they leave empty. */
async function removeStarted(folder: string, files: readonly string[]): Promise<void> {
  for (const file of files) {
    await rm(file, { force: true });
    await removeEmptyFolders(folder, path.dirname(file));
  }
}

function sameRepository(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/** Ends a member's staged apply by removing its file, and the folders in the batch that it leaves empty. */
async function removeStagedFile(batch: Batch, file: string): Promise<void> {
  // A file that is gone is already discarded; one that no longer reads as a staged apply goes too.
  await rm(file, { force: true });
  await removeEmptyFolders(batch.folder, path.dirname(file));
}

/** Removes the manifest of an empty batch, and its folder once nothing else is in it. */
async function endBatch(batch: Batch): Promise<void> {
  await rm(path.join(batch.folder, batchManifest), { force: true });
  await removeEmptyFolders(batch.folder, batch.folder);
}

/** `target` as the manifest in `folder` stores it: relative, with forward slashes, unless only an absolute path reaches it. */
function storedPath(folder: string, target: string): string {
  const relative = path.relative(folder, target);
  return path.isAbsolute(relative) ? target : relative.split(path.sep).join('/');
}

async function realFolder(folder: string): Promise<string> {
  return realpath(path.resolve(folder)).catch(() => path.resolve(folder));
}

function fromSaved(folder: string, saved: SavedManifest): Batch {
  return {
    folder,
    profile: saved.profile === null ? null : path.resolve(folder, saved.profile),
    members: saved.members.map((member) => ({
      repository: member.repository,
      file: path.resolve(folder, member.file),
      left_out: member.left_out === true,
      joined: member.joined === true,
    })),
  };
}

function toSaved(batch: Batch): SavedManifest {
  return {
    profile: batch.profile === null ? null : storedPath(batch.folder, batch.profile),
    members: batch.members.map((member) => ({
      repository: member.repository,
      file: storedPath(batch.folder, member.file),
      ...(member.left_out ? { left_out: true } : {}),
      ...(member.joined ? { joined: true } : {}),
    })),
  };
}

const manifestHeader = [
  '# A batch: one profile applied to several repositories, each through a staged apply of its own.',
  '# Change it with repotted stage <folder>; a repository is planned and applied as its staged apply is.',
].join('\n');

function manifestText(batch: Batch): string {
  return `${manifestHeader}\n${stringify(toSaved(batch), { lineWidth: 0 })}`;
}

/** Whether `folder` holds a batch, as a folder with a manifest. */
export async function isBatch(folder: string): Promise<boolean> {
  return readFile(path.join(folder, batchManifest)).then(
    () => true,
    () => false,
  );
}

/** Reads the batch in `folder`. */
export async function readBatch(folder: string): Promise<Batch> {
  const real = await realFolder(folder);
  const file = path.join(real, batchManifest);
  let data: unknown;
  try {
    data = parse(await readFile(file, 'utf8')) ?? {};
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
  return fromSaved(real, result.data);
}

/**
 * Changes the batch in `folder`: `change` gets the batch as one read finds
 * it and returns it as it should be, and the manifest is replaced whole.
 */
async function changeBatch(folder: string, change: (batch: Batch) => Batch | Promise<Batch>): Promise<Batch> {
  const batch = await readBatch(folder);
  const changed = await change(batch);
  await replaceFile(path.join(batch.folder, batchManifest), manifestText(changed), { create: false });
  return changed;
}

/** What to add to a batch: new staged applies, from its profile, and staged applies already in progress. */
export interface BatchAdditions {
  /** Repositories to start a staged apply for, as owner/name. */
  readonly repositories?: readonly string[];
  /** Staged apply files to add as they are. */
  readonly join?: readonly string[];
  /**
   * The folder new staged applies go in, as `<owner>/<name>.yaml`. The batch
   * folder by default.
   */
  readonly stagedFolder?: string;
}

/** Where a new member's staged apply goes. */
function newStagedFile(folder: string, repository: string): string {
  const repo = parseRepo(repository);
  return path.join(folder, repo.owner, `${repo.name}.yaml`);
}

/**
 * The members `additions` adds to `batch`. The staged applies it starts are
 * removed again when any addition fails, so a failed addition leaves no file
 * behind.
 */
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
      added.push({ repository: staged.repository, file: staged.file, left_out: false, joined: true });
    }
    const stagedFolder = path.resolve(additions.stagedFolder ?? batch.folder);
    for (const repository of additions.repositories ?? []) {
      const repo = parseRepo(repository);
      const name = `${repo.owner}/${repo.name}`;
      claim(name);
      const file = newStagedFile(stagedFolder, name);
      await mkdir(path.dirname(file), { recursive: true });
      try {
        await createStagedApply(file, name, batch.profile ?? undefined);
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
      added.push({ repository: name, file: path.resolve(file), left_out: false, joined: false });
    }
  } catch (error) {
    await removeStarted(batch.folder, started);
    throw error;
  }
  return added;
}

/** What starts a batch: its profile, or none to start each repository from itself, and its first members. */
export interface BatchStart extends BatchAdditions {
  readonly profile?: string;
}

/**
 * Starts a batch in `folder`, which is made if it is missing and must hold no
 * batch yet. It starts a staged apply for each repository, from the profile,
 * and adds each staged apply in `join` as it is. Nothing is left behind when
 * any of them fails.
 */
export async function createBatch(folder: string, start: BatchStart): Promise<Batch> {
  if ((start.repositories ?? []).length + (start.join ?? []).length === 0) {
    throw new ProfileError('A batch needs at least one repository');
  }
  if (await isBatch(folder)) {
    throw new ProfileError(`${folder} already holds a batch`);
  }
  // Resolving first means a batch never starts from a broken profile.
  const profile =
    start.profile === undefined
      ? null
      : ((await resolveProfile(start.profile)).chain[0] ?? path.resolve(start.profile));
  // The first folder mkdir made, if any, so a failed start removes what it made.
  const made = await mkdir(folder, { recursive: true });
  const real = await realFolder(folder);
  const empty: Batch = { folder: real, profile, members: [] };
  try {
    const members = await addMembers(empty, start);
    const batch = { ...empty, members };
    try {
      await writeFile(path.join(real, batchManifest), manifestText(batch), { flag: 'wx' });
    } catch (error) {
      await removeStarted(
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

/** Adds members to the batch in `folder`, as `createBatch` starts them, from the batch's profile. */
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
    await removeStarted(
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

/** The staged apply file of `repository` in the batch in `folder`, to show or edit it as any staged apply. */
export async function batchMemberFile(folder: string, repository: string): Promise<string> {
  return findMember(await readBatch(folder), repository).file;
}

/** Leaves repositories out of the batch's plans and applies, or puts them back. */
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

/** What excluding, or including, one key in every member did to each. */
export interface EverywhereResult {
  readonly batch: Batch;
  /** The members whose staged apply changed. */
  readonly changed: readonly string[];
  /** The members it could not change, and why; a member it had nothing to do in is in neither list. */
  readonly refused: readonly { readonly repository: string; readonly message: string }[];
}

/**
 * Excludes `key` from every member of the batch in `folder` whose profile
 * sets what it names, or includes it again in every member that excludes
 * it. Members left out of the batch change too, so putting one back finds
 * it as the rest. A member that refuses the change, as when its own edits
 * set the value, keeps its staged apply as it is and is named in `refused`.
 */
export async function editEverywhere(folder: string, key: string, excluded: boolean): Promise<EverywhereResult> {
  const batch = await readBatch(folder);
  const changed: string[] = [];
  const refused: { repository: string; message: string }[] = [];
  for (const member of batch.members) {
    try {
      const staged = await resolveStagedApply(member.file);
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
    throw new ProfileError(
      excluded
        ? `Cannot exclude ${key}: no repository's profile in the batch sets what it names`
        : `No repository in the batch excludes ${key}`,
    );
  }
  return { batch, changed, refused };
}

/**
 * Takes `repository` out of the batch in `folder` and discards its staged
 * apply, joined or not. The batch ends with its last member.
 */
export async function discardBatchMember(folder: string, repository: string): Promise<Batch> {
  const batch = await readBatch(folder);
  const member = findMember(batch, repository);
  const left = await changeBatch(folder, (current) => ({
    ...current,
    members: current.members.filter((item) => !sameRepository(item.repository, member.repository)),
  }));
  await removeStagedFile(left, member.file);
  if (left.members.length === 0) {
    await endBatch(left);
  }
  return left;
}

/**
 * Ends the batch in `folder`: discards the staged applies it started and
 * removes its manifest. A staged apply that joined the batch stays, as it
 * was before the batch, and so do the profiles.
 */
export async function discardBatch(folder: string): Promise<void> {
  const batch = await readBatch(folder);
  for (const member of batch.members) {
    if (!member.joined) {
      await removeStagedFile(batch, member.file);
    }
  }
  await endBatch(batch);
}

/** Why a member could not be planned or applied, as `--json` reports any failure. */
export interface MemberError {
  readonly kind: 'signed_out' | 'error';
  readonly message: string;
  /** The HTTP status GitHub answered with, or null when the failure was not GitHub's answer. */
  readonly status: number | null;
}

function memberError(error: unknown): MemberError {
  const message = error instanceof Error ? error.message : String(error);
  for (let current = error; current instanceof Error; current = current.cause) {
    if (current instanceof GitHubError) {
      return { kind: current.status === 401 ? 'signed_out' : 'error', message, status: current.status };
    }
  }
  return { kind: 'error', message, status: null };
}

/** One member's plan, as a staged apply's plan is shown, with the access that decides its locks. */
export interface MemberPlan {
  readonly repository: string;
  readonly file: string;
  /**
   * The staged apply file's SHA-256 when it was planned. Applying ends the
   * staged apply only when the file is still the same, so an edit made after
   * the review is never lost.
   */
  readonly digest: string;
  readonly plan: Plan;
  readonly access: Access;
  readonly locks: readonly Lock[];
  readonly staged: Pick<StagedApply, 'file' | 'repository' | 'base' | 'exclude'>;
  readonly exclusions: readonly PlanExclusion[];
}

/** Every member of a batch, planned: each plan, the members left out, and the members that could not be planned. */
export interface BatchPlan {
  readonly batch: string;
  readonly profile: string | null;
  readonly plans: readonly MemberPlan[];
  readonly left_out: readonly { readonly repository: string; readonly file: string }[];
  readonly failures: readonly { readonly repository: string; readonly file: string; readonly error: MemberError }[];
}

function digestOf(content: Uint8Array | string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function planMember(github: GitHub, member: BatchMember): Promise<MemberPlan> {
  const digest = digestOf(await readFile(member.file));
  const planned = await planStagedApply(github, member.file, ({ repository }) => {
    if (!sameRepository(repository, member.repository)) {
      throw new ProfileError(`${member.file} applies to ${repository}, not ${member.repository}`);
    }
  });
  const access = await readAccess(github, parseRepo(planned.staged.repository));
  const { file, repository, base, exclude } = planned.staged;
  return {
    repository: member.repository,
    file: member.file,
    digest,
    plan: planned.plan,
    access,
    locks: lockChanges(access, planned.plan.changes),
    staged: { file, repository, base, exclude },
    exclusions: planned.exclusions,
  };
}

/** Maps `items` with at most `limit` maps running at once, keeping their order. `map` must not throw. */
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
 * Plans every member of the batch in `folder` that is not left out, a few at
 * a time. A member that cannot be planned, as when the App is not installed
 * on it or its staged apply no longer resolves, is a failure of its own, and
 * the rest are planned all the same.
 */
export async function planBatch(github: GitHub, folder: string): Promise<BatchPlan> {
  const batch = await readBatch(folder);
  const included = batch.members.filter((member) => !member.left_out);
  const planned = await mapLimited(included, planningConcurrency, async (member) => {
    try {
      return { member, plan: await planMember(github, member) };
    } catch (error) {
      return { member, error: memberError(error) };
    }
  });
  return {
    batch: batch.folder,
    profile: batch.profile,
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
  plan: z.unknown(),
  locks: z.array(z.object({ change: z.number().int(), reason: z.string() })),
});

const savedBatchPlan = z.object({ batch: z.string().min(1), plans: z.array(savedMemberPlan) });

/** A saved batch plan, as apply reads it: each member's reviewed plan and what it needs to end its staged apply. */
export interface ReviewedBatch {
  readonly batch: string;
  readonly plans: readonly {
    readonly repository: string;
    readonly file: string;
    readonly digest: string;
    readonly plan: Plan;
    readonly locks: readonly Lock[];
  }[];
}

/** Whether a saved plan document is a batch's, which lists its members' plans. */
export function isBatchPlan(data: unknown): boolean {
  return typeof data === 'object' && data !== null && Array.isArray((data as { plans?: unknown }).plans);
}

export function parseBatchPlan(data: unknown): ReviewedBatch {
  const saved = savedBatchPlan.parse(data);
  return { batch: saved.batch, plans: saved.plans.map((member) => ({ ...member, plan: parsePlan(member.plan) })) };
}

/**
 * How applying one member ended. `applied` and `in_line` finish it; `stale`,
 * `apply_failed` and `failed` are failures; `locked`, `left_out` and
 * `stopped` were not tried.
 */
export type MemberResult = {
  readonly repository: string;
  /** Whether the member's staged apply ended, and it left the batch, now that it is applied. */
  readonly ended: boolean;
} & (
  | { readonly status: 'applied'; readonly applied: readonly Change[] }
  | { readonly status: 'in_line' }
  | { readonly status: 'locked'; readonly locks: readonly Lock[] }
  | { readonly status: 'left_out' }
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

/** Whether applying a member was tried and failed: what `stopOnFailure` stops at. */
export function isFailure(result: MemberResult): boolean {
  return result.status === 'stale' || result.status === 'apply_failed' || result.status === 'failed';
}

export interface BatchApplyOptions {
  /** Applies only these members, as the desktop applies one at a time; every member when undefined. */
  readonly only?: readonly string[];
  /** Stops at the first member that does not finish; the rest are `stopped`. */
  readonly stopOnFailure?: boolean;
  /** Called with each member's result as soon as it is known. */
  readonly onResult?: (result: MemberResult) => void;
}

/**
 * Ends an applied member's staged apply and takes it out of the batch, when
 * the batch still lists it with that file and the file is the one reviewed.
 * Returns whether it did. A batch that no longer exists ends nothing.
 */
async function endMember(folder: string, member: ReviewedBatch['plans'][number]): Promise<boolean> {
  if (!(await isBatch(folder))) {
    return false;
  }
  const content = await readFile(member.file).catch(() => undefined);
  if (content === undefined || digestOf(content) !== member.digest) {
    return false;
  }
  // Set by the change, which sees the batch as it is now.
  const outcome = { ended: false };
  const left = await changeBatch(folder, (batch) => {
    const listed = batch.members.find(
      (item) => sameRepository(item.repository, member.repository) && item.file === path.resolve(member.file),
    );
    if (listed === undefined) {
      return batch;
    }
    outcome.ended = true;
    return { ...batch, members: batch.members.filter((item) => item !== listed) };
  });
  if (outcome.ended) {
    await removeStagedFile(left, member.file);
    if (left.members.length === 0) {
      await endBatch(left);
    }
  }
  return outcome.ended;
}

/** Whether the batch, as it is now, has `repository` left out or no longer lists it, so its reviewed plan is not applied. */
async function nowLeftOut(folder: string, repository: string): Promise<boolean> {
  if (!(await isBatch(folder))) {
    return false;
  }
  const member = (await readBatch(folder)).members.find((item) => sameRepository(item.repository, repository));
  return member === undefined || member.left_out;
}

async function applyMember(
  github: GitHub,
  folder: string,
  member: ReviewedBatch['plans'][number],
): Promise<MemberResult> {
  const { repository } = member;
  if (await nowLeftOut(folder, repository)) {
    return { repository, ended: false, status: 'left_out' };
  }
  if (member.locks.length > 0) {
    return { repository, ended: false, status: 'locked', locks: member.locks };
  }
  let applied: readonly Change[] = [];
  if (member.plan.changes.length > 0) {
    try {
      applied = await applyPlan(github, member.plan);
    } catch (error) {
      if (error instanceof StalePlanError) {
        return { repository, ended: false, status: 'stale', message: error.message, current: error.current };
      }
      if (error instanceof ApplyError) {
        return {
          repository,
          ended: false,
          status: 'apply_failed',
          message: error.message,
          applied: error.applied,
          failed: error.failed,
          reason: failureReason(error),
          cause: error.cause,
        };
      }
      return { repository, ended: false, status: 'failed', error: memberError(error) };
    }
  }
  // The repository is in line now; a failure to end its staged apply only leaves it to plan again.
  const ended = await endMember(folder, member).catch(() => false);
  return member.plan.changes.length > 0
    ? { repository, ended, status: 'applied', applied }
    : { repository, ended, status: 'in_line' };
}

/**
 * Applies a reviewed batch one member at a time, in its order. Each member is
 * applied as `applyPlan` applies one plan, so it is planned again and written
 * only when its changes are the reviewed ones. A member with locks is not
 * tried, and one the batch now leaves out or no longer lists is not either.
 * A member that fails does not stop the rest unless `stopOnFailure` says so.
 * Each member that finishes ends its staged apply and leaves the batch,
 * and the batch ends with its last member.
 */
export async function applyBatch(
  github: GitHub,
  reviewed: ReviewedBatch,
  options: BatchApplyOptions = {},
): Promise<MemberResult[]> {
  const { only, stopOnFailure = false, onResult } = options;
  if (only !== undefined) {
    for (const repository of only) {
      if (!reviewed.plans.some((member) => sameRepository(member.repository, repository))) {
        throw new ProfileError(`The batch plan has no plan for ${repository}`);
      }
    }
  }
  const results: MemberResult[] = [];
  let stopped = false;
  for (const member of reviewed.plans) {
    if (only !== undefined && !only.some((repository) => sameRepository(repository, member.repository))) {
      continue;
    }
    const result: MemberResult = stopped
      ? { repository: member.repository, ended: false, status: 'stopped' }
      : await applyMember(github, reviewed.batch, member);
    stopped ||= stopOnFailure && isFailure(result);
    results.push(result);
    onResult?.(result);
  }
  return results;
}
