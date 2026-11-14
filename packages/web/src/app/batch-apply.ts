import { computed, signal } from '@preact/signals';
import {
  applyBatch,
  type BatchPlan,
  createBatch,
  describeSkipped,
  describeWarning,
  discardBatch,
  discardBatchMember,
  editEverywhere,
  editStagedApply,
  type GitHub,
  isBatch,
  leaveOut,
  type MemberResult,
  parseRepo,
  planBatch,
  readBatch,
} from '@repotted/core';

import { rm, stat } from '../engine/files.js';
import { basename } from '../engine/path.js';
import { isSignedOut } from './account.js';
import { type ComparedProfile, type CompareSection, compareSections } from './comparison.js';

/** Where the browser keeps the batch, and the applies its members share with applies made one at a time. */
const batchFolder = '/batch';
const stagedFolder = '/staged';

/** One repository of a batch as reviewed. */
export interface BatchMemberView {
  readonly repository: string;
  /**
   * Where it stands: it has changes to write, it already has what the
   * profile sets, GitHub would refuse one of its changes, it couldn't be
   * compared, or it is left out of this batch.
   */
  readonly status: 'changes' | 'in-line' | 'needs-access' | 'failed' | 'left-out';
  /** How many changes its plan writes. */
  readonly changes: number;
  /** Why it couldn't be compared. */
  readonly message: string | undefined;
  readonly sections: readonly CompareSection[];
  /** What its apply leaves out of the profile. */
  readonly leftOut: readonly string[];
  /** The drafts its plan leaves out. */
  readonly skipped: readonly string[];
  readonly warnings: readonly string[];
  /**
   * Said of an apply that doesn't start from the batch's profile, as one in
   * progress before the batch may not: what it starts from instead.
   */
  readonly startNote: string | undefined;
}

/** One change the profile makes, across the batch: the key that leaves it out everywhere, and how many repositories it reaches. */
export interface BatchChange {
  readonly key: string;
  readonly repositories: number;
}

interface Named {
  /** The profile's name, or none for a batch picked up without one picked. */
  readonly profile: string;
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
      /** Whether a batch is there to review again. */
      readonly batch: boolean;
    } & Named)
  | ({
      readonly kind: 'reviewed';
      /**
       * The plan this review shows, which is the one an apply from it writes.
       * It travels with the review, so no other plan can be applied in its place.
       */
      readonly plan: BatchPlan;
      readonly members: readonly BatchMemberView[];
      /** What a change everywhere couldn't do in some repository, as when its own edits set the value. */
      readonly refused: readonly string[];
    } & Named)
  | ({
      readonly kind: 'applying';
      readonly total: number;
      /** How each repository written so far ended, in a few words. */
      readonly results: readonly BatchResult[];
    } & Named)
  | ({ readonly kind: 'applied'; readonly results: readonly BatchResult[]; readonly left: number } & Named);

