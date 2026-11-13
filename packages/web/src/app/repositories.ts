import { computed, signal } from '@preact/signals';
import { type GitHub, listRepositories } from '@repotted/core';
import * as z from 'zod/mini';

import { isSignedOut, type User } from './account.js';
import type { Preferences } from './preferences.js';

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
const ownerNames = z.array(z.string());

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

  readonly #github: GitHub;
  readonly #user: User;
  readonly #preferences: Preferences;
  readonly #onSignedOut: () => void;
  readonly #hiddenOwners = signal<readonly string[]>([]);
  readonly #selectedName = signal<string | undefined>(undefined);

  constructor(github: GitHub, user: User, preferences: Preferences, onSignedOut: () => void) {
    this.#github = github;
    this.#user = user;
    this.#preferences = preferences;
    this.#onSignedOut = onSignedOut;
    const hidden = ownerNames.safeParse(preferences.read(hiddenOwnersKey));
    this.#hiddenOwners.value = hidden.success ? hidden.data : [];
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

  /** The repositories that show, by owner: those of owners not hidden whose name holds the search. */
  readonly groups = computed<readonly OwnerGroup[]>(() => {
    const words = this.search.value.trim().toLowerCase();
    const repositories = this.list.value?.repositories ?? [];
    return this.owners.value
      .filter((owner) => owner.shown)
      .map((owner) => ({
        owner: owner.owner,
        personal: owner.personal,
        repositories: repositories.filter(
          (repository) =>
            sameOwner(ownerOf(repository), owner.owner) && repository.full_name.toLowerCase().includes(words),
        ),
      }))
      .filter((group) => group.repositories.length > 0);
  });

  /** The selected repository, while it shows; a search or a hidden owner that takes it out of view clears it. */
  readonly selected = computed<Repository | undefined>(() =>
    this.groups.value
      .flatMap((group) => group.repositories)
      .find((repository) => repository.full_name === this.#selectedName.value),
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

  /** How many repositories the shown owners have, of all in the list. */
  readonly countLabel = computed(() => {
    const total = this.list.value?.repositories.length ?? 0;
    const shown = this.owners.value.filter((owner) => owner.shown).reduce((sum, owner) => sum + owner.count, 0);
    return this.ownersFiltered.value ? `${shown} of ${total}` : `All ${total}`;
  });

  /** Reads the list from GitHub. A refresh under way is left to finish; a failure keeps the list already shown. */
  async refresh(): Promise<void> {
    if (this.loading.value) {
      return;
    }
    this.loading.value = true;
    this.error.value = undefined;
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

  #save(hidden: readonly string[]): void {
    this.#hiddenOwners.value = hidden;
    this.#preferences.write(hiddenOwnersKey, hidden.length > 0 ? hidden : undefined);
  }
}
