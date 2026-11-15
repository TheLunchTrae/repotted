import type { JSX } from 'preact';

import { type ActionPatternChecks, gitHubPageOf, patternNote } from '../../app/profile-editor/action-pattern-checks.js';

export function PatternChecks({ checks }: { readonly checks: ActionPatternChecks }): JSX.Element {
  const lines = checks.lines.value.filter((line) => line.state !== undefined);
  return (
    <div class="pattern-checks">
      {/* Safari takes a list without bullets for no list, unless it is named one. */}
      <ul role="list" aria-label="What each pattern matches on GitHub" hidden={lines.length === 0}>
        {lines.map((line, index) => {
          const note = line.state === undefined ? undefined : patternNote(line.state);
          const pattern = line.text.trim();
          const gitHubPage = gitHubPageOf(line.state);
          return (
            // Two lines may hold the same pattern, so a line is known by its place.
            <li key={index}>
              {gitHubPage === undefined ? (
                <span class="mono">{pattern}</span>
              ) : (
                <a class="mono pattern-link" href={gitHubPage} target="_blank" rel="noreferrer">
                  {pattern}
                </a>
              )}
              <span class={`pattern-note pattern-${note?.tone ?? 'muted'}`}>{note?.text}</span>
            </li>
          );
        })}
      </ul>
      {/* The count's place is there before it has anything to say, so a screen reader announces what it comes to say. */}
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
