import { computed, signal } from '@preact/signals';
import { type checkActionPatterns, describeActionCheck } from '@repotted/core';

export type ActionPatternCheck = Awaited<ReturnType<typeof checkActionPatterns>>[number];

type PatternCheckState =
  | { readonly kind: 'waiting' | 'checking' }
  | { readonly kind: 'checked'; readonly check: ActionPatternCheck }
  | { readonly kind: 'failed'; readonly message: string };

export interface PatternLine {
  readonly text: string;
  /**
   * Undefined for a blank line or one not asked about yet. `several` is a
   * line with a comma, which holds several patterns and is never checked.
   */
  readonly state: PatternCheckState | { readonly kind: 'several' } | undefined;
}

export interface PatternNote {
  readonly tone: 'good' | 'warning' | 'bad' | 'muted';
  readonly text: string;
}

export function patternNote(state: NonNullable<PatternLine['state']>): PatternNote {
  if (state.kind === 'several') {
    return { tone: 'muted', text: "Several patterns on one line can't be checked. Put each on its own line." };
  }
  if (state.kind === 'failed') {
    return { tone: 'muted', text: `Could not be checked: ${state.message}` };
  }
  if (state.kind !== 'checked') {
    return { tone: 'muted', text: 'Checking…' };
  }
  const { check } = state;
  // The engine says it after the pattern, as its text output prints it; the line here already shows the pattern.
  const said = describeActionCheck(check).slice(check.pattern.length + 2);
  // It starts with a word, or with a repository's name, which keeps its case.
  const named =
    !said.startsWith('blocks ') &&
    (check.status === 'match' || check.status === 'missing_ref' || check.status === 'missing_path');
  const text = `${named ? said : `${said.slice(0, 1).toUpperCase()}${said.slice(1)}`}.`;
  if (check.status === 'match' || check.status === 'owner') {
    return { tone: 'good', text };
  }
  if (check.status === 'invalid') {
    return { tone: 'bad', text };
  }
  return { tone: check.status === 'unchecked' ? 'muted' : 'warning', text };
}

export function gitHubPageOf(state: PatternLine['state']): string | undefined {
  if (state?.kind !== 'checked') {
    return undefined;
  }
  const { check } = state;
  switch (check.status) {
    case 'match':
    case 'missing_ref':
    case 'missing_path':
      return `https://github.com/${check.repository}`;
    case 'owner':
      return `https://github.com/${check.owner}`;
    case 'unchecked':
    case 'not_found':
    case 'invalid':
    case 'error':
      return undefined;
  }
}

const patternsPerCheckRun = 100;

function patternOf(line: string): string {
  return line.trim();
}