/** How applying one repository of a batch ended. */
export interface BatchResult {
  readonly repository: string;
  /** Whether it finished: written, or already in line. */
  readonly finished: boolean;
  readonly said: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nameOf(profile: string | null): string {
  return profile === null ? '' : basename(profile).replace(/\.ya?ml$/u, '');
}

/** A message with its files by their names, not by where the browser keeps them. */
function cleaned(message: string): string {
  return message
    .replaceAll(/\/staged\/([^/\s]+)\/([^/\s]+)\.yaml/gu, 'the apply to $1/$2')
    .replaceAll(/(?<![\w./-])\/batch(?:\/batch\.yaml)?(?![\w/-])/gu, 'the batch')
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
      message: undefined,
      sections: compareSections(member, locks, member.exclusions),
      leftOut: member.staged.exclude,
      skipped: member.skipped.map(describeSkipped),
      warnings: member.warnings.map(describeWarning),
      startNote:
        member.staged.base === plan.profile
          ? undefined
          : member.staged.base === null
            ? 'This apply starts from the repository as it is, not from the profile of this batch. It was in progress before the batch.'
            : `This apply starts from ${nameOf(member.staged.base)}, not from the profile of this batch. It was in progress before the batch.`,
    };
  });
  const rest = (repository: string, status: 'failed' | 'left-out', message: string | undefined): BatchMemberView => ({
    repository,
    status,
    changes: 0,
    message,
    sections: [],
    leftOut: [],
    skipped: [],
    warnings: [],
    startNote: undefined,
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
 * One profile applied to several repositories, each reviewed on its own
 * first. It is kept as the engine's batch, a folder in the browser, whose
 * members are the same applies as those made one repository at a time.
 * Nothing is written to GitHub except by `apply`, which hands the engine
 * the plan of the review that is shown; the engine plans each repository
 * again and writes nothing to one that changed, is locked, or whose apply
 * was edited since.
 */
export class BatchApply {
  readonly state = signal<BatchState>({ kind: 'idle' });

  readonly #github: GitHub;
  readonly #onSignedOut: () => void;
  /** Counts what the state can go out of date by, so work that lands late changes nothing. */
  #turn = 0;

  constructor(github: GitHub, onSignedOut: () => void) {
    this.#github = github;
    this.#onSignedOut = onSignedOut;
  }

  /** The repositories an apply would write to: those with changes and none GitHub would refuse. */
  readonly ready = computed(() => {
    const state = this.state.value;
    return state.kind === 'reviewed' ? state.members.filter((member) => member.status === 'changes') : [];
  });

  /** The repositories as last reviewed, which stay in view while they are reviewed again. */
  readonly members = computed((): readonly BatchMemberView[] => {
    const state = this.state.value;
    return state.kind === 'reviewed' || state.kind === 'reviewing' ? state.members : [];
  });

  /** Each change that can be left out, with what leaves it out everywhere and how many repositories it reaches. */
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

  /** What some repository's apply leaves out, each key once. */
  readonly leftOut = computed(() => [...new Set(this.members.value.flatMap((member) => member.leftOut))]);

  /** Whether a batch was started and not finished. */
  async unfinished(): Promise<boolean> {
    return isBatch(batchFolder);
  }

  /**
   * Starts a batch of the profile over the repositories and reviews it. A
   * repository that has an apply in progress joins as it is, edits and all.
   * With a batch unfinished it starts nothing and says so under that batch's
   * own profile, which is the one a review or a discard from there acts on.
   */
  async start(repositories: readonly string[], profile: ComparedProfile): Promise<void> {
    if (this.#writing()) {
      return;
    }
    await this.#work(profile.name, [], async () => {
      if (await isBatch(batchFolder)) {
        const held = await readBatch(batchFolder).then(
          (batch) => nameOf(batch.profile),
          () => '',
        );
        return {
          kind: 'failed',
          profile: held,
          batch: true,
          message: `A batch apply${held === '' ? '' : ` of ${held}`} is not finished. Review it again to pick it up, or discard it, before starting another.`,
        };
      }
      const files = repositories.map((repository) => {
        const repo = parseRepo(repository);
        return { repository, file: `${stagedFolder}/${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}.yaml` };
      });
      const existing = await Promise.all(
        files.map(({ file }) =>
          stat(file).then(
            () => true,
            () => false,
          ),
        ),
      );
      await createBatch(batchFolder, {
        profile: profile.file,
        repositories: files.filter((_, index) => existing[index] !== true).map(({ repository }) => repository),
        join: files.filter((_, index) => existing[index] === true).map(({ file }) => file),
        stagedFolder,
      });
      return this.#review([]);
    });
  }

  /** Picks up the unfinished batch as it was left. */
  async resume(): Promise<void> {
    if (this.#writing()) {
      return;
    }
    await this.#work('', [], () => this.#review([]));
  }

  /** Whether a batch is there to plan again: not after one that ended, or that never started. */
  readonly canReviewAgain = computed(() => {
    const state = this.state.value;
    return (
      state.kind === 'reviewed' ||
      (state.kind === 'failed' && state.batch) ||
      (state.kind === 'applied' && state.left > 0)
    );
  });

  /** Plans every repository again, as after access was granted or the profile saved. */
  async reviewAgain(): Promise<void> {
    const state = this.state.value;
    if (this.canReviewAgain.value && 'profile' in state) {
      await this.#work(state.profile, this.members.value, () => this.#review([]));
    }
  }

  /** Leaves a repository out of the batch, or puts it back. Its apply stays as it is. */
  async leaveOutRepository(repository: string, out: boolean): Promise<void> {
    const state = this.state.value;
    if (state.kind === 'reviewed') {
      await this.#work(state.profile, state.members, async () => {
        await leaveOut(batchFolder, [repository], out);
        return this.#review([]);
      });
    }
  }

  /**
   * Takes a repository out of the batch for good. An apply the batch started
   * for it is discarded; one that joined stays. The batch ends with its last
   * repository.
   */
  async remove(repository: string): Promise<void> {
    const state = this.state.value;
    if (state.kind === 'reviewed') {
      await this.#work(state.profile, state.members, async () => {
        const { batch } = await discardBatchMember(batchFolder, repository);
        return batch === null ? { kind: 'idle' } : this.#review([]);
      });
    }
  }

  /** Leaves a change out of one repository's apply, or puts it back. */
  async leaveOut(repository: string, key: string, out: boolean): Promise<void> {
    const state = this.state.value;
    const file =
      state.kind === 'reviewed' ? state.plan.plans.find((member) => member.repository === repository)?.file : undefined;
    if (state.kind === 'reviewed' && file !== undefined) {
      await this.#work(state.profile, state.members, async () => {
        await editStagedApply(file, [{ exclude: key, excluded: out }]);
        return this.#review([]);
      });
    }
  }

  /** Leaves a change out of every repository's apply, or puts it back in each. The profile keeps it. */
  async everywhere(key: string, out: boolean): Promise<void> {
    const state = this.state.value;
    if (state.kind === 'reviewed') {
      await this.#work(state.profile, state.members, async () => {
        const { refused } = await editEverywhere(batchFolder, key, out);
        return this.#review(refused.map((item) => `${item.repository}: ${cleaned(item.message)}`));
      });
    }
  }

  /**
   * Writes the reviewed changes, one repository at a time. The engine plans
   * each again first and writes nothing to one that changed since the
   * review, has a change GitHub would refuse, was left out, or whose apply
   * was edited since. A repository that finishes leaves the batch, which
   * ends with its last one.
   */
  async apply(): Promise<void> {
    const state = this.state.value;
    if (state.kind !== 'reviewed' || this.ready.value.length === 0) {
      return;
    }
    const { plan, profile } = state;
    const turn = (this.#turn += 1);
    const results: BatchResult[] = [];
    let signedOut = false;
    const lostSignIn = (): void => {
      if (!signedOut) {
        signedOut = true;
        this.#onSignedOut();
      }
    };
    this.state.value = { kind: 'applying', profile, total: plan.plans.length, results };
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
              this.state.value = { kind: 'applying', profile, total: plan.plans.length, results: [...results] };
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
      const left = (await this.unfinished()) ? (await readBatch(batchFolder)).members.length : 0;
      // Those that didn't finish come first, since they are what is left to do.
      const ordered = [...results.filter((result) => !result.finished), ...results.filter((result) => result.finished)];
      this.state.value = { kind: 'applied', profile, results: ordered, left };
    } catch (error) {
      if (isSignedOut(error)) {
        lostSignIn();
      }
      this.state.value = { kind: 'failed', profile, batch: await this.#held(), message: cleaned(messageOf(error)) };
    }
  }

  /** Throws the batch away. An apply that joined it stays, to resume on its own; the profile stays as it is. */
  async discard(): Promise<void> {
    const state = this.state.value;
    if (state.kind === 'applying') {
      return;
    }
    // Nothing is reviewed while it goes, so nothing can be applied from a batch being thrown away.
    const turn = (this.#turn += 1);
    const profile = state.kind === 'idle' ? '' : state.profile;
    this.state.value = { kind: 'reviewing', profile, members: [] };
    try {
      if (await this.unfinished()) {
        await discardBatch(batchFolder).catch(async (error: unknown) => {
          // A batch that can't be read can't be resumed either, so its list
          // goes and its applies stay, each to resume on its own.
          if (
            await readBatch(batchFolder).then(
              () => true,
              () => false,
            )
          ) {
            throw error;
          }
          await rm(`${batchFolder}/batch.yaml`);
        });
      }
    } catch (error) {
      if (turn === this.#turn) {
        this.state.value = { kind: 'failed', profile, batch: await this.#held(), message: cleaned(messageOf(error)) };
      }
      return;
    }
    if (turn === this.#turn) {
      this.state.value = { kind: 'idle' };
    }
  }

  /** Leaves the batch's page. The batch itself is kept, to resume. */
  close(): void {
    if (!this.#writing()) {
      this.#turn += 1;
      this.state.value = { kind: 'idle' };
    }
  }

  #writing(): boolean {
    return this.state.value.kind === 'applying';
  }

  async #held(): Promise<boolean> {
    return this.unfinished().catch(() => false);
  }

  /** Plans the batch. The profile named is the batch's own, whatever was asked for. */
  async #review(refused: readonly string[]): Promise<BatchState> {
    const plan = await planBatch(this.#github, batchFolder);
    if (plan.failures.some((failure) => failure.error.kind === 'signed_out')) {
      this.#onSignedOut();
    }
    return { kind: 'reviewed', profile: nameOf(plan.profile), plan, members: membersOf(plan), refused };
  }

  /** Shows that it is reviewing while `work` runs, then what it gives, or why it failed. One piece of work counts at a time. */
  async #work(profile: string, members: readonly BatchMemberView[], work: () => Promise<BatchState>): Promise<void> {
    const turn = (this.#turn += 1);
    this.state.value = { kind: 'reviewing', profile, members };
    try {
      const next = await work();
      if (turn === this.#turn) {
        this.state.value = next;
      }
    } catch (error) {
      if (isSignedOut(error)) {
        this.#onSignedOut();
      }
      const batch = await this.#held();
      if (turn === this.#turn) {
        this.state.value = { kind: 'failed', profile, batch, message: cleaned(messageOf(error)) };
      }
    }
  }
}
