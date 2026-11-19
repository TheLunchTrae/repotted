import { computed, signal } from '@preact/signals';
import {
  applyBatch,
  type AuthoritativeSection,
  type BatchPlan,
  copyEditsEverywhere,
  createBatch,
  createStagedApply,
  describeSkipped,
  describeWarning,
  discardBatchMember,
  editEverywhere,
  editStagedApply,
  type GitHub,
  isBatch,
  leaveOut,
  type MemberResult,
  planBatch,
  readBatch,
  resolveStagedApply,
} from '@repotted/core';

import { mkdir, rm } from '../../engine/files.js';
import { basename, dirname } from '../../engine/path.js';
import { isSignedOut } from '../account/account.js';
import { ProfileEditor } from '../profile-editor/profile-editor.js';
import {
  assignmentKey,
  assignmentSource,
  canRecordAssignment,
  type ProfileAssignments,
  reviewedProfileVersions,
} from '../repositories/assignment-review.js';
import { profileName, profileVersion } from '../repositories/repository-profiles.js';
import type { AppliedVersion } from '../repositories/saved-assignments.js';
import { stagedStore } from './apply.js';
import { type ComparedProfile, type CompareSection, compareSections, exclusionLabel } from './comparison.js';

export interface BatchMemberView {
  readonly repository: string;
  readonly profiles: readonly string[];
  readonly authoritative: readonly AuthoritativeSection[];
  readonly status: 'changes' | 'in-line' | 'needs-access' | 'failed' | 'left-out';
  readonly changes: number;
  readonly comparisonFailureMessage: string | undefined;
  readonly sections: readonly CompareSection[];
  readonly leftOut: readonly string[];
  readonly skippedDrafts: readonly string[];
  readonly warnings: readonly string[];
}

/** `key` leaves the change out everywhere; `repositories` names those whose plans include it. */
export interface BatchChange {
  readonly key: string;
  readonly label: string;
  readonly repositories: readonly string[];
}

interface Named {
  readonly profileName: string;
}

export type BatchState =
  | { readonly kind: 'idle' }
  | ({
      readonly kind: 'editing';
      /** The one-off edits every repository gets, this once. */
      readonly repositories: readonly string[];
    } & Named)
  | ({
      readonly kind: 'reviewing';
      /** The review this one replaces, which stays in view while it runs; none on the first. */
      readonly members: readonly BatchMemberView[];
    } & Named)
  | ({
      readonly kind: 'failed';
      readonly message: string;
      readonly hasBatchToReviewAgain: boolean;
    } & Named)
  | ({
      readonly kind: 'reviewed';
      /** Travels with the review, so no other plan can be applied in its place. */
      readonly plan: BatchPlan;
      readonly members: readonly BatchMemberView[];
      /** What a change everywhere couldn't do in some repository, as when its own edits set the value. */
      readonly refused: readonly string[];
      readonly appliedVersions: ReadonlyMap<string, readonly AppliedVersion[]>;
      /**
       * By repository, the one profile its apply is of that it doesn't use yet,
       * which it can add to the end of its list. No version when the apply
       * doesn't give all the profile sets, so it counts as not applied yet.
       */
      readonly additions: ReadonlyMap<string, ProfileAddition>;
      readonly assignments: ReadonlyMap<string, string>;
    } & Named)
  | ({
      readonly kind: 'applying';
      readonly total: number;
      readonly results: readonly BatchResult[];
    } & Named)
  | ({ readonly kind: 'applied'; readonly results: readonly BatchResult[]; readonly left: number } & Named);

export interface ProfileAddition {
  readonly profile: string;
  readonly version: string | undefined;
}

