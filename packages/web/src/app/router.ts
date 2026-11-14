import { signal } from '@preact/signals';

/** A path without the slashes at its end, so `/profiles/` is the page `/profiles` is. */
function clean(path: string): string {
  return path.replace(/(?<=.)\/+$/u, '');
}

/** What a history entry that a query added holds: the query of the entry before it, on the same page. */
interface QueryEntry {
  readonly from: string;
}

function isQueryEntry(state: unknown): state is QueryEntry {
  return typeof state === 'object' && state !== null && typeof (state as Partial<QueryEntry>).from === 'string';
}

/** The page's address within the app, which follows the browser's history. */
export class Router {
  readonly path = signal('/');
  /** The address's query, such as `?repository=octo/app`, or empty. */
  readonly search = signal('');

  readonly #history: Pick<History, 'pushState' | 'replaceState' | 'back' | 'state'>;
  /** Whether a back this router asked for is under way, until the browser says it arrived. */
  #returning = false;

  constructor(
    location: Pick<Location, 'pathname' | 'search'>,
    history: Pick<History, 'pushState' | 'replaceState' | 'back' | 'state'>,
    window: { addEventListener(type: 'popstate', listener: () => void): void },
  ) {
    this.#history = history;
    this.path.value = clean(location.pathname);
    this.search.value = location.search;
    window.addEventListener('popstate', () => {
      this.#returning = false;
      this.path.value = clean(location.pathname);
      this.search.value = location.search;
    });
  }

  /** Goes to a page, or to the page shown without its query. */
  go(path: string): void {
    if (path !== this.path.value || this.search.value !== '') {
      this.#history.pushState(null, '', path);
      this.path.value = path;
      this.search.value = '';
    }
  }

  /**
   * Puts this query, `?…` or empty, on the page's address: in a new history
   * entry, so the browser's back returns to the query before it, or in place
   * of the one shown.
   */
  query(search: string, entry: 'push' | 'replace'): void {
    // While a back is under way, the address is the browser's to set.
    if (search === this.search.value || this.#returning) {
      return;
    }
    const address = `${this.path.value}${search}`;
    if (entry === 'push') {
      this.#history.pushState({ from: this.search.value } satisfies QueryEntry, '', address);
    } else {
      // The entry keeps what it holds, so one a query added still leads back to the one before it.
      this.#history.replaceState(this.#history.state, '', address);
    }
    this.search.value = search;
  }

  /**
   * Returns to this query on the page shown: by the browser's back when the
   * entry before this one has it, so the history doesn't grow, else in place
   * of the one shown.
   */
  returnTo(search: string): void {
    const state: unknown = this.#history.state;
    if (this.#returning) {
      return;
    }
    if (isQueryEntry(state) && state.from === search) {
      this.#returning = true;
      this.#history.back();
    } else {
      this.query(search, 'replace');
    }
  }
}
