import { computed, signal } from '@preact/signals';
import { type GitHub, listProfiles, parseRepo, syncFolder } from '@repotted/core';
import * as z from 'zod/mini';

import { mkdir, readdir, readFile, rm, stat, writeFile } from '../engine/files.js';
import { dirname, join, relative } from '../engine/path.js';
import { isSignedOut } from './account.js';
import type { Preferences } from './preferences.js';
import { SerialQueue } from './serial-queue.js';

export type ProfileListing = Awaited<ReturnType<typeof listProfiles>>[number];

/** Where the profiles are kept: in this browser only, or in a folder of a GitHub repository. */
export type ProfilesSource =
  | { readonly kind: 'browser' }
  | { readonly kind: 'repository'; readonly repository: string; readonly path: string };

export type SyncState =
  | { readonly status: 'none' }
  | { readonly status: 'syncing' }
  | { readonly status: 'synced'; readonly pulled: number; readonly pushed: number }
  | { readonly status: 'failed'; readonly message: string };

/** A folder of profiles in the sidebar, with the folders and profiles in it that show. */
export interface ProfileFolderNode {
  readonly name: string;
  /** Its path from the profiles folder, with `/` separators; '' for the profiles folder itself. */
  readonly path: string;
  /** How many profiles show in it and the folders under it. */
  readonly count: number;
  readonly open: boolean;
  readonly folders: readonly ProfileFolderNode[];
  readonly profiles: readonly ProfileListing[];
}

const sourceKey = 'profiles-source';
const savedSource = z.union([
  z.object({ kind: z.literal('browser') }),
  z.object({ kind: z.literal('repository'), repository: z.string(), path: z.string() }),
]);

// The engine's record of what a folder and its repository last agreed on.
const syncRecord = '.repotted-sync.json';
const browserFolder = '/profiles/browser';

function folderOf(source: ProfilesSource): string {
  if (source.kind === 'browser') {
    return browserFolder;
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

/** Every profile file under a folder, by its path from that folder. Hidden files and folders stay out, as in a sync. */
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

/**
 * The profiles: where they are kept, how the last sync with GitHub went,
 * and the list the sidebar shows. Syncs and changes to the folder take
 * turns, so a sync never reads a folder that is being changed.
 */
export class Profiles {
  readonly source = signal<ProfilesSource>({ kind: 'browser' });
  readonly sync = signal<SyncState>({ status: 'none' });
  /** The profiles that changed both here and on GitHub since the last sync, by path in the folder. */
  readonly conflicts = signal<readonly string[]>([]);
  readonly listings = signal<readonly ProfileListing[]>([]);
  /** Why the folder couldn't be listed. */
  readonly error = signal<string | undefined>(undefined);
  /** Whether a sync, a listing, or a change of where profiles are kept is under way. */
  readonly busy = signal(false);
  readonly search = signal('');
  /** The open profile's file as it is saved, once read. */
  readonly opened = signal<{ readonly file: string; readonly text: string } | undefined>(undefined);

  readonly #github: GitHub;
  readonly #preferences: Preferences;
  readonly #onSignedOut: () => void;
  readonly #queue = new SerialQueue();
  readonly #closedFolders = signal<ReadonlySet<string>>(new Set());
  readonly #selectedFile = signal<string | undefined>(undefined);

  constructor(github: GitHub, preferences: Preferences, onSignedOut: () => void) {
    this.#github = github;
    this.#preferences = preferences;
    this.#onSignedOut = onSignedOut;
    const saved = savedSource.safeParse(preferences.read(sourceKey));
    if (saved.success) {
      this.source.value = saved.data;
    }
  }

  /** The folder that holds the profiles, in the engine's files. */
  readonly folder = computed(() => folderOf(this.source.value));

  readonly selected = computed(() => this.listings.value.find((listing) => listing.file === this.#selectedFile.value));

  /** The profiles folder as the sidebar draws it: the profiles whose name or folder holds the search, by folder. */
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

  /** Syncs with GitHub when the profiles are kept there, then lists the folder. */
  refresh(): Promise<void> {
    return this.#work(async () => {
      if (this.source.value.kind === 'repository') {
        await this.#sync({});
      }
      await this.#list();
    });
  }

  /** Settles every conflict for one side: `local` commits this browser's versions, `remote` takes GitHub's. */
  keep(prefer: 'local' | 'remote'): Promise<void> {
    return this.#work(async () => {
      await this.#sync({ prefer, only: this.conflicts.value });
      await this.#list();
    });
  }

  /**
   * Keeps the profiles in a GitHub repository from now on, after a first
   * sync with it. `addLocal` first copies the profiles kept now into the
   * repository's copy, skipping names it already has. It answers why it
   * couldn't, having left where profiles are kept as it was.
   */
  connect(repository: string, path: string, addLocal: boolean): Promise<string | undefined> {
    return this.#work(async () => {
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
    });
  }

  /** Keeps the profiles in this browser only from now on. A repository keeps every profile it has. */
  keepInBrowser(): Promise<void> {
    return this.#work(async () => {
      this.#use({ kind: 'browser' });
      this.sync.value = { status: 'none' };
      this.conflicts.value = [];
      await this.#list();
    });
  }

  /** Opens a profile from the list, or with undefined leaves none open. */
  async select(listing: ProfileListing | undefined): Promise<void> {
    this.#selectedFile.value = listing?.file;
    this.opened.value = undefined;
    if (listing === undefined) {
      return;
    }
    const text = await readFile(listing.file, 'utf8').catch(() => undefined);
    // Another profile may have been chosen while this one was read.
    if (text !== undefined && this.#selectedFile.value === listing.file) {
      this.opened.value = { file: listing.file, text };
    }
  }

  toggleFolder(path: string): void {
    const closed = new Set(this.#closedFolders.value);
    if (!closed.delete(path)) {
      closed.add(path);
    }
    this.#closedFolders.value = closed;
  }

  /** A profile's path from the profiles folder, as the user knows it. */
  pathOf(listing: ProfileListing): string {
    return relative(this.folder.value, listing.file);
  }

  #use(source: ProfilesSource): void {
    this.source.value = source;
    this.#preferences.write(sourceKey, source);
    this.#closedFolders.value = new Set();
    this.#selectedFile.value = undefined;
    this.opened.value = undefined;
  }

  async #work<Result>(work: () => Promise<Result>): Promise<Result> {
    return this.#queue.run(async () => {
      this.busy.value = true;
      try {
        return await work();
      } finally {
        this.busy.value = false;
      }
    });
  }

  async #sync(options: { readonly prefer?: 'local' | 'remote'; readonly only?: readonly string[] }): Promise<void> {
    const source = this.source.value;
    if (source.kind !== 'repository') {
      return;
    }
    this.sync.value = { status: 'syncing' };
    try {
      const result = await syncFolder(this.#github, this.folder.value, options);
      this.sync.value = { status: 'synced', pulled: result.pulled.length, pushed: result.pushed.length };
      this.conflicts.value = result.conflicts;
    } catch (error) {
      if (isSignedOut(error)) {
        this.#onSignedOut();
      }
      this.sync.value = { status: 'failed', message: messageOf(error) };
    }
  }

  async #list(): Promise<void> {
    try {
      await mkdir(this.folder.value, { recursive: true });
      this.listings.value = await listProfiles(this.folder.value);
      this.error.value = undefined;
    } catch (error) {
      this.error.value = messageOf(error);
    }
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
