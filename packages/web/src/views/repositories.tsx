import type { JSX, RefObject } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import { installUrl } from '../app/github-app.js';
import type { Profiles } from '../app/profiles.js';
import type { Repositories, Repository } from '../app/repositories.js';
import { run } from './run.js';
import { useDismiss } from './shell.js';

function OwnerFilter({ repositories }: { readonly repositories: Repositories }): JSX.Element {
  const menu = useDismiss();
  const owners = repositories.owners.value;
  return (
    <details class="menu" ref={menu}>
      <summary class="button button-quiet">{repositories.ownersLabel.value}</summary>
      <div class="menu-panel">
        <fieldset class="owner-choices">
          <legend>Show repositories owned by</legend>
          {owners.map((owner) => (
            <label key={owner.owner}>
              <input
                type="checkbox"
                checked={owner.shown}
                onChange={(event) => {
                  repositories.setOwnerShown(owner.owner, event.currentTarget.checked);
                }}
              />
              <span class="owner-name">{owner.owner}</span>
              {owner.personal && <span class="pill">You</span>}
              <span class="muted count">{owner.count}</span>
            </label>
          ))}
        </fieldset>
        <div class="menu-actions">
          {owners.some((owner) => owner.personal) && (
            <button
              class="button button-quiet"
              type="button"
              onClick={() => {
                repositories.showOnlyPersonal();
              }}
            >
              Only personal
            </button>
          )}
          <button
            class="button button-quiet"
            type="button"
            disabled={!repositories.ownersFiltered.value}
            onClick={() => {
              repositories.showAllOwners();
            }}
          >
            Show all
          </button>
        </div>
      </div>
    </details>
  );
}

interface PanelProps {
  readonly repository: Repository;
  readonly profiles: Profiles;
  readonly onCapture: (repository: string) => void;
  readonly onCompare: (repository: string, profile: { readonly file: string; readonly name: string }) => void;
}

function RepositoryPanel({ repository, profiles, onCapture, onCompare }: PanelProps): JSX.Element {
  // A profile that can't be read has nothing to compare with.
  const listings = profiles.listings.value.filter((listing) => listing.problem === null);
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const profile = listings.find((listing) => listing.file === picked) ?? listings[0];
  const nameOf = (listing: (typeof listings)[number]): string => profiles.pathOf(listing).replace(/\.ya?ml$/u, '');
  const [owner, name] = repository.full_name.split('/');
  const panel = useRef<HTMLElement>(null);
  // On a narrow screen the panel sits under the list, out of view of the row that opened it.
  useEffect(() => {
    if (matchMedia('(max-width: 760px)').matches) {
      panel.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [repository.full_name]);
  return (
    <aside class="panel" ref={panel} aria-label={repository.full_name}>
      <p class="muted small">{owner}</p>
      <h2 class="mono">{name}</h2>
      <p class="pills">
        <span class="pill">{repository.private ? 'Private' : 'Public'}</span>
        {repository.archived && <span class="pill pill-drift">Archived</span>}
      </p>
      <a class="button" href={`https://github.com/${repository.full_name}`} target="_blank" rel="noreferrer">
        Open on GitHub
      </a>
      <button
        class="button"
        type="button"
        onClick={() => {
          onCapture(repository.full_name);
        }}
      >
        Capture as a new profile
      </button>
      <form
        class="panel-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (profile !== undefined) {
            // The profile goes by its path in the list, which tells two of one name apart.
            onCompare(repository.full_name, { file: profile.file, name: nameOf(profile) });
          }
        }}
      >
        {listings.length === 0 ? (
          <>
            <strong>Compare with a profile</strong>
            <p class="muted small">Make a profile first, on the Profiles page.</p>
          </>
        ) : (
          <>
            <label for="compare-profile">Compare with a profile</label>
            <select
              id="compare-profile"
              class="field"
              value={profile?.file}
              onChange={(event) => {
                setPicked(event.currentTarget.value);
              }}
            >
              {listings.map((listing) => (
                <option key={listing.file} value={listing.file}>
                  {nameOf(listing)}
                </option>
              ))}
            </select>
            <button class="button button-primary" type="submit">
              Compare
            </button>
            {profile !== undefined && profiles.unsaved.value.has(profile.file) && (
              <p class="muted small">It compares the profile as saved, without your unsaved changes.</p>
            )}
          </>
        )}
      </form>
    </aside>
  );
}

/** Focuses the search when the user presses `/` outside a field, as GitHub's own lists do. */
function useSearchKey(): RefObject<HTMLInputElement | null> {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const focus = (event: KeyboardEvent): void => {
      const typing = event.target instanceof HTMLElement && event.target.matches('input, textarea, select');
      // Without a search on the page, the key stays the browser's.
      if (event.key === '/' && !typing && !event.ctrlKey && !event.metaKey && !event.altKey && input.current !== null) {
        event.preventDefault();
        input.current.focus();
      }
    };
    document.addEventListener('keydown', focus);
    return () => {
      document.removeEventListener('keydown', focus);
    };
  }, []);
  return input;
}

