import { computed, signal } from '@preact/signals';
import type { findActions } from '@repotted/core';

export type FoundAction = Awaited<ReturnType<typeof findActions>>[number];

export type ActionSearchState =
  | { readonly kind: 'closed' | 'searching' }
  | { readonly kind: 'results'; readonly found: readonly FoundAction[] }
  | { readonly kind: 'message'; readonly text: string };

const minimumSearchCharacters = 2;

export function foundNotes(found: FoundAction): string {
  const stars = found.stars < 1000 ? String(found.stars) : `${(found.stars / 1000).toFixed(1)}k`;
  return `${stars} ${found.stars === 1 ? 'star' : 'stars'}, ${found.action_file ?? 'no action file at its top'}`;
}

function failureOf(error: unknown): string {
  if (error instanceof Error && 'rateLimited' in error && error.rateLimited === true) {
    return "GitHub's search limit is reached. Try again in a minute.";
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * It searches once typing has stopped for a moment, and one search counts
 * at a time: a newer one leaves the one before it behind, so an older answer
 * never replaces a newer one.
 */
export class ActionSearch {
  readonly #find: (words: string) => Promise<FoundAction[]>;
  readonly #typingPauseMilliseconds: number;
  readonly #text = signal('');
  readonly #state = signal<ActionSearchState>({ kind: 'closed' });
  #timer: ReturnType<typeof setTimeout> | undefined;
  #latestSearchTurn = 0;
  #wordsOfSearchUnderWay: string | undefined;

  constructor(find: (words: string) => Promise<FoundAction[]>, typingPauseMilliseconds = 500) {
    this.#find = find;
    this.#typingPauseMilliseconds = typingPauseMilliseconds;
  }

  readonly text = computed(() => this.#text.value);

  readonly state = computed(() => this.#state.value);

  type(text: string): void {
    this.#text.value = text;
    this.#cancel();
    if (text.trim().length < minimumSearchCharacters) {
      this.#state.value = { kind: 'closed' };
      return;
    }
    // What shows stays until the new search starts: a list still says it is searching, with its search left behind.
    this.#timer = setTimeout(() => {
      this.#search();
    }, this.#typingPauseMilliseconds);
  }

  enter(): void {
    const words = this.#text.value.trim();
    // A key held down asks once: the search under way is already for these words.
    if (
      words.length >= minimumSearchCharacters &&
      !(this.#state.value.kind === 'searching' && this.#wordsOfSearchUnderWay === words)
    ) {
      this.#cancel();
      this.#search();
    }
  }

  close(): void {
    this.#cancel();
    this.#state.value = { kind: 'closed' };
  }

  #cancel(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#latestSearchTurn += 1;
    this.#wordsOfSearchUnderWay = undefined;
  }

  #search(): void {
    const words = this.#text.value.trim();
    const turn = (this.#latestSearchTurn += 1);
    this.#wordsOfSearchUnderWay = words;
    this.#state.value = { kind: 'searching' };
    this.#find(words).then(
      (found) => {
        if (turn === this.#latestSearchTurn) {
          this.#state.value =
            found.length === 0
              ? { kind: 'message', text: `GitHub found no repositories for “${words}”.` }
              : { kind: 'results', found };
        }
      },
      (error: unknown) => {
        if (turn === this.#latestSearchTurn) {
          this.#state.value = { kind: 'message', text: failureOf(error) };
        }
      },
    );
  }
}
