import { computed, signal } from '@preact/signals';
import {
  type AppAccess,
  type AuthoritativeSection,
  ApplyError,
  applyPlan,
  createStagedApply,
  describeFailure,
  describeSkipped,
  describeWarning,
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
  type StagedApply,
  StalePlanError,
} from '@repotted/core';

import { mkdir, rm, stat } from '../../engine/files.js';
import { basename, dirname } from '../../engine/path.js';
import { isSignedOut } from '../account/account.js';
import { type EditorStore, ProfileEditor } from '../profile-editor/profile-editor.js';
import { builtInFolder } from '../profiles/config-protection.js';
import {
  type AppliedVersion,
  profileName,
  profilesApplyFully,
  profileVersion,
} from '../repositories/repository-profiles.js';
import { type ComparedProfile, type CompareSection, compareSections } from './comparison.js';

/** What applying does to the profiles the repository uses. */
export type AssignmentOffer =
  | { readonly kind: 'none' }
  /**
   * The apply is of the repository's own profiles, in its order. It records the
   * versions applied only when it gives what they set: nothing left out, no
   * one-off edit, and no setting GitHub refused to show.
   */
  | { readonly kind: 'own'; readonly recordsVersions: boolean }
  /** The apply is of one profile the repository doesn't use, which it can add to the end of its list. */
  | { readonly kind: 'add'; readonly profileName: string; readonly recordsVersions: boolean };

export interface ProfileAssignments {
  profilesOf(repository: string): readonly string[];
  /** Undefined for a profile kept outside the profiles folder. */
  pathOf(file: string): string | undefined;
  recordApplied(repository: string, applied: readonly AppliedVersion[]): void;
  recordAdded(repository: string, profilePath: string, version: string | undefined): void;
}

const noAssignments: ProfileAssignments = {
  profilesOf: () => [],
  pathOf: () => undefined,
  recordApplied: () => undefined,
  recordAdded: () => undefined,
};

export interface Reviewed {
  /** Travels with the review, so no other plan can be applied in its place. */
  readonly plan: Plan;
  readonly lockedChangeCount: number;
  readonly sections: readonly CompareSection[];
  /** By the keys that put each back. */
  readonly leftOut: readonly string[];
  readonly skippedDrafts: readonly string[];
  readonly warnings: readonly string[];
  readonly appAccess: { readonly settings: string } | 'install' | undefined;
  /** Why the last try to apply wrote nothing, or stopped partway, with what this review then shows. */
  readonly notice: string | undefined;
  readonly fromProfile: boolean;
  readonly assignment: AssignmentOffer;
  /** Of the profiles reviewed, each by its path in the profiles folder. */
  readonly appliedVersions: readonly AppliedVersion[];
}

interface Target {
  readonly repository: string;
  readonly profileName: string;
}

/** An apply's one-off edits are read, previewed, and written as its staged apply, which holds no drafts. */
const stagedStore: EditorStore = {
  canHoldDrafts: false,
  resolve: resolveStagedApply,
  preview: previewStagedApply,
  edit: editStagedApply,
};

export type ApplyState =
  | { readonly kind: 'idle' }
  | ({
      readonly kind: 'editing';
      readonly fromProfile: boolean;
      /** Edits can't be saved to a profile built into Repotted. */
      readonly builtIn: boolean;
      /** What this apply leaves out, which can't be edited here until it is put back. */
      readonly leftOut: readonly string[];
      readonly authoritative: readonly AuthoritativeSection[];
    } & Target)
  | ({ readonly kind: 'reviewing' | 'applying' } & Target)
  | ({ readonly kind: 'failed'; readonly message: string } & Target)
  | ({ readonly kind: 'reviewed' } & Target & Reviewed)
  | ({ readonly kind: 'applied'; readonly changes: number } & Target);

/** A message with its files by their names, not by where the browser keeps them. */
function cleaned(message: string, file: string): string {
  return message
    .replaceAll(file, 'this apply')
    .replaceAll(/\/profiles\/(?:browser\/|github\/[^/]+\/[^/]+\/@[^/]+\/)?/gu, '')
    .replaceAll(`${builtInFolder}/`, '');
}

