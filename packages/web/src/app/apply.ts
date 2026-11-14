import { computed, signal } from '@preact/signals';
import {
  ApplyError,
  applyPlan,
  createStagedApply,
  describeFailure,
  describeSkipped,
  describeWarning,
  discardStagedApply,
  editStagedApply,
  type GitHub,
  lockChanges,
  parseRepo,
  type Plan,
  planStagedApply,
  readAccess,
  StalePlanError,
} from '@repotted/core';

import { mkdir, stat } from '../engine/files.js';
import { basename, dirname } from '../engine/path.js';
import { isSignedOut } from './account.js';
import { type ComparedProfile, type CompareSection, compareSections } from './comparison.js';

/** An apply as reviewed: the changes it would write, what was left out of it, and what stops it. */
export interface Reviewed {
  readonly sections: readonly CompareSection[];
  /** What this apply leaves out of the profile, by the keys that put each back. */
  readonly leftOut: readonly string[];
  /** The profile's drafts, which an apply leaves out, each in a few words. */
  readonly skipped: readonly string[];
  readonly warnings: readonly string[];
  /** Where the Repotted App's access is reviewed on GitHub, as a comparison has it. */
  readonly appAccess: { readonly settings: string } | 'install' | undefined;
  /** Why the last try to apply wrote nothing, or stopped partway, with what this review then shows. */
  readonly notice: string | undefined;
}

interface Target {
  readonly repository: string;
  /** The profile's name as the list has it. */
  readonly profile: string;
}

export type ApplyState =
  | { readonly kind: 'idle' }
  /** An apply to the repository was started earlier and not finished: it is picked up, or started over. */
  | ({ readonly kind: 'unfinished' } & Target)
  | ({ readonly kind: 'reviewing' | 'applying' } & Target)
  | ({ readonly kind: 'failed'; readonly message: string } & Target)
  | ({ readonly kind: 'reviewed' } & Target & Reviewed)
  | ({ readonly kind: 'applied'; readonly changes: number } & Target);

