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
  previewStagedApply,
  readAccess,
  resolveStagedApply,
  saveStagedEdits,
  StalePlanError,
} from '@repotted/core';

import { mkdir, rm, stat } from '../engine/files.js';
import { basename, dirname } from '../engine/path.js';
import { isSignedOut } from './account.js';
import { type ComparedProfile, type CompareSection, compareSections } from './comparison.js';
import { type EditorStore, ProfileEditor } from './profile-editor.js';

/** An apply as reviewed: the changes it would write, what was left out of it, and what stops it. */
export interface Reviewed {
  /**
   * The plan this review shows, which is the one an apply from it writes.
   * It travels with the review, so no other plan can be applied in its place.
   */
  readonly plan: Plan;
  /** How many of the plan's changes GitHub would refuse. */
  readonly locked: number;
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
  /** Whether the apply starts from a profile, and not from the repository as it is. */
  readonly fromProfile: boolean;
}

interface Target {
  readonly repository: string;
  /** The profile's name as the list has it. */
  readonly profile: string;
}

/** An apply's one-off edits are read, previewed, and written as its staged apply, which holds no drafts. */
const stagedStore: EditorStore = {
  drafts: false,
  resolve: resolveStagedApply,
  preview: previewStagedApply,
  edit: editStagedApply,
};

export type ApplyState =
  | { readonly kind: 'idle' }
  /**
   * The first step: the apply's one-off edits, in `editor`. They apply on
   * top of the profile for this apply only. `fromProfile` is false for an
   * apply that starts from the repository as it is.
   */
  | ({
      readonly kind: 'editing';
      readonly fromProfile: boolean;
      /** What this apply leaves out, which can't be edited here until it is put back. */
      readonly leftOut: readonly string[];
    } & Target)
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

/** Removes the apply the browser keeps for a repository, however the file reads. */
async function forget(repository: string): Promise<void> {
  await discardStagedApply(stagedFile(repository)).catch(() => rm(stagedFile(repository), { force: true }));
}

/** A message with its files by their names, not by where the browser keeps them. */
function cleaned(message: string, repository: string): string {
  return message
    .replaceAll(stagedFile(repository), 'this apply')
    .replaceAll(/\/profiles\/(?:browser\/|github\/[^/]+\/[^/]+\/@[^/]+\/)?/gu, '');
}

