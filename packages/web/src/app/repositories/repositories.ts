import { computed, signal } from '@preact/signals';
import { type GitHub, GitHubError, listRepositories } from '@repotted/core';
import * as z from 'zod/mini';

import { isSignedOut, type User } from '../account/account.js';
import type { Preferences } from '../preferences/preferences.js';
import type { SharedPreferences } from '../preferences/shared-preferences.js';

type RepositoryList = Awaited<ReturnType<typeof listRepositories>>;
export type Repository = RepositoryList['repositories'][number];

export interface OwnerChoice {
  readonly owner: string;
  readonly personal: boolean;
  readonly count: number;
  readonly shown: boolean;
}

export interface OwnerGroup {
  readonly owner: string;
  readonly personal: boolean;
  readonly repositories: readonly Repository[];
}

/** Its repositories are by `owner/name`, in the order they were put in. */
export interface Folder {
  readonly name: string;
  readonly repositories: readonly string[];
}

export interface FolderGroup {
  readonly name: string;
  readonly open: boolean;
  /** As in the owners' groups, and while searching, those that match. */
  readonly repositories: readonly Repository[];
  readonly holdsNoListedRepository: boolean;
}

export type MoveTarget =
  | { readonly kind: 'folder'; readonly name: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'new' };

export interface RefreshWait {
  /** False for the pause after a refresh. */
  readonly rateLimited: boolean;
  readonly until: Date;
}

/** So repeated presses of Refresh don't spend the account's GitHub requests. */
export const refreshPause = 15_000;
/** For a rate limit GitHub gives no time for, or a time already past, as GitHub advises for a secondary limit. */
const rateLimitPause = 60_000;

export interface FolderMoveOptions {
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

/** A file edited by hand may name a folder twice or a repository in two folders: the first of each counts. */
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
 * The repositories go to the end of the named folder, or out of every folder
 * with none named. A named folder that is missing, say deleted elsewhere
 * meanwhile, is made again, so the repositories aren't lost.
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

/** Undefined deletes the key. */
function kept(list: readonly string[]): readonly string[] | undefined {
  return list.length > 0 ? list : undefined;
}

export class Repositories {
  readonly loading = signal(false);
  readonly error = signal<string | undefined>(undefined);
  /** Undefined until the first list arrives. */
  readonly list = signal<RepositoryList | undefined>(undefined);
  readonly search = signal('');
  readonly preferences: SharedPreferences;
  readonly showHidden = signal(false);
  /** Undo brings them back. */
  readonly justHidden = signal<readonly string[]>([]);
  /** Of those just hidden, the ones that were selected, which Undo selects again. */
  #justDeselected: readonly string[] = [];
  /** The repository let go of when the last hide took it out of view, which Undo opens again. */
  #justClosed: string | undefined;

  readonly #github: GitHub;
  readonly #user: User;
  readonly #browser: Preferences;
  readonly #onSignedOut: () => void;
  readonly #hiddenOwners = computed(() => namesIn(this.preferences.read(hiddenOwnersKey)));
  /** Kept lowercase, since GitHub matches names in any case. */
  readonly #hiddenNames = computed<ReadonlySet<string>>(
    () => new Set(namesIn(this.preferences.read(hiddenRepositoriesKey)).map((name) => name.toLowerCase())),
  );
  readonly #folders = computed<readonly Folder[]>(() => foldersIn(this.preferences.read(foldersKey)));
  /** Kept in this browser alone, so opening or closing a folder commits nothing. */
  readonly #closedFolders = signal<readonly string[]>([]);
  /** The folder last picked to move the selected repositories to, or made from the selected panel. */
  readonly #moveTarget = signal<MoveTarget | undefined>(undefined);
  readonly #openedName = signal<string | undefined>(undefined);
  readonly #selectedNames = signal<ReadonlySet<string>>(new Set());
  readonly #refreshWait = signal<RefreshWait | undefined>(undefined);
  readonly #timeCountdownLastRead = signal(Date.now());
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

  /** Of the owners shown, those whose installation of the Repotted App lacks permissions it asks for. */
  readonly installationsMissingPermissions = computed(() =>
    (this.list.value?.missing_permissions ?? []).filter(
      (installation) => !this.#hiddenOwners.value.some((name) => sameOwner(name, installation.owner)),
    ),
  );

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

