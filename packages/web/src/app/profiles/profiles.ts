import { computed, signal } from '@preact/signals';
import {
  captureProfile,
  checkActionPatterns,
  declaredExtends,
  type DefinitionKind,
  editProfile,
  parseProfile,
  withRewrittenReferences,
  findActions,
  findGitHubApp,
  type GitHub,
  listProfiles,
  type OwnerType,
  parseRepo,
  readInstallationSettingsUrl,
  stringifyProfile,
  syncFolder,
  withExtends,
} from '@repotted/core';
import { isMap, parseDocument } from 'yaml';
import * as z from 'zod/mini';

import { mkdir, readdir, readFile, rm, stat, writeFile } from '../../engine/files.js';
import { basename, dirname, join, relative, resolve } from '../../engine/path.js';
import { isSignedOut } from '../account/account.js';
import type { Preferences } from '../preferences/preferences.js';
import { ActionPatternChecks } from '../profile-editor/action-pattern-checks.js';
import { ActionSearch } from '../profile-editor/action-search.js';
import { GitHubAppLookup } from '../profile-editor/bypass-actors.js';
import type { SaveMode } from '../profile-editor/entry-edits.js';
import { type OwnerChoice, ProfileEditor } from '../profile-editor/profile-editor.js';
import { SerialQueue } from '../storage/serial-queue.js';
import { markConfigRepository, normalFolder, unmarkConfigRepository } from './config-marker.js';
import {
  type LocalFolder,
  type LocalFolders,
  replaceWorkingCopy,
  syncLocalFolder,
  unsyncedFiles,
} from './local-folder.js';
import { type UncapturedSettings, uncapturedSettings } from './uncaptured-settings.js';

export type ProfileListing = Awaited<ReturnType<typeof listProfiles>>[number];

export type ProfilesSource =
  | { readonly kind: 'browser' }
  | { readonly kind: 'folder'; readonly name: string }
  | { readonly kind: 'repository'; readonly repository: string; readonly path: string };

export type SyncState =
  | { readonly status: 'none' }
  | { readonly status: 'syncing' }
  | { readonly status: 'synced'; readonly pulled: number; readonly pushed: number }
  | { readonly status: 'failed'; readonly message: string };

export type NewProfileStart =
  | { readonly kind: 'empty' }
  | { readonly kind: 'extends'; readonly base: ProfileListing }
  | { readonly kind: 'repository'; readonly repository: string }
  | { readonly kind: 'duplicate'; readonly source: ProfileListing }
  | { readonly kind: 'import'; readonly text: string };

export interface NewProfile {
  readonly name: string;
  readonly definitionKind?: DefinitionKind;
  /** From the profiles folder; '' for the profiles folder itself. */
  readonly folder: string;
  readonly start: NewProfileStart;
  /** A capture takes the repository's owner type, and a profile that extends a typed one takes that type. */
  readonly ownerType: OwnerType | undefined;
}

// Names no file can have on Windows, where a config repository's profiles may also be used.
const windowsNames = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;