function checkable(pattern: string): boolean {
  return pattern !== '' && !pattern.includes(',');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A check belongs to a pattern's text, trimmed, so a check that lands after
 * its line changed shows on no other. The checks only inform: nothing here
 * holds a save back.
 */
export class ActionPatternChecks {
  readonly #check: (patterns: readonly string[]) => Promise<ActionPatternCheck[]>;
  readonly #typingPauseMilliseconds: number;
  readonly #known = signal<ReadonlyMap<string, PatternCheckState>>(new Map());
  readonly #lines = signal<readonly string[] | undefined>(undefined);
  #firstRunStarted = false;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(check: (patterns: readonly string[]) => Promise<ActionPatternCheck[]>, typingPauseMilliseconds = 600) {
    this.#check = check;
    this.#typingPauseMilliseconds = typingPauseMilliseconds;
  }

  readonly lines = computed((): PatternLine[] =>
    (this.#lines.value ?? []).map((text) => {
      const pattern = patternOf(text);
      return {
        text,
        state: pattern === '' ? undefined : checkable(pattern) ? this.#known.value.get(pattern) : { kind: 'several' },
      };
    }),
  );

  /** Patterns, trimmed, that GitHub says match nothing, as the summary counts them: those not found and those it refuses. */
  readonly patternsMatchingNothing = computed(
    () =>
      new Set(
        [...this.#known.value].flatMap(([pattern, state]) =>
          state.kind === 'checked' && (state.check.status === 'not_found' || state.check.status === 'invalid')
            ? [pattern]
            : [],
        ),
      ),
  );

  readonly canCheckAgain = computed(
    () =>
      this.#checkablePatterns().length > 0 &&
      !this.#checkablePatterns().some((pattern) => this.#known.value.get(pattern)?.kind === 'checking'),
  );

  readonly summary = computed(() => {
    const states = this.lines.value.flatMap((line) => (line.state === undefined ? [] : [line.state]));
    const checks = states.flatMap((state) => (state.kind === 'checked' ? [state.check] : []));
    const count = (statuses: readonly ActionPatternCheck['status'][]): number =>
      checks.filter((check) => statuses.includes(check.status)).length;
    const said = (amount: number, one: string, many: string): string[] =>
      amount === 0 ? [] : [amount === 1 ? `1 ${one}` : `${amount} ${many}`];
    const unchecked = count(['unchecked']) + states.filter((state) => state.kind === 'several').length;
    return [
      ...said(count(['match', 'owner']), 'matches', 'match'),
      ...said(count(['missing_ref']), 'has a missing tag or branch', 'have a missing tag or branch'),
      ...said(count(['missing_path']), 'has a missing folder or file', 'have a missing folder or file'),
      ...said(count(['not_found', 'invalid']), 'matches nothing', 'match nothing'),
      ...said(unchecked, "can't be checked", "can't be checked"),
      ...said(states.filter((state) => state.kind === 'failed').length, 'could not be checked', 'could not be checked'),
      ...said(
        states.filter((state) => state.kind === 'checking' || state.kind === 'waiting').length,
        'being checked',
        'being checked',
      ),
    ].join(', ');
  });

  /**
   * `lines` is undefined while the list's row doesn't show, as GitHub hides
   * it unless selected actions are allowed. The first patterns are asked
   * about at once; a pattern that comes later waits until the list has been
   * still for a moment, so each key typed isn't a lookup.
   */
  follow(lines: readonly string[] | undefined): void {
    // The list is handed over after every change to the profile, and only a change to the list starts the pause again.
    const before = this.#lines.value;
    if (lines?.join('\n') === before?.join('\n') && (lines === undefined) === (before === undefined)) {
      return;
    }
    this.#lines.value = lines;
    const patterns = new Set(this.#checkablePatterns());
    // A pattern that left the list before its pause ended is not asked about.
    const known = new Map(
      [...this.#known.value].filter(([pattern, state]) => state.kind !== 'waiting' || patterns.has(pattern)),
    );
    const fresh = [...patterns].filter((pattern) => !known.has(pattern));
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (!this.#firstRunStarted && fresh.length > 0) {
      this.#known.value = known;
      this.#run();
      return;
    }
    for (const pattern of fresh) {
      known.set(pattern, { kind: 'waiting' });
    }
    this.#known.value = known;
    if ([...known.values()].some((state) => state.kind === 'waiting')) {
      this.#timer = setTimeout(() => {
        this.#run();
      }, this.#typingPauseMilliseconds);
    }
  }

  checkAgain(): void {
    if (!this.canCheckAgain.value) {
      return;
    }
    const patterns = new Set(this.#checkablePatterns());
    this.#known.value = new Map([...this.#known.value].filter(([pattern]) => !patterns.has(pattern)));
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#run();
  }

  #checkablePatterns(): string[] {
    return [...new Set((this.#lines.value ?? []).map(patternOf).filter(checkable))];
  }

  #run(): void {
    this.#firstRunStarted = true;
    const asking = this.#checkablePatterns().filter((pattern) => {
      const kind = this.#known.value.get(pattern)?.kind;
      return kind === undefined || kind === 'waiting';
    });
    this.#set(asking, () => ({ kind: 'checking' }));
    // Each run's failure is kept as its patterns' state, so nothing is left to catch here.
    this.#ask(asking).catch(() => undefined);
  }

  /**
   * One run after another, so a long list asks no more at once than a short
   * one. A run that fails as a whole, as with no network or a lost sign-in,
   * fails the runs after it without asking.
   */
  async #ask(asking: readonly string[]): Promise<void> {
    for (let start = 0; start < asking.length; start += patternsPerCheckRun) {
      const patterns = asking.slice(start, start + patternsPerCheckRun);
      const failed = await this.#check(patterns).then(
        (checks) => {
          const answers = new Map(checks.map((check) => [check.pattern, check]));
          this.#set(patterns, (pattern) => {
            const check = answers.get(pattern);
            if (check === undefined) {
              return { kind: 'failed', message: 'GitHub gave no answer for it.' };
            }
            // GitHub's error for one pattern, or its limit, is a failure of the check, not something the pattern matches.
            return check.status === 'error'
              ? {
                  kind: 'failed',
                  message: check.rate_limited ? "GitHub's limit is reached. Check again in a while." : check.message,
                }
              : { kind: 'checked', check };
          });
          return false;
        },
        (error: unknown) => {
          this.#set(asking.slice(start), () => ({ kind: 'failed', message: messageOf(error) }));
          return true;
        },
      );
      if (failed) {
        return;
      }
    }
  }

  #set(patterns: readonly string[], state: (pattern: string) => PatternCheckState): void {
    const known = new Map(this.#known.value);
    for (const pattern of patterns) {
      known.set(pattern, state(pattern));
    }
    this.#known.value = known;
  }
}
