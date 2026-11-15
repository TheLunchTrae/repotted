import type { Repositories } from './repositories.js';
import type { Router } from './router.js';

const key = 'repository';

/** Whether two `owner/name`s, or none, are one repository, in any case, as GitHub matches them. */
function same(left: string | undefined, right: string | undefined): boolean {
  return left === right || (left !== undefined && right !== undefined && left.toLowerCase() === right.toLowerCase());
}

/** The query that names a repository, `owner/name`, or none. Its slash stays as it is, so the address reads as GitHub's. */
function queryFor(name: string | undefined): string {
  return name === undefined ? '' : `?${key}=${encodeURIComponent(name).replaceAll('%2F', '/')}`;
}

/** The address of the repositories page with this repository, `owner/name`, open. */
export function repositoryAddress(name: string): string {
  return `/${queryFor(name)}`;
}

/**
 * The repositories page's opened repository in the page's address, so a link or a
 * reload opens a repository, and the browser's back closes one that opened a
 * screen of its own, as on a phone. The opened repository stays where it is kept; the
 * address follows it, except on arrival and after a back or forward, when the
 * opened repository follows the address.
 *
 * On a phone the opened repository is a screen of its own, so it is let go of once
 * its repository is out of view, as one hidden, moved into a closed folder,
 * or gone from the list, and the address names only what shows.
 */
export class AddressedRepository {
  readonly #repositories: Repositories;
  readonly #router: Router;
  /** The opened repository and whether it had a screen of its own, as the address last took them. */
  #last: { readonly name: string | undefined; readonly screen: boolean } = { name: undefined, screen: false };
  /** The query this last put on the address, which `follow` leaves alone, since it is no back or forward. */
  #written: string | undefined;

  constructor(repositories: Repositories, router: Router) {
    this.#repositories = repositories;
    this.#router = router;
  }

  /** The repository the address names, if any. */
  get named(): string | undefined {
    return new URLSearchParams(this.#router.search.value).get(key) ?? undefined;
  }

  /**
   * On arrival at the page, a repository the address names is opened. An
   * address that names none shows the list on a phone, and elsewhere takes
   * the repository kept open from before, which shows beside the list.
   */
  arrive(phone: boolean): void {
    this.#written = undefined;
    const named = this.named;
    if (named !== undefined) {
      this.#open(named);
    } else if (phone) {
      this.#repositories.dropOpened();
    } else {
      this.#write(queryFor(this.#repositories.openedName), 'replace');
    }
    this.#last = { name: this.#repositories.openedName, screen: false };
  }

  /**
   * After a back or forward, the address's repository is opened, or none.
   * On a phone, one the list doesn't show, as one hidden or moved into a
   * closed folder since, is taken off the address instead; elsewhere it is
   * kept out of view, as an opened repository is. Neither ends a hide's Undo. An
   * address this wrote itself is no back or forward, and is left alone.
   */
  follow(phone: boolean): void {
    if (this.#router.search.value === this.#written) {
      return;
    }
    this.#written = undefined;
    const named = this.named;
    if (named === undefined) {
      this.#repositories.dropOpened();
    } else if (phone && this.#repositories.list.value !== undefined && this.#repositories.inView(named) === undefined) {
      this.#repositories.dropOpened();
      this.#write(queryFor(undefined), 'replace');
    } else {
      this.#open(named);
    }
    this.#last = { name: this.#repositories.openedName, screen: this.#last.screen };
  }

  /**
   * Brings the address up to date with the opened repository and what shows:
   * one that opens a screen of its own (`phone`) adds a history entry,
   * so back returns to the list, and any other change takes the place of the
   * entry shown.
   */
  update(phone: boolean): void {
    const repositories = this.#repositories;
    const shown = repositories.opened.value;
    const name = repositories.openedName;
    if (phone && name !== undefined && shown === undefined && repositories.list.value !== undefined) {
      // Out of view: its screen closes, back to the list's entry when it led there.
      repositories.dropOpened();
      this.#return();
      this.#last = { name: undefined, screen: false };
      return;
    }
    if (shown !== undefined && shown.full_name !== name) {
      // A link in another case takes the name as GitHub has it.
      repositories.open(shown);
    }
    const screen = phone && shown !== undefined;
    if (repositories.openedName !== this.#last.name) {
      // Only another repository opens a screen; the same one in GitHub's case takes the entry shown.
      const opened = screen && !this.#last.screen && !same(repositories.openedName, this.#last.name);
      this.#write(queryFor(repositories.openedName), opened ? 'push' : 'replace');
    }
    this.#last = { name: repositories.openedName, screen };
  }

  /**
   * Closes the opened repository's screen: back to the list's entry when
   * it led there, which lets go of it once the back arrives, so
   * the list comes back where the browser puts its scroll; else in place, at
   * once.
   */
  close(): void {
    if (!this.#return()) {
      this.#repositories.dropOpened();
    }
  }

  #write(search: string, entry: 'push' | 'replace'): void {
    this.#router.query(search, entry);
    this.#written = this.#router.search.value;
  }

  /**
   * Back to the address without a query. Says whether the browser runs a
   * back, which comes to `follow` once it arrives.
   */
  #return(): boolean {
    const back = this.#router.returnTo(queryFor(undefined));
    this.#written = this.#router.search.value;
    return back;
  }

  #open(name: string): void {
    // Opening again what is open would end the Undo of a hide.
    if (name !== this.#repositories.openedName) {
      this.#repositories.open({ full_name: name });
    }
  }
}
