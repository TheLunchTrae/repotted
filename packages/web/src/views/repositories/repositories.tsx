import { type InstallationMissingPermissions, permissionsInProse } from '@repotted/core';
import type { JSX, RefObject } from 'preact';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks';

import { repottedAppInstallUrl } from '../../app/account/github-app.js';
import type { ComparedProfile } from '../../app/apply/comparison.js';
import type { AddressedRepository } from '../../app/navigation/addressed-repository.js';
import type { Profiles } from '../../app/profiles/profiles.js';
import {
  type FolderGroup,
  refreshPause,
  type Repositories,
  type Repository,
} from '../../app/repositories/repositories.js';
import type { RepositoryProfiles } from '../../app/repositories/repository-profiles.js';
import {
  archivedFilters,
  archivedLabels,
  type FilterChip,
  pushedLabel,
  sortOrderLabels,
  sortOrders,
  visibilityFilters,
  visibilityLabels,
} from '../../app/repositories/sort-and-filters.js';
import { Loading, LoadingList } from '../layout/loading.js';
import { useMenuPanelKeptOnPage } from '../layout/menu-placement.js';
import { useNotifications } from '../layout/notifications.js';
import { usePhone } from '../layout/phone.js';
import { run } from '../layout/run.js';
import { useDismissibleMenu, useModal } from '../layout/shell.js';
import { FolderSettingsDialog } from './folder-settings.js';
import { EditProfilesDialog, PanelProfiles, RowProfileTags } from './repository-profiles.js';

