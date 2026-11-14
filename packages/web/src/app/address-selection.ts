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
 * The repositories page's selection in the page's address, so a link or a
 * reload opens a repository, and the browser's back closes one that opened a
 * screen of its own, as on a phone. The selection stays where it is kept; the
 * address follows it, except on arrival and after a back or forward, when the
 * selection follows the address.
 *
 * On a phone the selection is a screen of its own, so it is let go of once
 * its repository is out of view, as one hidden, moved into a closed folder,
 * or gone from the list, and the address names only what shows.
 */
export class AddressSelection {
  readonly #repositories: Repositories;
  readonly #router: Router;
  /** The selection and whether it had a screen of its own, as the address last took them. */
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
   * On arrival at the page, a repository the address names is selected. An
   * address that names none shows the list on a phone, and elsewhere takes
   * the selection kept from before, which shows beside the list.
   */
  arrive(phone: boolean): void {
    this.#written = undefined;
    const named = this.named;
    if (named !== undefined) {
      this.#select(named);
    } else if (phone) {
      this.#repositories.dropSelection();
    } else {
      this.#write(queryFor(this.#repositories.selectedName), 'replace');
    }
    this.#last = { name: this.#repositories.selectedName, screen: false };
  }

  /**
   * After a back or forward, the address's repository is selected, or none.
   * On a phone, one the list doesn't show, as one hidden or moved into a
   * closed folder since, is taken off the address instead; elsewhere it is
   * kept out of view, as a selection is. Neither ends a hide's Undo. An
   * address this wrote itself is no back or forward, and is left alone.
   */
  follow(phone: boolean): void {
    if (this.#router.search.value === this.#written) {
      return;
    }
    this.#written = undefined;
    const named = this.named;
    if (named === undefined) {
      this.#repositories.dropSelection();
    } else if (phone && this.#repositories.list.value !== undefined && this.#repositories.inView(named) === undefined) {
      this.#repositories.dropSelection();
      this.#write(queryFor(undefined), 'replace');
    } else {
      this.#select(named);
    }
    this.#last = { name: this.#repositories.selectedName, screen: this.#last.screen };
  }

  /**
   * Brings the address up to date with the selection and what shows: a
   * selection that opens a screen of its own (`phone`) adds a history entry,
   * so back returns to the list, and any other change takes the place of the
   * entry shown.
   */
  update(phone: boolean): void {
    const repositories = this.#repositories;
    const shown = repositories.selected.value;
    const name = repositories.selectedName;
    if (phone && name !== undefined && shown === undefined && repositories.list.value !== undefined) {
      // Out of view: its screen closes, back to the list's entry when it led there.
      repositories.dropSelection();
      this.#return();
      this.#last = { name: undefined, screen: false };
      return;
    }
    if (shown !== undefined && shown.full_name !== name) {
      // A link in another case takes the name as GitHub has it.
      repositories.select(shown);
    }
    const screen = phone && shown !== undefined;
    if (repositories.selectedName !== this.#last.name) {
      // Only another repository opens a screen; the same one in GitHub's case takes the entry shown.
      const opened = screen && !this.#last.screen && !same(repositories.selectedName, this.#last.name);
      this.#write(queryFor(repositories.selectedName), opened ? 'push' : 'replace');
    }
    this.#last = { name: repositories.selectedName, screen };
  }

  /** Closes the selected repository's screen: back to the list's entry when it led there, else in place. */
  close(): void {
    this.#repositories.dropSelection();
    this.#return();
  }

  #write(search: string, entry: 'push' | 'replace'): void {
    this.#router.query(search, entry);
    this.#written = this.#router.search.value;
  }

  /** Back to the address without a query; a back the browser runs comes to `follow` once it arrives. */
  #return(): void {
    this.#router.returnTo(queryFor(undefined));
    this.#written = this.#router.search.value;
  }

  #select(name: string): void {
    // Selecting again what is selected would end the Undo of a hide.
    if (name !== this.#repositories.selectedName) {
      this.#repositories.select({ full_name: name });
    }
  }
}
