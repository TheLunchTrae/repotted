import { describeActionCheck } from '@repotted/core';
import type { JSX } from 'preact';

import type { ActionPatternChecks, PatternLine } from '../app/action-pattern-checks.js';

/** What a line says about its pattern, and how loudly: fine, worth a look, wrong, or nothing to judge. */
function noteOf(state: NonNullable<PatternLine['state']>): { readonly tone: string; readonly text: string } {
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
  // What it says starts with a repository's name, which keeps its case, or with a word.
  const named = check.status === 'match' || check.status === 'missing_ref' || check.status === 'missing_path';
  const text = `${named ? said : `${said.slice(0, 1).toUpperCase()}${said.slice(1)}`}.`;
  if (check.status === 'match' || check.status === 'owner') {
    return { tone: 'good', text };
  }
  if (check.status === 'invalid') {
    return { tone: 'bad', text };
  }
  return { tone: check.status === 'unchecked' ? 'muted' : 'warning', text };
}

/** Beside each allowed action pattern, what it matches on GitHub, with the count under them and a way to ask again. */
export function PatternChecks({ checks }: { readonly checks: ActionPatternChecks }): JSX.Element | null {
  const lines = checks.lines.value.filter((line) => line.state !== undefined);
  if (lines.length === 0) {
    return null;
  }
  return (
    <div class="pattern-checks">
      <ul aria-label="What each pattern matches on GitHub">
        {lines.map((line, index) => {
          const note = line.state === undefined ? undefined : noteOf(line.state);
          return (
            // Two lines may hold the same pattern, so a line is known by its place.
            <li key={index}>
              <span class="mono">{line.text.trim()}</span>
              <span class={`pattern-note pattern-${note?.tone ?? 'muted'}`}>{note?.text}</span>
            </li>
          );
        })}
      </ul>
      <p class="muted small">
        <span role="status">{checks.summary.value === '' ? '' : `${checks.summary.value}.`}</span>{' '}
        {checks.canCheckAgain.value && (
          <button
            class="link"
            type="button"
            onClick={() => {
              checks.checkAgain();
            }}
          >
            Check again
          </button>
        )}
      </p>
    </div>
  );
}
