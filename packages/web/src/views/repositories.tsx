import type { JSX, RefObject } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import type { Apply } from '../app/apply.js';
import type { BatchApply } from '../app/batch-apply.js';
import type { ComparedProfile } from '../app/comparison.js';
import { installUrl } from '../app/github-app.js';
import type { Profiles } from '../app/profiles.js';
import type { FolderGroup, Repositories, Repository } from '../app/repositories.js';
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

/** A dialog open over the list: naming a new folder or renaming one, or deleting one. */
type FolderDialog =
  | { readonly kind: 'new'; readonly repositories: readonly Repository[] }
  | { readonly kind: 'rename'; readonly name: string }
  | { readonly kind: 'delete'; readonly name: string };

/** The value of the folder pickers' choice that asks for a new folder. */
const newFolderChoice = '\u0000new';
/** The value of the folder pickers' choice that takes repositories out of every folder. */
const noFolderChoice = '';

/** Opens the dialog when it mounts, and calls `onClose` when it closes, by its buttons or Escape. */
function useModal(): RefObject<HTMLDialogElement | null> {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return dialog;
}

interface FolderNameProps {
  readonly repositories: Repositories;
  readonly dialog: Extract<FolderDialog, { kind: 'new' | 'rename' }>;
  /** Called when it closes, with the folder whose menu takes the focus after a rename, if any. */
  readonly onClose: (focus: string | undefined) => void;
}