/** A folder is one that holds profiles, or a new one under the profiles folder, never a way out of it. */
function folderProblem(folder: string): string | undefined {
  const unusable = folder.split('/').some((part) => folder !== '' && /^\.|^$|[\\:*?"<>|\p{Cc}]|[. ]$/u.test(part));
  return unusable ? `${folder} is not a folder a profile can go in.` : undefined;
}

export interface ProfileFolderNode {
  readonly name: string;
  /** From the profiles folder, with `/` separators; '' for the profiles folder itself. */
  readonly path: string;
  /** Counts the profiles that show in it and in the folders under it. */
  readonly count: number;
  readonly open: boolean;
  readonly folders: readonly ProfileFolderNode[];
  readonly profiles: readonly ProfileListing[];
}

const sourceKey = 'profiles-source';
const savedSource = z.union([
  z.object({ kind: z.literal('browser') }),
  z.object({ kind: z.literal('folder'), name: z.string() }),
  z.object({ kind: z.literal('repository'), repository: z.string(), path: z.string() }),
]);

// The engine's record of what a folder and its repository last agreed on.
const syncRecord = '.repotted-sync.json';
const browserFolder = '/profiles/browser';
// The working copy of the folder on this computer, and where one is made ready before it takes that place.
const computerFolder = '/profiles/folder';
const nextComputerFolder = '/profiles/folder-next';
const unsavedFirst = 'Save or reset your unsaved changes first.';
const unsyncedFirst =
  'The folder on this computer has not received every change made here. Sync with it first, or choose the folder again.';

function folderOf(source: ProfilesSource): string {
  if (source.kind === 'browser') {
    return browserFolder;
  }
  if (source.kind === 'folder') {
    return computerFolder;
  }
  // One working copy for each repository and folder in it, since a copy syncs with only one.
  return `/profiles/github/${source.repository.toLowerCase()}/@${encodeURIComponent(source.path)}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

/** Hidden files and folders stay out, as in a sync. */
async function profileFiles(folder: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(folder, prefix), { withFileTypes: true })) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.name.startsWith('.')) {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...(await profileFiles(folder, path)));
    } else if (/\.ya?ml$/iu.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

/** Syncs and changes to the folder take turns, so a sync never reads a folder that is being changed. */
export class Profiles {
  readonly source = signal<ProfilesSource>({ kind: 'browser' });
  readonly sync = signal<SyncState>({ status: 'none' });
  /** The profiles that changed both here and where they sync with since the last sync, by path in the folder. */
  readonly conflicts = signal<readonly string[]>([]);
  readonly listings = signal<readonly ProfileListing[]>([]);
  readonly listingError = signal<string | undefined>(undefined);
  readonly profileWorkUnderWay = signal(false);
  readonly search = signal('');
  /** Until the next change of where profiles are kept. */
  readonly connectError = signal<string | undefined>(undefined);
  /** Whether this browser has a choice of where profiles are kept, saved now or on an earlier visit. */
  readonly chosen = signal(false);
  /** Why the config repository's topic or marker couldn't be set, so a new browser may not find it; until the next move. */
  readonly markProblem = signal<string | undefined>(undefined);
  /** The browser wants the user's leave again on each visit before the folder on this computer can be used. */
  readonly needsFolderAccess = signal(false);
  readonly settingsCaptureCouldNotRead = signal<
    { readonly file: string; readonly uncaptured: UncapturedSettings } | undefined
  >(undefined);
  readonly opened = signal<{ readonly file: string; readonly text: string } | undefined>(undefined);

  readonly #github: GitHub;
  readonly #preferences: Preferences;
  readonly #onSignedOut: () => void;
  readonly #queue = new SerialQueue();
  readonly #closedFolders = signal<ReadonlySet<string>>(new Set());
  readonly #selectedFile = signal<string | undefined>(undefined);
  /** One for each profile opened since profiles were last moved, so unsaved changes outlast a look at another profile. */
  readonly #editors = signal<readonly ProfileEditor[]>([]);
  /** The files that captures under way will make, so no other new profile takes their names. */
  readonly #capturing = new Set<string>();
  readonly #folders: LocalFolders | undefined;
  #assignedConsumers: (files: readonly string[]) => readonly string[];
  /** The folder on this computer, once the browser has let the page use it this visit. */
  #localFolder: LocalFolder | undefined;

  constructor(
    github: GitHub,
    preferences: Preferences,
    onSignedOut: () => void,
    folders?: LocalFolders,
    assignedConsumers: (files: readonly string[]) => readonly string[] = () => [],
  ) {
    this.#github = github;
    this.#preferences = preferences;
    this.#onSignedOut = onSignedOut;
    this.#folders = folders;
    this.#assignedConsumers = assignedConsumers;
    const saved = savedSource.safeParse(preferences.read(sourceKey));
    if (saved.success) {
      this.source.value = saved.data;
      this.chosen.value = true;
    }
  }

  protectAssignments(consumers: (files: readonly string[]) => readonly string[]): void {
    this.#assignedConsumers = consumers;
  }

  readonly folder = computed(() => folderOf(this.source.value));

  /** A link the capture notice can do without: a failure to find it leaves the notice as it is. */
  async #installationSettingsUrl(owner: string): Promise<string | null> {
    try {
      return await readInstallationSettingsUrl(this.#github, owner);
    } catch (error) {
      if (isSignedOut(error)) {
        throw error;
      }
      return null;
    }
  }

  readonly editor = computed(() => this.#editors.value.find((editor) => editor.file === this.#selectedFile.value));

  readonly unsaved = computed<ReadonlySet<string>>(
    () => new Set(this.#editors.value.filter((editor) => editor.dirty.value).map((editor) => editor.file)),
  );

  readonly selected = computed(() => this.listings.value.find((listing) => listing.file === this.#selectedFile.value));

  readonly unsavedNames = computed(() =>
    this.listings.value
      .filter((listing) => this.unsaved.value.has(listing.file))
      .map((listing) => this.pathOf(listing).replace(/\.ya?ml$/iu, '')),
  );

  /**
   * Answers `unsaved` when a profile keeps its changes: one that can't be
   * saved, as with a value that isn't valid, and one with a draft, which a
   * save here would apply unseen. Answers `unsynced` when all are saved in
   * this browser but the last sync failed or left a conflict, so where the
   * profiles are kept lacks them.
   */
  async saveAll(): Promise<'saved' | 'unsaved' | 'unsynced'> {
    for (const editor of this.#editors.value.filter((item) => item.dirty.value && item.draftCount.value === 0)) {
      await editor.save((write) => this.#write(write));
    }
    if (this.unsaved.value.size > 0) {
      return 'unsaved';
    }
    return this.sync.value.status === 'failed' || this.conflicts.value.length > 0 ? 'unsynced' : 'saved';
  }

  async discardAll(): Promise<void> {
    for (const editor of this.#editors.value.filter((item) => item.dirty.value)) {
      await editor.resetAll();
    }
  }

  readonly tree = computed<ProfileFolderNode>(() => {
    const words = this.search.value.trim().toLowerCase();
    const shown = this.listings.value.filter((listing) =>
      `${listing.folder}/${listing.name}`.toLowerCase().includes(words),
    );
    const build = (path: string): ProfileFolderNode => {
      const under = shown.filter(
        (listing) => path === '' || listing.folder === path || listing.folder.startsWith(`${path}/`),
      );
      const depth = path === '' ? 0 : path.split('/').length;
      const names = new Set(
        under.map((listing) => listing.folder.split('/')[depth]).filter((name) => name !== undefined && name !== ''),
      );
      return {
        name: path.split('/').at(-1) ?? '',
        path,
        count: under.length,
        // A search opens every folder, so what it found shows.
        open: words !== '' || !this.#closedFolders.value.has(path),
        folders: [...names].sort().map((name) => build(path === '' ? String(name) : `${path}/${name}`)),
        profiles: under.filter((listing) => listing.folder === path),
      };
    };
    return build('');
  });

  get foldersSupported(): boolean {
    return this.#folders?.supported ?? false;
  }

  refresh(): Promise<void> {
    return this.#work(async () => {
      await this.#sync({});
      await this.#list();
    });
  }

  /**
   * `addLocal` first copies the profiles kept now beside the picked folder's
   * own, skipping names it already has. It answers why it couldn't, having
   * left where profiles are kept as it was; picking no folder is no failure.
   * It must be called from a press of a button, since the browser's picker
   * needs one.
   */
  async useFolder(addLocal: boolean): Promise<string | undefined> {
    if (this.unsaved.value.size > 0) {
      this.connectError.value = unsavedFirst;
      return unsavedFirst;
    }
    let folder: LocalFolder | undefined;
    try {
      // Asked before the turn in the queue, while the press still counts with the browser.
      folder = await this.#folders?.pick();
    } catch (error) {
      this.connectError.value = messageOf(error);
      return this.connectError.value;
    }
    if (folder === undefined) {
      return undefined;
    }
    const picked = folder;
    return this.#work(async () => {
      if (this.unsaved.value.size > 0) {
        this.connectError.value = unsavedFirst;
        return unsavedFirst;
      }
      this.connectError.value = await this.#useFolder(picked, addLocal);
      return this.connectError.value;
    });
  }

  async #useFolder(folder: LocalFolder, addLocal: boolean): Promise<string | undefined> {
    const from = this.folder.value;
    const previous = this.source.value;
    try {
      // Made ready apart, so a folder that can't be synced leaves the profiles kept now as they are.
      await rm(nextComputerFolder, { recursive: true, force: true });
      await mkdir(nextComputerFolder, { recursive: true });
      const theirs = await folder.files();
      const taken = new Set([...theirs.keys()].map((path) => path.toLowerCase()));
      // What a folder used until now never received goes to the one picked, where a
      // profile that differs from the folder's is a conflict to settle, not a loss.
      const carried = from === computerFolder ? await unsyncedFiles(from) : new Map<string, string>();
      for (const [file, text] of carried) {
        await mkdir(dirname(join(nextComputerFolder, file)), { recursive: true });
        await writeFile(join(nextComputerFolder, file), text);
      }
      if (addLocal) {
        for (const file of await profileFiles(from)) {
          // A name the folder has in any case is skipped, since some computers take the two for one file.
          if (!taken.has(file.toLowerCase()) && !carried.has(file)) {
            await mkdir(dirname(join(nextComputerFolder, file)), { recursive: true });
            await writeFile(join(nextComputerFolder, file), await readFile(join(from, file)));
          }
        }
      }
      const result = await syncLocalFolder(nextComputerFolder, folder);
      const [failure] = result.failures;
      if (failure !== undefined) {
        throw new Error(failure);
      }
      await replaceWorkingCopy(nextComputerFolder, computerFolder);
      await this.#folders?.remember(folder);
      this.#localFolder = folder;
      this.needsFolderAccess.value = false;
      this.#use({ kind: 'folder', name: folder.name });
      this.sync.value = { status: 'synced', pulled: result.pulled.length, pushed: result.pushed.length };
      this.conflicts.value = result.conflicts;
      await this.#list();
      await this.#moveMark(previous);
      return undefined;
    } catch (error) {
      await rm(nextComputerFolder, { recursive: true, force: true });
      return messageOf(error);
    }
  }

  /** Must be called from a press of a button. */
  async allowFolder(): Promise<void> {
    let allowed = false;
    try {
      allowed = (await this.#folders?.allow()) ?? false;
    } catch {
      // A browser that won't ask leaves the folder as it was: not allowed.
    }
    if (allowed) {
      await this.refresh();
    } else if (this.source.value.kind === 'folder') {
      this.sync.value = {
        status: 'failed',
        message:
          "The browser didn't allow it. If it no longer asks, allow the folder in the site's settings, or choose it again in Settings",
      };
    }
  }

  /** Why profiles kept in a folder on this computer can't move elsewhere yet: the folder lacks changes made here. */
  async #unsynced(): Promise<string | undefined> {
    return this.source.value.kind === 'folder' && (await unsyncedFiles(this.folder.value)).size > 0
      ? unsyncedFirst
      : undefined;
  }

  /** `local` keeps this browser's versions, `remote` takes GitHub's or the folder's. */
  keep(prefer: 'local' | 'remote'): Promise<void> {
    return this.#work(async () => {
      await this.#sync({ prefer, only: this.conflicts.value });
      await this.#list();
    });
  }

  /**
   * `addLocal` first copies the profiles kept now into the repository's
   * copy, skipping names it already has. It answers why it couldn't, having
   * left where profiles are kept as it was. `onlyIntoEmptyUnchosenBrowser`
   * does nothing, and answers no failure, once its turn comes in a browser
   * that has chosen, such as in Settings, or that holds profiles.
   */
  connect(
    repository: string,
    path: string,
    addLocal: boolean,
    options: { readonly onlyIntoEmptyUnchosenBrowser?: boolean } = {},
  ): Promise<string | undefined> {
    return this.#work(async () => {
      if (options.onlyIntoEmptyUnchosenBrowser === true && (this.chosen.value || this.listings.value.length > 0)) {
        return undefined;
      }
      if (this.unsaved.value.size > 0) {
        this.connectError.value = unsavedFirst;
        return unsavedFirst;
      }
      // A last sync gives the folder on this computer what it lacks, when it can.
      if (this.source.value.kind === 'folder') {
        await this.#sync({});
      }
      const unsynced = await this.#unsynced();
      if (unsynced !== undefined) {
        this.connectError.value = unsynced;
        return unsynced;
      }
      this.connectError.value = await this.#connect(repository, path, addLocal);
      return this.connectError.value;
    });
  }

  async #connect(repository: string, path: string, addLocal: boolean): Promise<string | undefined> {
    let source: ProfilesSource;
    try {
      const repo = parseRepo(repository.trim());
      source = {
        kind: 'repository',
        repository: `${repo.owner}/${repo.name}`,
        path: normalFolder(path),
      };
    } catch {
      return 'Name the repository as owner/name, such as you/repotted-config.';
    }
    const target = folderOf(source);
    const from = this.folder.value;
    const previous = this.source.value;
    const synced = await exists(join(target, syncRecord));
    const copied: string[] = [];
    try {
      await mkdir(target, { recursive: true });
      if (addLocal && from !== target) {
        for (const file of await profileFiles(from)) {
          if (!(await exists(join(target, file)))) {
            await mkdir(dirname(join(target, file)), { recursive: true });
            await writeFile(join(target, file), await readFile(join(from, file)));
            copied.push(file);
          }
        }
      }
      const result = await syncFolder(this.#github, target, { repository: source.repository, path: source.path });
      this.#use(source);
      this.sync.value = { status: 'synced', pulled: result.pulled.length, pushed: result.pushed.length };
      this.conflicts.value = result.conflicts;
      await this.#list();
      await this.#moveMark(previous);
      return undefined;
    } catch (error) {
      // A copy that never synced goes whole; one that had keeps all but what this try copied in.
      if (synced) {
        for (const file of copied) {
          await rm(join(target, file), { force: true });
        }
      } else {
        await rm(target, { recursive: true, force: true });
      }
      if (isSignedOut(error)) {
        this.#onSignedOut();
      }
      return messageOf(error);
    }
  }

  /** A repository keeps every profile it has. Unsaved changes hold it back, with why in `connectError`. */
  keepInBrowser(): Promise<void> {
    return this.#work(async () => {
      if (this.source.value.kind === 'browser') {
        this.#preferences.write(sourceKey, this.source.value);
        this.chosen.value = true;
        this.connectError.value = undefined;
        return;
      }
      if (this.unsaved.value.size > 0) {
        this.connectError.value = unsavedFirst;
        return;
      }
      // A last sync gives the folder on this computer what it lacks, when it can.
      if (this.source.value.kind === 'folder') {
        await this.#sync({});
      }
      const unsynced = await this.#unsynced();
      if (unsynced !== undefined) {
        this.connectError.value = unsynced;
        return;
      }
      const previous = this.source.value;
      this.#use({ kind: 'browser' });
      this.connectError.value = undefined;
      this.sync.value = { status: 'none' };
      this.conflicts.value = [];
      await this.#list();
      await this.#moveMark(previous);
    });
  }

  /**
   * Marks the repository profiles are kept in, for one chosen before
   * repositories were marked. A failure shows in `markProblem`.
   */
  markRepository(): Promise<void> {
    return this.#work(() => this.#moveMark(this.source.value));
  }

  /** Takes the mark off the repository profiles left, if they left one, and puts it on the one they're in now. */
  async #moveMark(previous: ProfilesSource): Promise<void> {
    const current = this.source.value;
    const problems: string[] = [];
    const sameRepository =
      previous.kind === 'repository' &&
      current.kind === 'repository' &&
      previous.repository.toLowerCase() === current.repository.toLowerCase();
    let signedOut = false;
    if (previous.kind === 'repository' && !sameRepository) {
      try {
        await unmarkConfigRepository(this.#github, previous.repository);
      } catch (error) {
        if (isSignedOut(error)) {
          signedOut = true;
          this.#onSignedOut();
        }
        problems.push(
          `Couldn't take the repotted-config topic off ${previous.repository}, so a new browser may still offer it: ${messageOf(error)}`,
        );
      }
    }
    if (current.kind === 'repository' && !signedOut) {
      try {
        if (await markConfigRepository(this.#github, current.repository, current.path)) {
          await this.#syncPastMarker();
        }
      } catch (error) {
        if (isSignedOut(error)) {
          this.#onSignedOut();
        }
        problems.push(
          `Couldn't mark ${current.repository} with the repotted-config topic, so a new browser won't find it by itself: ${messageOf(error)}`,
        );
      }
    }
    this.markProblem.value = problems.length === 0 ? undefined : problems.join(' ');
  }

  /** From the profiles folder, with '' for the profiles folder itself first. */
  readonly folders = computed<readonly string[]>(() => {
    const folders = new Set(['']);
    for (const listing of this.listings.value) {
      const parts = listing.folder === '' ? [] : listing.folder.split('/');
      parts.forEach((_part, index) => folders.add(parts.slice(0, index + 1).join('/')));
    }
    return [...folders].sort();
  });

  nameProblem(name: string, folder: string): string | undefined {
    const trimmed = name.trim();
    if (trimmed === '') {
      return 'Give the profile a name.';
    }
    // What a sync refuses in a profile's path, so a profile made here always reaches GitHub.
    if (/^\.|[/\\:*?"<>|\p{Cc}]|[. ]$/u.test(trimmed)) {
      return 'A name cannot start with a dot, end with a dot or a space, or hold / \\ : * ? " < > |.';
    }
    if (/\.ya?ml$/iu.test(trimmed)) {
      return 'Leave out the file ending; Repotted adds .yaml.';
    }
    if (windowsNames.test(trimmed.split('.')[0] ?? trimmed)) {
      return `Windows keeps the name ${trimmed} for itself, so it cannot be a file there.`;
    }
    const place = folder === '' ? 'the profiles folder' : folder;
    const taken = this.listings.value.find(
      (listing) => listing.folder === folder && listing.name.toLowerCase() === trimmed.toLowerCase(),
    );
    if (taken !== undefined) {
      return `${basename(taken.file)} is already in ${place}.`;
    }
    return this.#capturing.has(this.#fileOf(trimmed, folder).toLowerCase())
      ? `Another capture is making ${trimmed}.yaml.`
      : undefined;
  }

  /**
   * Never replaces a file that is there. A capture reads GitHub first,
   * outside the queue, and holds its name meanwhile; a `signal` aborted
   * before it ends leaves nothing behind. It answers why it couldn't.
   */
  async create(profile: NewProfile, signal?: AbortSignal): Promise<string | undefined> {
    const problem = this.nameProblem(profile.name, profile.folder);
    if (problem !== undefined) {
      return problem;
    }
    const file = this.#fileOf(profile.name.trim(), profile.folder);
    const folder = this.folder.value;
    let text: string;
    let uncaptured: UncapturedSettings = {
      count: 0,
      groups: [],
      needsAppPermission: false,
      installationSettingsUrl: null,
    };
    if (profile.start.kind === 'repository') {
      this.#capturing.add(file.toLowerCase());
      try {
        const repository = parseRepo(profile.start.repository);
        const captured = await captureProfile(this.#github, repository);
        if (profile.definitionKind !== undefined && captured.profile.actions === undefined) {
          return 'The Actions settings could not be captured. Check repository access before trying again.';
        }
        text =
          profile.definitionKind === undefined
            ? stringifyProfile(captured.profile)
            : `kind: ${profile.definitionKind}\n${stringifyProfile({ owner_type: captured.profile.owner_type, actions: captured.profile.actions })}`;
        uncaptured = uncapturedSettings(captured.warnings, captured.profile.owner_type);
        if (uncaptured.needsAppPermission) {
          uncaptured = {
            ...uncaptured,
            installationSettingsUrl: await this.#installationSettingsUrl(repository.owner),
          };
        }
      } catch (error) {
        if (isSignedOut(error)) {
          this.#onSignedOut();
        }
        return messageOf(error);
      } finally {
        this.#capturing.delete(file.toLowerCase());
      }
    } else if (profile.start.kind === 'duplicate') {
      const source = profile.start.source.file;
      const original = await readFile(source, 'utf8');
      const base = declaredExtends(original);
      text =
        base === undefined ? original : withExtends(original, relative(dirname(file), resolve(dirname(source), base)));
      text = withRewrittenReferences(text, (reference) => relative(dirname(file), resolve(dirname(source), reference)));
    } else if (profile.start.kind === 'import') {
      text = profile.start.text;
    } else {
      if (profile.definitionKind !== undefined && profile.start.kind === 'extends') {
        return 'A reusable definition cannot extend a profile.';
      }
      const owner = profile.ownerType === undefined ? '' : `owner_type: ${profile.ownerType}\n`;
      text =
        profile.start.kind === 'empty'
          ? profile.definitionKind === undefined
            ? owner
            : `kind: ${profile.definitionKind}\n${owner}actions: {}\n`
          : `extends: ${JSON.stringify(relative(dirname(file), profile.start.base.file))}\n${
              profile.start.base.owner_type === null ? owner : ''
            }`;
    }
    return this.#work(async () => {
      // A capture whose form closed makes nothing. A profile asked for outright is made even so.
      if (profile.start.kind === 'repository' && signal?.aborted === true) {
        return undefined;
      }
      // Where profiles are kept may have changed while this waited or GitHub was read.
      if (this.folder.value !== folder) {
        return 'Where profiles are kept changed, so the profile was not made.';
      }
      // A file a tool put in the folder on this computer since the last sync counts too.
      if (this.source.value.kind === 'folder') {
        await this.#sync({});
        await this.#list();
      }
      // The list is as the turns before this one left it, such as a sync that pulled a profile of that name.
      const taken = this.nameProblem(profile.name, profile.folder);
      if (taken !== undefined) {
        return taken;
      }
      const unusableFolder = folderProblem(profile.folder);
      if (unusableFolder !== undefined) {
        return unusableFolder;
      }
      try {
        await parseProfile(text, dirname(file));
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, text, { flag: 'wx' });
      } catch (error) {
        const exists = error instanceof Error && 'code' in error && error.code === 'EEXIST';
        return exists ? `${basename(file)} is already there.` : messageOf(error);
      }
      await this.#sync({});
      await this.#list();
      this.settingsCaptureCouldNotRead.value = uncaptured.count > 0 ? { file, uncaptured } : undefined;
      await this.select(this.listings.value.find((listing) => listing.file === file));
      return undefined;
    });
  }

  /** Directly or through another: they stop loading without these profiles. */
  dependents(...listings: readonly ProfileListing[]): readonly ProfileListing[] {
    const gone = new Set(listings.map((listing) => listing.file));
    const found = new Set<string>(gone);
    for (let grew = true; grew;) {
      grew = false;
      for (const other of this.listings.value) {
        if (
          [other.extends, ...(other.references ?? [])].some((source) => source !== null && found.has(source)) &&
          !found.has(other.file)
        ) {
          found.add(other.file);
          grew = true;
        }
      }
    }
    return this.listings.value.filter((other) => !gone.has(other.file) && found.has(other.file));
  }

  consumerNames(listing: ProfileListing): readonly string[] {
    const profiles = this.dependents(listing);
    return [
      ...profiles.map((item) => item.name),
      ...this.#assignedConsumers([listing.file, ...profiles.map((item) => item.file)]),
    ];
  }

  /** Deleted in one turn, so they leave in one commit. */
  remove(...listings: readonly ProfileListing[]): Promise<string | undefined> {
    return this.#work(async () => {
      // The list may have been read again, from another place, since the user asked.
      const listed = new Set(this.listings.value.map((item) => item.file));
      const going = new Set(listings.map((listing) => listing.file).filter((file) => listed.has(file)));
      if (going.size === 0) {
        return undefined;
      }
      const dependent = this.dependents(...listings);
      if (listings.some((listing) => listing.kind !== undefined) && dependent.length > 0) {
        return `Remove the references in ${dependent.map((listing) => listing.name).join(', ')} first.`;
      }
      const assigned = this.#assignedConsumers([...going]);
      if (assigned.length > 0) {
        return `Remove these sources from the assignments of ${assigned.join(', ')} before deleting them.`;
      }
      for (const file of going) {
        await rm(file, { force: true });
      }
      // Their unsaved changes go with them.
      this.#editors.value = this.#editors.value.filter((editor) => !going.has(editor.file));
      if (going.has(this.settingsCaptureCouldNotRead.value?.file ?? '')) {
        this.settingsCaptureCouldNotRead.value = undefined;
      }
      this.#deselect(going);
      await this.#sync({});
      await this.#list();
      return undefined;
    });
  }

  /** Into `folder`, '' for the profiles folder itself. Answers why they couldn't move. */
  async move(listings: readonly ProfileListing[], folder: string): Promise<string | undefined> {
    const named = folder.trim();
    const failure = await this.#moveFiles(
      () => {
        const inAnotherCase = this.#folderInAnotherCase(named, undefined);
        return inAnotherCase === undefined ? folderProblem(named) : `There is already a folder named ${inAnotherCase}.`;
      },
      () => new Map(listings.map((listing) => [listing.file, join(this.folder.value, named, basename(listing.file))])),
    );
    if (failure === undefined) {
      // Those already there are deselected with the rest, and the folder they went to opens, so they stay in view.
      this.#deselect(new Set(listings.map((listing) => listing.file)));
      this.#closedFolders.value = new Set(
        [...this.#closedFolders.value].filter((path) => path !== named && !named.startsWith(`${path}/`)),
      );
    }
    return failure;
  }

  /** Moves every profile in the folder and its subfolders. Answers why it couldn't. */
  async renameFolder(path: string, name: string): Promise<string | undefined> {
    const trimmed = name.trim();
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const renamed = parent === '' ? trimmed : `${parent}/${trimmed}`;
    const failure = await this.#moveFiles(
      () => {
        if (trimmed === '') {
          return 'Give the folder a name.';
        }
        if (trimmed.includes('/')) {
          return 'A folder name cannot hold /.';
        }
        if (renamed !== path && renamed.toLowerCase() === path.toLowerCase()) {
          return `${trimmed} differs from ${path.slice(parent === '' ? 0 : parent.length + 1)} only in case, which some computers take for the same folder. Give it another name.`;
        }
        if (renamed !== path && this.folders.value.includes(renamed)) {
          return `There is already a folder named ${renamed}.`;
        }
        const inAnotherCase = this.#folderInAnotherCase(renamed, path);
        return inAnotherCase === undefined
          ? folderProblem(renamed)
          : `There is already a folder named ${inAnotherCase}.`;
      },
      () =>
        new Map(
          this.listings.value
            .filter((listing) => listing.folder === path || listing.folder.startsWith(`${path}/`))
            .map((listing) => [
              listing.file,
              join(this.folder.value, renamed + listing.folder.slice(path.length), basename(listing.file)),
            ]),
        ),
    );
    if (failure === undefined) {
      this.#closedFolders.value = new Set(
        [...this.#closedFolders.value].map((closed) =>
          closed === path || closed.startsWith(`${path}/`) ? renamed + closed.slice(path.length) : closed,
        ),
      );
    }
    return failure;
  }

  /**
   * A folder there is already whose name matches `folder`, or a folder over
   * it, in another case, leaving out `renaming` and the folders in it. Some
   * computers take the two for one folder.
   */
  #folderInAnotherCase(folder: string, renaming: string | undefined): string | undefined {
    const parts = folder === '' ? [] : folder.split('/');
    for (let depth = 1; depth <= parts.length; depth += 1) {
      const over = parts.slice(0, depth).join('/');
      const other = this.folders.value.find(
        (existing) =>
          existing !== over &&
          existing.toLowerCase() === over.toLowerCase() &&
          (renaming === undefined || (existing !== renaming && !existing.startsWith(`${renaming}/`))),
      );
      if (other !== undefined) {
        return other;
      }
    }
    return undefined;
  }

  /**
   * Moves the files named in the plan, from their file to where they go,
   * and points every `extends` that names a moved file at its new place, so
   * nothing stops loading. The plan is made in the turn, from the list as
   * the turns before this one left it. A write that fails takes back those
   * before it, so nothing is half moved.
   */
  #moveFiles(problem: () => string | undefined, plan: () => ReadonlyMap<string, string>): Promise<string | undefined> {
    return this.#work(async () => {
      // A file a tool put in the folder on this computer since the last sync counts too.
      if (this.source.value.kind === 'folder') {
        await this.#sync({});
        await this.#list();
      }
      const refused = problem();
      if (refused !== undefined) {
        return refused;
      }
      const listed = new Map(this.listings.value.map((listing) => [listing.file, listing]));
      const moves = new Map([...plan()].filter(([from, to]) => listed.has(from) && from !== to));
      if (moves.size === 0) {
        return undefined;
      }
      const assigned = this.#assignedConsumers([...moves.keys()]);
      if (assigned.length > 0) {
        return `Remove these sources from the assignments of ${assigned.join(', ')} before moving them.`;
      }
      for (const from of moves.keys()) {
        const listing = listed.get(from);
        if (listing?.problem !== null) {
          return `${listing?.name ?? basename(from)} doesn't load, so it can't be moved. Fix it first.`;
        }
        if (this.unsaved.value.has(from)) {
          return `Save or reset the changes to ${listing.name} first.`;
        }
      }
      const listedInAnyCase = new Set([...listed.keys()].map((file) => file.toLowerCase()));
      const staying = new Set([...listed.keys()].filter((file) => !moves.has(file)).map((file) => file.toLowerCase()));
      const arriving = new Set<string>();
      for (const to of moves.values()) {
        const place = relative(this.folder.value, dirname(to));
        const parts = place === '' ? [] : place.split('/');
        const profileInTheWay = parts
          .map((_part, index) => parts.slice(0, index + 1).join('/'))
          .find((over) => listedInAnyCase.has(join(this.folder.value, over).toLowerCase()));
        if (profileInTheWay !== undefined) {
          return `${profileInTheWay} is a profile, so it can't be a folder.`;
        }
        const key = to.toLowerCase();
        if (staying.has(key) || arriving.has(key)) {
          return `${basename(to)} is already in ${place === '' ? 'the profiles folder' : place}.`;
        }
        arriving.add(key);
      }
      const moved: { readonly from: string; readonly to: string; readonly text: string }[] = [];
      const repointed: { readonly file: string; readonly text: string; readonly before: string }[] = [];
      for (const from of listed.keys()) {
        const to = moves.get(from) ?? from;
        const before = await readFile(from, 'utf8');
        const declared = declaredExtends(before);
        const base = declared === undefined ? undefined : resolve(dirname(from), declared);
        const baseNow = base === undefined ? undefined : (moves.get(base) ?? base);
        const stillPointed = declared === undefined || resolve(dirname(to), declared) === baseNow;
        const extended =
          stillPointed || baseNow === undefined ? before : withExtends(before, relative(dirname(to), baseNow));
        const text = withRewrittenReferences(extended, (reference) => {
          const target = resolve(dirname(from), reference);
          return relative(dirname(to), moves.get(target) ?? target);
        });
        if (to !== from) {
          moved.push({ from, to, text });
        } else if (text !== before) {
          // An open editor holds the file as it was read, so a save would put the old `extends` back.
          if (this.unsaved.value.has(from)) {
            return `Save or reset the changes to ${listed.get(from)?.name ?? basename(from)} first.`;
          }
          repointed.push({ file: from, text, before });
        }
      }
      const written: (() => Promise<void>)[] = [];
      let writing = moved[0]?.to ?? '';
      try {
        for (const { to, text } of moved) {
          writing = to;
          await mkdir(dirname(to), { recursive: true });
          await writeFile(to, text, { flag: 'wx' });
          written.push(() => rm(to, { force: true }));
        }
        for (const { file, text, before } of repointed) {
          writing = file;
          await writeFile(file, text);
          written.push(() => writeFile(file, before));
        }
      } catch (error) {
        for (const takeBack of written.reverse()) {
          await takeBack().catch(() => undefined);
        }
        await this.#list();
        const place = relative(this.folder.value, dirname(writing));
        return error instanceof Error && 'code' in error && error.code === 'EEXIST'
          ? `${basename(writing)} is already in ${place === '' ? 'the profiles folder' : place}.`
          : `Couldn't move the profiles, so nothing moved: ${messageOf(error)}`;
      }
      try {
        for (const { from } of moved) {
          writing = from;
          await rm(from, { force: true });
        }
      } catch (error) {
        await this.#sync({});
        await this.#list();
        return `The profiles are at the new place, but ${relative(this.folder.value, writing)} couldn't be removed from the old one: ${messageOf(error)}`;
      }
      const rewritten = new Set([...moves.keys(), ...repointed.map((write) => write.file)]);
      this.#editors.value = this.#editors.value.filter((editor) => !rewritten.has(editor.file));
      const couldNotRead = this.settingsCaptureCouldNotRead.value;
      if (couldNotRead !== undefined && moves.has(couldNotRead.file)) {
        this.settingsCaptureCouldNotRead.value = {
          ...couldNotRead,
          file: moves.get(couldNotRead.file) ?? couldNotRead.file,
        };
      }
      const open = this.#selectedFile.value;
      this.#selectedFile.value = open === undefined ? undefined : (moves.get(open) ?? open);
      this.#deselect(new Set(moves.keys()));
      await this.#sync({});
      await this.#list();
      if (open !== undefined && rewritten.has(open)) {
        await this.select(this.selected.value);
      }
      return undefined;
    });
  }

  /** For a batch action; which profile is open is `selected`. */
  readonly #selectedForBatch = signal<ReadonlySet<string>>(new Set());

  readonly batch = computed(() =>
    this.listings.value.filter((listing) => this.#selectedForBatch.value.has(listing.file)),
  );

  isInBatch(listing: ProfileListing): boolean {
    return this.#selectedForBatch.value.has(listing.file);
  }

  selectForBatch(listings: readonly ProfileListing[], selected: boolean): void {
    const next = new Set(this.#selectedForBatch.value);
    for (const listing of listings) {
      if (selected) {
        next.add(listing.file);
      } else {
        next.delete(listing.file);
      }
    }
    this.#selectedForBatch.value = next;
  }

  deselectBatch(): void {
    this.#selectedForBatch.value = new Set();
  }

  #deselect(files: ReadonlySet<string>): void {
    this.#selectedForBatch.value = new Set([...this.#selectedForBatch.value].filter((file) => !files.has(file)));
  }

  async select(listing: ProfileListing | undefined): Promise<void> {
    this.#selectedFile.value = listing?.file;
    this.opened.value = undefined;
    if (listing === undefined) {
      return;
    }
    let editor = this.#editors.value.find((item) => item.file === listing.file);
    if (editor === undefined) {
      editor = new ProfileEditor(listing.file, {
        patterns: new ActionPatternChecks((patterns) => this.#asking(checkActionPatterns(this.#github, patterns))),
        search: new ActionSearch((words) => this.#asking(findActions(this.#github, words))),
        appLookup: new GitHubAppLookup((slug) => this.#asking(findGitHubApp(this.#github, slug))),
      });
      this.#editors.value = [...this.#editors.value, editor];
      await editor.load();
    }
    const text = await readFile(listing.file, 'utf8').catch(() => undefined);
    // Another profile may have been chosen while this one was read.
    if (text !== undefined && this.#selectedFile.value === listing.file) {
      this.opened.value = { file: listing.file, text };
    }
  }

  /**
   * When profiles are kept on GitHub, a sync first brings in what changed
   * there, so the save lands on the file as it is now, and a sync after
   * commits it.
   */
  async saveReferences(
    file: string,
    references: Readonly<Record<string, string | readonly string[]>>,
    expected: string,
  ): Promise<string | undefined> {
    try {
      await this.#write(async () => {
        if (this.unsaved.value.has(file)) {
          throw new Error(unsavedFirst);
        }
        if ((await readFile(file, 'utf8')) !== expected) {
          throw new Error('The file changed. Reload its references before saving.');
        }
        await editProfile(file, [{ path: ['references'], value: references }]);
      });
      return undefined;
    } catch (error) {
      return messageOf(error);
    }
  }

  referencesOf(text: string, file: string): Readonly<Record<string, unknown>> {
    const node = parseDocument(text).get('references', true);
    const value: unknown = isMap(node) ? node.toJSON() : {};
    const references = z.record(z.string(), z.union([z.string(), z.array(z.string())])).parse(value);
    const canonical = (reference: string): string => relative(dirname(file), resolve(dirname(file), reference));
    return Object.fromEntries(
      Object.entries(references).map(([section, reference]) => [
        section,
        typeof reference === 'string' ? canonical(reference) : reference.map(canonical),
      ]),
    );
  }

  async save(mode: SaveMode = 'applies'): Promise<void> {
    await this.editor.value?.save((write) => this.#write(write), mode);
  }

  /**
   * Gives a write to a profile's file, made from outside its editor, its
   * turn among syncs: what changed on GitHub comes in first, the write is
   * committed after, and the list and the editors are read again.
   */
  async write(work: () => Promise<void>): Promise<void> {
    await this.#write(work);
  }

  /** In a turn of the queue, so no sync or save changes the folder while it is read. */
  async readFolderWithoutSyncing<Result>(
    work: (folder: string, source: ProfilesSource) => Promise<Result>,
  ): Promise<Result> {
    return this.#work(() => work(this.folder.value, this.source.value));
  }

  async changeOwnerType(type: OwnerChoice): Promise<void> {
    await this.editor.value?.changeOwnerType((write) => this.#write(write), type);
  }

  async discardDraft(): Promise<void> {
    await this.editor.value?.discardDraft((write) => this.#write(write));
  }

  async #write(write: () => Promise<void>): Promise<void> {
    await this.#work(async () => {
      await this.#sync({});
      await write();
      await this.#sync({});
      await this.#list();
    });
  }

  /** A sign-in GitHub refuses on an editor's request goes to the sign-in page, as anywhere. */
  async #asking<Answer>(asked: Promise<Answer>): Promise<Answer> {
    try {
      return await asked;
    } catch (error) {
      if (isSignedOut(error)) {
        this.#onSignedOut();
      }
      throw error;
    }
  }

  toggleFolder(path: string): void {
    const closed = new Set(this.#closedFolders.value);
    if (!closed.delete(path)) {
      closed.add(path);
    }
    this.#closedFolders.value = closed;
  }

  pathOf(listing: ProfileListing): string {
    return relative(this.folder.value, listing.file);
  }

  #fileOf(name: string, folder: string): string {
    return join(this.folder.value, folder, `${name}.yaml`);
  }

  #use(source: ProfilesSource): void {
    if (source.kind !== 'folder') {
      this.#localFolder = undefined;
      this.needsFolderAccess.value = false;
      if (this.source.value.kind === 'folder') {
        // A folder the browser can't forget is only a handle left behind, which the next folder picked replaces.
        this.#folders?.forget().catch(() => undefined);
      }
    }
    this.source.value = source;
    this.#preferences.write(sourceKey, source);
    this.chosen.value = true;
    this.markProblem.value = undefined;
    this.#closedFolders.value = new Set();
    this.#selectedForBatch.value = new Set();
    this.#editors.value = [];
    this.settingsCaptureCouldNotRead.value = undefined;
    this.#selectedFile.value = undefined;
    this.opened.value = undefined;
  }

  async #work<Result>(work: () => Promise<Result>): Promise<Result> {
    return this.#queue.run(async () => {
      this.profileWorkUnderWay.value = true;
      try {
        return await work();
      } finally {
        this.profileWorkUnderWay.value = false;
      }
    });
  }

  /** The marker's commit moves the default branch on, so the copy here syncs to it again, adding to what was synced. */
  async #syncPastMarker(): Promise<void> {
    const before = this.sync.value;
    await this.#sync({});
    const after = this.sync.value;
    if (after.status !== 'synced') {
      return;
    }
    if (before.status === 'synced') {
      this.sync.value = {
        status: 'synced',
        pulled: before.pulled + after.pulled,
        pushed: before.pushed + after.pushed,
      };
    }
    if (after.pulled > 0) {
      await this.#list();
    }
  }

  async #sync(options: { readonly prefer?: 'local' | 'remote'; readonly only?: readonly string[] }): Promise<void> {
    const source = this.source.value;
    if (source.kind === 'folder') {
      await this.#syncFolder(options);
      return;
    }
    if (source.kind !== 'repository') {
      return;
    }
    this.sync.value = { status: 'syncing' };
    try {
      // Named each time, so a working copy the browser lost starts over as a first sync.
      const result = await syncFolder(this.#github, this.folder.value, {
        repository: source.repository,
        path: source.path,
        ...options,
      });
      this.sync.value = { status: 'synced', pulled: result.pulled.length, pushed: result.pushed.length };
      this.conflicts.value = result.conflicts;
    } catch (error) {
      if (isSignedOut(error)) {
        this.#onSignedOut();
      }
      this.sync.value = { status: 'failed', message: messageOf(error) };
    }
  }

  async #syncFolder(options: {
    readonly prefer?: 'local' | 'remote';
    readonly only?: readonly string[];
  }): Promise<void> {
    this.sync.value = { status: 'syncing' };
    try {
      if (this.#localFolder === undefined) {
        const saved = await this.#folders?.saved();
        if (saved === undefined) {
          throw new Error('This browser no longer has the folder. Choose it again in Settings.');
        }
        this.needsFolderAccess.value = !saved.allowed;
        if (!saved.allowed) {
          this.sync.value = { status: 'failed', message: 'The browser asks before Repotted uses the folder again' };
          return;
        }
        this.#localFolder = saved.folder;
      }
      const result = await syncLocalFolder(this.folder.value, this.#localFolder, options);
      this.conflicts.value = result.conflicts;
      const [failure] = result.failures;
      if (failure !== undefined) {
        const more = result.failures.length - 1;
        throw new Error(more === 0 ? failure : `${failure}, and ${more} more ${more === 1 ? 'profile' : 'profiles'}`);
      }
      this.needsFolderAccess.value = false;
      this.sync.value = { status: 'synced', pulled: result.pulled.length, pushed: result.pushed.length };
    } catch (error) {
      // The browser may have taken its leave back, as it does when the tab was away for long,
      // so the folder is asked for afresh next time, and the user for their leave if it went.
      this.#localFolder = undefined;
      const saved = await this.#folders?.saved().catch(() => undefined);
      this.needsFolderAccess.value = saved !== undefined && !saved.allowed;
      this.sync.value = { status: 'failed', message: messageOf(error) };
    }
  }

  async #list(): Promise<void> {
    try {
      await mkdir(this.folder.value, { recursive: true });
      this.listings.value = await listProfiles(this.folder.value);
      this.listingError.value = undefined;
    } catch (error) {
      this.listingError.value = messageOf(error);
    }
    // Each editor reads its profile again, since a sync may have changed it or one it extends,
    // and lays its unsaved changes over what it finds. An editor whose profile is gone goes too.
    const listed = new Set(this.listings.value.map((listing) => listing.file));
    this.#editors.value = this.#editors.value.filter((editor) => listed.has(editor.file));
    await Promise.all(this.#editors.value.map((editor) => editor.load()));
    // The open profile may have changed in the sync, or gone.
    const open = this.selected.value;
    if (open === undefined) {
      this.#selectedFile.value = undefined;
      this.opened.value = undefined;
    } else {
      const text = await readFile(open.file, 'utf8').catch(() => undefined);
      this.opened.value = text === undefined ? undefined : { file: open.file, text };
    }
  }
}