interface RepositoriesProps {
  readonly repositories: Repositories;
  readonly profiles: Profiles;
  /** Starts a new profile that captures this repository, `owner/name`. */
  readonly onCapture: (repository: string) => void;
  /** Compares this repository, `owner/name`, with a profile. */
  readonly onCompare: PanelProps['onCompare'];
}

export function RepositoriesPage({ repositories, profiles, onCapture, onCompare }: RepositoriesProps): JSX.Element {
  const search = useSearchKey();
  const list = repositories.list.value;
  const loading = repositories.loading.value;
  const error = repositories.error.value;
  const groups = repositories.groups.value;
  const selected = repositories.selected.value;
  const fromApp = list?.source === 'installations';
  const total = list?.repositories.length ?? 0;

  return (
    <div class={selected === undefined ? 'page' : 'page page-with-panel'}>
      <section class="page-body" aria-labelledby="repositories-heading">
        <div class="page-heading">
          <div>
            <h1 id="repositories-heading">Repositories</h1>
            {list !== undefined && (
              <p class="muted">
                {fromApp
                  ? 'Repositories the Repotted App is installed on that you administer.'
                  : 'Repositories your account administers.'}
              </p>
            )}
          </div>
          <div class="page-actions">
            {fromApp && total > 0 && (
              <a class="button" href={installUrl} target="_blank" rel="noreferrer">
                Add repositories
              </a>
            )}
            <button
              class="button"
              type="button"
              disabled={loading}
              onClick={() => {
                run(repositories.refresh());
              }}
            >
              Refresh
            </button>
          </div>
        </div>

        {error !== undefined && (
          <p class="notice notice-problem" role="alert">
            Couldn't read your repositories: {error}
          </p>
        )}
        {list === undefined && loading && (
          <p class="muted" role="status">
            Reading your repositories…
          </p>
        )}

        {list !== undefined && total === 0 && (
          <div class="empty">
            <p>
              {fromApp
                ? 'The Repotted App is not installed on any repositories you administer yet.'
                : 'Your account administers no repositories.'}
            </p>
            {fromApp && (
              <a class="button button-primary" href={installUrl} target="_blank" rel="noreferrer">
                Add repositories
              </a>
            )}
          </div>
        )}

        {total > 0 && (
          <>
            <div class="toolbar">
              <input
                ref={search}
                class="field"
                type="search"
                placeholder="Find a repository"
                aria-label="Find a repository"
                aria-keyshortcuts="/"
                value={repositories.search.value}
                onInput={(event) => {
                  repositories.search.value = event.currentTarget.value;
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    repositories.search.value = '';
                  }
                }}
              />
              <span class="muted" role="status">
                {repositories.countLabel.value}
              </span>
              {(repositories.owners.value.length > 1 || repositories.ownersFiltered.value) && (
                <OwnerFilter repositories={repositories} />
              )}
            </div>

            {repositories.everyOwnerHidden.value ? (
              <div class="empty">
                <p>Every owner is hidden.</p>
                <button
                  class="button"
                  type="button"
                  onClick={() => {
                    repositories.showAllOwners();
                  }}
                >
                  Show all
                </button>
              </div>
            ) : groups.length === 0 ? (
              <p class="empty">No repository matches "{repositories.search.value.trim()}".</p>
            ) : (
              <div class={loading ? 'groups groups-stale' : 'groups'}>
                {groups.map((group) => (
                  <section key={group.owner} aria-label={group.owner}>
                    <h2 class="group-heading">
                      <span>{group.owner}</span>
                      {group.personal && <span class="pill">You</span>}
                      <span class="muted count">{group.repositories.length}</span>
                    </h2>
                    <ul class="rows">
                      {group.repositories.map((repository) => (
                        <li key={repository.full_name}>
                          <button
                            class="row"
                            type="button"
                            aria-pressed={selected?.full_name === repository.full_name}
                            onClick={() => {
                              repositories.select(
                                selected?.full_name === repository.full_name ? undefined : repository,
                              );
                            }}
                          >
                            <span class="mono row-name">{repository.full_name.slice(group.owner.length + 1)}</span>
                            {repository.archived && <span class="pill pill-drift">Archived</span>}
                            <span class="muted small">{repository.private ? 'Private' : 'Public'}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </>
        )}
      </section>
      {selected !== undefined && (
        <RepositoryPanel repository={selected} profiles={profiles} onCapture={onCapture} onCompare={onCompare} />
      )}
    </div>
  );
}