  readonly #ownersRepositories = computed<readonly Repository[]>(() => {
    const shown = this.owners.value.filter((owner) => owner.shown);
    return (this.list.value?.repositories ?? []).filter((repository) =>
      shown.some((owner) => sameOwner(owner.owner, ownerOf(repository))),
    );
  });

  readonly hiddenCount = computed(
    () => this.#ownersRepositories.value.filter((repository) => this.isHidden(repository)).length,
  );

  readonly #hidingRepositories = computed(() => this.hiddenCount.value > 0 && !this.showHidden.value);

  readonly #listedRepositories = computed<readonly Repository[]>(() =>
    this.#ownersRepositories.value.filter((repository) => this.showHidden.value || !this.isHidden(repository)),
  );

  readonly folderNames = computed<readonly string[]>(() => this.#folders.value.map((folder) => folder.name));

  /**
   * A folder whose name holds the search shows all of its repositories, and
   * one with a repository that matches shows those, open while the search
   * lasts. A folder whose repositories are all out of view, of hidden owners
   * or hidden themselves, doesn't show, as they wouldn't in their owners'
   * groups; an empty one does, so it can be filled.
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
          holdsNoListedRepository: empty,
        },
      ];
    });
  });

  folderOf(repository: Pick<Repository, 'full_name'>): string | undefined {
    return this.#folders.value.find((folder) =>
      folder.repositories.some((name) => sameName(name, repository.full_name)),
    )?.name;
  }

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

  /** A search with no match names how many hidden repositories hold it. */
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

  readonly everyRepositoryHidden = computed(
    () => this.#hidingRepositories.value && this.hiddenCount.value === this.#ownersRepositories.value.length,
  );

  /** A search, a hide, or a closed folder that takes the opened repository out of view clears this. */
  readonly opened = computed<Repository | undefined>(() => {
    const name = this.#openedName.value;
    return name === undefined ? undefined : this.inView(name);
  });

  readonly #inView = computed<readonly Repository[]>(() =>
    [...this.folders.value.filter((folder) => folder.open), ...this.groups.value].flatMap(
      (group) => group.repositories,
    ),
  );

  /** In any case, since GitHub matches names in any case. */
  inView(name: string): Repository | undefined {
    return this.#inView.value.find((repository) => sameName(repository.full_name, name));
  }

  /**
   * A repository a search or a hidden owner takes out of view stays selected,
   * since selecting across searches is how several are found; hiding a
   * repository deselects it.
   */
  readonly selected = computed<readonly Repository[]>(() =>
    (this.list.value?.repositories ?? []).filter((repository) => this.#selectedNames.value.has(repository.full_name)),
  );

  readonly ownersFiltered = computed(() => this.owners.value.some((owner) => !owner.shown));
  readonly everyOwnerHidden = computed(
    () => this.owners.value.length > 0 && this.owners.value.every((owner) => !owner.shown),
  );

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

  readonly countLabel = computed(() => {
    const total = this.list.value?.repositories.length ?? 0;
    const shown = this.#ownersRepositories.value.length - (this.#hidingRepositories.value ? this.hiddenCount.value : 0);
    return shown === total ? `All ${total}` : `${shown} of ${total}`;
  });

  readonly secondsUntilRefreshCanRun = computed(() => {
    const until = this.#refreshWait.value?.until.getTime() ?? 0;
    return Math.max(0, Math.ceil((until - this.#timeCountdownLastRead.value) / 1000));
  });

  readonly refreshWait = computed(() =>
    this.secondsUntilRefreshCanRun.value > 0 ? this.#refreshWait.value : undefined,
  );

  /** Unlike `refresh`, with no pause after it. */
  async load(): Promise<void> {
    await this.#read();
  }

  async refresh(): Promise<void> {
    if (this.loading.value || this.refreshWait.value !== undefined) {
      return;
    }
    await this.#read();
    this.#waitUntil(Date.now() + refreshPause, false);
  }

  /**
   * The hidden owners and repositories are read again with the list, so the
   * list shows once both are known. A failure keeps the list already shown.
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

  #waitUntil(until: number, rateLimited: boolean): void {
    if (until <= Date.now() || until <= (this.refreshWait.value?.until.getTime() ?? 0)) {
      return;
    }
    this.#refreshWait.value = { rateLimited, until: new Date(until) };
    this.#tick();
  }

  #tick(): void {
    clearTimeout(this.#clock);
    this.#timeCountdownLastRead.value = Date.now();
    const left = (this.#refreshWait.value?.until.getTime() ?? 0) - this.#timeCountdownLastRead.value;
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

  /** Kept while the repository is out of view or before the list arrives. */
  get openedName(): string | undefined {
    return this.#openedName.value;
  }

  open(repository: Pick<Repository, 'full_name'> | undefined): void {
    this.#openedName.value = repository?.full_name;
    this.#clearJustHidden();
  }

  /**
   * Doesn't move on from the last hide: its Undo opens the repository again
   * if the hide took it out of view.
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

  /** A hidden repository stays hidden when the list no longer has it, so it is still hidden if it returns. */
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

  unhide(repositories: readonly Pick<Repository, 'full_name'>[]): void {
    const showing = new Set(repositories.map((repository) => repository.full_name.toLowerCase()));
    this.preferences.update(hiddenRepositoriesKey, (current) =>
      kept(namesIn(current).filter((name) => !showing.has(name.toLowerCase()))),
    );
    this.#clearJustHidden();
  }

  undoHide(): void {
    const deselected = this.#justDeselected;
    const closed = this.#justClosed;
    this.unhide(this.justHidden.value.map((full_name) => ({ full_name })));
    this.#setSelected(new Set([...this.#selectedNames.value, ...deselected]));
    if (closed !== undefined) {
      this.#openedName.value = closed;
    }
  }

  select(repository: Repository, selected: boolean): void {
    this.selectEach([repository], selected);
  }

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

  isSelected(repository: Repository): boolean {
    return this.#selectedNames.value.has(repository.full_name);
  }

  deselectAll(): void {
    this.#setSelected(new Set());
  }

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

  /** An owner that was hidden and is not in the list now stays hidden, so it is still hidden when it returns. */
  showOnlyPersonal(): void {
    const listed = this.owners.value;
    this.preferences.update(hiddenOwnersKey, (current) => {
      const absent = namesIn(current).filter((name) => !listed.some((owner) => sameOwner(owner.owner, name)));
      return kept([...absent, ...listed.filter((owner) => !owner.personal).map((owner) => owner.owner)]);
    });
  }

  /** Including any that was hidden and is not in the list now. */
  showAllOwners(): void {
    this.preferences.write(hiddenOwnersKey, undefined);
  }

  folderNameProblem(name: string, folderBeingRenamed?: string): string | undefined {
    const trimmed = name.trim();
    if (trimmed === '') {
      return 'Give the folder a name.';
    }
    const taken = this.#folders.value.find(
      (folder) =>
        sameName(folder.name, trimmed) &&
        (folderBeingRenamed === undefined || !sameName(folder.name, folderBeingRenamed)),
    );
    return taken === undefined ? undefined : `There's already a folder called ${taken.name}.`;
  }

  /**
   * A folder picked or made from the selected panel is followed under any
   * name it was given since. The choice goes once nothing is selected.
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
   * Answers why not when the name can't be used. A folder of that name saved
   * elsewhere meanwhile takes the repositories instead.
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
   * Answers why not when the name can't be used. A folder of the new name
   * saved elsewhere meanwhile takes this folder's repositories instead.
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

  deleteFolder(name: string): void {
    this.#updateFolders((folders) => folders.filter((folder) => !sameName(folder.name, name)));
    this.#updateClosed((closed) => closed.filter((folder) => !sameName(folder, name)));
    const picked = this.#moveTarget.value;
    if (picked?.kind === 'folder' && sameName(picked.name, name)) {
      this.#moveTarget.value = undefined;
    }
  }

  /** `deselect` is for repositories selected to be moved, which have then gone where they were selected for. */
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

  /** Undo after a hide doesn't select these again either. */
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