export interface BatchResult {
  readonly repository: string;
  /** Written, or already in line. */
  readonly finished: boolean;
  readonly said: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nameOf(profiles: readonly string[]): string {
  return profiles.map((profile) => basename(profile).replace(/\.ya?ml$/u, '')).join(', ');
}

/** A message with its files by their names, not by where the browser keeps them. */
function cleaned(message: string): string {
  return message
    .replaceAll(/\/apply\/[^/\s]+\/batch/gu, 'the batch')
    .replaceAll(/\/profiles\/(?:browser\/|github\/[^/]+\/[^/]+\/@[^/]+\/)?/gu, '');
}

function count(amount: number, noun: string): string {
  return amount === 1 ? `1 ${noun}` : `${amount} ${noun}s`;
}

function resultOf(result: MemberResult): BatchResult {
  const { repository } = result;
  switch (result.status) {
    case 'applied':
      return { repository, finished: true, said: `${count(result.applied.length, 'change')} written.` };
    case 'in_line':
      return { repository, finished: true, said: 'Already in line: nothing to write.' };
    case 'locked':
      return { repository, finished: false, said: 'Not written: GitHub would refuse one of its changes.' };
    case 'left_out':
      return { repository, finished: false, said: 'Left out of the batch.' };
    case 'changed':
      return { repository, finished: false, said: 'Not written: its apply changed since the review.' };
    case 'stopped':
      return { repository, finished: false, said: 'Not written: the batch stopped before it.' };
    case 'stale':
      return {
        repository,
        finished: false,
        said: 'Not written: the repository changed since the review.',
      };
    case 'apply_failed':
      return {
        repository,
        finished: false,
        // The message's first line says what failed and why; the rest is advice for a terminal.
        said: `${result.message.split('\n')[0] ?? ''}. ${count(result.applied.length, 'change')} before it ${result.applied.length === 1 ? 'stays' : 'stay'} written, and nothing after it was.`,
      };
    case 'failed':
      return { repository, finished: false, said: cleaned(result.error.message) };
  }
}

function membersOf(plan: BatchPlan, assignments: ProfileAssignments | undefined): BatchMemberView[] {
  const planned = plan.plans.map((member): BatchMemberView => {
    const locks = new Map(member.locks.map((lock) => [lock.change, lock.reason]));
    return {
      repository: member.repository,
      profiles: member.staged.profiles.map((file) =>
        (assignments?.pathOf(file) ?? basename(file)).replace(/\.ya?ml$/iu, ''),
      ),
      authoritative: member.authoritative ?? [],
      status: member.locks.length > 0 ? 'needs-access' : member.changes.length === 0 ? 'in-line' : 'changes',
      changes: member.changes.length,
      comparisonFailureMessage: undefined,
      sections: compareSections(member, locks, member.exclusions),
      leftOut: member.staged.exclude,
      skippedDrafts: member.skipped.map(describeSkipped),
      warnings: member.warnings.map(describeWarning),
    };
  });
  const rest = (repository: string, status: 'failed' | 'left-out', message: string | undefined): BatchMemberView => ({
    repository,
    profiles: [],
    authoritative: [],
    status,
    changes: 0,
    comparisonFailureMessage: message,
    sections: [],
    leftOut: [],
    skippedDrafts: [],
    warnings: [],
  });
  return [
    ...planned,
    ...plan.failures.map((failure) =>
      rest(
        failure.repository,
        'failed',
        failure.error.message.includes('ENOENT')
          ? 'Its apply is gone: it was applied or discarded on its own. Remove it from the batch.'
          : cleaned(failure.error.message),
      ),
    ),
    ...plan.left_out.map((member) => rest(member.repository, 'left-out', undefined)),
  ];
}

/**
 * The engine's batch holds this page's review in temporary files, discarded
 * when the page is left. Nothing is
 * written to GitHub except by `apply`, which hands the engine the plan of
 * the review that is shown; the engine plans each repository again and
 * writes nothing to one that changed, is locked, or whose apply was edited
 * since.
 */
export class BatchApply {
  readonly state = signal<BatchState>({ kind: 'idle' });
  /** Only for a batch that changes settings once, without a profile: the edits each repository gets. */
  readonly editor = signal<ProfileEditor | undefined>(undefined);

  readonly #github: GitHub;
  readonly #onSignedOut: () => void;
  readonly #assignments: ProfileAssignments | undefined;
  readonly #onApplied: ((repositories: number) => void) | undefined;
  /** Counts what the state can go out of date by, so work that lands late changes nothing. */
  #turn = 0;
  #folder: string | undefined;
  #assigned = new Map<string, string>();
  /**
   * The staged apply that holds a batch's one-off edits, beside the batch,
   * copied into every repository's own before each review.
   */
  #edits: string | undefined;

  constructor(
    github: GitHub,
    onSignedOut: () => void,
    assignments?: ProfileAssignments,
    onApplied?: (repositories: number) => void,
  ) {
    this.#github = github;
    this.#onSignedOut = onSignedOut;
    this.#assignments = assignments;
    this.#onApplied = onApplied;
  }