/** The name an apply goes by: the profile it starts from, or none for one that starts from the repository as it is. */
function nameOf(base: string | null): string {
  return base === null ? '' : basename(base).replace(/\.ya?ml$/u, '');
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
  /** The editor of the apply's one-off edits, while the apply is open. */
  readonly editor = signal<ProfileEditor | undefined>(undefined);
  /** Why the one-off edits couldn't be saved to the profile, until the next try. */
  readonly editError = signal<string | undefined>(undefined);

  readonly #github: GitHub;
  readonly #onSignedOut: () => void;
  #profile: ComparedProfile | undefined;
  /** Counts what the state can go out of date by, so work that lands late changes nothing. */
  #turn = 0;

  readonly #writeProfile: (work: () => Promise<void>) => Promise<void>;

  /**
   * `writeProfile` gives a write to a profile's file its turn among the
   * profiles' syncs, as a save of the profile has.
   */
  constructor(
    github: GitHub,
    onSignedOut: () => void,
    writeProfile: (work: () => Promise<void>) => Promise<void> = (work) => work(),
  ) {
    this.#github = github;
    this.#onSignedOut = onSignedOut;
    this.#writeProfile = writeProfile;
  }

  /** How many changes the reviewed plan writes, and how many of them GitHub would refuse. */
  readonly counts = computed(() => {
    const state = this.state.value;
    return state.kind === 'reviewed'
      ? { changes: state.plan.changes.length, locked: state.locked }
      : { changes: 0, locked: 0 };
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
    // An apply that is writing is neither replaced nor joined: its page shows it until it ends.
    if (this.#writing()) {
      return;
    }
    const unfinished = await this.unfinished(repository);
    // Looked at again, since an apply may have begun to write while the browser's files were read.
    if (this.#writing()) {
      return;
    }
    this.#profile = profile;
    if (unfinished) {
      this.#turn += 1;
      this.state.value = { kind: 'unfinished', repository, profile: profile.name };
      return;
    }
    await this.#work(repository, profile.name, 'reviewing', async () => {
      await mkdir(dirname(stagedFile(repository)), { recursive: true });
      await createStagedApply(stagedFile(repository), repository, profile.file);
      return this.#edit(repository);
    });
  }

  /** Starts an apply that changes settings once, from the repository as it is, with no profile. */
  async startWithoutProfile(repository: string): Promise<void> {
    if (this.#writing()) {
      return;
    }
    const unfinished = await this.unfinished(repository);
    if (this.#writing()) {
      return;
    }
    // One apply a repository at a time: an unfinished one is resumed or discarded first, from its panel.
    if (unfinished) {
      return;
    }
    this.#profile = undefined;
    await this.#work(repository, '', 'reviewing', async () => {
      await mkdir(dirname(stagedFile(repository)), { recursive: true });
      await createStagedApply(stagedFile(repository), repository, undefined);
      return this.#edit(repository);
    });
  }

  /**
   * Goes on from the edits to the review. Edits that aren't saved are saved
   * to the apply first, never to the profile, so the review shows what the
   * edits say. It stays on the edits, with why, while one isn't valid or
   * can't be saved.
   */
  async review(): Promise<void> {
    const state = this.state.value;
    // The page may have moved on while the edits were saved, and then there is nothing here to review.
    if (state.kind !== 'editing' || !(await this.#saveEdits()) || this.state.value !== state) {
      return;
    }
    await this.#work(state.repository, state.profile, 'reviewing', () => this.#review(state.repository, undefined));
  }

  /** Goes back from the review to the edits. */
  async backToEdits(): Promise<void> {
    const state = this.state.value;
    if (
      (state.kind === 'reviewed' || (state.kind === 'failed' && (await this.unfinished(state.repository)))) &&
      // The page may have moved on while the browser's files were read.
      this.state.value === state
    ) {
      await this.#work(state.repository, state.profile, 'reviewing', () => this.#edit(state.repository));
    }
  }

  /**
   * Writes the one-off edits into the profile, which then sets them itself.
   * Edits that aren't saved are saved to the apply first, so the profile
   * gets what the editor shows.
   */
  async saveToProfile(): Promise<void> {
    const state = this.state.value;
    this.editError.value = undefined;
    if (state.kind !== 'editing' || !state.fromProfile || !(await this.#saveEdits()) || this.state.value !== state) {
      return;
    }
    try {
      // The profile is written in its turn among the profiles' syncs, which commit it when profiles are kept on GitHub.
      await this.#writeProfile(async () => {
        await saveStagedEdits(stagedFile(state.repository));
      });
    } catch (error) {
      this.editError.value = cleaned(messageOf(error), state.repository);
    }
    await this.editor.value?.load();
  }

  /** Saves the editor's unsaved edits to the apply, and says whether nothing is left unsaved. */
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

  /** Opens the apply's one-off edits in an editor of their own. */
  async #edit(repository: string): Promise<ApplyState> {
    const staged = await resolveStagedApply(stagedFile(repository));
    const editor = new ProfileEditor(stagedFile(repository), undefined, stagedStore);
    await editor.load();
    this.editor.value = editor;
    this.editError.value = undefined;
    return {
      kind: 'editing',
      repository,
      profile: nameOf(staged.base),
      fromProfile: staged.base !== null,
      leftOut: staged.exclude,
    };
  }

  /** Picks up the unfinished apply to a repository from its panel, with no profile picked. */
  async pickUp(repository: string): Promise<void> {
    if (this.state.value.kind === 'applying') {
      return;
    }
    this.#profile = undefined;
    await this.#work(repository, '', 'reviewing', () => this.#edit(repository));
  }

  /** Picks up the unfinished apply to the repository as it was left, whatever profile it started from. */
  async resume(): Promise<void> {
    const state = this.state.value;
    if (state.kind === 'unfinished') {
      await this.#work(state.repository, state.profile, 'reviewing', () => this.#edit(state.repository));
    }
  }

  /** Throws the unfinished apply away and starts one from the profile picked. */
  async startOver(): Promise<void> {
    const state = this.state.value;
    const profile = this.#profile;
    if (state.kind === 'unfinished' && profile !== undefined) {
      await forget(state.repository);
      await this.start(state.repository, profile);
    }
  }

  /** Leaves a change out of this apply, or puts one back, and reviews it again. The profile keeps it either way. */
  async leaveOut(key: string, out: boolean): Promise<void> {
    const state = this.state.value;
    if (state.kind === 'editing' && !out) {
      // Put back from the edits, where what is left out can't be edited: the edits stay open, with the value back.
      if (await this.#saveEdits()) {
        await this.#work(state.repository, state.profile, 'reviewing', async () => {
          await editStagedApply(stagedFile(state.repository), [{ exclude: key, excluded: false }]);
          return this.#edit(state.repository);
        });
      }
      return;
    }
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
    if (state.kind !== 'reviewed' || !this.canApply.value) {
      return;
    }
    const { plan } = state;
    // The plan is the shown review's own. This only guards the invariant that a review is of its own repository.
    if (plan.repository.toLowerCase() !== state.repository.toLowerCase()) {
      return;
    }
    await this.#work(state.repository, state.profile, 'applying', async () => {
      try {
        const written = await applyPlan(this.#github, plan);
        await forget(state.repository);
        return { kind: 'applied', repository: state.repository, profile: state.profile, changes: written.length };
      } catch (error) {
        if (error instanceof StalePlanError) {
          return this.#review(
            state.repository,
            `${state.repository} changed since you reviewed this apply, so nothing was written. This is what it needs now.`,
          );
        }
        if (error instanceof ApplyError) {
          const partly = `${describeFailure(error)} ${error.applied.length === 1 ? 'The 1 change before it stays' : `The ${error.applied.length} changes before it stay`} written, and nothing after it was.`;
          try {
            return await this.#review(state.repository, `${partly} This is what is left.`);
          } catch (again) {
            // What was written is said even when what is left can't be read.
            throw new Error(`${partly} What is left couldn't be read: ${messageOf(again)}`, { cause: again });
          }
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
    await forget(state.repository);
    this.editor.value = undefined;
    this.state.value = { kind: 'idle' };
  }

  /** Leaves the apply's page. The apply itself is kept, to pick up from its repository. */
  close(): void {
    if (this.state.value.kind !== 'applying') {
      this.#turn += 1;
      // Edits that can be saved go into the apply, never the profile, so leaving the page doesn't lose them.
      const editor = this.editor.value;
      if (this.state.value.kind === 'editing' && editor?.canSave.value === true) {
        editor.save((work) => work()).catch(() => undefined);
      }
      this.editor.value = undefined;
      this.state.value = { kind: 'idle' };
    }
  }

  /** Whether an apply is writing to GitHub right now. */
  #writing(): boolean {
    return this.state.value.kind === 'applying';
  }

  async #review(repository: string, notice: string | undefined): Promise<ApplyState> {
    const [staged, access] = await Promise.all([
      planStagedApply(this.#github, stagedFile(repository)),
      readAccess(this.#github, parseRepo(repository)),
    ]);
    // An apply picked up goes by the profile it started from, which may not be the one picked now.
    const profile = nameOf(staged.staged.base);
    const locks = new Map(lockChanges(access, staged.plan.changes).map((lock) => [lock.change, lock.reason]));
    return {
      kind: 'reviewed',
      repository,
      profile,
      plan: staged.plan,
      locked: locks.size,
      sections: compareSections(staged.plan, locks, staged.exclusions),
      fromProfile: staged.staged.base !== null,
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
    work: (current: () => boolean) => Promise<ApplyState>,
  ): Promise<void> {
    const turn = (this.#turn += 1);
    this.state.value = { kind, repository, profile };
    try {
      const next = await work(() => turn === this.#turn);
      if (turn === this.#turn) {
        this.state.value = next;
      }
    } catch (error) {
      if (isSignedOut(error)) {
        this.#onSignedOut();
      }
      if (turn === this.#turn) {
        const gone = messageOf(error).includes(stagedFile(repository)) && !(await this.unfinished(repository));
        const message = gone
          ? 'This apply is no longer in this browser. Start it again from its repository.'
          : cleaned(messageOf(error), repository);
        if (turn === this.#turn) {
          this.state.value = { kind: 'failed', repository, profile, message };
        }
      }
    }
  }
}
