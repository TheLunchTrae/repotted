import type { JSX, RefObject } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import type { Apply } from '../app/apply.js';
import type { BatchApply } from '../app/batch-apply.js';
import type { ComparedProfile } from '../app/comparison.js';
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
  readonly repositories: Repositories;
  readonly profiles: Profiles;
  readonly onCapture: (repository: string) => void;
  readonly onCompare: (repository: string, profile: ComparedProfile) => void;
  readonly apply: Apply;
  /**
   * Starts an apply of the profile to the repository, picks up the
   * unfinished one when no profile is given, or with `once` starts one that
   * changes settings without a profile.
   */
  readonly onApply: (repository: string, profile: ComparedProfile | 'once' | undefined) => void;
}

function RepositoryPanel({
  repository,
  repositories,
  profiles,
  apply,
  onCapture,
  onCompare,
  onApply,
}: PanelProps): JSX.Element {
  // Whether an apply here was left unfinished, which the browser keeps.
  const [unfinished, setUnfinished] = useState(false);
  // Looked up again whenever the apply moves on, since one that ends or is discarded is no longer there.
  const moved = apply.state.value.kind;
  useEffect(() => {
    let current = true;
    setUnfinished(false);
    run(
      apply.unfinished(repository.full_name).then((found) => {
        if (current) {
          setUnfinished(found);
        }
      }),
    );
    return () => {
      current = false;
    };
  }, [apply, repository.full_name, moved]);
  // A profile that can't be read has nothing to compare with.
  const listings = profiles.listings.value.filter((listing) => listing.problem === null);
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const profile = listings.find((listing) => listing.file === picked) ?? listings[0];
  const nameOf = (listing: (typeof listings)[number]): string => profiles.pathOf(listing).replace(/\.ya?ml$/u, '');
  const [owner, name] = repository.full_name.split('/');
  const hidden = repositories.isHidden(repository);
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
        {hidden && <span class="pill">Hidden</span>}
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
      {/* One apply a repository at a time: an unfinished one is resumed or discarded first. */}
      {!unfinished && (
        <button
          class="button"
          type="button"
          onClick={() => {
            onApply(repository.full_name, 'once');
          }}
        >
          Change settings once
        </button>
      )}
      {unfinished && (
        <div class="notice notice-drift">
          <p>An apply here is not finished.</p>
          <p class="notice-actions">
            <button
              class="button button-small"
              type="button"
              onClick={() => {
                onApply(repository.full_name, undefined);
              }}
            >
              Resume
            </button>
          </p>
        </div>
      )}
      <form
        class="panel-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (profile !== undefined) {
            // The profile goes by its path in the list, which tells two of one name apart.
            onCompare(repository.full_name, {
              file: profile.file,
              name: nameOf(profile),
              folder: profiles.folder.value,
            });
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
            <div class="form-actions">
              <button class="button button-primary" type="submit">
                Compare
              </button>
              <button
                class="button"
                type="button"
                onClick={() => {
                  if (profile !== undefined) {
                    onApply(repository.full_name, {
                      file: profile.file,
                      name: nameOf(profile),
                      folder: profiles.folder.value,
                    });
                  }
                }}
              >
                Apply
              </button>
            </div>
            {profile !== undefined && profiles.unsaved.value.has(profile.file) && (
              <p class="muted small">It compares the profile as saved, without your unsaved changes.</p>
            )}
          </>
        )}
      </form>
      <button
        class="button button-quiet"
        type="button"
        onClick={() => {
          if (hidden) {
            repositories.unhide([repository]);
          } else {
            repositories.hide([repository]);
          }
        }}
      >
        {hidden ? 'Show in list' : 'Hide from list'}
      </button>
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
  readonly apply: Apply;
  readonly onApply: PanelProps['onApply'];
  readonly batch: BatchApply;
  /** Starts a batch of the profile over the repositories, or resumes the unfinished one when no profile is given. */
  readonly onBatch: (repositories: readonly string[], profile: ComparedProfile | undefined) => void;
}

interface TickedProps {
  readonly repositories: Repositories;
  /** Whether a batch is unfinished, which is resumed or discarded before another starts. */
  readonly unfinished: boolean;
  readonly profiles: Profiles;
  readonly onBatch: RepositoriesProps['onBatch'];
}

/** The panel for the ticked repositories: the profile to apply to them all, each reviewed on its own first. */
function TickedPanel({ repositories, profiles, unfinished, onBatch }: TickedProps): JSX.Element {
  const ticked = repositories.ticked.value;
  const listings = profiles.listings.value.filter((listing) => listing.problem === null);
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const profile = listings.find((listing) => listing.file === picked) ?? listings[0];
  const nameOf = (listing: (typeof listings)[number]): string => profiles.pathOf(listing).replace(/\.ya?ml$/u, '');
  return (
    <aside class="panel" aria-label="Ticked repositories">
      <h2>{ticked.length === 1 ? '1 repository ticked' : `${ticked.length} repositories ticked`}</h2>
      <ul class="muted small ticked-names">
        {ticked.map((repository) => (
          <li key={repository.full_name} class="mono">
            {repository.full_name}
          </li>
        ))}
      </ul>
      <form
        class="panel-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (profile !== undefined && !unfinished) {
            onBatch(
              ticked.map((repository) => repository.full_name),
              { file: profile.file, name: nameOf(profile), folder: profiles.folder.value },
            );
          }
        }}
      >
        {listings.length === 0 ? (
          <>
            <strong>Apply a profile to them</strong>
            <p class="muted small">Make a profile first, on the Profiles page.</p>
          </>
        ) : (
          <>
            <label for="batch-profile">Apply a profile to them</label>
            <select
              id="batch-profile"
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
            <button class="button button-primary" type="submit" disabled={unfinished}>
              Review apply
            </button>
            <p class="muted small">
              {unfinished
                ? 'A batch apply is not finished. Resume it, then apply or discard it, before starting another.'
                : 'Each repository is reviewed first, and one with an apply in progress joins as it is. Nothing is written until you apply.'}
            </p>
          </>
        )}
      </form>
      <div class="panel-actions">
        <button
          class="button button-quiet"
          type="button"
          onClick={() => {
            repositories.clearTicks();
          }}
        >
          Untick all
        </button>
        <button
          class="button button-quiet"
          type="button"
          onClick={() => {
            repositories.hide(ticked);
          }}
        >
          Hide from list
        </button>
      </div>
    </aside>
  );
}

