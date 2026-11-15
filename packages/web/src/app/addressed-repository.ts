import type { Repositories } from './repositories.js';
import type { Router } from './router.js';

const key = 'repository';

function isSameRepositoryIgnoringCase(left: string | undefined, right: string | undefined): boolean {
  return left === right || (left !== undefined && right !== undefined && left.toLowerCase() === right.toLowerCase());
}

/** The slash stays as it is, so the address reads as GitHub's. */
function queryFor(name: string | undefined): string {
  return name === undefined ? '' : `?${key}=${encodeURIComponent(name).replaceAll('%2F', '/')}`;
}

export function repositoryAddress(name: string): string {
  return `/${queryFor(name)}`;
}

/**
 * The opened repository stays where it is kept; the address follows it,
 * except on arrival and after a back or forward, when the opened repository
 * follows the address.
 *
 * On a phone the opened repository is a screen of its own, so it is let go of once
 * its repository is out of view, as one hidden, moved into a closed folder,
 * or gone from the list, and the address names only what shows.
 */
export class AddressedRepository {
  readonly #repositories: Repositories;
  readonly #router: Router;
  #openedRepositoryAsAddressLastShowed: { readonly name: string | undefined; readonly hadOwnScreen: boolean } = {
    name: undefined,
    hadOwnScreen: false,
  };
  /** `follow` leaves this query alone, since it is no back or forward. */
  #queryThisWrote: string | undefined;

  constructor(repositories: Repositories, router: Router) {
    this.#repositories = repositories;
    this.#router = router;
  }

  get named(): string | undefined {
    return new URLSearchParams(this.#router.search.value).get(key) ?? undefined;
  }

  /**
   * An address that names no repository shows the list on a phone, and
   * elsewhere takes the repository kept open from before, which shows beside
   * the list.
   */
  arrive(phone: boolean): void {
    this.#queryThisWrote = undefined;
    const named = this.named;
    if (named !== undefined) {
      this.#open(named);
    } else if (phone) {
      this.#repositories.dropOpened();
    } else {
      this.#write(queryFor(this.#repositories.openedName), 'replace');
    }
    this.#openedRepositoryAsAddressLastShowed = { name: this.#repositories.openedName, hadOwnScreen: false };
  }

  /**
   * On a phone, a named repository the list doesn't show, as one hidden or
   * moved into a closed folder since, is taken off the address instead;
   * elsewhere it is kept out of view, as an opened repository is. Neither
   * ends a hide's Undo.
   */
  follow(phone: boolean): void {
    if (this.#router.search.value === this.#queryThisWrote) {
      return;
    }
    this.#queryThisWrote = undefined;
    const named = this.named;
    if (named === undefined) {
      this.#repositories.dropOpened();
    } else if (phone && this.#repositories.list.value !== undefined && this.#repositories.inView(named) === undefined) {
      this.#repositories.dropOpened();
      this.#write(queryFor(undefined), 'replace');
    } else {
      this.#open(named);
    }
    this.#openedRepositoryAsAddressLastShowed = {
      name: this.#repositories.openedName,
      hadOwnScreen: this.#openedRepositoryAsAddressLastShowed.hadOwnScreen,
    };
  }

  /**
   * A repository that opens a screen of its own (`phone`) adds a history
   * entry, so back returns to the list, and any other change takes the place
   * of the entry shown.
   */
  update(phone: boolean): void {
    const repositories = this.#repositories;
    const shown = repositories.opened.value;
    const name = repositories.openedName;
    if (phone && name !== undefined && shown === undefined && repositories.list.value !== undefined) {
      // Out of view: its screen closes, back to the list's entry when it led there.
      repositories.dropOpened();
      this.#returnToAddressWithoutQuery();
      this.#openedRepositoryAsAddressLastShowed = { name: undefined, hadOwnScreen: false };
      return;
    }
    if (shown !== undefined && shown.full_name !== name) {
      // A link in another case takes the name as GitHub has it.
      repositories.open(shown);
    }
    const screen = phone && shown !== undefined;
    if (repositories.openedName !== this.#openedRepositoryAsAddressLastShowed.name) {
      // Only another repository opens a screen; the same one in GitHub's case takes the entry shown.
      const opened =
        screen &&
        !this.#openedRepositoryAsAddressLastShowed.hadOwnScreen &&
        !isSameRepositoryIgnoringCase(repositories.openedName, this.#openedRepositoryAsAddressLastShowed.name);
      this.#write(queryFor(repositories.openedName), opened ? 'push' : 'replace');
    }
    this.#openedRepositoryAsAddressLastShowed = { name: repositories.openedName, hadOwnScreen: screen };
  }

  /**
   * Goes back to the list's entry when it led there, which lets go of the
   * repository once the back arrives, so the list comes back where the
   * browser puts its scroll; else lets go of it in place, at once.
   */
  close(): void {
    if (!this.#returnToAddressWithoutQuery()) {
      this.#repositories.dropOpened();
    }
  }

  #write(search: string, entry: 'push' | 'replace'): void {
    this.#router.query(search, entry);
    this.#queryThisWrote = this.#router.search.value;
  }

  /** Says whether the browser runs a back, which comes to `follow` once it arrives. */
  #returnToAddressWithoutQuery(): boolean {
    const back = this.#router.returnTo(queryFor(undefined));
    this.#queryThisWrote = this.#router.search.value;
    return back;
  }

  #open(name: string): void {
    // Opening again what is open would end the Undo of a hide.
    if (name !== this.#repositories.openedName) {
      this.#repositories.open({ full_name: name });
    }
  }
}
