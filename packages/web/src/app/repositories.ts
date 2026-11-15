import { computed, signal } from '@preact/signals';
import { type GitHub, GitHubError, listRepositories } from '@repotted/core';
import * as z from 'zod/mini';

import { isSignedOut, type User } from './account.js';
import type { Preferences } from './preferences.js';
import type { SharedPreferences } from './shared-preferences.js';

type RepositoryList = Awaited<ReturnType<typeof listRepositories>>;
export type Repository = RepositoryList['repositories'][number];

export interface OwnerChoice {
  readonly owner: string;
  /** Whether the owner is the signed-in account. */
  readonly personal: boolean;
  /** How many repositories the owner has in the list. */
  readonly count: number;
  readonly shown: boolean;
}

export interface OwnerGroup {
  readonly owner: string;
  readonly personal: boolean;
  readonly repositories: readonly Repository[];
}

/** A folder the user made, with its repositories by `owner/name`, in the order they were put in. */
export interface Folder {
  readonly name: string;
  readonly repositories: readonly string[];
}

export interface FolderGroup {
  readonly name: string;
  readonly open: boolean;
  /** The repositories that show in it: as in the owners' groups, and while searching, those that match. */
  readonly repositories: readonly Repository[];
  /** Whether the folder holds no repository the list has. */
  readonly empty: boolean;
}

/** Where the selected panel moves the selected repositories: a folder, out of every folder, or a new folder. */
export type MoveTarget =
  | { readonly kind: 'folder'; readonly name: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'new' };

/** Why Refresh waits before it reads again, and until when. */
export interface RefreshWait {
  /** Whether GitHub's rate limit holds it, rather than the pause after a refresh. */
  readonly rateLimited: boolean;
  readonly until: Date;
}

/** How long Refresh waits after the read it started, so repeated presses don't spend the account's GitHub requests. */
export const refreshPause = 15_000;
/**
 * How long Refresh waits after a rate limit GitHub gives no time for, or a
 * time already past, as GitHub advises for a secondary limit.
 */
const rateLimitPause = 60_000;

/** How a folder move treats the selection. */
export interface FolderMoveOptions {
  /** Deselects the repositories moved, for ones that were selected to be moved. */
  readonly deselect?: boolean;
}

const hiddenOwnersKey = 'hidden-repository-owners';
const hiddenRepositoriesKey = 'hidden-repositories';
const foldersKey = 'repository-folders';
const closedFoldersKey = 'closed-repository-folders';
const names = z.array(z.string());
const savedFolders = z.array(z.object({ name: z.string(), repositories: z.array(z.string()) }));

function ownerOf(repository: Repository): string {
  return repository.full_name.split('/')[0] ?? repository.full_name;
}

