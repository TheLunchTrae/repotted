import { computed, signal } from '@preact/signals';
import { type GitHub, listRepositories } from '@repotted/core';
import * as z from 'zod/mini';

import { isSignedOut, type User } from './account.js';
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

const hiddenOwnersKey = 'hidden-repository-owners';
const hiddenRepositoriesKey = 'hidden-repositories';
const names = z.array(z.string());

function ownerOf(repository: Repository): string {
  return repository.full_name.split('/')[0] ?? repository.full_name;
}

function sameOwner(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/** The repositories page: the list, whose repositories show, the search, and the selection. */
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

  readonly #github: GitHub;
  readonly #user: User;
  readonly #onSignedOut: () => void;
  readonly #hiddenOwners = computed<readonly string[]>(() => {
    const hidden = names.safeParse(this.preferences.read(hiddenOwnersKey));
    return hidden.success ? hidden.data : [];
  });
  /** Hidden repositories by `owner/name`, kept lowercase, since GitHub matches names in any case. */
  readonly #hiddenNames = computed<ReadonlySet<string>>(() => {
    const hidden = names.safeParse(this.preferences.read(hiddenRepositoriesKey));
    return new Set(hidden.success ? hidden.data.map((name) => name.toLowerCase()) : []);
  });
  readonly #selectedName = signal<string | undefined>(undefined);
  readonly #tickedNames = signal<ReadonlySet<string>>(new Set());

  constructor(github: GitHub, user: User, preferences: SharedPreferences, onSignedOut: () => void) {
    this.#github = github;
    this.#user = user;
    this.preferences = preferences;
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

  /**
   * The repositories that show, by owner: those of owners not hidden whose
   * name holds the search, without the hidden ones unless they show.
   */
  readonly groups = computed<readonly OwnerGroup[]>(() => {
    const words = this.search.value.trim().toLowerCase();
    const repositories = this.#ownersRepositories.value.filter(
      (repository) =>
        repository.full_name.toLowerCase().includes(words) && (this.showHidden.value || !this.isHidden(repository)),
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
      (repository) => this.isHidden(repository) && repository.full_name.toLowerCase().includes(words),
    ).length;
  });

  /** Whether the shown owners have repositories and every one of them is hidden. */
  readonly everyRepositoryHidden = computed(
    () => this.#hidingRepositories.value && this.hiddenCount.value === this.#ownersRepositories.value.length,
  );

  /** The selected repository, while it shows; a search or a hide that takes it out of view clears it. */
  readonly selected = computed<Repository | undefined>(() =>
    this.groups.value
      .flatMap((group) => group.repositories)
      .find((repository) => repository.full_name === this.#selectedName.value),
  );

  /**
   * The ticked repositories the account still lists, in the list's order. One
   * a search or a hidden owner takes out of view stays ticked, since ticking
   * across searches is how several are found; hiding a repository unticks it.
   */
  readonly ticked = computed<readonly Repository[]>(() =>
    (this.list.value?.repositories ?? []).filter((repository) => this.#tickedNames.value.has(repository.full_name)),
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

  /** Reads the list from GitHub. A refresh under way is left to finish; a failure keeps the list already shown. */
  async refresh(): Promise<void> {
    if (this.loading.value) {
      return;
    }
    this.loading.value = true;
    this.error.value = undefined;
    this.justHidden.value = [];
    try {
      this.list.value = await listRepositories(this.#github);
    } catch (error) {
      if (isSignedOut(error)) {
        this.#onSignedOut();
      } else {
        this.error.value = error instanceof Error ? error.message : String(error);
      }
    } finally {
      this.loading.value = false;
    }
  }

  select(repository: Repository | undefined): void {
    this.#selectedName.value = repository?.full_name;
    this.justHidden.value = [];
  }

  setShowHidden(shown: boolean): void {
    this.showHidden.value = shown;
    this.justHidden.value = [];
  }

  /**
   * Hides these repositories from the list, unticks them, and keeps them for
   * Undo. A hidden repository stays hidden when the list no longer has it,
   * so it is still hidden if it returns.
   */
  hide(repositories: readonly Repository[]): void {
    const hiding = new Set(repositories.map((repository) => repository.full_name.toLowerCase()));
    this.#saveHidden(new Set([...this.#hiddenNames.value, ...hiding]));
    const ticked = new Set(this.#tickedNames.value);
    for (const repository of repositories) {
      ticked.delete(repository.full_name);
    }
    this.#tickedNames.value = ticked;
    this.justHidden.value = repositories.map((repository) => repository.full_name);
  }

  /** Shows these repositories in the list again. */
  unhide(repositories: readonly Pick<Repository, 'full_name'>[]): void {
    const showing = new Set(repositories.map((repository) => repository.full_name.toLowerCase()));
    this.#saveHidden(new Set([...this.#hiddenNames.value].filter((name) => !showing.has(name))));
    this.justHidden.value = [];
  }

  /** Shows the repositories the last hide took out of the list again. */
  undoHide(): void {
    this.unhide(this.justHidden.value.map((full_name) => ({ full_name })));
  }

  /** Ticks a repository for an apply to several, or unticks it. */
  tick(repository: Repository, ticked: boolean): void {
    const names = new Set(this.#tickedNames.value);
    if (ticked) {
      names.add(repository.full_name);
    } else {
      names.delete(repository.full_name);
    }
    this.#tickedNames.value = names;
  }

  clearTicks(): void {
    this.#tickedNames.value = new Set();
  }

  setOwnerShown(owner: string, shown: boolean): void {
    this.#hide(this.owners.value.filter((item) => (sameOwner(item.owner, owner) ? !shown : !item.shown)));
  }

  showOnlyPersonal(): void {
    this.#hide(this.owners.value.filter((owner) => !owner.personal));
  }

  /** Shows every owner, including any that was hidden and is not in the list now. */
  showAllOwners(): void {
    this.#save([]);
  }

  /**
   * Hides these owners of the list's, and keeps hidden any owner that was
   * hidden and is not in the list now, so it stays hidden when it returns.
   */
  #hide(owners: readonly OwnerChoice[]): void {
    const absent = this.#hiddenOwners.value.filter(
      (name) => !this.owners.value.some((owner) => sameOwner(owner.owner, name)),
    );
    this.#save([...absent, ...owners.map((owner) => owner.owner)]);
  }

  #saveHidden(hidden: ReadonlySet<string>): void {
    this.preferences.write(hiddenRepositoriesKey, hidden.size > 0 ? [...hidden] : undefined);
  }

  #save(hidden: readonly string[]): void {
    this.preferences.write(hiddenOwnersKey, hidden.length > 0 ? hidden : undefined);
  }
}