function OwnerFilter({ repositories }: { readonly repositories: Repositories }): JSX.Element {
  const menu = useDismissibleMenu();
  useMenuPanelKeptOnPage(menu);
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

function FilterChoices<Choice extends string>({
  legend,
  name,
  choices,
  labels,
  value,
  onChange,
}: {
  readonly legend: string;
  readonly name: string;
  readonly choices: readonly Choice[];
  readonly labels: Readonly<Record<Choice, string>>;
  readonly value: Choice;
  readonly onChange: (choice: Choice) => void;
}): JSX.Element {
  return (
    <fieldset class="filter-choices">
      <legend>{legend}</legend>
      <div class="segments">
        {choices.map((choice) => (
          <label key={choice}>
            <input
              type="radio"
              name={name}
              checked={value === choice}
              onChange={() => {
                onChange(choice);
              }}
            />
            <span>{labels[choice]}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function FilterMenu({ repositories }: { readonly repositories: Repositories }): JSX.Element {
  const menu = useDismissibleMenu();
  useMenuPanelKeptOnPage(menu);
  const filters = repositories.filters.value;
  const topics = repositories.topicChoices.value;
  const count = repositories.filterCount.value;
  return (
    <details class="menu" ref={menu}>
      <summary class="button button-quiet" aria-label={count > 0 ? `Filter, ${count} on` : 'Filter'}>
        Filter
        {count > 0 && (
          <span class="pill filter-count" aria-hidden="true">
            {count}
          </span>
        )}
      </summary>
      <div class="menu-panel filter-panel">
        <FilterChoices
          legend="Visibility"
          name="filter-visibility"
          choices={visibilityFilters}
          labels={visibilityLabels}
          value={filters.visibility}
          onChange={(visibility) => {
            repositories.setVisibilityFilter(visibility);
          }}
        />
        <FilterChoices
          legend="Archived"
          name="filter-archived"
          choices={archivedFilters}
          labels={archivedLabels}
          value={filters.archived}
          onChange={(archived) => {
            repositories.setArchivedFilter(archived);
          }}
        />
        <fieldset class="owner-choices filter-topics">
          <legend>Has any of these topics</legend>
          {topics.length === 0 && <p class="muted small filter-none">No repository here has topics.</p>}
          {topics.map((choice) => (
            <label key={choice.topic}>
              <input
                type="checkbox"
                checked={choice.chosen}
                onChange={(event) => {
                  repositories.setTopicChosen(choice.topic, event.currentTarget.checked);
                }}
              />
              <span class="owner-name mono">{choice.topic}</span>
              <span class="muted count">{choice.count}</span>
            </label>
          ))}
        </fieldset>
        <div class="menu-actions">
          <button
            class="button button-quiet"
            type="button"
            disabled={count === 0}
            onClick={() => {
              repositories.clearFilters();
              requestAnimationFrame(() => {
                menu.current?.querySelector<HTMLElement>('.menu-panel input:checked')?.focus();
              });
            }}
          >
            Clear filters
          </button>
        </div>
      </div>
    </details>
  );
}

function SortMenu({ repositories }: { readonly repositories: Repositories }): JSX.Element {
  const menu = useDismissibleMenu();
  useMenuPanelKeptOnPage(menu);
  const order = repositories.sortOrder.value;
  return (
    <details class="menu" ref={menu}>
      <summary class="button button-quiet">
        Sort: <span class="sort-order">{sortOrderLabels[order]}</span>
      </summary>
      <div class="menu-panel">
        <fieldset class="owner-choices">
          <legend>Sort repositories by</legend>
          {sortOrders.map((choice) => (
            <label key={choice}>
              <input
                type="radio"
                name="sort-order"
                checked={order === choice}
                onChange={() => {
                  repositories.setSortOrder(choice);
                }}
              />
              <span class="owner-name">{sortOrderLabels[choice]}</span>
            </label>
          ))}
        </fieldset>
      </div>
    </details>
  );
}

function removeChip(repositories: Repositories, chip: FilterChip): void {
  switch (chip.kind) {
    case 'visibility':
      repositories.setVisibilityFilter('any');
      return;
    case 'archived':
      repositories.setArchivedFilter('any');
      return;
    case 'topic':
      repositories.setTopicChosen(chip.topic, false);
  }
}

function chipRemovalLabel(chip: FilterChip): string {
  return chip.kind === 'topic'
    ? `Remove the topic filter ${chip.topic}`
    : `Remove the ${chip.label.toLowerCase()} filter`;
}

/** Removing a chip takes it away, so the focus moves to the chip now in its place, the one before it, or the search. */
function FilterChips({
  repositories,
  search,
}: {
  readonly repositories: Repositories;
  readonly search: RefObject<HTMLInputElement | null>;
}): JSX.Element | null {
  const chips = repositories.filterChips.value;
  const list = useRef<HTMLDivElement>(null);
  if (chips.length === 0) {
    return null;
  }
  const focusAfterRemoving = (index: number): void => {
    requestAnimationFrame(() => {
      const left = list.current?.querySelectorAll<HTMLElement>('.filter-chip');
      (left?.[Math.min(index, left.length - 1)] ?? search.current)?.focus();
    });
  };
  return (
    <div class="filter-chips" ref={list} role="group" aria-label="Filters on">
      {chips.map((chip, index) => (
        <button
          key={chip.kind === 'topic' ? `topic:${chip.topic}` : chip.kind}
          class="pill filter-chip"
          type="button"
          aria-label={chipRemovalLabel(chip)}
          onClick={() => {
            removeChip(repositories, chip);
            focusAfterRemoving(index);
          }}
        >
          {chip.label}
          <span aria-hidden="true">×</span>
        </button>
      ))}
      <button
        class="button button-quiet button-small"
        type="button"
        onClick={() => {
          repositories.clearFilters();
          requestAnimationFrame(() => {
            search.current?.focus();
          });
        }}
      >
        Clear filters
      </button>
    </div>
  );
}

type FolderDialog =
  | {
      readonly kind: 'new';
      readonly repositories: readonly Repository[];
      readonly isTheSelection: boolean;
    }
  | { readonly kind: 'rename'; readonly name: string }
  | { readonly kind: 'settings'; readonly name: string }
  | { readonly kind: 'delete'; readonly name: string };

const newFolderChoice = '\u0000new';
const noFolderChoice = '';

function countdown(seconds: number): string {
  return seconds < 60 ? `${seconds}s` : `${Math.ceil(seconds / 60)} min`;
}

/**
 * It stays focusable while off, so the focus a press gave it isn't lost. The
 * countdown isn't part of its name, so a screen reader isn't told each second;
 * its description says why it waits, once.
 */
function RefreshButton({ repositories }: { readonly repositories: Repositories }): JSX.Element {
  const notifications = useNotifications();
  const wait = repositories.refreshWait.value;
  const off = repositories.loading.value || wait !== undefined;
  const why = useId();
  return (
    <>
      <button
        class="button refresh"
        type="button"
        aria-disabled={off ? 'true' : undefined}
        aria-describedby={wait === undefined ? undefined : why}
        onClick={() => {
          if (!off) {
            run(
              repositories.refresh().then(() => {
                if (repositories.error.value === undefined) {
                  notifications?.show({ message: 'Repositories refreshed.' });
                }
              }),
            );
          }
        }}
      >
        Refresh
        {wait !== undefined && (
          <span class="refresh-countdown" aria-hidden="true">
            &nbsp;in {countdown(repositories.secondsUntilRefreshCanRun.value)}
          </span>
        )}
      </button>
      {wait !== undefined && (
        <span id={why} class="visually-hidden">
          {wait.rateLimited
            ? `GitHub's rate limit holds the next refresh until ${wait.until.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`
            : `Refresh waits ${refreshPause / 1000} seconds between reads.`}
        </span>
      )}
    </>
  );
}

function MissingPermissionsNotice({
  installation,
}: {
  readonly installation: InstallationMissingPermissions;
}): JSX.Element {
  const { owner, permissions, settings_url: settingsUrl } = installation;
  const them = permissions.length === 1 ? 'it' : 'them';
  return (
    <div class="notice notice-drift" role="status">
      <p>
        <strong>
          The Repotted App on {owner} doesn't have the {permissionsInProse(permissions)} yet.
        </strong>{' '}
        Until an owner of {owner} accepts {them}, Repotted can't read or change what needs {them} on its repositories,
        and turns those settings off while you edit an apply.
      </p>
      {settingsUrl !== null && (
        <p class="notice-actions">
          <a class="button button-small" href={settingsUrl} target="_blank" rel="noreferrer">
            Review on GitHub
          </a>
        </p>
      )}
    </div>
  );
}

interface FolderNameProps {
  readonly repositories: Repositories;
  readonly dialog: Extract<FolderDialog, { kind: 'new' | 'rename' }>;
  readonly onClose: (folderToFocus: string | undefined) => void;
}

function FolderNameDialog({ repositories, dialog: asked, onClose }: FolderNameProps): JSX.Element {
  const dialog = useModal();
  const renaming = asked.kind === 'rename' ? asked.name : undefined;
  const [name, setName] = useState(renaming ?? '');
  const [putIn, setPutIn] = useState(true);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const moving = asked.kind === 'new' ? asked.repositories : [];
  const fromSelected = asked.kind === 'new' && asked.isTheSelection && moving.length > 0;
  // The folder's name once renamed, since the menu that opened the dialog goes with its old name, or once
  // made with the selected repositories in it, since the selection's panel goes when they are deselected.
  const landed = useRef<string | undefined>(undefined);
  return (
    <dialog
      class="dialog"
      ref={dialog}
      aria-labelledby="folder-name-heading"
      onClose={() => {
        onClose(landed.current ?? renaming);
      }}
    >
      <form
        method="dialog"
        onSubmit={(event) => {
          if (event.submitter instanceof HTMLButtonElement && event.submitter.value === 'save') {
            const refused =
              renaming === undefined
                ? repositories.createFolder(name, putIn ? moving : [], { deselect: fromSelected })
                : repositories.renameFolder(renaming, name);
            if (refused !== undefined) {
              event.preventDefault();
              setProblem(refused);
            } else if (renaming !== undefined || (putIn && fromSelected)) {
              landed.current = name.trim();
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
              : `Put the ${moving.length} selected repositories in it`}
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

function DeleteFolderDialog({
  repositories,
  name,
  onClose,
}: {
  readonly repositories: Repositories;
  readonly name: string;
  readonly onClose: (folderToFocus: string | undefined) => void;
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
  readonly value: string | undefined;
  readonly onChange: (value: string) => void;
}

const unchosen = '\u0000unchosen';

function FolderPicker({ repositories, id, value, onChange }: FolderPickerProps): JSX.Element {
  return (
    <select
      id={id}
      class="field"
      value={value ?? unchosen}
      onChange={(event) => {
        onChange(event.currentTarget.value);
      }}
    >
      {value === undefined && (
        <option value={unchosen} disabled>
          Choose a folder
        </option>
      )}
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
  const menu = useDismissibleMenu();
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
            pick({ kind: 'settings', name });
          }}
        >
          Settings
        </button>
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
  readonly assignments: RepositoryProfiles;
  readonly phone: boolean;
  readonly withOwner: boolean;
}

function RepositoryRow({ repository, repositories, assignments, phone, withOwner }: RowProps): JSX.Element {
  const opened = repositories.opened.value;
  const [owner = '', name = repository.full_name] = repository.full_name.split('/');
  const hidden = repositories.isHidden(repository);
  const order = repositories.sortOrder.value;
  const byPush = order === 'pushed-newest' || order === 'pushed-oldest';
  return (
    <li class={hidden ? 'selectable-row selectable-row-hidden' : 'selectable-row'}>
      <input
        class="select-box"
        type="checkbox"
        aria-label={`Select ${repository.full_name}`}
        checked={repositories.isSelected(repository)}
        onChange={(event) => {
          repositories.select(repository, event.currentTarget.checked);
        }}
      />
      <button
        class="row"
        type="button"
        data-repository={repository.full_name}
        aria-pressed={opened?.full_name === repository.full_name}
        onClick={() => {
          repositories.open(opened?.full_name === repository.full_name ? undefined : repository);
        }}
      >
        <span class="row-name">
          <span class="mono">{name}</span>
          {withOwner && <span class="row-owner muted small">{owner}</span>}
          {byPush && (
            <span
              class="row-pushed muted small"
              title={repository.pushed_at === null ? undefined : new Date(repository.pushed_at).toLocaleString()}
            >
              {pushedLabel(repository.pushed_at, Date.now())}
            </span>
          )}
        </span>
        <RowProfileTags repository={repository} assignments={assignments} phone={phone} />
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
  assignments,
  phone,
  onDialog,
}: {
  readonly folder: FolderGroup;
  readonly repositories: Repositories;
  readonly assignments: RepositoryProfiles;
  readonly phone: boolean;
  readonly onDialog: (dialog: FolderDialog) => void;
}): JSX.Element {
  const searching = repositories.search.value.trim() !== '';
  const count = folder.repositories.length;
  const everyShownRepositorySelected =
    count > 0 && folder.repositories.every((repository) => repositories.isSelected(repository));
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
        {folder.open && count > 0 && (
          <button
            class="button button-quiet button-small folder-select"
            type="button"
            aria-label={`${everyShownRepositorySelected ? 'Deselect all in' : 'Select all in'} ${folder.name}`}
            onClick={() => {
              repositories.selectEach(folder.repositories, !everyShownRepositorySelected);
            }}
          >
            {everyShownRepositorySelected ? 'Deselect all' : 'Select all'}
          </button>
        )}
        <FolderMenu name={folder.name} onDialog={onDialog} />
      </div>
      {folder.open &&
        (folder.holdsNoListedRepository ? (
          <p class="empty-folder">
            Nothing in this folder yet. Select repositories, then pick this folder under{' '}
            <strong>Move to a folder</strong>.
          </p>
        ) : (
          <ul class="rows repository-rows">
            {folder.repositories.map((repository) => (
              <RepositoryRow
                key={repository.full_name}
                repository={repository}
                repositories={repositories}
                assignments={assignments}
                phone={phone}
                withOwner
              />
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
  /** With `once`, starts an apply that changes settings without a profile. */
  readonly onApply: (repository: string, profile: ComparedProfile | 'once') => void;
  readonly onApplyProfiles: (repository: string, profiles: readonly ComparedProfile[]) => void;
  readonly assignments: RepositoryProfiles;
  /** Goes back to the list, given when the panel is a screen of its own, as on a phone. */
  readonly onBack?: (() => void) | undefined;
}

function RepositoryPanel({
  repository,
  repositories,
  onDialog,
  profiles,
  onCapture,
  onCompare,
  onApply,
  onApplyProfiles,
  assignments,
  onBack,
}: PanelProps): JSX.Element {
  const [editingProfiles, setEditingProfiles] = useState(false);
  const usesProfiles =
    assignments.profilesOf(repository.full_name).length > 0 ||
    assignments.authoritativeOf(repository.full_name).length > 0;
  const listings = profiles.listings.value.filter((listing) => listing.problem === null);
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const profile = listings.find((listing) => listing.file === picked) ?? listings[0];
  const nameOf = (listing: (typeof listings)[number]): string => profiles.pathOf(listing).replace(/\.ya?ml$/u, '');
  const [owner, name] = repository.full_name.split('/');
  const hidden = repositories.isHidden(repository);
  const back = useRef<HTMLButtonElement>(null);
  const screen = onBack !== undefined;
  // A screen of its own takes the focus to the way back, since the row that opened it is gone. One opened by a
  // link as the page loads leaves the focus at the start of the page, before the navigation.
  useLayoutEffect(() => {
    // Safari before 16.4 has no record of activation; treat it as active.
    if (screen && ((navigator as { userActivation?: UserActivation }).userActivation?.hasBeenActive ?? true)) {
      back.current?.focus({ preventScroll: true });
    }
  }, [screen, repository.full_name]);
  return (
    <aside class="panel" aria-label={repository.full_name}>
      {onBack !== undefined && (
        <button ref={back} class="panel-back" type="button" aria-label="Back to repositories" onClick={onBack}>
          Repositories
        </button>
      )}
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
              onDialog({ kind: 'new', repositories: [repository], isTheSelection: false });
            } else {
              repositories.moveToFolder([repository], value === noFolderChoice ? undefined : value);
            }
          }}
        />
      </div>
      <PanelProfiles
        repository={repository}
        assignments={assignments}
        folder={profiles.folder.value}
        onApplyProfiles={onApplyProfiles}
        onEdit={() => {
          setEditingProfiles(true);
        }}
      />
      {editingProfiles && (
        <EditProfilesDialog
          repository={repository}
          assignments={assignments}
          profiles={profiles}
          onClose={() => {
            setEditingProfiles(false);
          }}
        />
      )}
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
      <button
        class="button"
        type="button"
        onClick={() => {
          onApply(repository.full_name, 'once');
        }}
      >
        Change settings once
      </button>
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
            <strong>{usesProfiles ? 'Compare with another profile' : 'Compare with a profile'}</strong>
            <p class="muted small">Make a profile first, on the Profiles page.</p>
          </>
        ) : (
          <>
            <label for="compare-profile">
              {usesProfiles ? 'Compare with another profile' : 'Compare with a profile'}
            </label>
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

function useSlashKeyToFocusSearch(): RefObject<HTMLInputElement | null> {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const focus = (event: KeyboardEvent): void => {
      const typing = event.target instanceof HTMLElement && event.target.matches('input, textarea, select');
      // Without a search on the page, the key stays the browser's.
      // Nor while the search is out of view, as behind a repository's details on a phone.
      const shown = input.current !== null && input.current.getClientRects().length > 0;
      if (event.key === '/' && !typing && !event.ctrlKey && !event.metaKey && !event.altKey && shown) {
        event.preventDefault();
        input.current?.focus();
      }
    };
    document.addEventListener('keydown', focus);
    return () => {
      document.removeEventListener('keydown', focus);
    };
  }, []);
  return input;
}

/**
 * Keeps the opened repository and the page's address together, as `AddressedRepository`
 * says. Returns whether a phone is arriving at the list, with no repository
 * named, which drops the repository kept open from before before the page paints.
 */
function useAddressedRepository(address: AddressedRepository, repositories: Repositories, phone: boolean): boolean {
  const named = address.named;
  const name = repositories.openedName;
  const shown = repositories.opened.value?.full_name;
  const listed = repositories.list.value !== undefined;
  const arrived = useRef(false);
  // Before the page paints, so a phone arriving at the list doesn't show a kept repository's screen first.
  useLayoutEffect(() => {
    if (arrived.current) {
      address.follow(phone);
    } else {
      arrived.current = true;
      address.arrive(phone);
    }
    // The screen's width is read as the address changes; a change of width alone moves no address.
  }, [address, named]);
  useLayoutEffect(() => {
    address.update(phone);
  }, [address, phone, name, shown, listed]);
  return phone && !arrived.current && named === undefined;
}

/**
 * On a phone, a repository's details open at their top, and the list comes
 * back from them where it was left, with the focus on the row that opened them, or on the page's heading
 * when that row is out of view.
 */
function useListReturn(
  details: boolean,
  phone: boolean,
  name: string | undefined,
): RefObject<HTMLHeadingElement | null> {
  const heading = useRef<HTMLHeadingElement>(null);
  const scrolled = useRef(0);
  const closed = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (details) {
      closed.current = name;
      scrollTo(0, 0);
      return undefined;
    }
    if (closed.current !== undefined) {
      const row = document.querySelector<HTMLElement>(`button.row[data-repository="${CSS.escape(closed.current)}"]`);
      // Only focus that went with the details moves; one left elsewhere, as on the link that came here, stays.
      const lost = document.activeElement === null || document.activeElement === document.body;
      if (phone && row !== null) {
        const y = scrolled.current;
        scrollTo(0, y);
        // Again once a back has run its course, since the browser puts back the scroll it kept for the entry,
        // which it took after the details had opened.
        requestAnimationFrame(() => {
          scrollTo(0, y);
        });
        if (lost) {
          row.focus({ preventScroll: true });
        }
      } else if (phone) {
        // With the row out of the list, as after a hide or a move into a closed folder, the list stays at its
        // top, and the heading, or Undo after it, takes the focus where it is.
        if (lost) {
          heading.current?.focus();
        }
      } else if (lost) {
        // Details that close because the screen grew stay beside the list, which wasn't left.
        row?.focus();
      }
    }
    closed.current = undefined;
    // Kept as it changes, since opening the details takes the list out of the page and the scroll with it.
    const keep = (): void => {
      scrolled.current = scrollY;
    };
    addEventListener('scroll', keep, { passive: true });
    return () => {
      removeEventListener('scroll', keep);
    };
  }, [details, phone, name]);
  return heading;
}

interface RepositoriesProps {
  readonly repositories: Repositories;
  readonly address: AddressedRepository;
  readonly profiles: Profiles;
  readonly onCapture: (repository: string) => void;
  readonly onCompare: PanelProps['onCompare'];
  readonly onApply: PanelProps['onApply'];
  readonly onApplyProfiles: PanelProps['onApplyProfiles'];
  readonly assignments: RepositoryProfiles;
  readonly onBatch: (repositories: readonly string[], profile: ComparedProfile) => void;
}

interface SelectedProps {
  readonly repositories: Repositories;
  readonly onDialog: (dialog: FolderDialog) => void;
  readonly profiles: Profiles;
  readonly onBatch: RepositoriesProps['onBatch'];
  readonly onMoved: (folder: string | undefined) => void;
  readonly onDeselectAll: () => void;
}

function SelectedPanel({
  repositories,
  onDialog,
  profiles,
  onBatch,
  onMoved,
  onDeselectAll,
}: SelectedProps): JSX.Element {
  const selected = repositories.selected.value;
  const target = repositories.moveTarget.value;
  const listings = profiles.listings.value.filter((listing) => listing.problem === null);
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const profile = listings.find((listing) => listing.file === picked) ?? listings[0];
  const nameOf = (listing: (typeof listings)[number]): string => profiles.pathOf(listing).replace(/\.ya?ml$/u, '');
  return (
    <aside class="panel" aria-label="Selected repositories">
      <h2>{selected.length === 1 ? '1 repository selected' : `${selected.length} repositories selected`}</h2>
      <ul class="muted small selected-names">
        {selected.map((repository) => (
          <li key={repository.full_name} class="mono">
            {repository.full_name}
          </li>
        ))}
      </ul>
      <form
        class="panel-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (target === undefined) {
            return;
          }
          if (target.kind === 'new') {
            onDialog({ kind: 'new', repositories: selected, isTheSelection: true });
          } else {
            const folder = target.kind === 'folder' ? target.name : undefined;
            repositories.moveToFolder(selected, folder, { deselect: true });
            onMoved(folder);
          }
        }}
      >
        <label for="move-folder">Move to a folder</label>
        <div class="move-row">
          <FolderPicker
            repositories={repositories}
            id="move-folder"
            value={
              target === undefined
                ? undefined
                : target.kind === 'folder'
                  ? target.name
                  : target.kind === 'new'
                    ? newFolderChoice
                    : noFolderChoice
            }
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
          <button class="button" type="submit" disabled={target === undefined}>
            {target?.kind === 'new' ? 'New folder' : 'Move'}
          </button>
        </div>
      </form>
      <form
        class="panel-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (profile !== undefined) {
            onBatch(
              selected.map((repository) => repository.full_name),
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
            <button class="button button-primary" type="submit">
              Review apply
            </button>
            <p class="muted small">Each repository is reviewed first. Nothing is written until you apply.</p>
          </>
        )}
      </form>
      <div class="panel-actions">
        <button class="button button-quiet" type="button" onClick={onDeselectAll}>
          Deselect all
        </button>
        <button
          class="button button-quiet"
          type="button"
          onClick={() => {
            repositories.hide(selected);
          }}
        >
          Hide from list
        </button>
      </div>
    </aside>
  );
}

function noMatch(search: string, filtering: boolean): string {
  if (!filtering) {
    return `No repository matches "${search}".`;
  }
  return search === ''
    ? 'No repository matches these filters.'
    : `No repository matches "${search}" and these filters.`;
}

export function RepositoriesPage({
  repositories,
  address,
  profiles,
  onCapture,
  onCompare,
  onApply,
  onApplyProfiles,
  assignments,
  onBatch,
}: RepositoriesProps): JSX.Element {
  const selected = repositories.selected.value;
  const search = useSlashKeyToFocusSearch();
  const list = repositories.list.value;
  const loading = repositories.loading.value;
  const error = repositories.error.value;
  const groups = repositories.groups.value;
  const folders = repositories.folders.value;
  const opened = repositories.opened.value;
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
   * Puts the focus in a folder once the page has drawn it: on its heading
   * when `on` is the toggle and it can be pressed, otherwise on its menu, or
   * on New folder when there is no such folder.
   */
  const focusFolder = (name: string | undefined, on: 'toggle' | 'menu'): void => {
    requestAnimationFrame(() => {
      const section = [...document.querySelectorAll<HTMLElement>('section.folder')].find(
        (found) => name !== undefined && found.getAttribute('aria-label')?.toLowerCase() === name.toLowerCase(),
      );
      const toggle = on === 'toggle' ? section?.querySelector<HTMLElement>('.folder-toggle:not(:disabled)') : null;
      (toggle ?? section?.querySelector<HTMLElement>('.folder-menu > summary') ?? newFolderButton.current)?.focus();
    });
  };
  // The buttons that deselect go with the selection, so the focus moves to New folder.
  const deselectAll = (): void => {
    repositories.deselectAll();
    requestAnimationFrame(() => {
      newFolderButton.current?.focus();
    });
  };
  /**
   * After a rename or delete the menu that opened the dialog is gone, so the
   * focus goes to the folder's menu under its name now, or to New folder
   * once it is deleted. A new folder made with the selected repositories takes
   * the focus, since deselecting them closes the selection's panel; otherwise the
   * browser puts the focus back itself.
   */
  const closeDialog = (focus: string | undefined): void => {
    const opened = dialog?.kind;
    setDialog(undefined);
    if (opened === 'new') {
      if (focus !== undefined) {
        focusFolder(focus, 'toggle');
      }
      return;
    }
    focusFolder(focus, 'menu');
  };
  const fromApp = list?.source === 'installations';
  const total = list?.repositories.length ?? 0;
  // On a phone a repository's details take the place of the list, unless selected ones take the panel, as they do
  // beside the list.
  const phone = usePhone();
  // On a phone the details are a screen of their own, which leaves any selected repositories with the list.
  const toList = useAddressedRepository(address, repositories, phone);
  const details = phone && opened !== undefined && !toList;
  const heading = useListReturn(details, phone, opened?.full_name);

  return (
    <div
      class={
        details ? 'page page-details' : opened === undefined && selected.length === 0 ? 'page' : 'page page-with-panel'
      }
    >
      <section class="page-body" aria-labelledby="repositories-heading">
        <div class="page-heading">
          <div>
            <h1 id="repositories-heading" ref={heading} tabIndex={-1}>
              Repositories
            </h1>
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
              <a class="button" href={repottedAppInstallUrl} target="_blank" rel="noreferrer">
                Add repositories
              </a>
            )}
            <RefreshButton repositories={repositories} />
          </div>
        </div>

        {repositories.installationsMissingPermissions.value.map((installation) => (
          <MissingPermissionsNotice key={installation.owner} installation={installation} />
        ))}
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
        {list === undefined && loading && <LoadingList>Reading your repositories…</LoadingList>}

        {list !== undefined && loading && <Loading>Refreshing your repositories…</Loading>}
        {list !== undefined && total === 0 && (
          <div class="empty">
            <h2>No repositories yet</h2>
            <p>
              {fromApp
                ? 'The Repotted App is not installed on any repositories you administer yet.'
                : 'Your account administers no repositories.'}
            </p>
            {fromApp && (
              <a class="button button-primary" href={repottedAppInstallUrl} target="_blank" rel="noreferrer">
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
              <FilterMenu repositories={repositories} />
              <SortMenu repositories={repositories} />
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
                  setDialog({ kind: 'new', repositories: selected, isTheSelection: true });
                }}
              >
                New folder
              </button>
              {selected.length > 0 && (
                <button class="button button-quiet" type="button" onClick={deselectAll}>
                  Deselect all
                </button>
              )}
            </div>

            <FilterChips repositories={repositories} search={search} />

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
                <h2>Every owner is hidden</h2>
                <p>Show the owners again to see their repositories.</p>
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
                <h2>Every repository here is hidden</h2>
                <p>Show hidden repositories to find them.</p>
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
                <h2>No repositories found</h2>
                <p>
                  {noMatch(repositories.search.value.trim(), repositories.filtering.value)}
                  {hiddenMatches > 0 &&
                    (hiddenMatches === 1 ? ' 1 hidden repository does.' : ` ${hiddenMatches} hidden repositories do.`)}
                </p>
                {repositories.search.value.trim() !== '' && (
                  <button
                    class="button"
                    type="button"
                    onClick={() => {
                      repositories.search.value = '';
                      search.current?.focus();
                    }}
                  >
                    Clear search
                  </button>
                )}
                {repositories.filtering.value && (
                  <button
                    class="button"
                    type="button"
                    onClick={() => {
                      repositories.clearFilters();
                      requestAnimationFrame(() => {
                        search.current?.focus();
                      });
                    }}
                  >
                    Clear filters
                  </button>
                )}
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
                  <FolderSection
                    key={folder.name}
                    folder={folder}
                    repositories={repositories}
                    assignments={assignments}
                    phone={phone}
                    onDialog={setDialog}
                  />
                ))}
                {folders.length > 0 && groups.length > 0 && <p class="section-label">Not in a folder</p>}
                {groups.map((group) => (
                  <section key={group.owner} aria-label={group.owner}>
                    <h2 class="group-heading">
                      <span>{group.owner}</span>
                      {group.personal && <span class="pill">You</span>}
                      <span class="muted count">{group.repositories.length}</span>
                    </h2>
                    <ul class="rows repository-rows">
                      {group.repositories.map((repository) => (
                        <RepositoryRow
                          key={repository.full_name}
                          repository={repository}
                          repositories={repositories}
                          assignments={assignments}
                          phone={phone}
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
      {selected.length > 0 && !details ? (
        <SelectedPanel
          repositories={repositories}
          onDialog={setDialog}
          profiles={profiles}
          onBatch={onBatch}
          onMoved={(folder) => {
            focusFolder(folder, 'toggle');
          }}
          onDeselectAll={deselectAll}
        />
      ) : (
        opened !== undefined && (
          <RepositoryPanel
            repository={opened}
            repositories={repositories}
            onDialog={setDialog}
            profiles={profiles}
            onCapture={onCapture}
            onCompare={onCompare}
            onApply={onApply}
            onApplyProfiles={onApplyProfiles}
            assignments={assignments}
            onBack={
              details
                ? () => {
                    address.close();
                  }
                : undefined
            }
          />
        )
      )}
      {dialog?.kind === 'settings' ? (
        <FolderSettingsDialog
          name={dialog.name}
          repositories={repositories}
          profiles={profiles}
          assignments={assignments}
          onClose={closeDialog}
        />
      ) : dialog?.kind === 'delete' ? (
        <DeleteFolderDialog repositories={repositories} name={dialog.name} onClose={closeDialog} />
      ) : (
        dialog !== undefined && <FolderNameDialog repositories={repositories} dialog={dialog} onClose={closeDialog} />
      )}
    </div>
  );
}