function profileNameOfApply(profiles: readonly string[]): string {
  return profiles.map((profile) => basename(profile).replace(/\.ya?ml$/u, '')).join(', ');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

/**
 * The engine's staged apply holds this page's one-off edits and exclusions
 * in temporary files. Leaving the page discards them. Nothing is written to GitHub
 * except by `apply`, which writes exactly the plan last reviewed, and nothing
 * when the repository has changed since.
 */
export class Apply {
  readonly state = signal<ApplyState>({ kind: 'idle' });
  readonly editor = signal<ProfileEditor | undefined>(undefined);
  readonly editError = signal<string | undefined>(undefined);
  /** For an apply of a profile the repository doesn't use: whether applying adds it to the repository's profiles. */
  readonly addToRepositoryProfiles = signal(true);

  readonly #github: GitHub;
  readonly #onSignedOut: () => void;
  #lastAppAccessRead: { readonly repository: string; readonly app: AppAccess } | undefined;
  #profiles: readonly ComparedProfile[] = [];
  #file: string | undefined;
  /** Counts what the state can go out of date by, so work that lands late changes nothing. */
  #turn = 0;

  readonly #writeProfile: (work: () => Promise<void>) => Promise<void>;
  readonly #assignments: ProfileAssignments;

  /**
   * `writeProfile` gives a write to a profile's file its turn among the
   * profiles' syncs, as a save of the profile has.
   */
  constructor(
    github: GitHub,
    onSignedOut: () => void,
    writeProfile: (work: () => Promise<void>) => Promise<void> = (work) => work(),
    assignments: ProfileAssignments = noAssignments,
  ) {
    this.#github = github;
    this.#onSignedOut = onSignedOut;
    this.#writeProfile = writeProfile;
    this.#assignments = assignments;
  }

  readonly counts = computed(() => {
    const state = this.state.value;
    return state.kind === 'reviewed'
      ? { changes: state.plan.changes.length, locked: state.lockedChangeCount }
      : { changes: 0, locked: 0 };
  });

  /**
   * Not while GitHub would refuse a change, since the apply would stop there
   * and leave the changes after it unwritten.
   */
  readonly canApply = computed(
    () => this.state.value.kind === 'reviewed' && this.counts.value.changes > 0 && this.counts.value.locked === 0,
  );

  readonly canRecordWithoutChanges = computed(() => {
    const state = this.state.value;
    return (
      state.kind === 'reviewed' &&
      this.counts.value.changes === 0 &&
      ((state.assignment.kind === 'own' && state.assignment.recordsVersions) ||
        (state.assignment.kind === 'add' && state.assignment.recordsVersions && this.addToRepositoryProfiles.value))
    );
  });

  async start(repository: string, profile: ComparedProfile): Promise<void> {
    await this.startFromProfiles(repository, [profile]);
  }

  /** The profiles apply in order, later ones overriding earlier ones. */
  async startFromProfiles(
    repository: string,
    profiles: readonly ComparedProfile[],
    authoritative: readonly AuthoritativeSection[] = [],
  ): Promise<void> {
    if (this.#writing() || profiles.length === 0) {
      return;
    }
    await this.#start(repository, profiles, false, authoritative);
  }

  async startReview(
    repository: string,
    profiles: readonly ComparedProfile[],
    authoritative: readonly AuthoritativeSection[] = [],
  ): Promise<void> {
    if (!this.#writing() && profiles.length > 0) {
      await this.#start(repository, profiles, true, authoritative);
    }
  }

  async startWithoutProfile(repository: string): Promise<void> {
    if (!this.#writing()) {
      await this.#start(repository, []);
    }
  }

  async #start(
    repository: string,
    profiles: readonly ComparedProfile[],
    review = false,
    authoritative: readonly AuthoritativeSection[] = [],
  ): Promise<void> {
    const closing = this.close();
    this.#profiles = profiles;
    const file = `/apply/${crypto.randomUUID()}/apply.yaml`;
    this.#file = file;
    this.addToRepositoryProfiles.value = true;
    const name = profiles.map((profile) => profile.name).join(', ');
    await this.#work(repository, name, 'reviewing', async (current) => {
      await closing;
      await mkdir(dirname(file), { recursive: true });
      try {
        await createStagedApply(
          file,
          repository,
          profiles.map((profile) => profile.file),
          authoritative,
        );
      } catch (error) {
        await rm(dirname(file), { recursive: true, force: true });
        throw error;
      }
      return review ? this.#review(repository, file, undefined) : this.#edit(repository, file, current);
    });
  }

  /**
   * Edits that aren't saved are saved to the apply first, never to the
   * profile, so the review shows what the edits say. It stays on the edits,
   * with why, while one isn't valid or can't be saved.
   */
  async review(): Promise<void> {
    const state = this.state.value;
    // The page may have moved on while the edits were saved, and then there is nothing here to review.
    if (state.kind !== 'editing' || !(await this.#saveEdits()) || this.state.value !== state) {
      return;
    }
    await this.#work(state.repository, state.profileName, 'reviewing', (_current, file) =>
      this.#review(state.repository, file, undefined),
    );
  }

  async setAuthoritative(authoritative: readonly AuthoritativeSection[]): Promise<void> {
    const state = this.state.value;
    if (state.kind !== 'editing' || !(await this.#saveEdits()) || this.state.value !== state) {
      return;
    }
    await this.#work(state.repository, state.profileName, 'reviewing', async (current, file) => {
      await editStagedApply(file, [{ authoritative }]);
      return this.#edit(state.repository, file, current);
    });
  }

  async backToEdits(): Promise<void> {
    const state = this.state.value;
    if (state.kind === 'reviewed' || state.kind === 'failed') {
      await this.#work(state.repository, state.profileName, 'reviewing', (current, file) =>
        this.#edit(state.repository, file, current),
      );
    }
  }

  /** Edits that aren't saved are saved to the apply first, so the profile gets what the editor shows. */
  async saveToProfile(): Promise<void> {
    const state = this.state.value;
    const file = this.#file;
    this.editError.value = undefined;
    if (
      state.kind !== 'editing' ||
      file === undefined ||
      !state.fromProfile ||
      state.builtIn ||
      !(await this.#saveEdits()) ||
      this.state.value !== state
    ) {
      return;
    }
    try {
      // The profile is written in its turn among the profiles' syncs, which commit it when profiles are kept on GitHub.
      await this.#writeProfile(async () => {
        if (this.state.value === state) {
          await saveStagedEdits(file);
        }
      });
    } catch (error) {
      // Said only on the edits it is about: the apply may have been left or discarded while the turn ran.
      if (this.state.value === state) {
        this.editError.value = cleaned(messageOf(error), file);
      }
    }
    if (this.state.value === state) {
      await this.editor.value?.load();
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

  async #edit(repository: string, file: string, current: () => boolean): Promise<ApplyState> {
    const staged = await resolveStagedApply(file);
    const editor = new ProfileEditor(file, undefined, stagedStore);
    await editor.load();
    if (!current()) {
      return { kind: 'idle' };
    }
    this.editor.value = editor;
    const known = this.#lastAppAccessRead;
    if (known?.repository === repository) {
      editor.useInstallation(known.app);
    } else {
      this.#turnOffWhatTheInstallationLacks(editor, repository);
    }
    this.editError.value = undefined;
    return {
      kind: 'editing',
      repository,
      profileName: profileNameOfApply(staged.profiles),
      fromProfile: staged.profiles.length > 0,
      builtIn: staged.profiles.some((profile) => profile.startsWith(`${builtInFolder}/`)),
      leftOut: staged.exclude,
      authoritative: staged.authoritative,
    };
  }

  /**
   * The editor opens without waiting for this. Until it ends, or if it fails,
   * the edits are only checked at review, as they are for any repository.
   */
  #turnOffWhatTheInstallationLacks(editor: ProfileEditor, repository: string): void {
    readAccess(this.#github, parseRepo(repository)).then(
      (access) => {
        if (this.editor.value === editor) {
          this.#lastAppAccessRead = { repository, app: access.app };
          editor.useInstallation(access.app);
        }
      },
      (error: unknown) => {
        if (isSignedOut(error)) {
          this.#onSignedOut();
        }
      },
    );
  }

  /** The profile keeps the change either way. */
  async leaveOut(key: string, out: boolean): Promise<void> {
    const state = this.state.value;
    if (state.kind === 'editing' && !out) {
      // Put back from the edits, where what is left out can't be edited: the edits stay open, with the value back.
      if ((await this.#saveEdits()) && this.state.value === state) {
        await this.#work(state.repository, state.profileName, 'reviewing', async (current, file) => {
          await editStagedApply(file, [{ exclude: key, excluded: false }]);
          return this.#edit(state.repository, file, current);
        });
      }
      return;
    }
    if (state.kind === 'reviewed') {
      await this.#work(state.repository, state.profileName, 'reviewing', async (_current, file) => {
        await editStagedApply(file, [{ exclude: key, excluded: out }]);
        return this.#review(state.repository, file, undefined);
      });
    }
  }

  async reviewAgain(): Promise<void> {
    const state = this.state.value;
    const file = this.#file;
    if ((state.kind !== 'reviewed' && state.kind !== 'failed') || file === undefined) {
      return;
    }
    if (state.kind === 'failed') {
      const exists = await stat(file).then(
        () => true,
        () => false,
      );
      if (this.state.value !== state) {
        return;
      }
      if (!exists) {
        await this.#start(state.repository, this.#profiles);
        return;
      }
    }
    await this.#work(state.repository, state.profileName, 'reviewing', (_current, currentFile) =>
      this.#review(state.repository, currentFile, undefined),
    );
  }

  /**
   * The engine plans again first and writes only when that gives the same
   * changes, so a repository that changed since the review gets nothing
   * written and a fresh review. A change GitHub refuses partway leaves the
   * ones before it written, and the review that follows shows what is left.
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
    await this.#work(state.repository, state.profileName, 'applying', async (_current, file) => {
      try {
        const written = await applyPlan(this.#github, plan);
        this.#recordAssignment(state);
        await rm(dirname(file), { recursive: true, force: true });
        return {
          kind: 'applied',
          repository: state.repository,
          profileName: state.profileName,
          changes: written.length,
        };
      } catch (error) {
        if (error instanceof StalePlanError) {
          return this.#review(
            state.repository,
            file,
            `${state.repository} changed since you reviewed this apply, so nothing was written. This is what it needs now.`,
          );
        }
        if (error instanceof ApplyError) {
          const partly = `${describeFailure(error)} ${error.applied.length === 1 ? 'The 1 change before it stays' : `The ${error.applied.length} changes before it stay`} written, and nothing after it was.`;
          try {
            return await this.#review(state.repository, file, `${partly} This is what is left.`);
          } catch (again) {
            // What was written is said even when what is left can't be read.
            throw new Error(`${partly} What is left couldn't be read: ${messageOf(again)}`, { cause: again });
          }
        }
        throw error;
      }
    });
  }

  async recordWithoutChanges(): Promise<void> {
    const state = this.state.value;
    if (state.kind !== 'reviewed' || !this.canRecordWithoutChanges.value) {
      return;
    }
    this.#recordAssignment(state);
    await this.#work(state.repository, state.profileName, 'applying', async (_current, file) => {
      await rm(dirname(file), { recursive: true, force: true });
      return { kind: 'applied', repository: state.repository, profileName: state.profileName, changes: 0 };
    });
  }

  #recordAssignment(state: Reviewed & { readonly repository: string }): void {
    const [added] = state.appliedVersions;
    if (state.assignment.kind === 'own' && state.assignment.recordsVersions) {
      this.#assignments.recordApplied(state.repository, state.appliedVersions);
    } else if (state.assignment.kind === 'add' && this.addToRepositoryProfiles.peek() && added !== undefined) {
      this.#assignments.recordAdded(
        state.repository,
        added.profile,
        state.assignment.recordsVersions ? added.version : undefined,
      );
    }
  }

  async #assignmentOf(
    repository: string,
    staged: StagedApply,
    plan: Plan,
  ): Promise<{ assignment: AssignmentOffer; appliedVersions: readonly AppliedVersion[] }> {
    const files = staged.profiles;
    // A read GitHub refused, as for a missing permission, compared nothing there, and granting it can change the plan.
    const recordsVersions = profilesApplyFully(staged, plan);
    const paths = files.map((file) => this.#assignments.pathOf(file));
    const inFolder = paths.filter((path) => path !== undefined);
    if (inFolder.length === 0 || inFolder.length !== paths.length) {
      return { assignment: { kind: 'none' }, appliedVersions: [] };
    }
    const own = this.#assignments.profilesOf(repository);
    const [only] = inFolder;
    const assignment: AssignmentOffer = isSameList(inFolder, own)
      ? { kind: 'own', recordsVersions }
      : inFolder.length === 1 && only !== undefined && !own.includes(only)
        ? { kind: 'add', profileName: profileName(only), recordsVersions }
        : { kind: 'none' };
    if (assignment.kind === 'none') {
      return { assignment, appliedVersions: [] };
    }
    const appliedVersions = await Promise.all(
      files.map(async (file, index) => ({ profile: inFolder[index] ?? file, version: await profileVersion(file) })),
    );
    return { assignment, appliedVersions };
  }

  /** Leaving discards the pending apply, but a write already under way finishes. */
  async close(): Promise<void> {
    if (this.#writing()) {
      return;
    }
    this.#turn += 1;
    const file = this.#file;
    this.#file = undefined;
    this.editor.value = undefined;
    this.editError.value = undefined;
    this.#lastAppAccessRead = undefined;
    this.state.value = { kind: 'idle' };
    if (file !== undefined) {
      await rm(dirname(file), { recursive: true, force: true });
    }
  }

  #writing(): boolean {
    return this.state.value.kind === 'applying';
  }

  async #review(repository: string, file: string, notice: string | undefined): Promise<ApplyState> {
    const turn = this.#turn;
    const [staged, access] = await Promise.all([
      planStagedApply(this.#github, file),
      readAccess(this.#github, parseRepo(repository)),
    ]);
    if (turn === this.#turn && file === this.#file) {
      this.#lastAppAccessRead = { repository, app: access.app };
    }
    const profile = profileNameOfApply(staged.staged.profiles);
    const locks = new Map(lockChanges(access, staged.plan.changes).map((lock) => [lock.change, lock.reason]));
    const { assignment, appliedVersions } = await this.#assignmentOf(repository, staged.staged, staged.plan);
    return {
      assignment,
      appliedVersions,
      kind: 'reviewed',
      repository,
      profileName: profile,
      plan: staged.plan,
      lockedChangeCount: locks.size,
      sections: compareSections(staged.plan, locks, staged.exclusions),
      fromProfile: staged.staged.profiles.length > 0,
      leftOut: staged.staged.exclude,
      skippedDrafts: staged.plan.skipped.map(describeSkipped),
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

  /** One piece of work counts at a time. */
  async #work(
    repository: string,
    profile: string,
    kind: 'reviewing' | 'applying',
    work: (current: () => boolean, file: string) => Promise<ApplyState>,
  ): Promise<void> {
    const file = this.#file;
    if (file === undefined) {
      return;
    }
    const turn = (this.#turn += 1);
    this.state.value = { kind, repository, profileName: profile };
    try {
      const next = await work(() => turn === this.#turn, file);
      if (turn === this.#turn) {
        this.state.value = next;
      }
    } catch (error) {
      if (isSignedOut(error)) {
        this.#onSignedOut();
      }
      if (turn === this.#turn) {
        this.state.value = {
          kind: 'failed',
          repository,
          profileName: profile,
          message: cleaned(messageOf(error), file),
        };
      }
    } finally {
      if (file !== this.#file) {
        await rm(dirname(file), { recursive: true, force: true });
      }
    }
  }
}