export function RepositoriesPage({
  repositories,
  profiles,
  apply,
  batch,
  onCapture,
  onCompare,
  onApply,
  onBatch,
}: RepositoriesProps): JSX.Element {
  const ticked = repositories.ticked.value;
  // Whether a batch was left unfinished, which the browser keeps.
  const [unfinished, setUnfinished] = useState(false);
  const moved = batch.state.value.kind;
  useEffect(() => {
    let current = true;
    run(
      batch.unfinished().then((found) => {
        if (current) {
          setUnfinished(found);
        }
      }),
    );
    return () => {
      current = false;
    };
  }, [batch, moved]);
  const search = useSearchKey();
  const list = repositories.list.value;
  const loading = repositories.loading.value;
  const error = repositories.error.value;
  const groups = repositories.groups.value;
  const selected = repositories.selected.value;
  const justHidden = repositories.justHidden.value;
  const hiddenMatches = repositories.hiddenMatches.value;
  const preferencesError = repositories.preferences.error.value;
  const fromApp = list?.source === 'installations';
  const total = list?.repositories.length ?? 0;

  return (
    <div class={selected === undefined && ticked.length === 0 ? 'page' : 'page page-with-panel'}>
      <section class="page-body" aria-labelledby="repositories-heading">
        {unfinished && (
          <div class="notice notice-drift">
            <p>A batch apply is not finished.</p>
            <p class="notice-actions">
              <button
                class="button button-small"
                type="button"
                onClick={() => {
                  onBatch([], undefined);
                }}
              >
                Resume
              </button>
            </p>
          </div>
        )}
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
        {preferencesError !== undefined && (
          <p class="notice notice-problem" role="alert">
            {preferencesError}
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
              {(repositories.hiddenCount.value > 0 || repositories.showHidden.value) && (
                <div class="segments">
                  <label>
                    <input
                      type="checkbox"
                      checked={repositories.showHidden.value}
                      onChange={(event) => {
                        repositories.setShowHidden(event.currentTarget.checked);
                      }}
                    />
                    <span>
                      Show hidden <span class="muted count">{repositories.hiddenCount.value}</span>
                    </span>
                  </label>
                </div>
              )}
            </div>

            {justHidden.length > 0 && (
              <div class="notice" role="status">
                <p>
                  {justHidden.length === 1 ? (
                    <>
                      <span class="mono">{justHidden[0]}</span> is hidden from the list.
                    </>
                  ) : (
                    `${justHidden.length} repositories are hidden from the list.`
                  )}
                </p>
                <p class="notice-actions">
                  <button
                    class="button button-small"
                    type="button"
                    onClick={() => {
                      repositories.undoHide();
                    }}
                  >
                    Undo
                  </button>
                </p>
              </div>
            )}

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
            ) : repositories.everyRepositoryHidden.value ? (
              <div class="empty">
                <p>Every repository here is hidden.</p>
                <button
                  class="button"
                  type="button"
                  onClick={() => {
                    repositories.setShowHidden(true);
                  }}
                >
                  Show hidden
                </button>
              </div>
            ) : groups.length === 0 ? (
              <div class="empty">
                <p>
                  No repository matches "{repositories.search.value.trim()}".
                  {hiddenMatches > 0 &&
                    (hiddenMatches === 1 ? ' 1 hidden repository does.' : ` ${hiddenMatches} hidden repositories do.`)}
                </p>
                {hiddenMatches > 0 && (
                  <button
                    class="button"
                    type="button"
                    onClick={() => {
                      repositories.setShowHidden(true);
                    }}
                  >
                    Show hidden
                  </button>
                )}
              </div>
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
                        <li
                          key={repository.full_name}
                          class={repositories.isHidden(repository) ? 'ticked-row ticked-row-hidden' : 'ticked-row'}
                        >
                          <input
                            class="tick"
                            type="checkbox"
                            aria-label={`Tick ${repository.full_name}`}
                            checked={ticked.some((item) => item.full_name === repository.full_name)}
                            onChange={(event) => {
                              repositories.tick(repository, event.currentTarget.checked);
                            }}
                          />
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
                            {repositories.isHidden(repository) && <span class="pill">Hidden</span>}
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
      {ticked.length > 0 ? (
        <TickedPanel repositories={repositories} profiles={profiles} unfinished={unfinished} onBatch={onBatch} />
      ) : (
        selected !== undefined && (
          <RepositoryPanel
            repository={selected}
            repositories={repositories}
            profiles={profiles}
            apply={apply}
            onCapture={onCapture}
            onCompare={onCompare}
            onApply={onApply}
          />
        )
      )}
    </div>
  );
}