  /** Those with changes and none GitHub would refuse. */
  readonly ready = computed(() => {
    const state = this.state.value;
    return state.kind === 'reviewed' ? state.members.filter((member) => member.status === 'changes') : [];
  });

  /** Deselected, an apply of one profile is a one-time apply: the repositories keep no record of it. */
  readonly addToRepositoryProfiles = signal(true);

  /** The profile the repositories can add to their lists, by name; none when no repository can. */
  readonly addOffer = computed(() => {
    const state = this.state.value;
    const [first] = state.kind === 'reviewed' ? state.additions.values() : [];
    return first === undefined ? undefined : profileName(first.profile);
  });

  readonly canRecordWithoutChanges = computed(() => {
    const state = this.state.value;
    return (
      state.kind === 'reviewed' &&
      this.ready.value.length === 0 &&
      state.members.some(
        (member) =>
          member.status === 'in-line' &&
          (state.appliedVersions.has(member.repository) ||
            (state.additions.get(member.repository)?.version !== undefined && this.addToRepositoryProfiles.value)),
      )
    );
  });

  /** The repositories as last reviewed, which stay in view while they are reviewed again. */
  readonly members = computed((): readonly BatchMemberView[] => {
    const state = this.state.value;
    return state.kind === 'reviewed' || state.kind === 'reviewing' ? state.members : [];
  });

  readonly changes = computed((): BatchChange[] => {
    const found = new Map<string, string[]>();
    for (const member of this.members.value) {
      const keys = new Set(member.sections.flatMap((section) => section.rows.flatMap((row) => row.leaveOut ?? [])));
      for (const key of keys) {
        found.set(key, [...(found.get(key) ?? []), member.repository]);
      }
    }
    return [...found].map(([key, repositories]) => ({ key, label: exclusionLabel(key), repositories }));
  });

  readonly leftOut = computed(() => [...new Set(this.members.value.flatMap((member) => member.leftOut))]);

  async start(repositories: readonly string[], profile: ComparedProfile): Promise<void> {
    await this.#start(profile.name, [profile.file], repositories);
  }

  async startFromProfiles(
    repositories: readonly { readonly repository: string; readonly profiles: readonly ComparedProfile[] }[],
  ): Promise<void> {
    await this.#start(
      '',
      [],
      repositories.map(({ repository, profiles }) => ({
        repository,
        profiles: profiles.map((profile) => profile.file),
        authoritative: this.#assignments?.authoritativeOf(repository) ?? [],
      })),
    );
  }