function sameOwner(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/** GitHub names are case-insensitive, and so are folder names. */
const sameName = sameOwner;

function byName(left: Folder, right: Folder): number {
  return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
}

/**
 * The folders a saved value holds, by name. A file edited by hand may name a
 * folder twice or a repository in two folders: the first of each counts.
 */
function foldersIn(value: unknown): readonly Folder[] {
  const parsed = savedFolders.safeParse(value);
  if (!parsed.success) {
    return [];
  }
  const folders: Folder[] = [];
  const filed: string[] = [];
  for (const folder of parsed.data) {
    if (folders.some((kept) => sameName(kept.name, folder.name))) {
      continue;
    }
    const repositories = folder.repositories.filter(
      (name, index) =>
        !filed.some((other) => sameName(other, name)) &&
        folder.repositories.findIndex((other) => sameName(other, name)) === index,
    );
    filed.push(...repositories);
    folders.push({ name: folder.name, repositories });
  }
  return folders.toSorted(byName);
}

function namesIn(value: unknown): readonly string[] {
  const parsed = names.safeParse(value);
  return parsed.success ? parsed.data : [];
}

/**
 * The folders with these repositories taken out of every one and put at the
 * end of the named one, if any. A named folder that is missing, say deleted
 * elsewhere meanwhile, is made again, so the repositories aren't lost.
 */
function withMoved(folders: readonly Folder[], repositories: readonly string[], name: string | undefined): Folder[] {
  const moving = (filed: string): boolean => repositories.some((repository) => sameName(repository, filed));
  if (name !== undefined && !folders.some((folder) => sameName(folder.name, name))) {
    return [...withMoved(folders, repositories, undefined), { name, repositories: [...repositories] }];
  }
  return folders.map((folder) => {
    const kept = folder.repositories.filter((filed) => !moving(filed));
    return name !== undefined && sameName(folder.name, name)
      ? { ...folder, repositories: [...kept, ...repositories] }
      : { ...folder, repositories: kept };
  });
}

/** The list, or undefined to delete the key, when it holds none. */
function kept(list: readonly string[]): readonly string[] | undefined {
  return list.length > 0 ? list : undefined;
}

/** The repositories page: the list, whose repositories show, the search, and the repository opened. */
export class Repositories {
  readonly loading = signal(false);
  readonly error = signal<string | undefined>(undefined);
  /** Undefined until the first list arrives. */
  readonly list = signal<RepositoryList | undefined>(undefined);
  readonly search = signal('');
  /** Where the hidden owners and repositories are kept, and why they couldn't be read or saved. */
  readonly preferences: SharedPreferences;
  /** Whether the hidden repositories show, marked, among the rest. */
  readonly showHidden = signal(false);
  /** The repositories the last hide took out of the list, which Undo brings back. */
  readonly justHidden = signal<readonly string[]>([]);
  /** Of those, the ones that were selected, which Undo selects again. */
  #justDeselected: readonly string[] = [];
  /** The repository let go of when the last hide took it out of view, which Undo opens again. */
  #justClosed: string | undefined;

  readonly #github: GitHub;
  readonly #user: User;
  readonly #browser: Preferences;
  readonly #onSignedOut: () => void;
  readonly #hiddenOwners = computed(() => namesIn(this.preferences.read(hiddenOwnersKey)));
  /** Hidden repositories by `owner/name`, kept lowercase, since GitHub matches names in any case. */
  readonly #hiddenNames = computed<ReadonlySet<string>>(
    () => new Set(namesIn(this.preferences.read(hiddenRepositoriesKey)).map((name) => name.toLowerCase())),
  );
  /** The folders, by name. */
  readonly #folders = computed<readonly Folder[]>(() => foldersIn(this.preferences.read(foldersKey)));
  /** The closed folders, by name. Kept in this browser alone, so opening or closing a folder commits nothing. */
  readonly #closedFolders = signal<readonly string[]>([]);
  /** The folder last picked to move the selected repositories to, or made from the selected panel. */
  readonly #moveTarget = signal<MoveTarget | undefined>(undefined);
  readonly #openedName = signal<string | undefined>(undefined);
  readonly #selectedNames = signal<ReadonlySet<string>>(new Set());
  readonly #refreshWait = signal<RefreshWait | undefined>(undefined);
  /** The time the countdown last read, which a timer moves on each second while Refresh waits. */
  readonly #now = signal(Date.now());
  #clock: ReturnType<typeof setTimeout> | undefined;

  constructor(
    github: GitHub,
    user: User,
    preferences: SharedPreferences,
    browser: Preferences,
    onSignedOut: () => void,
  ) {
    this.#github = github;
    this.#user = user;
    this.preferences = preferences;
    this.#browser = browser;
    this.#closedFolders.value = namesIn(browser.read(closedFoldersKey));
    this.#onSignedOut = onSignedOut;
  }

  isHidden(repository: Repository): boolean {
    return this.#hiddenNames.value.has(repository.full_name.toLowerCase());
  }

  /** Every owner in the list, the signed-in account first, then by name. An owner new to the list shows. */
  readonly owners = computed<readonly OwnerChoice[]>(() => {
    const counts = new Map<string, number>();
    for (const repository of this.list.value?.repositories ?? []) {
      const owner = ownerOf(repository);
      const known = [...counts.keys()].find((name) => sameOwner(name, owner)) ?? owner;
      counts.set(known, (counts.get(known) ?? 0) + 1);
    }
    return [...counts]
      .map(([owner, count]) => ({
        owner,
        personal: sameOwner(owner, this.#user.login),
        count,
        shown: !this.#hiddenOwners.value.some((name) => sameOwner(name, owner)),
      }))
      .sort((left, right) =>
        left.personal === right.personal
          ? left.owner.localeCompare(right.owner, undefined, { sensitivity: 'base' })
          : left.personal
            ? -1
            : 1,
      );
  });

  /** The repositories of the owners not hidden, in the list's order. */
  readonly #ownersRepositories = computed<readonly Repository[]>(() => {
    const shown = this.owners.value.filter((owner) => owner.shown);
    return (this.list.value?.repositories ?? []).filter((repository) =>
      shown.some((owner) => sameOwner(owner.owner, ownerOf(repository))),
    );
  });

  /** How many of the shown owners' repositories are hidden. */
  readonly hiddenCount = computed(
    () => this.#ownersRepositories.value.filter((repository) => this.isHidden(repository)).length,
  );

  /** Whether hidden repositories leave the list short: some are hidden and they don't show. */
  readonly #hidingRepositories = computed(() => this.hiddenCount.value > 0 && !this.showHidden.value);

  /** The repositories that show without a search: the owners' not hidden, without the hidden ones unless they show. */
  readonly #listedRepositories = computed<readonly Repository[]>(() =>
    this.#ownersRepositories.value.filter((repository) => this.showHidden.value || !this.isHidden(repository)),
  );

  /** The folders' names, in order. */
  readonly folderNames = computed<readonly string[]>(() => this.#folders.value.map((folder) => folder.name));

  /**
   * The folders that show, by name. A folder whose name holds the search
   * shows all of its repositories, and one with a repository that matches
   * shows those, open while the search lasts. A folder whose repositories are
   * all out of view, of hidden owners or hidden themselves, doesn't show, as
   * they wouldn't in their owners' groups; an empty one does, so it can be
   * filled.
   */
  readonly folders = computed<readonly FolderGroup[]>(() => {
    const words = this.search.value.trim().toLowerCase();
    const listed = this.list.value?.repositories ?? [];
    const visible = this.#listedRepositories.value;
    return this.#folders.value.flatMap((folder) => {
      const filed = (repository: Repository): boolean =>
        folder.repositories.some((name) => sameName(name, repository.full_name));
      const empty = !listed.some(filed);
      const inView = visible.filter(filed);
      const named = words === '' || folder.name.toLowerCase().includes(words);
      const matching = named
        ? inView
        : inView.filter((repository) => repository.full_name.toLowerCase().includes(words));
      if (matching.length === 0 && !(empty && named)) {
        return [];
      }
      return [
        {
          name: folder.name,
          open: words !== '' || !this.#closedFolders.value.some((name) => sameName(name, folder.name)),
          repositories: matching,
          empty,
        },
      ];
    });
  });

  /** The name of the folder the repository is in, if any. */
  folderOf(repository: Pick<Repository, 'full_name'>): string | undefined {
    return this.#folders.value.find((folder) =>
      folder.repositories.some((name) => sameName(name, repository.full_name)),
    )?.name;
  }

  /**
   * The repositories in no folder that show, by owner: those of owners not
   * hidden whose name holds the search, without the hidden ones unless they
   * show.
   */
  readonly groups = computed<readonly OwnerGroup[]>(() => {
    const words = this.search.value.trim().toLowerCase();
    const repositories = this.#listedRepositories.value.filter(
      (repository) => this.folderOf(repository) === undefined && repository.full_name.toLowerCase().includes(words),
    );
    return this.owners.value
      .filter((owner) => owner.shown)
      .map((owner) => ({
        owner: owner.owner,
        personal: owner.personal,
        repositories: repositories.filter((repository) => sameOwner(ownerOf(repository), owner.owner)),
      }))
      .filter((group) => group.repositories.length > 0);
  });

  /** How many hidden repositories hold the search while they don't show, which a search with no match names. */
  readonly hiddenMatches = computed(() => {
    if (this.showHidden.value) {
      return 0;
    }
    const words = this.search.value.trim().toLowerCase();
    return this.#ownersRepositories.value.filter(
      (repository) =>
        this.isHidden(repository) &&
        (repository.full_name.toLowerCase().includes(words) ||
          (this.folderOf(repository)?.toLowerCase().includes(words) ?? false)),
    ).length;
  });

  /** Whether the shown owners have repositories and every one of them is hidden. */
  readonly everyRepositoryHidden = computed(
    () => this.#hidingRepositories.value && this.hiddenCount.value === this.#ownersRepositories.value.length,
  );

  /**
   * The opened repository, while it shows; a search, a hide, or a closed
   * folder that takes it out of view clears it.
   */
  readonly opened = computed<Repository | undefined>(() => {
    const name = this.#openedName.value;
    return name === undefined ? undefined : this.inView(name);
  });

  /** The repositories in view: those in open folders, then those by owner. */
  readonly #inView = computed<readonly Repository[]>(() =>
    [...this.folders.value.filter((folder) => folder.open), ...this.groups.value].flatMap(
      (group) => group.repositories,
    ),
  );

  /** The repository in view with this `owner/name`, in any case, since GitHub matches names in any case. */
  inView(name: string): Repository | undefined {
    return this.#inView.value.find((repository) => sameName(repository.full_name, name));
  }

  /**
   * The selected repositories the account still lists, in the list's order. One
   * a search or a hidden owner takes out of view stays selected, since selecting
   * across searches is how several are found; hiding a repository deselects it.
   */
  readonly selected = computed<readonly Repository[]>(() =>
    (this.list.value?.repositories ?? []).filter((repository) => this.#selectedNames.value.has(repository.full_name)),
  );

  readonly ownersFiltered = computed(() => this.owners.value.some((owner) => !owner.shown));
  readonly everyOwnerHidden = computed(
    () => this.owners.value.length > 0 && this.owners.value.every((owner) => !owner.shown),
  );

  /** What the owner filter's button says: whose repositories show. */
  readonly ownersLabel = computed(() => {
    const shown = this.owners.value.filter((owner) => owner.shown);
    const [only] = shown;
    if (shown.length === this.owners.value.length) {
      return 'All owners';
    }
    if (only === undefined) {
      return 'No owners';
    }
    return shown.length > 1 ? `${shown.length} owners` : only.personal ? 'Personal' : only.owner;
  });

  /** How many repositories show without a search, of all in the list. */
  readonly countLabel = computed(() => {
    const total = this.list.value?.repositories.length ?? 0;
    const shown = this.#ownersRepositories.value.length - (this.#hidingRepositories.value ? this.hiddenCount.value : 0);
    return shown === total ? `All ${total}` : `${shown} of ${total}`;
  });

  /** Whole seconds until Refresh reads again, or 0 when it can. */
  readonly refreshIn = computed(() => {
    const until = this.#refreshWait.value?.until.getTime() ?? 0;
    return Math.max(0, Math.ceil((until - this.#now.value) / 1000));
  });

  /** Why Refresh waits, while it does. */
  readonly refreshWait = computed(() => (this.refreshIn.value > 0 ? this.#refreshWait.value : undefined));

  /** Reads the list for the page as it opens, with no pause after it. */
  async load(): Promise<void> {
    await this.#read();
  }

  /**
   * Reads the list again, unless a read is under way or Refresh waits, and
   * then waits `refreshPause` before it can read again.
   */
  async refresh(): Promise<void> {
    if (this.loading.value || this.refreshWait.value !== undefined) {
      return;
    }
    await this.#read();
    this.#waitUntil(Date.now() + refreshPause, false);
  }

  /**
   * Reads the list from GitHub, and the hidden owners and repositories again,
   * so the list shows once both are known. A read under way is left to
   * finish; a failure keeps the list already shown. A rate limit holds
   * Refresh until GitHub says a request may go through.
   */
  async #read(): Promise<void> {
    if (this.loading.value) {
      return;
    }
    this.loading.value = true;
    this.error.value = undefined;
    this.#clearJustHidden();
    try {
      const [list] = await Promise.all([listRepositories(this.#github), this.preferences.reload()]);
      this.list.value = list;
      // A selected repository the account no longer lists drops out, so it isn't selected again if it returns.
      const listed = new Set(list.repositories.map((repository) => repository.full_name));
      const kept = [...this.#selectedNames.value].filter((name) => listed.has(name));
      if (kept.length !== this.#selectedNames.value.size) {
        this.#setSelected(new Set(kept));
      }
    } catch (error) {
      if (isSignedOut(error)) {
        this.#onSignedOut();
      } else {
        if (error instanceof GitHubError && error.rateLimited) {
          // GitHub's reset time is by its clock; one that has already passed by this device's waits the minute.
          const retryAt = error.retryAt?.getTime() ?? 0;
          this.#waitUntil(retryAt > Date.now() ? retryAt : Date.now() + rateLimitPause, true);
        }
        this.error.value = error instanceof Error ? error.message : String(error);
      }
    } finally {
      this.loading.value = false;
    }
  }

  /** Holds Refresh until this time, unless it already waits longer. */
  #waitUntil(until: number, rateLimited: boolean): void {
    if (until <= Date.now() || until <= (this.refreshWait.value?.until.getTime() ?? 0)) {
      return;
    }
    this.#refreshWait.value = { rateLimited, until: new Date(until) };
    this.#tick();
  }

  /** Moves the countdown on, and again at the next whole second left, until Refresh can read. */
  #tick(): void {
    clearTimeout(this.#clock);
    this.#now.value = Date.now();
    const left = (this.#refreshWait.value?.until.getTime() ?? 0) - this.#now.value;
    if (left <= 0) {
      this.#clock = undefined;
      return;
    }
    const toNextSecond = left % 1000;
    this.#clock = setTimeout(
      () => {
        this.#tick();
      },
      toNextSecond === 0 ? 1000 : toNextSecond,
    );
  }

  /** The opened repository's `owner/name`, kept while it is out of view or before the list arrives. */
  get openedName(): string | undefined {
    return this.#openedName.value;
  }

  /** Opens a repository by its `owner/name`, which shows once the list has it in view. */
  open(repository: Pick<Repository, 'full_name'> | undefined): void {
    this.#openedName.value = repository?.full_name;
    this.#clearJustHidden();
  }

  /**
   * Lets go of the opened repository, as when it has gone out of view, without
   * moving on from the last hide: its Undo opens it again if the hide took
   * it out of view.
   */
  dropOpened(): void {
    const name = this.#openedName.value;
    if (name !== undefined && this.justHidden.value.includes(name)) {
      this.#justClosed = name;
    }
    this.#openedName.value = undefined;
  }

  setShowHidden(shown: boolean): void {
    this.showHidden.value = shown;
    this.#clearJustHidden();
  }

  /**
   * Hides these repositories from the list, deselects them, and keeps them for
   * Undo. A hidden repository stays hidden when the list no longer has it,
   * so it is still hidden if it returns.
   */
  hide(repositories: readonly Repository[]): void {
    const hiding = repositories.filter((repository) => !this.isHidden(repository));
    const adding = hiding.map((repository) => repository.full_name.toLowerCase());
    this.preferences.update(hiddenRepositoriesKey, (current) => {
      const hidden = namesIn(current);
      const have = new Set(hidden.map((name) => name.toLowerCase()));
      return kept([...hidden, ...adding.filter((name) => !have.has(name))]);
    });
    const selected = new Set(this.#selectedNames.value);
    for (const repository of repositories) {
      selected.delete(repository.full_name);
    }
    this.justHidden.value = hiding.map((repository) => repository.full_name);
    this.#justDeselected = repositories
      .map((repository) => repository.full_name)
      .filter((name) => this.#selectedNames.value.has(name));
    this.#justClosed = undefined;
    this.#setSelected(selected);
  }

  /** Shows these repositories in the list again. */
  unhide(repositories: readonly Pick<Repository, 'full_name'>[]): void {
    const showing = new Set(repositories.map((repository) => repository.full_name.toLowerCase()));
    this.preferences.update(hiddenRepositoriesKey, (current) =>
      kept(namesIn(current).filter((name) => !showing.has(name.toLowerCase()))),
    );
    this.#clearJustHidden();
  }

  /** Shows the repositories the last hide took out of the list again, selected as they were. */
  undoHide(): void {
    const deselected = this.#justDeselected;
    const closed = this.#justClosed;
    this.unhide(this.justHidden.value.map((full_name) => ({ full_name })));
    this.#setSelected(new Set([...this.#selectedNames.value, ...deselected]));
    if (closed !== undefined) {
      this.#openedName.value = closed;
    }
  }

  /** Selects a repository for an apply to several, or deselects it. */
  select(repository: Repository, selected: boolean): void {
    this.selectEach([repository], selected);
  }

  /** Selects these repositories, as a folder's Select all does, or deselects them; others stay as they are. */
  selectEach(repositories: readonly Repository[], selected: boolean): void {
    const names = new Set(this.#selectedNames.value);
    for (const repository of repositories) {
      if (selected) {
        names.add(repository.full_name);
      } else {
        names.delete(repository.full_name);
      }
    }
    this.#setSelected(names);
  }

  /** Whether the repository is selected. */
  isSelected(repository: Repository): boolean {
    return this.#selectedNames.value.has(repository.full_name);
  }

  deselectAll(): void {
    this.#setSelected(new Set());
  }

  /** Keeps the selection, and forgets where the panel was moving it once nothing is selected. */
  #setSelected(names: ReadonlySet<string>): void {
    this.#selectedNames.value = names;
    if (names.size === 0) {
      this.#moveTarget.value = undefined;
    }
  }

  setOwnerShown(owner: string, shown: boolean): void {
    this.preferences.update(hiddenOwnersKey, (current) => {
      const others = namesIn(current).filter((name) => !sameOwner(name, owner));
      return kept(shown ? others : [...others, owner]);
    });
  }

  /**
   * Hides every owner of the list's but the signed-in account, and keeps
   * hidden any owner that was hidden and is not in the list now, so it stays
   * hidden when it returns.
   */
  showOnlyPersonal(): void {
    const listed = this.owners.value;
    this.preferences.update(hiddenOwnersKey, (current) => {
      const absent = namesIn(current).filter((name) => !listed.some((owner) => sameOwner(owner.owner, name)));
      return kept([...absent, ...listed.filter((owner) => !owner.personal).map((owner) => owner.owner)]);
    });
  }

  /** Shows every owner, including any that was hidden and is not in the list now. */
  showAllOwners(): void {
    this.preferences.write(hiddenOwnersKey, undefined);
  }

  /** Why a folder can't take this name, or undefined when it can. `current` is the folder being renamed. */
  folderNameProblem(name: string, current?: string): string | undefined {
    const trimmed = name.trim();
    if (trimmed === '') {
      return 'Give the folder a name.';
    }
    const taken = this.#folders.value.find(
      (folder) => sameName(folder.name, trimmed) && (current === undefined || !sameName(folder.name, current)),
    );
    return taken === undefined ? undefined : `There's already a folder called ${taken.name}.`;
  }

  /**
   * Where the selected panel moves the selected repositories: what was picked
   * there, or the folder made from there, while it is still there under any
   * name it was given since. Nothing is picked until one is chosen, and the
   * choice goes once nothing is selected.
   */
  readonly moveTarget = computed<MoveTarget | undefined>(() => {
    const picked = this.#moveTarget.value;
    if (picked?.kind !== 'folder') {
      return picked;
    }
    const name = this.folderNames.value.find((folder) => sameName(folder, picked.name));
    return name === undefined ? undefined : { kind: 'folder', name };
  });

  pickMoveTarget(target: MoveTarget): void {
    this.#moveTarget.value = target;
  }

  /**
   * Makes a folder and moves these repositories into it, deselecting them
   * when `deselect` says they were selected for it. Answers why not when the name can't
   * be used. A folder of that name saved elsewhere meanwhile takes the
   * repositories instead.
   */
  createFolder(
    name: string,
    repositories: readonly Repository[] = [],
    { deselect = false }: FolderMoveOptions = {},
  ): string | undefined {
    const problem = this.folderNameProblem(name);
    if (problem !== undefined) {
      return problem;
    }
    const trimmed = name.trim();
    const moving = repositories.map((repository) => repository.full_name);
    this.#updateFolders((folders) => withMoved(folders, moving, trimmed));
    if (deselect) {
      this.#deselect(moving);
    }
    // Made from the selected panel and left empty, it is where the panel moves them.
    if (deselect && this.#selectedNames.value.size > 0) {
      this.#moveTarget.value = { kind: 'folder', name: trimmed };
    }
    return undefined;
  }

  /**
   * Renames a folder, keeping whether it is open. Answers why not when the
   * name can't be used. A folder of the new name saved elsewhere meanwhile
   * takes this folder's repositories instead.
   */
  renameFolder(name: string, to: string): string | undefined {
    const problem = this.folderNameProblem(to, name);
    if (problem !== undefined) {
      return problem;
    }
    const trimmed = to.trim();
    this.#updateFolders((folders) => {
      const renamed = folders.find((folder) => sameName(folder.name, name));
      if (renamed === undefined) {
        return folders;
      }
      const into = folders.find((folder) => folder !== renamed && sameName(folder.name, trimmed));
      return into === undefined
        ? folders.map((folder) => (folder === renamed ? { ...folder, name: trimmed } : folder))
        : withMoved(
            folders.filter((folder) => folder !== renamed),
            renamed.repositories,
            into.name,
          );
    });
    this.#updateClosed((closed) =>
      closed.some((folder) => sameName(folder, name))
        ? [...closed.filter((folder) => !sameName(folder, name)), trimmed]
        : closed,
    );
    const picked = this.#moveTarget.value;
    if (picked?.kind === 'folder' && sameName(picked.name, name)) {
      this.#moveTarget.value = { kind: 'folder', name: trimmed };
    }
    return undefined;
  }

  /** Deletes a folder. Its repositories go back to their owners' groups; no repository is changed. */
  deleteFolder(name: string): void {
    this.#updateFolders((folders) => folders.filter((folder) => !sameName(folder.name, name)));
    this.#updateClosed((closed) => closed.filter((folder) => !sameName(folder, name)));
    const picked = this.#moveTarget.value;
    if (picked?.kind === 'folder' && sameName(picked.name, name)) {
      this.#moveTarget.value = undefined;
    }
  }

  /**
   * Moves the repositories into the folder, out of any other, or out of every
   * folder when none is named. With `deselect`, for repositories selected to
   * be moved, it deselects them too, since they have gone where they were selected for.
   */
  moveToFolder(
    repositories: readonly Repository[],
    name: string | undefined,
    { deselect = false }: FolderMoveOptions = {},
  ): void {
    const moving = repositories.map((repository) => repository.full_name);
    this.#updateFolders((folders) => withMoved(folders, moving, name));
    if (deselect) {
      this.#deselect(moving);
    }
  }

  /** Deselects these repositories, so that Undo after a hide doesn't select them again either. */
  #deselect(names: readonly string[]): void {
    const selected = new Set(this.#selectedNames.value);
    for (const name of names) {
      selected.delete(name);
    }
    if (selected.size !== this.#selectedNames.value.size) {
      this.#setSelected(selected);
    }
    const gone = new Set(names);
    this.#justDeselected = this.#justDeselected.filter((name) => !gone.has(name));
  }

  /** Opens or closes a folder. */
  setFolderOpen(name: string, open: boolean): void {
    this.#updateClosed((closed) => [...closed.filter((folder) => !sameName(folder, name)), ...(open ? [] : [name])]);
  }

  /** Changes the folders as they are when saved, so folders saved elsewhere, or not yet read, are kept. */
  #updateFolders(change: (folders: readonly Folder[]) => readonly Folder[]): void {
    this.preferences.update(foldersKey, (current) => {
      const next = change(foldersIn(current));
      return next.length > 0 ? next.toSorted(byName) : undefined;
    });
  }

  #updateClosed(change: (closed: readonly string[]) => readonly string[]): void {
    const next = change(this.#closedFolders.value);
    this.#closedFolders.value = next;
    this.#browser.write(closedFoldersKey, next.length > 0 ? next : undefined);
  }

  #clearJustHidden(): void {
    this.justHidden.value = [];
    this.#justDeselected = [];
    this.#justClosed = undefined;
  }
}