/** Where the browser keeps the apply to a repository until it is finished or discarded. */
function stagedFile(repository: string): string {
  const repo = parseRepo(repository);
  return `/staged/${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}.yaml`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One apply of a profile to one repository: reviewed first, and written
 * only when asked to after that. It is kept as the engine's staged apply, a
 * file in the browser, so an apply left unfinished is there to pick up.
 * Nothing is written to GitHub except by `apply`, which writes exactly the
 * plan last reviewed, and nothing when the repository has changed since.
 */
export class Apply {
  readonly state = signal<ApplyState>({ kind: 'idle' });

  readonly #github: GitHub;
  readonly #onSignedOut: () => void;
  /** The plan last reviewed, which is the only one `apply` writes. */
  #plan: Plan | undefined;
  #profile: ComparedProfile | undefined;
  /** Counts what the state can go out of date by, so work that lands late changes nothing. */
  #turn = 0;

  constructor(github: GitHub, onSignedOut: () => void) {
    this.#github = github;
    this.#onSignedOut = onSignedOut;
  }

  /** How many changes the review holds, and how many of them GitHub would refuse. */
  readonly counts = computed(() => {
    const state = this.state.value;
    const rows = state.kind === 'reviewed' ? state.sections.flatMap((section) => section.rows) : [];
    return { changes: rows.length, locked: rows.filter((row) => row.lock !== undefined).length };
  });

  /**
   * Whether the review can be applied: it has a change, and none GitHub
   * would refuse, since the apply would stop there and leave the changes
   * after it unwritten.
   */
  readonly canApply = computed(
    () => this.state.value.kind === 'reviewed' && this.counts.value.changes > 0 && this.counts.value.locked === 0,
  );

  /** Whether an apply to the repository was started and not finished. */
  async unfinished(repository: string): Promise<boolean> {
    return stat(stagedFile(repository)).then(
      () => true,
      () => false,
    );
  }

  /**
   * Starts an apply of a profile to a repository and reviews it. Where an
   * apply to the repository is unfinished, it asks which to go on with.
   */
  async start(repository: string, profile: ComparedProfile): Promise<void> {
    this.#profile = profile;
    this.#plan = undefined;
    if (await this.unfinished(repository)) {
      this.#turn += 1;
      this.state.value = { kind: 'unfinished', repository, profile: profile.name };
      return;
    }
    await this.#work(repository, profile.name, 'reviewing', async () => {
      await mkdir(dirname(stagedFile(repository)), { recursive: true });
      await createStagedApply(stagedFile(repository), repository, profile.file);
      return this.#review(repository, undefined);
    });
  }

  /** Picks up the unfinished apply to a repository from its panel, with no profile picked. */
  async pickUp(repository: string): Promise<void> {
    this.#profile = undefined;
    await this.#work(repository, '', 'reviewing', () => this.#review(repository, undefined));
  }

  /** Picks up the unfinished apply to the repository as it was left, whatever profile it started from. */
  async resume(): Promise<void> {
    const state = this.state.value;
    if (state.kind === 'unfinished' || state.kind === 'failed') {
      await this.#work(state.repository, state.profile, 'reviewing', () => this.#review(state.repository, undefined));
    }
  }

  /** Throws the unfinished apply away and starts one from the profile picked. */
  async startOver(): Promise<void> {
    const state = this.state.value;
    const profile = this.#profile;
    if (state.kind === 'unfinished' && profile !== undefined) {
      await discardStagedApply(stagedFile(state.repository));
      await this.start(state.repository, profile);
    }
  }

  /** Leaves a change out of this apply, or puts one back, and reviews it again. The profile keeps it either way. */
  async leaveOut(key: string, out: boolean): Promise<void> {
    const state = this.state.value;
    if (state.kind === 'reviewed') {
      await this.#work(state.repository, state.profile, 'reviewing', async () => {
        await editStagedApply(stagedFile(state.repository), [{ exclude: key, excluded: out }]);
        return this.#review(state.repository, undefined);
      });
    }
  }

  /** Reads GitHub and the profile again, as after access was granted or the profile saved. */
  async reviewAgain(): Promise<void> {
    const state = this.state.value;
    const profile = this.#profile;
    if (state.kind === 'failed' && profile !== undefined && !(await this.unfinished(state.repository))) {
      // The apply never began, as when its profile couldn't be read, so it starts now.
      await this.start(state.repository, profile);
    } else if (state.kind === 'reviewed' || state.kind === 'failed') {
      await this.#work(state.repository, state.profile, 'reviewing', () => this.#review(state.repository, undefined));
    }
  }

  /**
   * Writes the reviewed changes to GitHub. The engine plans again first and
   * writes only when that gives the same changes, so a repository that
   * changed since the review gets nothing written and a fresh review. A
   * change GitHub refuses partway leaves the ones before it written, and
   * the review that follows shows what is left.
   */
  async apply(): Promise<void> {
    const state = this.state.value;
    const plan = this.#plan;
    if (state.kind !== 'reviewed' || plan === undefined || !this.canApply.value) {
      return;
    }
    await this.#work(state.repository, state.profile, 'applying', async () => {
      try {
        const written = await applyPlan(this.#github, plan);
        await discardStagedApply(stagedFile(state.repository));
        return { kind: 'applied', repository: state.repository, profile: state.profile, changes: written.length };
      } catch (error) {
        if (error instanceof StalePlanError) {
          return this.#review(
            state.repository,
            `${state.repository} changed since you reviewed this apply, so nothing was written. This is what it needs now.`,
          );
        }
        if (error instanceof ApplyError) {
          return this.#review(
            state.repository,
            `${describeFailure(error)} ${error.applied.length === 1 ? 'The 1 change before it stays' : `The ${error.applied.length} changes before it stay`} written, and nothing after it was. This is what is left.`,
          );
        }
        throw error;
      }
    });
  }

  /** Throws the apply away. The profile stays as it is, and nothing on GitHub changes. */
  async discard(): Promise<void> {
    const state = this.state.value;
    if (state.kind === 'idle' || state.kind === 'applying') {
      return;
    }
    this.#turn += 1;
    this.#plan = undefined;
    await discardStagedApply(stagedFile(state.repository)).catch(() => undefined);
    this.state.value = { kind: 'idle' };
  }

  /** Leaves the apply's page. The apply itself is kept, to pick up from its repository. */
  close(): void {
    if (this.state.value.kind !== 'applying') {
      this.#turn += 1;
      this.#plan = undefined;
      this.state.value = { kind: 'idle' };
    }
  }

  async #review(repository: string, notice: string | undefined): Promise<ApplyState> {
    const [staged, access] = await Promise.all([
      planStagedApply(this.#github, stagedFile(repository)),
      readAccess(this.#github, parseRepo(repository)),
    ]);
    this.#plan = staged.plan;
    // An apply picked up goes by the profile it started from, which may not be the one picked now.
    const base = staged.staged.base;
    const profile = base === null ? 'no profile' : basename(base).replace(/\.ya?ml$/u, '');
    const locks = new Map(lockChanges(access, staged.plan.changes).map((lock) => [lock.change, lock.reason]));
    return {
      kind: 'reviewed',
      repository,
      profile,
      sections: compareSections(staged.plan, locks, staged.exclusions),
      leftOut: staged.staged.exclude,
      skipped: staged.plan.skipped.map(describeSkipped),
      warnings: staged.plan.warnings.map(describeWarning),
      appAccess:
        access.app.status === 'not_installed'
          ? 'install'
          : access.app.status === 'installed' && access.app.settings_url !== null
            ? { settings: access.app.settings_url }
            : undefined,
      notice,
    };
  }

  /** Shows `kind` while `work` runs, then what it gives, or why it failed. One piece of work counts at a time. */
  async #work(
    repository: string,
    profile: string,
    kind: 'reviewing' | 'applying',
    work: () => Promise<ApplyState>,
  ): Promise<void> {
    const turn = (this.#turn += 1);
    this.#plan = kind === 'applying' ? this.#plan : undefined;
    this.state.value = { kind, repository, profile };
    try {
      const next = await work();
      if (turn === this.#turn) {
        this.state.value = next;
      }
    } catch (error) {
      if (isSignedOut(error)) {
        this.#onSignedOut();
      }
      if (turn === this.#turn) {
        this.#plan = undefined;
        // The files go by their names, not by where the browser keeps them.
        const message = messageOf(error)
          .replaceAll(stagedFile(repository), 'the apply')
          .replaceAll(`${this.#profile?.folder ?? '/profiles'}/`, '');
        this.state.value = { kind: 'failed', repository, profile, message };
      }
    }
  }
}
