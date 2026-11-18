import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import type { Router } from '../../app/navigation/router.js';
import type { SaveMode } from '../../app/profile-editor/entry-edits.js';
import type { BranchPreview } from '../../app/profiles/branch-preview.js';
import type { ProfileFolderNode, ProfileListing, Profiles } from '../../app/profiles/profiles.js';
import type { Repositories } from '../../app/repositories/repositories.js';
import { Link } from '../layout/link.js';
import { Loading, LoadingList } from '../layout/loading.js';
import { useProfileConfirmation } from '../layout/notifications.js';
import { PendingButton, usePendingAction } from '../layout/pending-button.js';
import { run } from '../layout/run.js';
import { useDismissibleMenu, useModal } from '../layout/shell.js';
import { ProfileSettings } from '../profile-editor/profile-editor.js';
import { RepairProfile } from '../profile-editor/profile-repair.js';
import { previewAddress, PreviewPicker } from './branch-preview.js';
import { NewProfileForm } from './new-profile.js';
import { OwnerTypeDialog } from './owner-type.js';
import { SyncNote } from './sync-note.js';

const ownerTypes = {
  user: 'For personal accounts',
  organization: 'For organizations',
} as const;

export type ProfilesDialog =
  | { readonly kind: 'delete'; readonly listings: readonly ProfileListing[] }
  | {
      readonly kind: 'new-folder';
      readonly listings: readonly ProfileListing[];
    }
  | { readonly kind: 'rename'; readonly path: string; readonly name: string };

/** The profile's path in the profiles folder without its extension, which tells apart two of one name. */
function nameOf(profiles: Profiles, listing: ProfileListing): string {
  return profiles.pathOf(listing).replace(/\.ya?ml$/iu, '');
}

/** Those the list shows, in its order: its folders' first, then its own, leaving out closed folders. */
function shownIn(node: ProfileFolderNode): readonly ProfileListing[] {
  return node.open ? [...node.folders.flatMap(shownIn), ...node.profiles] : [];
}

function parentOf(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}

interface RowProps {
  readonly listing: ProfileListing;
  readonly profiles: Profiles;
  readonly onOpen: (listing: ProfileListing) => void;
}

function ProfileRow({ listing, profiles, onOpen }: RowProps): JSX.Element {
  const base = profiles.listings.value.find((item) => item.file === listing.extends);
  return (
    <li class="selectable-row">
      <input
        class="select-box"
        type="checkbox"
        aria-label={`Select ${nameOf(profiles, listing)}`}
        checked={profiles.isInBatch(listing)}
        onChange={(event) => {
          profiles.selectForBatch([listing], event.currentTarget.checked);
        }}
      />
      <button
        class="row profile-row"
        type="button"
        data-profile={listing.file}
        onClick={() => {
          onOpen(listing);
        }}
      >
        <span class="row-name">{listing.name}</span>
        {profiles.unsaved.value.has(listing.file) && <span class="pill pill-drift">Not saved</span>}
        {listing.problem !== null && <span class="pill pill-remove">Problem</span>}
        <span class="profile-row-details muted small">
          {listing.problem === null && (
            <span>{listing.owner_type === null ? 'For any owner' : ownerTypes[listing.owner_type]}</span>
          )}
          {base !== undefined && <span>Extends {base.name}</span>}
        </span>
      </button>
    </li>
  );
}

function FolderMenu({
  node,
  onDialog,
}: {
  readonly node: ProfileFolderNode;
  readonly onDialog: (dialog: ProfilesDialog) => void;
}): JSX.Element {
  const menu = useDismissibleMenu();
  return (
    <details class="menu folder-menu" ref={menu}>
      <summary class="button button-quiet button-small" aria-label={`Edit ${node.path}`}>
        Edit
      </summary>
      <div class="menu-panel menu-panel-end">
        <button
          class="menu-item"
          type="button"
          onClick={() => {
            if (menu.current !== null) {
              menu.current.open = false;
            }
            onDialog({ kind: 'rename', path: node.path, name: node.name });
          }}
        >
          Rename
        </button>
      </div>
    </details>
  );
}

interface FolderProps {
  readonly node: ProfileFolderNode;
  readonly profiles: Profiles;
  readonly onOpen: (listing: ProfileListing) => void;
  readonly onDialog: (dialog: ProfilesDialog) => void;
}