  /**
   * Each repository starts from what it has, and every one gets the same
   * one-off edits, which open first. Nothing is recorded on the repositories.
   */
  async startWithoutProfile(repositories: readonly string[]): Promise<void> {
    const [first] = repositories;
    if (this.#writing() || first === undefined) {
      return;
    }
    const closing = this.close();
    this.addToRepositoryProfiles.value = true;
    this.#assigned = new Map();
    const folder = `/apply/${crypto.randomUUID()}/batch`;
    const edits = `${dirname(folder)}/edits.yaml`;
    this.#folder = folder;
    this.#edits = edits;
    await this.#work('', [], async (_folder, current) => {
      await closing;
      const batch = await createBatch(folder, { profiles: [], repositories });
      await mkdir(dirname(edits), { recursive: true });
      // Only the edits are read from it: it is never planned, so the repository it names is any of the batch's.
      await createStagedApply(edits, first, []);
      const editor = new ProfileEditor(edits, undefined, stagedStore);
      await editor.load();
      if (!current()) {
        return { kind: 'idle' };
      }
      this.editor.value = editor;
      return { kind: 'editing', profileName: '', repositories: batch.members.map((member) => member.repository) };
    });
  }

  /**
   * Edits that aren't saved are saved first, and then copied into every
   * repository's apply. It stays on the edits while one isn't valid.
   */
  async review(): Promise<void> {
    const state = this.state.value;
    const edits = this.#edits;
    // The page may have moved on while the edits were saved, and then there is nothing here to review.
    if (state.kind !== 'editing' || edits === undefined || !(await this.#saveEdits()) || this.state.value !== state) {
      return;
    }
    await this.#work(state.profileName, [], async (folder) => {
      const { refused } = await copyEditsEverywhere(folder, edits);
      // One that kept other edits would be applied with them, so it waits, left out, until it is put back.
      if (refused.length > 0) {
        await leaveOut(
          folder,
          refused.map((item) => item.repository),
          true,
        );
      }
      return this.#review(
        folder,
        refused.map((item) => `${item.repository}: ${cleaned(item.message)}`),
      );
    });
  }

  /** For a batch that changes settings once, as long as it holds repositories. */
  readonly canEdit = computed(() => {
    const state = this.state.value;
    return (
      this.editor.value !== undefined &&
      (state.kind === 'reviewed' ||
        (state.kind === 'failed' && state.hasBatchToReviewAgain) ||
        (state.kind === 'applied' && state.left > 0))
    );
  });

  async backToEdits(): Promise<void> {
    const state = this.state.value;
    if (this.canEdit.value && 'profileName' in state) {
      await this.#work(state.profileName, [], async (folder) => ({
        kind: 'editing',
        profileName: state.profileName,
        repositories: (await readBatch(folder)).members.map((member) => member.repository),
      }));
    }
  }

  /** Says whether nothing is left unsaved. */
  async #saveEdits(): Promise<boolean> {
    const editor = this.editor.value;
    if (editor === undefined || !editor.dirty.value) {
      return true;
    }
    if (!editor.canSave.value) {
      return false;
    }
    await editor.save((work) => work());
    // Read afresh: the save has changed them since they were looked at above.
    return !editor.dirty.peek() && editor.saveError.peek() === undefined;
  }

  async #start(
    profileName: string,
    profiles: readonly string[],
    repositories: readonly (
      | string
      | {
          readonly repository: string;
          readonly profiles: readonly string[];
          readonly authoritative: readonly AuthoritativeSection[];
        }
    )[],
  ): Promise<void> {
    if (this.#writing() || repositories.length === 0) {
      return;
    }
    const closing = this.close();
    this.addToRepositoryProfiles.value = true;
    const snapshots = new Map<string, string>();
    for (const input of repositories) {
      if (typeof input !== 'string' && this.#assignments !== undefined) {
        snapshots.set(input.repository, assignmentKey(this.#assignments, input.repository));
      }
    }
    this.#assigned = snapshots;
    this.#folder = `/apply/${crypto.randomUUID()}/batch`;
    await this.#work(profileName, [], async (folder) => {
      await closing;
      const batch = await createBatch(folder, { profiles, repositories });
      for (const member of batch.members) {
        const input = repositories.find((item) => typeof item !== 'string' && item.repository === member.repository);
        if (input !== undefined && typeof input !== 'string') {
          await editStagedApply(member.file, [{ authoritative: input.authoritative }]);
        }
      }
      return this.#review(folder, []);
    });
  }

  /** Not after a batch that ended, or that never started. */
  readonly canReviewAgain = computed(() => {
    const state = this.state.value;
    return (
      state.kind === 'reviewed' ||
      (state.kind === 'failed' && state.hasBatchToReviewAgain) ||
      (state.kind === 'applied' && state.left > 0)
    );
  });

  async reviewAgain(): Promise<void> {
    const state = this.state.value;
    if (this.canReviewAgain.value && 'profileName' in state) {
      await this.#work(state.profileName, this.members.value, (folder) => this.#review(folder, []));
    }
  }

  /** The repository's apply stays as it is. */
  async leaveOutRepository(repository: string, out: boolean): Promise<void> {
    const state = this.state.value;
    if (state.kind === 'reviewed') {
      await this.#work(state.profileName, state.members, async (folder) => {
        await leaveOut(folder, [repository], out);
        return this.#review(folder, []);
      });
    }
  }

  /** The batch ends with its last repository. */
  async remove(repository: string): Promise<void> {
    const state = this.state.value;
    if (state.kind === 'reviewed') {
      await this.#work(state.profileName, state.members, async (folder, current) => {
        const { batch } = await discardBatchMember(folder, repository);
        if (batch === null) {
          await rm(dirname(folder), { recursive: true, force: true });
          if (current()) {
            this.#edits = undefined;
            this.editor.value = undefined;
          }
          return { kind: 'idle' };
        }
        return this.#review(folder, []);
      });
    }
  }

  async leaveOut(repository: string, key: string, out: boolean): Promise<void> {
    const state = this.state.value;
    const file =
      state.kind === 'reviewed' ? state.plan.plans.find((member) => member.repository === repository)?.file : undefined;
    if (state.kind === 'reviewed' && file !== undefined) {
      await this.#work(state.profileName, state.members, async (folder) => {
        await editStagedApply(file, [{ exclude: key, excluded: out }]);
        return this.#review(folder, []);
      });
    }
  }

  async everywhere(key: string, out: boolean): Promise<void> {
    const state = this.state.value;
    if (state.kind === 'reviewed') {
      await this.#work(state.profileName, state.members, async (folder) => {
        const { refused } = await editEverywhere(folder, key, out);
        return this.#review(
          folder,
          refused.map((item) => `${item.repository}: ${cleaned(item.message)}`),
        );
      });
    }
  }

  /**
   * The engine plans each repository again first and writes nothing to one
   * that changed since the review, has a change GitHub would refuse, was left
   * out, or whose apply was edited since. A repository that finishes leaves
   * the batch, which ends with its last one.
   */
  async apply(): Promise<void> {
    const state = this.state.value;
    if (state.kind !== 'reviewed' || (this.ready.value.length === 0 && !this.canRecordWithoutChanges.value)) {
      return;
    }
    const { plan, profileName: profile } = state;
    const addToRepositoryProfiles = this.addToRepositoryProfiles.peek();
    const folder = this.#folder;
    if (folder === undefined) {
      return;
    }
    const turn = (this.#turn += 1);
    const results: BatchResult[] = [];
    const records: Promise<boolean>[] = [];
    let signedOut = false;
    const lostSignIn = (): void => {
      if (!signedOut) {
        signedOut = true;
        this.#onSignedOut();
      }
    };
    this.state.value = { kind: 'applying', profileName: profile, total: plan.plans.length, results };
    try {
      await applyBatch(
        this.#github,
        {
          batch: plan.batch,
          id: plan.id,
          plans: plan.plans.map((member) => ({
            repository: member.repository,
            file: member.file,
            digest: member.digest,
            locks: member.locks,
            plan: member,
          })),
        },
        {
          beforeApply: (repository) => {
            const reviewed = state.assignments.get(repository);
            if (
              reviewed !== undefined &&
              this.#assignments !== undefined &&
              reviewed !== assignmentKey(this.#assignments, repository)
            ) {
              throw new Error('The repository assignment changed since review. Start a new batch review.');
            }
          },
          onResult: (result) => {
            const versions = state.appliedVersions.get(result.repository);
            const addition = state.additions.get(result.repository);
            if (
              (result.status === 'applied' || result.status === 'in_line') &&
              addition !== undefined &&
              addToRepositoryProfiles &&
              this.#assignments !== undefined
            ) {
              records.push(this.#assignments.recordAdded(result.repository, addition.profile, addition.version, false));
            }
            if (
              (result.status === 'applied' || result.status === 'in_line') &&
              versions !== undefined &&
              this.#assignments !== undefined
            ) {
              records.push(
                this.#assignments.recordApplied(
                  result.repository,
                  versions,
                  plan.plans.find((member) => member.repository === result.repository)?.authoritative ?? [],
                  false,
                ),
              );
            }
            results.push(resultOf(result));
            if (turn === this.#turn) {
              this.state.value = {
                kind: 'applying',
                profileName: profile,
                total: plan.plans.length,
                results: [...results],
              };
            }
            // The rest are still tried, and fail the same way, so the account is signed out once.
            if (
              (result.status === 'failed' && result.error.kind === 'signed_out') ||
              (result.status === 'apply_failed' && isSignedOut(result.cause))
            ) {
              lostSignIn();
            }
          },
        },
      );
      const left = (await this.#held(folder)) ? (await readBatch(folder)).members.length : 0;
      if (left === 0) {
        await rm(dirname(folder), { recursive: true, force: true });
        if (turn === this.#turn) {
          this.#edits = undefined;
          this.editor.value = undefined;
        }
      }
      // Those that didn't finish come first, since they are what is left to do.
      const ordered = [...results.filter((result) => !result.finished), ...results.filter((result) => result.finished)];
      const saved = await Promise.all(records);
      this.state.value = { kind: 'applied', profileName: profile, results: ordered, left };
      if (
        plan.failures.length === 0 &&
        results.length > 0 &&
        results.every((result) => result.finished) &&
        saved.every((written) => written)
      ) {
        this.#onApplied?.(results.length);
      }
    } catch (error) {
      if (isSignedOut(error)) {
        lostSignIn();
      }
      this.state.value = {
        kind: 'failed',
        profileName: profile,
        hasBatchToReviewAgain: await this.#held(folder),
        message: cleaned(messageOf(error)),
      };
    }
  }

  /** Leaving discards the pending batch, but a write already under way finishes. */
  async close(): Promise<void> {
    if (this.#writing()) {
      return;
    }
    this.#turn += 1;
    const folder = this.#folder;
    this.#folder = undefined;
    this.#edits = undefined;
    this.editor.value = undefined;
    this.#assigned = new Map();
    this.state.value = { kind: 'idle' };
    if (folder !== undefined) {
      await rm(dirname(folder), { recursive: true, force: true });
    }
  }

  #writing(): boolean {
    return this.state.value.kind === 'applying';
  }

  async #held(folder: string): Promise<boolean> {
    return isBatch(folder).catch(() => false);
  }

  async #review(folder: string, refused: readonly string[]): Promise<BatchState> {
    const reviewedAssignments = new Map(this.#assigned);
    const checkAssignments = (): void => {
      for (const [repository, reviewed] of reviewedAssignments) {
        if (this.#assignments !== undefined && reviewed !== assignmentKey(this.#assignments, repository)) {
          throw new Error(`${repository}'s assignment changed since review. Start a new batch review.`);
        }
      }
    };
    checkAssignments();
    const batch = await readBatch(folder);
    const sourceFiles = [...new Set(batch.members.flatMap((member) => member.profiles ?? batch.profiles))];
    const sourceVersions = new Map(
      await Promise.all(
        sourceFiles.map(async (file) => [file, await profileVersion(file).catch(() => undefined)] as const),
      ),
    );
    const plan = await planBatch(this.#github, folder);
    checkAssignments();
    if (plan.failures.some((failure) => failure.error.kind === 'signed_out')) {
      this.#onSignedOut();
    }
    const appliedVersions = new Map<string, readonly AppliedVersion[]>();
    const additions = new Map<string, ProfileAddition>();
    const assignments = this.#assignments;
    if (assignments !== undefined) {
      for (const member of plan.plans) {
        const source = assignmentSource(
          assignments,
          member.repository,
          member.staged.profiles,
          assignments.authoritativeOf(member.repository).length > 0,
        );
        if (source.kind === 'add') {
          const [addedFile] = member.staged.profiles;
          const addedSourceStillReadable =
            addedFile !== undefined && (await profileVersion(addedFile).catch(() => undefined)) !== undefined;
          if (!addedSourceStillReadable) {
            continue;
          }
          const staged = await resolveStagedApply(member.file);
          const [added] = await reviewedProfileVersions(
            assignments,
            member.staged.profiles,
            member.staged.profiles.map((file) => sourceVersions.get(file)),
            member.repository,
          );
          if (added !== undefined) {
            additions.set(member.repository, {
              profile: added.profile,
              version: canRecordAssignment(assignments, member.repository, staged, member) ? added.version : undefined,
            });
          }
          continue;
        }
        if (source.kind !== 'own') {
          continue;
        }
        const staged = await resolveStagedApply(member.file);
        if (canRecordAssignment(assignments, member.repository, staged, member)) {
          appliedVersions.set(
            member.repository,
            await reviewedProfileVersions(
              assignments,
              member.staged.profiles,
              member.staged.profiles.map((file) => sourceVersions.get(file)),
              member.repository,
            ),
          );
        }
      }
    }
    return {
      kind: 'reviewed',
      profileName: nameOf(plan.profiles),
      plan,
      members: membersOf(plan, assignments),
      refused,
      appliedVersions,
      additions,
      assignments: reviewedAssignments,
    };
  }

  /** One piece of work counts at a time. */
  async #work(
    profile: string,
    members: readonly BatchMemberView[],
    work: (folder: string, current: () => boolean) => Promise<BatchState>,
  ): Promise<void> {
    const folder = this.#folder;
    if (folder === undefined) {
      return;
    }
    const turn = (this.#turn += 1);
    this.state.value = { kind: 'reviewing', profileName: profile, members };
    try {
      const next = await work(folder, () => turn === this.#turn);
      if (turn === this.#turn) {
        this.state.value = next;
      }
    } catch (error) {
      if (isSignedOut(error)) {
        this.#onSignedOut();
      }
      const batch = await this.#held(folder);
      if (turn === this.#turn) {
        this.state.value = {
          kind: 'failed',
          profileName: profile,
          hasBatchToReviewAgain: batch,
          message: cleaned(messageOf(error)),
        };
      }
    } finally {
      if (folder !== this.#folder) {
        await rm(dirname(folder), { recursive: true, force: true });
      }
    }
  }
}