/** Names a new folder, optionally with repositories to put in it, or renames one. */
function FolderNameDialog({ repositories, dialog: asked, onClose }: FolderNameProps): JSX.Element {
  const dialog = useModal();
  const renaming = asked.kind === 'rename' ? asked.name : undefined;
  const [name, setName] = useState(renaming ?? '');
  const [putIn, setPutIn] = useState(true);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const moving = asked.kind === 'new' ? asked.repositories : [];
  // The folder's name once renamed, since the menu that opened the dialog goes with its old name.
  const renamed = useRef<string | undefined>(undefined);
  return (
    <dialog
      class="dialog"
      ref={dialog}
      aria-labelledby="folder-name-heading"
      onClose={() => {
        onClose(renamed.current ?? renaming);
      }}
    >
      <form
        method="dialog"
        onSubmit={(event) => {
          if (event.submitter instanceof HTMLButtonElement && event.submitter.value === 'save') {
            const refused =
              renaming === undefined
                ? repositories.createFolder(name, putIn ? moving : [])
                : repositories.renameFolder(renaming, name);
            if (refused !== undefined) {
              event.preventDefault();
              setProblem(refused);
            } else if (renaming !== undefined) {
              renamed.current = name.trim();
            }
          }
        }}
      >
        <h2 id="folder-name-heading">{renaming === undefined ? 'New folder' : `Rename ${renaming}`}</h2>
        <div class="form-field">
          <label for="folder-name">Name</label>
          <input
            id="folder-name"
            class="field"
            value={name}
            autoComplete="off"
            aria-invalid={problem !== undefined}
            aria-describedby={problem === undefined ? undefined : 'folder-name-problem'}
            onInput={(event) => {
              setName(event.currentTarget.value);
              setProblem(undefined);
            }}
          />
          {problem !== undefined && (
            <p id="folder-name-problem" class="problem small" role="alert">
              {problem}
            </p>
          )}
        </div>
        {moving.length > 0 && (
          <label class="check">
            <input
              type="checkbox"
              checked={putIn}
              onChange={(event) => {
                setPutIn(event.currentTarget.checked);
              }}
            />
            {moving.length === 1
              ? `Put ${moving[0]?.full_name} in it`
              : `Put the ${moving.length} ticked repositories in it`}
          </label>
        )}
        <div class="form-actions">
          <button class="button button-primary" type="submit" value="save">
            {renaming === undefined ? 'Create folder' : 'Rename folder'}
          </button>
          <button class="button button-quiet" type="submit" value="cancel">
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}

/** Asks before a folder is deleted, saying its repositories stay as they are. */
function DeleteFolderDialog({
  repositories,
  name,
  onClose,
}: {
  readonly repositories: Repositories;
  readonly name: string;
  /** Called when it closes, with the folder whose menu takes the focus: none once it is deleted. */
  readonly onClose: (focus: string | undefined) => void;
}): JSX.Element {
  const dialog = useModal();
  return (
    <dialog
      class="dialog"
      ref={dialog}
      aria-labelledby="delete-folder-heading"
      onClose={() => {
        onClose(dialog.current?.returnValue === 'delete' ? undefined : name);
      }}
    >
      <form
        method="dialog"
        onSubmit={(event) => {
          if (event.submitter instanceof HTMLButtonElement && event.submitter.value === 'delete') {
            repositories.deleteFolder(name);
          }
        }}
      >
        <h2 id="delete-folder-heading">Delete {name}?</h2>
        <p>Its repositories go back to their owners in the list. Nothing changes on GitHub.</p>
        <div class="form-actions">
          <button class="button button-danger" type="submit" value="delete">
            Delete folder
          </button>
          {/* Cancel takes the focus, so Enter doesn't delete. */}
          <button class="button button-quiet" type="submit" value="cancel" autofocus>
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}

interface FolderPickerProps {
  readonly repositories: Repositories;
  readonly id: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}

/** The folders to pick from, with no folder and a new folder. */
function FolderPicker({ repositories, id, value, onChange }: FolderPickerProps): JSX.Element {
  return (
    <select
      id={id}
      class="field"
      value={value}
      onChange={(event) => {
        onChange(event.currentTarget.value);
      }}
    >
      <option value={noFolderChoice}>No folder</option>
      {repositories.folderNames.value.map((name) => (
        <option key={name} value={name}>
          {name}
        </option>
      ))}
      <option value={newFolderChoice}>New folder…</option>
    </select>
  );
}

function FolderMenu({
  name,
  onDialog,
}: {
  readonly name: string;
  readonly onDialog: (dialog: FolderDialog) => void;
}): JSX.Element {
  const menu = useDismiss();
  const pick = (dialog: FolderDialog): void => {
    if (menu.current !== null) {
      menu.current.open = false;
    }
    onDialog(dialog);
  };
  return (
    <details class="menu folder-menu" ref={menu}>
      <summary class="button button-quiet button-small" aria-label={`Edit ${name}`}>
        Edit
      </summary>
      <div class="menu-panel menu-panel-end">
        <button
          class="menu-item"
          type="button"
          onClick={() => {
            pick({ kind: 'rename', name });
          }}
        >
          Rename
        </button>
        <button
          class="menu-item"
          type="button"
          onClick={() => {
            pick({ kind: 'delete', name });
          }}
        >
          Delete folder
        </button>
      </div>
    </details>
  );
}

interface RowProps {
  readonly repository: Repository;
  readonly repositories: Repositories;
  /** Whether the row names the owner, as a folder's rows do, since a folder holds several owners'. */
  readonly withOwner: boolean;
}

function RepositoryRow({ repository, repositories, withOwner }: RowProps): JSX.Element {
  const selected = repositories.selected.value;
  const [owner = '', name = repository.full_name] = repository.full_name.split('/');
  const hidden = repositories.isHidden(repository);
  return (
    <li class={hidden ? 'ticked-row ticked-row-hidden' : 'ticked-row'}>
      <input
        class="tick"
        type="checkbox"
        aria-label={`Tick ${repository.full_name}`}
        checked={repositories.ticked.value.some((item) => item.full_name === repository.full_name)}
        onChange={(event) => {
          repositories.tick(repository, event.currentTarget.checked);
        }}
      />
      <button
        class="row"
        type="button"
        aria-pressed={selected?.full_name === repository.full_name}
        onClick={() => {
          repositories.select(selected?.full_name === repository.full_name ? undefined : repository);
        }}
      >
        <span class="row-name">
          <span class="mono">{name}</span>
          {withOwner && <span class="row-owner muted small">{owner}</span>}
        </span>
        {repository.archived && <span class="pill pill-drift">Archived</span>}
        {hidden && <span class="pill">Hidden</span>}
        <span class="muted small">{repository.private ? 'Private' : 'Public'}</span>
      </button>
    </li>
  );
}

function FolderSection({
  folder,
  repositories,
  onDialog,
}: {
  readonly folder: FolderGroup;
  readonly repositories: Repositories;
  readonly onDialog: (dialog: FolderDialog) => void;
}): JSX.Element {
  const searching = repositories.search.value.trim() !== '';
  const count = folder.repositories.length;
  return (
    <section class="folder" aria-label={folder.name}>
      <div class="folder-heading">
        <h2 class="folder-title">
          <button
            class="folder-toggle"
            type="button"
            aria-expanded={folder.open}
            disabled={searching}
            onClick={() => {
              repositories.setFolderOpen(folder.name, !folder.open);
            }}
          >
            <svg class="folder-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2.2h8.4A1.5 1.5 0 0 1 21 8.7v9.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z" />
            </svg>
            <span class="folder-name">{folder.name}</span>
            <span class="muted count">{count}</span>
          </button>
        </h2>
        <FolderMenu name={folder.name} onDialog={onDialog} />
      </div>
      {folder.open &&
        (folder.empty ? (
          <p class="empty-folder">
            Nothing in this folder yet. Tick repositories, then pick this folder under <strong>Move to a folder</strong>
            .
          </p>
        ) : (
          <ul class="rows">
            {folder.repositories.map((repository) => (
              <RepositoryRow key={repository.full_name} repository={repository} repositories={repositories} withOwner />
            ))}
          </ul>
        ))}
    </section>
  );
}

interface PanelProps {
  readonly repository: Repository;
  readonly repositories: Repositories;
  readonly onDialog: (dialog: FolderDialog) => void;
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
  onDialog,
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
      <div class="panel-form">
        <label for="repository-folder">Folder</label>
        <FolderPicker
          repositories={repositories}
          id="repository-folder"
          value={repositories.folderOf(repository) ?? noFolderChoice}
          onChange={(value) => {
            if (value === newFolderChoice) {
              onDialog({ kind: 'new', repositories: [repository] });
            } else {
              repositories.moveToFolder([repository], value === noFolderChoice ? undefined : value);
            }
          }}
        />
      </div>
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
  readonly onDialog: (dialog: FolderDialog) => void;
  /** Whether a batch is unfinished, which is resumed or discarded before another starts. */
  readonly unfinished: boolean;
  readonly profiles: Profiles;
  readonly onBatch: RepositoriesProps['onBatch'];
}

/** The panel for the ticked repositories: the profile to apply to them all, each reviewed on its own first. */
function TickedPanel({ repositories, onDialog, profiles, unfinished, onBatch }: TickedProps): JSX.Element {
  const ticked = repositories.ticked.value;
  const target = repositories.moveTarget.value;
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
          if (target.kind === 'new') {
            onDialog({ kind: 'new', repositories: ticked });
          } else {
            repositories.moveToFolder(ticked, target.kind === 'folder' ? target.name : undefined);
          }
        }}
      >
        <label for="move-folder">Move to a folder</label>
        <FolderPicker
          repositories={repositories}
          id="move-folder"
          value={target.kind === 'folder' ? target.name : target.kind === 'new' ? newFolderChoice : noFolderChoice}
          onChange={(value) => {
            repositories.pickMoveTarget(
              value === newFolderChoice
                ? { kind: 'new' }
                : value === noFolderChoice
                  ? { kind: 'none' }
                  : { kind: 'folder', name: value },
            );
          }}
        />
        <button class="button" type="submit">
          {target.kind === 'new' ? 'New folder' : 'Move'}
        </button>
      </form>
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
  const folders = repositories.folders.value;
  const selected = repositories.selected.value;
  const justHidden = repositories.justHidden.value;
  const hiddenMatches = repositories.hiddenMatches.value;
  const preferencesError = repositories.preferences.error.value;
  // A hide takes away the button that did it, unless hidden ones show, so focus moves to Undo, which also
  // brings it into view on a phone.
  const undo = useRef<HTMLButtonElement>(null);
  const showingHidden = repositories.showHidden.value;
  useEffect(() => {
    if (justHidden.length > 0 && !showingHidden) {
      undo.current?.focus();
    }
  }, [justHidden, showingHidden]);
  const [dialog, setDialog] = useState<FolderDialog | undefined>(undefined);
  const newFolderButton = useRef<HTMLButtonElement>(null);
  /**
   * After a rename or delete the menu that opened the dialog is gone, so the
   * focus goes to the folder's menu under its name now, or to New folder
   * once it is deleted. After a new folder the browser puts it back itself.
   */
  const closeDialog = (focus: string | undefined): void => {
    const opened = dialog?.kind;
    setDialog(undefined);
    if (opened === 'new') {
      return;
    }
    requestAnimationFrame(() => {
      const menu = [...document.querySelectorAll<HTMLElement>('section.folder')]
        .find((section) => focus !== undefined && section.getAttribute('aria-label') === focus)
        ?.querySelector<HTMLElement>('.folder-menu > summary');
      (menu ?? newFolderButton.current)?.focus();
    });
  };
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
              <button
                ref={newFolderButton}
                class="button button-quiet"
                type="button"
                onClick={() => {
                  setDialog({ kind: 'new', repositories: ticked });
                }}
              >
                New folder
              </button>
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
                    ref={undo}
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
            ) : groups.length === 0 && folders.length === 0 ? (
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
                {folders.map((folder) => (
                  <FolderSection key={folder.name} folder={folder} repositories={repositories} onDialog={setDialog} />
                ))}
                {folders.length > 0 && groups.length > 0 && <p class="section-label">Not in a folder</p>}
                {groups.map((group) => (
                  <section key={group.owner} aria-label={group.owner}>
                    <h2 class="group-heading">
                      <span>{group.owner}</span>
                      {group.personal && <span class="pill">You</span>}
                      <span class="muted count">{group.repositories.length}</span>
                    </h2>
                    <ul class="rows">
                      {group.repositories.map((repository) => (
                        <RepositoryRow
                          key={repository.full_name}
                          repository={repository}
                          repositories={repositories}
                          withOwner={false}
                        />
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
        <TickedPanel
          repositories={repositories}
          onDialog={setDialog}
          profiles={profiles}
          unfinished={unfinished}
          onBatch={onBatch}
        />
      ) : (
        selected !== undefined && (
          <RepositoryPanel
            repository={selected}
            repositories={repositories}
            onDialog={setDialog}
            profiles={profiles}
            apply={apply}
            onCapture={onCapture}
            onCompare={onCompare}
            onApply={onApply}
          />
        )
      )}
      {dialog?.kind === 'delete' ? (
        <DeleteFolderDialog repositories={repositories} name={dialog.name} onClose={closeDialog} />
      ) : (
        dialog !== undefined && <FolderNameDialog repositories={repositories} dialog={dialog} onClose={closeDialog} />
      )}
    </div>
  );
}
