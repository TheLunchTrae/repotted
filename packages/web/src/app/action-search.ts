import { computed, signal } from '@preact/signals';
import type { findActions } from '@repotted/core';

export type FoundAction = Awaited<ReturnType<typeof findActions>>[number];

/** What the search shows under its box: nothing, that it is searching, what it found, or why it found nothing. */
export type ActionSearchState =
  | { readonly kind: 'closed' | 'searching' }
  | { readonly kind: 'results'; readonly found: readonly FoundAction[] }
  | { readonly kind: 'message'; readonly text: string };

/** The fewest characters worth a search. */
const fewest = 2;

function failureOf(error: unknown): string {
  if (error instanceof Error && 'rateLimited' in error && error.rateLimited === true) {
    return "GitHub's search limit is reached. Try again in a minute.";
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * The search for repositories to allow actions from. It searches once
 * typing has stopped for a moment, and one search counts at a time: a newer
 * one leaves the one before it behind, so an older answer never replaces a
 * newer one.
 */
export class ActionSearch {
  readonly #find: (words: string) => Promise<FoundAction[]>;
  readonly #pause: number;
  readonly #text = signal('');
  readonly #state = signal<ActionSearchState>({ kind: 'closed' });
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** Counts searches, so only the last one's answer is shown. */
  #searches = 0;

  constructor(find: (words: string) => Promise<FoundAction[]>, pause = 500) {
    this.#find = find;
    this.#pause = pause;
  }

  /** What is typed in the box. */
  readonly text = computed(() => this.#text.value);

  readonly state = computed(() => this.#state.value);

  /** Takes what is typed, as each key is pressed. */
  type(text: string): void {
    this.#text.value = text;
    this.#cancel();
    if (text.trim().length < fewest) {
      this.#state.value = { kind: 'closed' };
      return;
    }
    // What shows stays until the new search starts: a list still says it is searching, with its search left behind.
    this.#timer = setTimeout(() => {
      this.#search();
    }, this.#pause);
  }

  /** Searches at once for the text as it is. */
  enter(): void {
    if (this.#text.value.trim().length >= fewest) {
      this.#cancel();
      this.#search();
    }
  }

  /** Puts the results away, with any search left behind. The text stays, to search again. */
  close(): void {
    this.#cancel();
    this.#state.value = { kind: 'closed' };
  }

  #cancel(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#searches += 1;
  }

  #search(): void {
    const words = this.#text.value.trim();
    const turn = (this.#searches += 1);
    this.#state.value = { kind: 'searching' };
    this.#find(words).then(
      (found) => {
        if (turn === this.#searches) {
          this.#state.value =
            found.length === 0
              ? { kind: 'message', text: `GitHub found no repositories for “${words}”.` }
              : { kind: 'results', found };
        }
      },
      (error: unknown) => {
        if (turn === this.#searches) {
          this.#state.value = { kind: 'message', text: failureOf(error) };
        }
      },
    );
  }
}
