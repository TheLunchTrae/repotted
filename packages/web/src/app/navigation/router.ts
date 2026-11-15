import { signal } from '@preact/signals';

function withoutTrailingSlashes(path: string): string {
  return path.replace(/(?<=.)\/+$/u, '');
}

/** What a history entry that a query added holds: the query of the entry before it, on the same page. */
interface QueryEntry {
  readonly from: string;
}

function isQueryEntry(state: unknown): state is QueryEntry {
  return typeof state === 'object' && state !== null && typeof (state as Partial<QueryEntry>).from === 'string';
}

export class Router {
  readonly path = signal('/');
  readonly search = signal('');

  readonly #history: Pick<History, 'pushState' | 'replaceState' | 'back' | 'state'>;
  #browserBackUnderWay = false;

  constructor(
    location: Pick<Location, 'pathname' | 'search'>,
    history: Pick<History, 'pushState' | 'replaceState' | 'back' | 'state'>,
    window: { addEventListener(type: 'popstate', listener: () => void): void },
  ) {
    this.#history = history;
    this.path.value = withoutTrailingSlashes(location.pathname);
    this.search.value = location.search;
    window.addEventListener('popstate', () => {
      this.#browserBackUnderWay = false;
      this.path.value = withoutTrailingSlashes(location.pathname);
      this.search.value = location.search;
    });
  }

  /** Going to the page shown, without a query, returns to that page as it was before its query. */
  go(address: string): void {
    const at = address.indexOf('?');
    const path = at === -1 ? address : address.slice(0, at);
    const search = at === -1 ? '' : address.slice(at);
    if (path === this.path.value) {
      if (search === '') {
        this.returnTo('');
      } else {
        this.query(search, 'push');
      }
      return;
    }
    this.#history.pushState(null, '', address);
    this.path.value = path;
    this.search.value = search;
  }

  query(search: string, entry: 'push' | 'replace'): void {
    // While a back is under way, the address is the browser's to set.
    if (search === this.search.value || this.#browserBackUnderWay) {
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
   * Uses the browser's back when the entry before this one has the query, so
   * the history doesn't grow. Returns whether a back is under way, which sets
   * the address once it arrives.
   */
  returnTo(search: string): boolean {
    const state: unknown = this.#history.state;
    if (this.#browserBackUnderWay) {
      return true;
    }
    if (search === this.search.value) {
      return false;
    }
    if (isQueryEntry(state) && state.from === search) {
      this.#browserBackUnderWay = true;
      this.#history.back();
      return true;
    }
    this.query(search, 'replace');
    return false;
  }
}
