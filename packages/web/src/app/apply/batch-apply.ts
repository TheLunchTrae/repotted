import { computed, signal } from '@preact/signals';
import {
  applyBatch,
  type BatchPlan,
  createBatch,
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
} from '@repotted/core';

import { rm } from '../../engine/files.js';
import { basename, dirname } from '../../engine/path.js';
import { isSignedOut } from '../account/account.js';
import { type ComparedProfile, type CompareSection, compareSections } from './comparison.js';

export interface BatchMemberView {
  readonly repository: string;
  readonly status: 'changes' | 'in-line' | 'needs-access' | 'failed' | 'left-out';
  readonly changes: number;
  readonly comparisonFailureMessage: string | undefined;
  readonly sections: readonly CompareSection[];
  readonly leftOut: readonly string[];
  readonly skippedDrafts: readonly string[];
  readonly warnings: readonly string[];
}

/** `key` leaves the change out everywhere, and `repositories` is how many it reaches. */
export interface BatchChange {
  readonly key: string;
  readonly repositories: number;
}

interface Named {
  readonly profileName: string;
}

export type BatchState =
  | { readonly kind: 'idle' }
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
    } & Named)
  | ({
      readonly kind: 'applying';
      readonly total: number;
      readonly results: readonly BatchResult[];
    } & Named)
  | ({ readonly kind: 'applied'; readonly results: readonly BatchResult[]; readonly left: number } & Named);

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

function membersOf(plan: BatchPlan): BatchMemberView[] {
  const planned = plan.plans.map((member): BatchMemberView => {
    const locks = new Map(member.locks.map((lock) => [lock.change, lock.reason]));
    return {
      repository: member.repository,
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

  readonly #github: GitHub;
  readonly #onSignedOut: () => void;
  /** Counts what the state can go out of date by, so work that lands late changes nothing. */
  #turn = 0;
  #folder: string | undefined;

  constructor(github: GitHub, onSignedOut: () => void) {
    this.#github = github;
    this.#onSignedOut = onSignedOut;
  }

  /** Those with changes and none GitHub would refuse. */
  readonly ready = computed(() => {
    const state = this.state.value;
    return state.kind === 'reviewed' ? state.members.filter((member) => member.status === 'changes') : [];
  });

  /** The repositories as last reviewed, which stay in view while they are reviewed again. */
  readonly members = computed((): readonly BatchMemberView[] => {
    const state = this.state.value;
    return state.kind === 'reviewed' || state.kind === 'reviewing' ? state.members : [];
  });

  readonly changes = computed((): BatchChange[] => {
    const found = new Map<string, number>();
    for (const member of this.members.value) {
      const keys = new Set(member.sections.flatMap((section) => section.rows.flatMap((row) => row.leaveOut ?? [])));
      for (const key of keys) {
        found.set(key, (found.get(key) ?? 0) + 1);
      }
    }
    return [...found].map(([key, repositories]) => ({ key, repositories }));
  });

  readonly leftOut = computed(() => [...new Set(this.members.value.flatMap((member) => member.leftOut))]);

  async start(repositories: readonly string[], profile: ComparedProfile): Promise<void> {
    if (this.#writing() || repositories.length === 0) {
      return;
    }
    const closing = this.close();
    this.#folder = `/apply/${crypto.randomUUID()}/batch`;
    await this.#work(profile.name, [], async (folder) => {
      await closing;
      await createBatch(folder, { profiles: [profile.file], repositories });
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
      await this.#work(state.profileName, state.members, async (folder) => {
        const { batch } = await discardBatchMember(folder, repository);
        if (batch === null) {
          await rm(dirname(folder), { recursive: true, force: true });
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
    if (state.kind !== 'reviewed' || this.ready.value.length === 0) {
      return;
    }
    const { plan, profileName: profile } = state;
    const folder = this.#folder;
    if (folder === undefined) {
      return;
    }
    const turn = (this.#turn += 1);
    const results: BatchResult[] = [];
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
          onResult: (result) => {
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
      }
      // Those that didn't finish come first, since they are what is left to do.
      const ordered = [...results.filter((result) => !result.finished), ...results.filter((result) => result.finished)];
      this.state.value = { kind: 'applied', profileName: profile, results: ordered, left };
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
    const plan = await planBatch(this.#github, folder);
    if (plan.failures.some((failure) => failure.error.kind === 'signed_out')) {
      this.#onSignedOut();
    }
    return { kind: 'reviewed', profileName: nameOf(plan.profiles), plan, members: membersOf(plan), refused };
  }

  /** One piece of work counts at a time. */
  async #work(
    profile: string,
    members: readonly BatchMemberView[],
    work: (folder: string) => Promise<BatchState>,
  ): Promise<void> {
    const folder = this.#folder;
    if (folder === undefined) {
      return;
    }
    const turn = (this.#turn += 1);
    this.state.value = { kind: 'reviewing', profileName: profile, members };
    try {
      const next = await work(folder);
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