function FolderSection({ node, profiles, onOpen, onDialog }: FolderProps): JSX.Element {
  const searching = profiles.search.value.trim() !== '';
  const inside = shownIn(node);
  const everyShownProfileSelected = inside.length > 0 && inside.every((listing) => profiles.isInBatch(listing));
  const Title = node.path.includes('/') ? 'h3' : 'h2';
  return (
    <section class="folder" aria-label={node.path} data-folder={node.path}>
      <div class="folder-heading">
        <Title class="folder-title">
          <button
            class="folder-toggle"
            type="button"
            aria-expanded={node.open}
            disabled={searching}
            onClick={() => {
              profiles.toggleFolder(node.path);
            }}
          >
            <svg class="folder-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2.2h8.4A1.5 1.5 0 0 1 21 8.7v9.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z" />
            </svg>
            <span class="folder-name">{node.name}</span>
            <span class="muted count">{node.count}</span>
          </button>
        </Title>
        {node.open && inside.length > 0 && (
          <button
            class="button button-quiet button-small folder-select"
            type="button"
            aria-label={`${everyShownProfileSelected ? 'Deselect all in' : 'Select all in'} ${node.path}`}
            onClick={() => {
              profiles.selectForBatch(inside, !everyShownProfileSelected);
            }}
          >
            {everyShownProfileSelected ? 'Deselect all' : 'Select all'}
          </button>
        )}
        <FolderMenu node={node} onDialog={onDialog} />
      </div>
      {node.open && (
        <div class="folder-body">
          {node.folders.map((folder) => (
            <FolderSection key={folder.path} node={folder} profiles={profiles} onOpen={onOpen} onDialog={onDialog} />
          ))}
          {node.profiles.length > 0 && (
            <ul class="rows">
              {node.profiles.map((listing) => (
                <ProfileRow key={listing.file} listing={listing} profiles={profiles} onOpen={onOpen} />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

interface FolderNameProps {
  readonly profiles: Profiles;
  readonly dialog: Extract<ProfilesDialog, { kind: 'new-folder' | 'rename' }>;
  /** With the folder the profiles are in now, once they moved. */
  readonly onClose: (landed: string | undefined) => void;
}

export function FolderNameDialog({ profiles, dialog: asked, onClose }: FolderNameProps): JSX.Element {
  const confirm = useProfileConfirmation(profiles);
  const dialog = useModal();
  const renaming = asked.kind === 'rename' ? asked : undefined;
  const [name, setName] = useState(renaming?.name ?? '');
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const landed = useRef<string | undefined>(undefined);
  const [moving, setMoving] = useState(false);
  const count = asked.kind === 'new-folder' ? asked.listings.length : 0;
  const noun =
    asked.kind === 'new-folder' && asked.listings.every((listing) => listing.kind !== undefined)
      ? 'definition'
      : 'profile';
  return (
    <dialog
      class="dialog"
      ref={dialog}
      aria-labelledby="folder-name-heading"
      onCancel={(event) => {
        // Escape would hide why a move under way failed.
        if (moving) {
          event.preventDefault();
        }
      }}
      onClose={() => {
        onClose(landed.current);
      }}
    >
      <form
        method="dialog"
        onSubmit={(event) => {
          if (!(event.submitter instanceof HTMLButtonElement) || event.submitter.value !== 'save') {
            return;
          }
          event.preventDefault();
          const trimmed = name.trim();
          if (asked.kind === 'new-folder' && trimmed === '') {
            setProblem('Give the folder a name.');
            return;
          }
          const folder =
            renaming === undefined ? trimmed : [parentOf(renaming.path), trimmed].filter(Boolean).join('/');
          setMoving(true);
          run(
            (renaming === undefined
              ? profiles.move(asked.kind === 'new-folder' ? asked.listings : [], trimmed)
              : profiles.renameFolder(renaming.path, trimmed)
            )
              .then((failure) => {
                setProblem(failure);
                if (failure === undefined) {
                  confirm(
                    renaming === undefined
                      ? noun === 'definition'
                        ? 'Definitions moved.'
                        : 'Profiles moved.'
                      : 'Folder renamed.',
                  );
                  landed.current = folder;
                  dialog.current?.close();
                }
              })
              .finally(() => {
                setMoving(false);
              }),
          );
        }}
      >
        <h2 id="folder-name-heading">{renaming === undefined ? 'New folder' : `Rename ${renaming.path}`}</h2>
        <p class="muted">
          {renaming === undefined
            ? `${count === 1 ? `The selected ${noun} moves` : `The ${count} selected ${noun}s move`} into it. For a folder inside another, give both, as apps/desktop.`
            : 'Every profile and definition in it moves with it.'}{' '}
          Profiles that reference or extend them are pointed at the new place.
        </p>
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
        <div class="form-actions">
          <PendingButton
            pending={moving}
            class="button button-primary"
            type="submit"
            value="save"
            disabled={profiles.profileWorkUnderWay.value}
          >
            {renaming === undefined ? 'Create and move' : 'Rename folder'}
          </PendingButton>
          <button class="button button-quiet" type="submit" value="cancel" disabled={moving}>
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}

interface DeleteProps {
  readonly listings: readonly ProfileListing[];
  readonly profiles: Profiles;
  /** With whether they were deleted. */
  readonly onClose: (deleted: boolean) => void;
}

export function DeleteProfiles({ listings, profiles, onClose }: DeleteProps): JSX.Element {
  const confirm = useProfileConfirmation(profiles);
  const dialog = useModal();
  const [error, setError] = useState<string | undefined>(undefined);
  const deleted = useRef(false);
  const [deleting, setDeleting] = useState(false);
  const dependents = profiles.dependents(...listings);
  const source = profiles.source.value.kind;
  const one = listings.length === 1 ? listings[0] : undefined;
  const noun = listings.every((listing) => listing.kind !== undefined) ? 'definition' : 'profile';
  return (
    <dialog
      class="dialog"
      ref={dialog}
      aria-labelledby="delete-heading"
      onCancel={(event) => {
        // Escape would hide why a delete under way failed.
        if (deleting) {
          event.preventDefault();
        }
      }}
      onClose={() => {
        onClose(deleted.current);
      }}
    >
      <form
        method="dialog"
        onSubmit={(event) => {
          if (event.submitter instanceof HTMLButtonElement && event.submitter.value === 'delete') {
            event.preventDefault();
            setDeleting(true);
            run(
              profiles
                .remove(...listings)
                .then((failure) => {
                  setError(failure);
                  if (failure === undefined) {
                    confirm(
                      listings.length === 1
                        ? `${listings[0]?.name ?? 'Profile'} deleted.`
                        : `${listings.length} ${noun}s deleted.`,
                    );
                    deleted.current = true;
                    dialog.current?.close();
                  }
                })
                .finally(() => {
                  setDeleting(false);
                }),
            );
          }
        }}
      >
        <h2 id="delete-heading">{one === undefined ? `Delete ${listings.length} ${noun}s?` : `Delete ${one.name}?`}</h2>
        {one === undefined ? (
          <ul class="muted small selected-names">
            {listings.map((listing) => (
              <li key={listing.file} class="mono">
                {profiles.pathOf(listing)}
              </li>
            ))}
          </ul>
        ) : (
          <p>
            This deletes <span class="mono">{profiles.pathOf(one)}</span>.
          </p>
        )}
        <p>
          {source === 'repository'
            ? `The deletion is committed to the repository, whose history keeps ${one === undefined ? 'the files as they were' : 'the file as it was'} at the last sync. Changes made since then can't be brought back.`
            : source === 'folder'
              ? `${one === undefined ? 'The files are' : 'The file is'} deleted from the folder on this computer too. ${one === undefined ? 'They' : 'It'} can't be brought back from here.`
              : `${one === undefined ? 'They' : 'It'} can't be brought back.`}
        </p>
        {dependents.length > 0 && noun === 'profile' && (
          <p>
            {dependents.map((item) => item.name).join(', ')} {dependents.length === 1 ? 'extends' : 'extend'}{' '}
            {one === undefined ? 'one of them' : 'it'} and {dependents.length === 1 ? 'stops' : 'stop'} loading until
            pointed at another profile.
          </p>
        )}
        {dependents.length > 0 && noun === 'definition' && (
          <p>Remove references from {dependents.map((item) => item.name).join(', ')} before deleting.</p>
        )}
        {error !== undefined && (
          <p class="notice notice-problem" role="alert">
            {error}
          </p>
        )}
        <div class="form-actions">
          <PendingButton
            pending={deleting}
            class="button button-danger"
            type="submit"
            value="delete"
            disabled={profiles.profileWorkUnderWay.value}
          >
            {one === undefined
              ? `Delete ${listings.length} ${noun}s`
              : one.kind === undefined
                ? 'Delete profile'
                : 'Delete definition'}
          </PendingButton>
          {/* The dialog opens with the keyboard on Cancel, so Enter never deletes by itself. */}
          <button class="button button-quiet" type="submit" value="cancel" disabled={deleting} autofocus>
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}

const unchosen = '\u0000unchosen';
const newFolderChoice = '\u0000new';
const noFolderChoice = '';

interface SelectedProps {
  readonly profiles: Profiles;
  readonly selection: readonly ProfileListing[];
  readonly onDialog: (dialog: ProfilesDialog) => void;
  readonly onMoved: (folder: string) => void;
  readonly onDeselectAll: () => void;
}

export function SelectedPanel({
  profiles,
  selection: batch,
  onDialog,
  onMoved,
  onDeselectAll,
}: SelectedProps): JSX.Element {
  const confirm = useProfileConfirmation(profiles);
  const [movingProfiles, moveProfiles] = usePendingAction();
  const busy = profiles.profileWorkUnderWay.value;
  const noun = batch.every((listing) => listing.kind !== undefined) ? 'definition' : 'profile';
  const [picked, setPicked] = useState<string | undefined>(undefined);
  // A folder renamed away, or emptied by another move, is no longer a choice.
  const target =
    picked === undefined || picked === newFolderChoice || profiles.folders.value.includes(picked) ? picked : undefined;
  const [problem, setProblem] = useState<string | undefined>(undefined);
  return (
    <aside class="panel" aria-label={`Selected ${noun}s`}>
      <h2>{batch.length === 1 ? `1 ${noun} selected` : `${batch.length} ${noun}s selected`}</h2>
      <ul class="muted small selected-names">
        {batch.map((listing) => (
          <li key={listing.file} class="mono">
            {profiles.pathOf(listing)}
          </li>
        ))}
      </ul>
      <form
        class="panel-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (target === newFolderChoice) {
            onDialog({ kind: 'new-folder', listings: batch });
          } else if (target !== undefined) {
            run(
              moveProfiles(() =>
                profiles.move(batch, target).then((failure) => {
                  setProblem(failure);
                  if (failure === undefined) {
                    confirm(noun === 'definition' ? 'Definitions moved.' : 'Profiles moved.');
                    onMoved(target);
                  }
                }),
              ),
            );
          }
        }}
      >
        <label for="move-folder">Move to a folder</label>
        <div class="move-row">
          <select
            id="move-folder"
            class="field"
            value={target ?? unchosen}
            aria-describedby={problem === undefined ? undefined : 'move-problem'}
            onChange={(event) => {
              setPicked(event.currentTarget.value);
              setProblem(undefined);
            }}
          >
            {target === undefined && (
              <option value={unchosen} disabled>
                Choose a folder
              </option>
            )}
            <option value={noFolderChoice}>No folder</option>
            {profiles.folders.value
              .filter((folder) => folder !== '')
              .map((folder) => (
                <option key={folder} value={folder}>
                  {folder}
                </option>
              ))}
            <option value={newFolderChoice}>New folder…</option>
          </select>
          <PendingButton pending={movingProfiles} class="button" type="submit" disabled={target === undefined || busy}>
            {target === newFolderChoice ? 'New folder' : 'Move'}
          </PendingButton>
        </div>
        {problem !== undefined && (
          <p id="move-problem" class="problem small" role="alert">
            {problem}
          </p>
        )}
        <p class="muted small">Profiles that reference or extend them are pointed at the new place.</p>
      </form>
      <div class="panel-actions">
        <button class="button button-quiet" type="button" onClick={onDeselectAll}>
          Deselect all
        </button>
        <button
          class="button button-quiet"
          type="button"
          disabled={busy}
          onClick={() => {
            onDialog({ kind: 'delete', listings: batch });
          }}
        >
          Delete
        </button>
      </div>
    </aside>
  );
}

interface ProfileProps {
  readonly router: Router;
  readonly standalone?: boolean;
  readonly listing: ProfileListing;
  readonly profiles: Profiles;
}

export function Profile({ listing, profiles, router, standalone }: ProfileProps): JSX.Element {
  const confirm = useProfileConfirmation(profiles);
  const [showYaml, setShowYaml] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [changingOwner, setChangingOwner] = useState(false);
  const couldNotRead = profiles.settingsCaptureCouldNotRead.value;
  const editor = profiles.editor.value;
  const opened = profiles.opened.value;
  const base = profiles.listings.value.find((item) => item.file === listing.extends);
  const save = async (mode: SaveMode = 'applies'): Promise<void> => {
    const current = profiles.editor.value;
    if (current === undefined || !(mode === 'applies' ? current.canSave.value : current.canSaveAsDraft.value)) {
      return;
    }
    const repair = current.repair.value;
    await profiles.save(mode);
    if (current.saveError.value === undefined && repair?.saveError.value === undefined) {
      confirm(`${listing.name} saved${mode === 'draft' ? ' as a draft' : ''}.`);
    }
  };
  return (
    <article class={standalone === true ? 'definition-editor' : 'page-body'} aria-labelledby="profile-heading">
      <div class="page-heading">
        <div>
          <h1 id="profile-heading">{listing.name}</h1>
          <p class="muted">
            {listing.owner_type === null ? 'For any owner' : ownerTypes[listing.owner_type]}
            {editor?.loaded.value === true && (
              <>
                {' '}
                <button
                  class="link"
                  type="button"
                  aria-label="Change who the profile is for"
                  onClick={() => {
                    setChangingOwner(true);
                  }}
                >
                  Change
                </button>
              </>
            )}
            {base !== undefined && (
              <>
                , extends{' '}
                <button
                  class="link"
                  type="button"
                  onClick={() => {
                    run(profiles.select(base));
                  }}
                >
                  {base.name}
                </button>
              </>
            )}
          </p>
          <p class="mono small muted">{profiles.pathOf(listing)}</p>
        </div>
        <div class="page-actions">
          <button
            class="button"
            type="button"
            onClick={() => {
              setShowYaml(!showYaml);
            }}
          >
            {showYaml ? 'Hide YAML' : 'Show YAML'}
          </button>
          {opened?.file === listing.file && (
            <a
              class="button"
              download={`${listing.name}.yaml`}
              href={`data:application/yaml;charset=utf-8,${encodeURIComponent(opened.text)}`}
            >
              Export YAML
            </a>
          )}
          <button
            class="button"
            type="button"
            disabled={
              listing.kind !== undefined && (editor?.dirty.value === true || profiles.consumerNames(listing).length > 0)
            }
            onClick={() => {
              setDeleting(true);
            }}
          >
            {listing.kind === undefined ? 'Delete profile' : 'Delete definition'}
          </button>
        </div>
      </div>
      {changingOwner && editor !== undefined && (
        <OwnerTypeDialog
          editor={editor}
          profiles={profiles}
          onClose={() => {
            setChangingOwner(false);
          }}
        />
      )}
      {deleting && (
        <DeleteProfiles
          listings={[listing]}
          profiles={profiles}
          onClose={() => {
            setDeleting(false);
          }}
        />
      )}
      {couldNotRead?.file === listing.file && (
        <div class="notice notice-drift" role="status">
          <details class="uncaptured">
            <summary>
              <span>
                {couldNotRead.uncaptured.count === 1
                  ? "1 setting wasn't captured"
                  : `${couldNotRead.uncaptured.count} settings weren't captured`}
              </span>
              <span class="uncaptured-toggle">
                <span class="uncaptured-show">Show</span>
                <span class="uncaptured-hide">Hide</span>
              </span>
            </summary>
            <ul>
              {couldNotRead.uncaptured.groups.map((group) => (
                <li key={group.settings.join()}>
                  <strong>{group.settings.join(', ')}</strong>
                  <span class="uncaptured-reason">{group.reason}</span>
                </li>
              ))}
            </ul>
          </details>
          {couldNotRead.uncaptured.installationSettingsUrl !== null && (
            <p class="notice-actions">
              <a
                class="button button-small"
                href={couldNotRead.uncaptured.installationSettingsUrl}
                target="_blank"
                rel="noreferrer"
              >
                Review on GitHub
              </a>
            </p>
          )}
        </div>
      )}
      {listing.problem !== null && editor?.repair.value === undefined && (
        <p class="notice notice-problem" role="alert">
          {listing.problem}
        </p>
      )}
      {editor?.repair.value !== undefined && <RepairProfile editor={editor} save={save} />}
      {listing.kind !== undefined && standalone !== true && (
        <p class="notice">
          Used by:{' '}
          {profiles.consumerNames(listing).length === 0 ? 'No consumers' : profiles.consumerNames(listing).join(', ')}.
          Saving changes every consumer on its next resolution. GitHub changes only after reviewed apply.
        </p>
      )}
      {editor?.loaded.value === false && editor.loadError.value === undefined && editor.repair.value === undefined && (
        <Loading>Reading the profile…</Loading>
      )}
      {editor?.loaded.value === true && (
        <ProfileSettings
          key={editor.file}
          name={listing.name}
          editor={editor}
          saving={{
            ...(listing.kind === undefined ? {} : { saveLabel: 'Save definition' }),
            save,
            discardDraft: () => profiles.discardDraft(),
            onGitHub: profiles.source.value.kind === 'repository',
          }}
          sharedDefinitions={listing.kind === undefined ? { profiles, router } : undefined}
          ownerTypeHasPushRulesets={listing.owner_type !== 'user'}
        />
      )}
      {showYaml && opened?.file === listing.file && (
        <pre class="code" role="region" tabIndex={0} aria-label={`${listing.name} as YAML`}>
          {opened.text}
        </pre>
      )}
    </article>
  );
}

interface ProfilesProps {
  readonly profiles: Profiles;
  readonly repositories: Repositories;
  readonly router: Router;
  readonly preview: BranchPreview;
  readonly newProfileForm: { readonly repository: string | undefined } | undefined;
}

export function Banners({ profiles }: { readonly profiles: Profiles }): JSX.Element | null {
  const [keepingLocal, keepLocal] = usePendingAction();
  const [keepingRemote, keepRemote] = usePendingAction();
  const source = profiles.source.value;
  const conflicts = profiles.conflicts.value;
  const busy = profiles.profileWorkUnderWay.value;
  const elsewhere = source.kind === 'folder' ? 'in the folder' : 'on GitHub';
  if (conflicts.length === 0 && profiles.sync.value.status !== 'failed' && profiles.listingError.value === undefined) {
    return null;
  }
  return (
    <>
      {profiles.listingError.value !== undefined && (
        <p class="notice notice-problem" role="alert">
          Couldn't list the profiles: {profiles.listingError.value}
        </p>
      )}
      {profiles.sync.value.status === 'failed' && (
        <div class="notice notice-problem">
          <SyncNote profiles={profiles} />
        </div>
      )}
      {conflicts.length > 0 && (
        <div class="notice notice-drift" role="alert">
          <p>
            {conflicts.length === 1
              ? `${conflicts[0]} changed both here and ${elsewhere} since the last sync.`
              : `${conflicts.length} profiles changed both here and ${elsewhere} since the last sync: ${conflicts.join(', ')}.`}{' '}
            Which version do you want to keep?
          </p>
          <div class="notice-actions">
            <PendingButton
              pending={keepingLocal}
              class="button"
              type="button"
              disabled={busy}
              onClick={() => {
                run(keepLocal(() => profiles.keep('local')));
              }}
            >
              Keep mine
            </PendingButton>
            <PendingButton
              pending={keepingRemote}
              class="button"
              type="button"
              disabled={busy}
              onClick={() => {
                run(keepRemote(() => profiles.keep('remote')));
              }}
            >
              {source.kind === 'folder' ? "Use the folder's" : "Use GitHub's"}
            </PendingButton>
          </div>
        </div>
      )}
    </>
  );
}

export function ProfilesPage({ profiles, repositories, router, preview, newProfileForm }: ProfilesProps): JSX.Element {
  const confirm = useProfileConfirmation(profiles);
  const [refreshing, refresh] = usePendingAction();
  const source = profiles.source.value;
  const tree = profiles.tree.value;
  const selected = profiles.selected.value?.kind === undefined ? profiles.selected.value : undefined;
  const batch = profiles.batch.value.filter((listing) => listing.kind === undefined);
  const busy = profiles.profileWorkUnderWay.value;
  const total = profiles.listings.value.filter((listing) => listing.kind === undefined).length;
  const shown = shownIn(tree);
  const everyShownProfileSelected = shown.length > 0 && shown.every((listing) => profiles.isInBatch(listing));
  // The list and an open profile, or the new-profile form, are two screens.
  const showing = newProfileForm !== undefined ? '/profiles/new' : selected?.file;
  const open = showing !== undefined;
  const [picking, setPicking] = useState(false);
  const [dialog, setDialog] = useState<ProfilesDialog | undefined>(undefined);
  const heading = useRef<HTMLHeadingElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const listScroll = useRef(0);
  const first = useRef(true);
  const previous = useRef(showing);
  useEffect(() => {
    const left = previous.current;
    previous.current = showing;
    if (first.current) {
      first.current = false;
      return;
    }
    // The button that was pressed is gone with the screen it was on, so the new screen takes the focus.
    if (open) {
      scrollTo(0, 0);
      document.querySelector<HTMLElement>('.profiles-back')?.focus();
      return;
    }
    // Back to the row that was open, where the list was left, or to New profile after its form, or else to
    // the heading, as when the open profile was deleted or synced away.
    const row =
      left === undefined ? null : document.querySelector<HTMLElement>(`button.row[data-profile="${CSS.escape(left)}"]`);
    const newProfile =
      left === '/profiles/new' ? document.querySelector<HTMLElement>('.page-actions a[href="/profiles/new"]') : null;
    scrollTo(0, row === null ? 0 : listScroll.current);
    (row ?? newProfile ?? heading.current)?.focus({
      preventScroll: row !== null,
    });
  }, [showing]);

  const openProfile = (listing: ProfileListing): void => {
    listScroll.current = scrollY;
    router.go('/profiles');
    run(profiles.select(listing));
  };
  /** Once the page has drawn it, on the folder's toggle, or on the heading for none. */
  const focusFolder = (path: string): void => {
    requestAnimationFrame(() => {
      const section = [...document.querySelectorAll<HTMLElement>('section.folder')].find(
        (found) => path !== '' && found.getAttribute('data-folder') === path,
      );
      (section?.querySelector<HTMLElement>('.folder-toggle:not(:disabled)') ?? heading.current)?.focus();
    });
  };
  // The buttons that deselect go with the selection's panel.
  const deselectAll = (): void => {
    profiles.selectForBatch(batch, false);
    requestAnimationFrame(() => {
      heading.current?.focus();
    });
  };

  const dialogs = (
    <>
      {dialog?.kind === 'delete' && (
        <DeleteProfiles
          listings={dialog.listings}
          profiles={profiles}
          onClose={(deleted) => {
            setDialog(undefined);
            if (deleted) {
              focusFolder('');
            }
          }}
        />
      )}
      {(dialog?.kind === 'new-folder' || dialog?.kind === 'rename') && (
        <FolderNameDialog
          profiles={profiles}
          dialog={dialog}
          onClose={(landed) => {
            setDialog(undefined);
            if (landed !== undefined) {
              focusFolder(landed);
            }
          }}
        />
      )}
    </>
  );

  if (open) {
    return (
      <div class="page profiles-open">
        <div class="profiles-open-top">
          <button
            class="link profiles-back"
            type="button"
            onClick={() => {
              // An editor keeps its unsaved changes when its profile is closed, and the list marks it Not saved.
              run(profiles.select(undefined));
              if (newProfileForm !== undefined) {
                router.go('/profiles');
              }
            }}
          >
            All profiles
          </button>
          <Banners profiles={profiles} />
        </div>
        {newProfileForm !== undefined ? (
          <NewProfileForm
            profiles={profiles}
            repositories={repositories}
            router={router}
            repositoryToCapture={newProfileForm.repository}
          />
        ) : (
          selected !== undefined && (
            <Profile key={selected.file} listing={selected} profiles={profiles} router={router} />
          )
        )}
      </div>
    );
  }

  return (
    <div class={batch.length > 0 ? 'page page-with-panel' : 'page'}>
      <section class="page-body" aria-labelledby="profiles-heading">
        <div class="page-heading">
          <div>
            <h1 id="profiles-heading" ref={heading} tabIndex={-1}>
              Profiles
            </h1>
            <p class="muted">
              {source.kind === 'repository' ? (
                <>
                  Kept in <span class="mono">{source.repository}</span>
                  {source.path === '' ? (
                    ''
                  ) : (
                    <>
                      {' '}
                      in <span class="mono">{source.path}</span>
                    </>
                  )}
                  .{' '}
                </>
              ) : source.kind === 'folder' ? (
                <>
                  Kept in <span class="mono">{source.name}</span> on this computer.{' '}
                </>
              ) : (
                'Kept in this browser. '
              )}
              A profile describes how a repository should be set up.
            </p>
          </div>
          <div class="page-actions">
            <PendingButton
              pending={refreshing}
              class="button"
              type="button"
              disabled={busy}
              onClick={() => {
                run(
                  refresh(() =>
                    profiles
                      .refresh()
                      .then(() =>
                        confirm(profiles.source.value.kind === 'browser' ? 'Profiles refreshed.' : 'Profiles synced.'),
                      ),
                  ),
                );
              }}
            >
              {source.kind === 'browser' ? 'Refresh' : 'Sync'}
            </PendingButton>
            {source.kind === 'repository' && (
              <button
                class="button"
                type="button"
                onClick={() => {
                  setPicking(true);
                }}
              >
                Preview
              </button>
            )}
            <Link class="button button-primary" router={router} to="/profiles/new">
              New profile
            </Link>
          </div>
        </div>
        {picking && source.kind === 'repository' && (
          <PreviewPicker
            preview={preview}
            repository={source.repository}
            onPick={(branch) => {
              router.go(previewAddress(branch));
            }}
            onClose={() => {
              setPicking(false);
            }}
          />
        )}
        <Banners profiles={profiles} />

        {busy && profiles.listed.value && total > 0 && <Loading>Updating profiles…</Loading>}
        {!profiles.listed.value ||
        (total === 0 &&
          (busy || profiles.listingError.value !== undefined || profiles.sync.value.status === 'failed')) ? (
          (busy || (profiles.listingError.value === undefined && profiles.sync.value.status !== 'failed')) && (
            <LoadingList>Reading your profiles…</LoadingList>
          )
        ) : total === 0 ? (
          <div class="empty">
            <h2>No profiles yet</h2>
            {source.kind === 'folder' ? (
              <p>
                <span class="mono">{source.name}</span> has no profiles yet.
              </p>
            ) : source.kind === 'repository' ? (
              <p>
                <span class="mono">{source.repository}</span> has no profiles
                {source.path === '' ? '' : ` in ${source.path}`} yet.
              </p>
            ) : (
              <>
                <p>There are no profiles in this browser yet.</p>
                <p>
                  If you keep profiles in a GitHub repository, choose it in{' '}
                  <Link router={router} to="/settings">
                    Settings
                  </Link>
                  .
                </p>
              </>
            )}
            <Link class="button button-primary" router={router} to="/profiles/new">
              New profile
            </Link>
          </div>
        ) : (
          <>
            <div class="toolbar">
              <input
                class="field"
                type="search"
                ref={search}
                placeholder="Find a profile"
                aria-label="Find a profile"
                value={profiles.search.value}
                onInput={(event) => {
                  profiles.search.value = event.currentTarget.value;
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    profiles.search.value = '';
                  }
                }}
              />
              <span class="muted" role="status">
                {shown.length === total
                  ? `${total} ${total === 1 ? 'profile' : 'profiles'}`
                  : `${shown.length} of ${total} profiles`}
              </span>
              {shown.length > 0 && (
                <button
                  class="button button-quiet"
                  type="button"
                  onClick={() => {
                    profiles.selectForBatch(shown, !everyShownProfileSelected);
                  }}
                >
                  {everyShownProfileSelected ? 'Deselect all' : 'Select all'}
                </button>
              )}
            </div>
            {shown.length === 0 && total > 0 ? (
              <div class="empty">
                <h2>No profiles found</h2>
                <p>No profile matches "{profiles.search.value.trim()}".</p>
                <button
                  class="button"
                  type="button"
                  onClick={() => {
                    profiles.search.value = '';
                    search.current?.focus();
                  }}
                >
                  Clear search
                </button>
              </div>
            ) : (
              <div class="groups">
                {tree.folders.map((folder) => (
                  <FolderSection
                    key={folder.path}
                    node={folder}
                    profiles={profiles}
                    onOpen={openProfile}
                    onDialog={setDialog}
                  />
                ))}
                {tree.folders.length > 0 && tree.profiles.length > 0 && <p class="section-label">Not in a folder</p>}
                {tree.profiles.length > 0 && (
                  <ul class="rows">
                    {tree.profiles.map((listing) => (
                      <ProfileRow key={listing.file} listing={listing} profiles={profiles} onOpen={openProfile} />
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
      </section>
      {batch.length > 0 && (
        <SelectedPanel
          profiles={profiles}
          selection={batch}
          onDialog={setDialog}
          onMoved={focusFolder}
          onDeselectAll={deselectAll}
        />
      )}
      {dialogs}
    </div>
  );
}
