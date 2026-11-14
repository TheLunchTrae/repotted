import type { JSX } from 'preact';

import type { CompareRow, Comparison } from '../app/comparison.js';
import { installUrl } from '../app/github-app.js';
import type { Router } from '../app/router.js';
import { Link } from './link.js';
import { run } from './run.js';

const kinds: Readonly<Record<CompareRow['kind'], string>> = { changes: 'Changes', adds: 'Adds', removes: 'Removes' };

function Row({ row }: { readonly row: CompareRow }): JSX.Element {
  return (
    <li class="compare-row">
      <span class="compare-what">
        <strong>{row.label}</strong>
        <span class="mono small muted">{row.key}</span>
      </span>
      <span class="compare-values">
        <span class="visually-hidden">{kinds[row.kind]}: on GitHub now, </span>
        <span class={row.kind === 'adds' ? 'muted' : 'compare-now'}>{row.now}</span>
        <span aria-hidden="true">→</span>
        <span class="visually-hidden">; the profile wants </span>
        <span class={row.kind === 'removes' ? 'compare-removed' : 'compare-wanted'}>{row.wanted}</span>
      </span>
      {row.lock !== undefined && <span class="pill pill-remove">{row.lock}</span>}
    </li>
  );
}

interface CompareProps {
  readonly comparison: Comparison;
  readonly router: Router;
}

/** A repository compared with a profile: each difference by section, what GitHub has now, and what the profile wants. */
export function ComparePage({ comparison, router }: CompareProps): JSX.Element {
  const state = comparison.state.value;
  const back = (
    <Link router={router} to="/">
      Back to repositories
    </Link>
  );
  if (state.kind === 'idle') {
    return (
      <div class="page">
        <div class="page-body">
          <h1>Compare a repository with a profile</h1>
          <p>Select a repository on the Repositories page, pick a profile, and choose Compare.</p>
          <p>{back}</p>
        </div>
      </div>
    );
  }
  const counts = comparison.counts.value;
  const shown = comparison.shown.value;
  return (
    <div class="page">
      <article class="page-body" aria-labelledby="compare-heading">
        <p>{back}</p>
        <div class="page-heading">
          <div>
            <h1 id="compare-heading">
              <span class="mono">{state.repository}</span> with {state.profile}
            </h1>
            <p class="muted" role="status">
              {state.kind === 'comparing'
                ? 'Reading from GitHub…'
                : state.kind === 'failed'
                  ? "The comparison couldn't be made."
                  : counts.differences === 0
                    ? state.warnings.length > 0
                      ? 'No differences in what the comparison could read.'
                      : 'The repository already has everything the profile applies.'
                    : `${counts.differences === 1 ? '1 difference' : `${counts.differences} differences`}${
                        counts.locked === 0 ? '' : `, ${counts.locked} that Repotted can't change`
                      }. Comparing only reads from GitHub.`}
              {state.kind === 'compared' &&
                counts.matches > 0 &&
                ` ${counts.matches === 1 ? '1 thing the profile sets needs' : `${counts.matches} things the profile sets need`} no change${
                  comparison.onlyDifferences.value || comparison.onlyLocked.value ? ', folded away' : ''
                }.`}
            </p>
          </div>
        </div>
        {state.kind !== 'comparing' && (
          <p>
            <button
              class="button"
              type="button"
              onClick={() => {
                run(comparison.again());
              }}
            >
              Compare again
            </button>
          </p>
        )}
        {state.kind === 'failed' && (
          <p class="notice notice-problem" role="alert">
            {state.message}
          </p>
        )}
        {state.kind === 'compared' && (
          <>
            {state.warnings.length > 0 && (
              <div class="notice notice-drift">
                <p>The comparison left some things out:</p>
                <ul>
                  {state.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            )}
            {state.skipped.length > 0 && (
              <div class="notice">
                <p>The profile's draft is left out. It holds:</p>
                <ul>
                  {state.skipped.map((skipped) => (
                    <li key={skipped} class="mono small">
                      {skipped}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {counts.locked > 0 && state.appAccess !== undefined && (
              <p>
                <a
                  class="button"
                  href={state.appAccess === 'install' ? installUrl : state.appAccess.settings}
                  target="_blank"
                  rel="noreferrer"
                >
                  {state.appAccess === 'install' ? 'Install the App' : 'Review App access'}
                </a>
              </p>
            )}
            {counts.differences + counts.matches > 0 && (
              <div class="filters" role="search" aria-label="This comparison">
                <input
                  class="field"
                  type="search"
                  placeholder="Search this comparison"
                  aria-label="Search this comparison"
                  value={comparison.search.value}
                  onInput={(event) => {
                    comparison.search.value = event.currentTarget.value;
                  }}
                />
                {counts.matches + counts.locked > 0 && (
                  <div class="segments" role="group" aria-label="Show only">
                    {counts.matches > 0 && (
                      <label>
                        <input
                          type="checkbox"
                          checked={comparison.onlyDifferences.value}
                          onChange={(event) => {
                            comparison.onlyDifferences.value = event.currentTarget.checked;
                          }}
                        />
                        <span>Differs from GitHub</span>
                      </label>
                    )}
                    {counts.locked > 0 && (
                      <label>
                        <input
                          type="checkbox"
                          checked={comparison.onlyLocked.value}
                          onChange={(event) => {
                            comparison.onlyLocked.value = event.currentTarget.checked;
                          }}
                        />
                        <span>Can't change</span>
                      </label>
                    )}
                  </div>
                )}
              </div>
            )}
            {shown.length === 0 && comparison.search.value.trim() !== '' && (
              <p class="empty">
                {comparison.onlyDifferences.value || comparison.onlyLocked.value
                  ? `No difference matches "${comparison.search.value.trim()}".`
                  : `Nothing in this comparison matches "${comparison.search.value.trim()}".`}
              </p>
            )}
            <div class="groups">
              {shown.map((section) => (
                <section key={section.section} class="settings-group" aria-label={section.title}>
                  <h2>{section.title}</h2>
                  <ul class="rows" role="list">
                    {section.rows.map((row) => (
                      <Row key={`${row.label} ${row.key}`} row={row} />
                    ))}
                    {section.matches.map((row) => (
                      <li key={`matches ${row.label} ${row.key}`} class="compare-row">
                        <span class="compare-what">
                          <strong>{row.label}</strong>
                          <span class="mono small muted">{row.key}</span>
                        </span>
                        <span class="compare-values muted">
                          {row.value !== undefined && <span class="visually-hidden">The profile sets </span>}
                          {row.value}
                        </span>
                        <span class="pill">No change</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </>
        )}
      </article>
    </div>
  );
}
