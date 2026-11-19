import { signal } from '@preact/signals';

function withoutTrailingSlashes(path: string): string {
  return path.replace(/(?<=.)\/+$/u, '');
}

/**
 * What a history entry the app made holds: its place in the history, so a
 * back or forward says how far it went, and, for one a query added, the query
 * of the entry before it, on the same page.
 */
interface Entry {
  readonly index: number;
  readonly from?: string;
}

function isEntry(state: unknown): state is Entry {
  return typeof state === 'object' && state !== null && typeof (state as Partial<Entry>).index === 'number';
}

/** The entry the page loaded on is the only one the app didn't make, and it starts the count. */
function placeOf(state: unknown): number {
  return isEntry(state) ? state.index : 0;
}

function isQueryEntry(state: unknown): state is Entry & { readonly from: string } {
  return isEntry(state) && typeof state.from === 'string';
}

/** Work that leaving the page shown would lose, which is asked about first. */
export type LeaveQuestion =
  | {
      readonly kind: 'one-off-edits';
      readonly repositories: readonly string[];
      /** Whether **Save edits to profile** can keep them. */
      readonly savable: boolean;
    }
  | { readonly kind: 'capture'; readonly repository: string }
  | { readonly kind: 'new-profile'; readonly name: string };

interface GoOptions {
  /** A page link: the page opens at its top, not at what it last had open, even when it is the page shown. */
  readonly landOnTop?: boolean;
  /** The page itself is done with its work, as after it was created or cancelled. */
  readonly withoutAsking?: boolean;
}

interface Leaving {
  readonly question: LeaveQuestion;
  /** An address to go to, or how many entries the browser's back or forward went, counted forward. */
  readonly to: { readonly address: string; readonly options: GoOptions } | { readonly traversal: number };
}

export class Router {
  readonly path = signal('/');
  readonly search = signal('');
  /** Set while the leave question is open. */
  readonly leaving = signal<Leaving | undefined>(undefined);

  readonly #history: Pick<History, 'pushState' | 'replaceState' | 'back' | 'go' | 'state'>;
  readonly #location: Pick<Location, 'pathname' | 'search'>;
  #browserBackUnderWay = false;
  /** A traversal the user chose to make after being asked, which arrives without being asked again. */
  #traversalAnswered = false;
  /** The traversal back to the entry shown, after one held for the question, which changes nothing. */
  #traversalUndoing = false;
  /** The place in the history of the entry shown. */
  #index: number;
  readonly #holds = new Set<() => LeaveQuestion | undefined>();
  readonly #topOfPageListeners = new Set<(path: string) => void>();

  constructor(
    location: Pick<Location, 'pathname' | 'search'>,
    history: Pick<History, 'pushState' | 'replaceState' | 'back' | 'go' | 'state'>,
    window: { addEventListener(type: 'popstate', listener: () => void): void },
  ) {
    this.#history = history;
    this.#location = location;
    this.#index = placeOf(history.state);
    this.path.value = withoutTrailingSlashes(location.pathname);
    this.search.value = location.search;
    window.addEventListener('popstate', () => {
      this.#arrive();
    });
  }

  /**
   * While `ask` returns a question, leaving the address shown asks it first.
   * Returns the release, for when the page that holds the work goes.
   */
  holdWhileLeaving(ask: () => LeaveQuestion | undefined): () => void {
    this.#holds.add(ask);
    return () => {
      this.#holds.delete(ask);
    };
  }

  /** Called with the page's path whenever a page link opens a page at its top. */
  onTopOfPage(listener: (path: string) => void): () => void {
    this.#topOfPageListeners.add(listener);
    return () => {
      this.#topOfPageListeners.delete(listener);
    };
  }

  /** Going to the page shown, without a query, returns to that page as it was before its query. */
  go(address: string, options: GoOptions = {}): void {
    const at = address.indexOf('?');
    const path = at === -1 ? address : address.slice(0, at);
    const search = at === -1 ? '' : address.slice(at);
    const question =
      options.withoutAsking === true || (path === this.path.value && search === this.search.value)
        ? undefined
        : this.#question();
    if (question !== undefined) {
      this.leaving.value = { question, to: { address, options } };
      return;
    }
    this.leaving.value = undefined;
    this.#go(path, search, address);
    if (options.landOnTop === true) {
      for (const listener of this.#topOfPageListeners) {
        listener(path);
      }
    }
  }

  /** The answer to the leave question that goes where it was asked to. */
  leave(): void {
    const leaving = this.leaving.value;
    if (leaving === undefined) {
      return;
    }
    this.leaving.value = undefined;
    if ('traversal' in leaving.to) {
      this.#traversalAnswered = true;
      this.#history.go(leaving.to.traversal);
    } else {
      this.go(leaving.to.address, { ...leaving.to.options, withoutAsking: true });
    }
  }

  stay(): void {
    this.leaving.value = undefined;
  }

  #question(): LeaveQuestion | undefined {
    for (const ask of this.#holds) {
      const question = ask();
      if (question !== undefined) {
        return question;
      }
    }
    return undefined;
  }

  #arrive(): void {
    const index = placeOf(this.#history.state);
    const traversal = index - this.#index;
    this.#index = index;
    if (this.#traversalUndoing) {
      this.#traversalUndoing = false;
      return;
    }
    const path = withoutTrailingSlashes(this.#location.pathname);
    const search = this.#location.search;
    const answered = this.#traversalAnswered || this.#browserBackUnderWay;
    this.#traversalAnswered = false;
    this.#browserBackUnderWay = false;
    const question =
      answered || traversal === 0 || (path === this.path.value && search === this.search.value)
        ? undefined
        : this.#question();
    if (question !== undefined) {
      // The browser has already moved, so it goes back to the entry shown, leaving the history as it was.
      this.#traversalUndoing = true;
      this.#history.go(-traversal);
      this.leaving.value = { question, to: { traversal } };
      return;
    }
    this.leaving.value = undefined;
    this.path.value = path;
    this.search.value = search;
  }

  #go(path: string, search: string, address: string): void {
    if (path === this.path.value) {
      if (search === '') {
        this.returnTo('');
      } else {
        this.query(search, 'push');
      }
      return;
    }
    this.#push({ index: this.#index + 1 }, address);
    this.path.value = path;
    this.search.value = search;
  }

  #push(entry: Entry, address: string): void {
    this.#history.pushState(entry, '', address);
    this.#index = entry.index;
  }

  query(search: string, entry: 'push' | 'replace'): void {
    // While a back is under way, the address is the browser's to set.
    if (search === this.search.value || this.#browserBackUnderWay) {
      return;
    }
    const address = `${this.path.value}${search}`;
    if (entry === 'push') {
      this.#push({ index: this.#index + 1, from: this.search.value }, address);
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
