import type { Repositories } from './repositories.js';
import type { Router } from './router.js';

const key = 'repository';

/** The query that names a repository, `owner/name`, or none. Its slash stays as it is, so the address reads as GitHub's. */
function queryFor(name: string | undefined): string {
  return name === undefined ? '' : `?${key}=${encodeURIComponent(name).replaceAll('%2F', '/')}`;
}

/**
 * The repositories page's selection in the page's address, so a link or a
 * reload opens a repository, and the browser's back closes one that opened a
 * screen of its own. The selection stays where it is kept; the address
 * follows it, except on arrival and after a back or forward, when the
 * selection follows the address.
 */
export class AddressSelection {
  readonly #repositories: Repositories;
  readonly #router: Router;

  constructor(repositories: Repositories, router: Router) {
    this.#repositories = repositories;
    this.#router = router;
  }

  /** The repository the address names, if any. */
  get named(): string | undefined {
    return new URLSearchParams(this.#router.search.value).get(key) ?? undefined;
  }

  /**
   * On arrival at the page, a repository the address names is selected; an
   * address that names none, as a link to the page's, takes the selection
   * kept from before.
   */
  arrive(): void {
    const named = this.named;
    if (named === undefined) {
      this.keep('replace');
    } else {
      this.#select(named);
    }
  }

  /** After a back or forward, the address's repository is selected, or none. */
  follow(): void {
    this.#select(this.named);
  }

  /**
   * Puts the selection on the address: in a new history entry when it opens
   * a screen of its own, so back closes it, or in place of the one shown.
   */
  keep(entry: 'push' | 'replace'): void {
    this.#router.query(queryFor(this.#repositories.selectedName), entry);
  }

  /**
   * Closes the selected repository's screen: back to the list's history
   * entry when it led there, so the history doesn't grow, else in place.
   */
  close(): void {
    this.#router.returnTo(queryFor(undefined));
  }

  /**
   * Lets go of a selection that is out of view, as one hidden, moved into a
   * closed folder, or gone from the list, and takes it off the address.
   * A hide's Undo selects it again.
   */
  release(): void {
    this.#repositories.dropSelection();
    this.close();
  }

  #select(name: string | undefined): void {
    // Selecting again what is selected would clear the Undo of a hide.
    if (name !== this.#repositories.selectedName) {
      this.#repositories.select(name === undefined ? undefined : { full_name: name });
    }
  }
}
