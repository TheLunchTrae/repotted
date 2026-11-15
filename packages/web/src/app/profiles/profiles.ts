import { computed, signal } from '@preact/signals';
import {
  captureProfile,
  checkActionPatterns,
  findActions,
  type GitHub,
  listProfiles,
  type OwnerType,
  parseRepo,
  readInstallationSettingsUrl,
  stringifyProfile,
  syncFolder,
} from '@repotted/core';
import * as z from 'zod/mini';

import { mkdir, readdir, readFile, rm, stat, writeFile } from '../../engine/files.js';
import { basename, dirname, join, relative } from '../../engine/path.js';
import { isSignedOut } from '../account/account.js';
import type { Preferences } from '../preferences/preferences.js';
import { ActionPatternChecks } from '../profile-editor/action-pattern-checks.js';
import { ActionSearch } from '../profile-editor/action-search.js';
import type { SaveMode } from '../profile-editor/entry-edits.js';
import { type OwnerChoice, ProfileEditor } from '../profile-editor/profile-editor.js';
import { SerialQueue } from '../storage/serial-queue.js';
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
  | { readonly kind: 'repository'; readonly repository: string };

export interface NewProfile {
  readonly name: string;
  /** From the profiles folder; '' for the profiles folder itself. */
  readonly folder: string;
  readonly start: NewProfileStart;
  /** A capture takes the repository's owner type, and a profile that extends a typed one takes that type. */
  readonly ownerType: OwnerType | undefined;
}

// Names no file can have on Windows, where a config repository's profiles may also be used.
const windowsNames = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;

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
  /** The folder on this computer, once the browser has let the page use it this visit. */
  #localFolder: LocalFolder | undefined;

  constructor(github: GitHub, preferences: Preferences, onSignedOut: () => void, folders?: LocalFolders) {
    this.#github = github;
    this.#preferences = preferences;
    this.#onSignedOut = onSignedOut;
    this.#folders = folders;
    const saved = savedSource.safeParse(preferences.read(sourceKey));
    if (saved.success) {
      this.source.value = saved.data;
    }
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
   * left where profiles are kept as it was.
   */
  connect(repository: string, path: string, addLocal: boolean): Promise<string | undefined> {
    return this.#work(async () => {
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
        path: path.trim().replace(/^\/+|\/+$/gu, ''),
      };
    } catch {
      return 'Name the repository as owner/name, such as you/repotted-config.';
    }
    const target = folderOf(source);
    const from = this.folder.value;
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
      this.#use({ kind: 'browser' });
      this.connectError.value = undefined;
      this.sync.value = { status: 'none' };
      this.conflicts.value = [];
      await this.#list();
    });
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
        text = stringifyProfile(captured.profile);
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
    } else {
      const owner = profile.ownerType === undefined ? '' : `owner_type: ${profile.ownerType}\n`;
      text =
        profile.start.kind === 'empty'
          ? owner
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
      // A folder is one that holds profiles, or a new one under the profiles folder, never a way out of it.
      if (
        profile.folder.split('/').some((part) => profile.folder !== '' && /^\.|^$|[\\:*?"<>|\p{Cc}]|[. ]$/u.test(part))
      ) {
        return `${profile.folder} is not a folder a profile can go in.`;
      }
      try {
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

  /** Directly or through another: they stop loading without this profile. */
  dependents(listing: ProfileListing): readonly ProfileListing[] {
    const found = new Set<string>([listing.file]);
    for (let grew = true; grew;) {
      grew = false;
      for (const other of this.listings.value) {
        if (other.extends !== null && found.has(other.extends) && !found.has(other.file)) {
          found.add(other.file);
          grew = true;
        }
      }
    }
    return this.listings.value.filter((other) => other.file !== listing.file && found.has(other.file));
  }

  remove(listing: ProfileListing): Promise<string | undefined> {
    return this.#work(async () => {
      // The list may have been read again, from another place, since the user asked.
      if (!this.listings.value.some((item) => item.file === listing.file)) {
        return undefined;
      }
      await rm(listing.file, { force: true });
      // Its unsaved changes go with it.
      this.#editors.value = this.#editors.value.filter((editor) => editor.file !== listing.file);
      if (this.settingsCaptureCouldNotRead.value?.file === listing.file) {
        this.settingsCaptureCouldNotRead.value = undefined;
      }
      await this.#sync({});
      await this.#list();
      return undefined;
    });
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
    this.#closedFolders.value = new Set();
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
