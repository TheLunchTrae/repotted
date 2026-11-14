import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import type { ProfileFolderNode, ProfileListing, Profiles } from '../app/profiles.js';
import type { Repositories } from '../app/repositories.js';
import type { Router } from '../app/router.js';
import { Link } from './link.js';
import { NewProfileForm } from './new-profile.js';
import { OwnerTypeDialog } from './owner-type.js';
import { ProfileSettings } from './profile-editor.js';
import { run } from './run.js';
import { SyncNote } from './settings.js';

const ownerTypes = { user: 'For personal accounts', organization: 'For organizations' } as const;

interface FolderProps {
  readonly node: ProfileFolderNode;
  readonly profiles: Profiles;
  /** Called when a profile is chosen, which closes the new profile form. */
  readonly onOpen: () => void;
}

function Folder({ node, profiles, onOpen }: FolderProps): JSX.Element {
  const selected = profiles.selected.value;
  return (
    <ul class="tree">
      {node.profiles.map((listing) => (
        <li key={listing.file}>
          <button
            class="tree-item"
            type="button"
            aria-current={selected?.file === listing.file ? 'true' : undefined}
            onClick={() => {
              onOpen();
              run(profiles.select(listing));
            }}
          >
            <span class="tree-name">{listing.name}</span>
            {profiles.unsaved.value.has(listing.file) && <span class="pill pill-drift">Not saved</span>}
            {listing.problem !== null && <span class="pill pill-remove">Problem</span>}
          </button>
        </li>
      ))}
      {node.folders.map((folder) => (
        <li key={folder.path}>
          <button
            class="tree-item tree-folder"
            type="button"
            aria-expanded={folder.open}
            aria-label={`${folder.name}, ${folder.count} ${folder.count === 1 ? 'profile' : 'profiles'}`}
            onClick={() => {
              profiles.toggleFolder(folder.path);
            }}
          >
            <span class="tree-name">{folder.name}</span>
            <span class="muted count">{folder.count}</span>
          </button>
          {folder.open && <Folder node={folder} profiles={profiles} onOpen={onOpen} />}
        </li>
      ))}
    </ul>
  );
}

interface ProfileProps {
  readonly listing: ProfileListing;
  readonly profiles: Profiles;
}

/** Asks before a profile is deleted, naming its file and the profiles that stop loading without it. */
function DeleteProfile({ listing, profiles, onClose }: ProfileProps & { readonly onClose: () => void }): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const dependents = profiles.dependents(listing);
  const onGitHub = profiles.source.value.kind === 'repository';
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog class="dialog" ref={dialog} aria-labelledby="delete-heading" onClose={onClose}>
      <form
        method="dialog"
        onSubmit={(event) => {
          if (event.submitter instanceof HTMLButtonElement && event.submitter.value === 'delete') {
            event.preventDefault();
            run(
              profiles.remove(listing).then((failure) => {
                setError(failure);
                if (failure === undefined) {
                  dialog.current?.close();
                }
              }),
            );
          }
        }}
      >
        <h2 id="delete-heading">Delete {listing.name}?</h2>
        <p>
          This deletes <span class="mono">{profiles.pathOf(listing)}</span>.{' '}
          {onGitHub
            ? "The deletion is committed to the repository, whose history keeps the file as it was at the last sync. Changes made since then can't be brought back."
            : "It can't be brought back."}
        </p>
        {dependents.length > 0 && (
          <p>
            {dependents.map((item) => item.name).join(', ')} {dependents.length === 1 ? 'extends' : 'extend'} it and{' '}
            {dependents.length === 1 ? 'stops' : 'stop'} loading until pointed at another profile.
          </p>
        )}
        {error !== undefined && (
          <p class="notice notice-problem" role="alert">
            {error}
          </p>
        )}
        <div class="form-actions">
          <button class="button button-danger" type="submit" value="delete" disabled={profiles.busy.value}>
            Delete profile
          </button>
          {/* The dialog opens with the keyboard on Cancel, so Enter never deletes by itself. */}
          <button class="button button-quiet" type="submit" value="cancel" autofocus>
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}

function Profile({ listing, profiles }: ProfileProps): JSX.Element {
  const [showYaml, setShowYaml] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [changingOwner, setChangingOwner] = useState(false);
  const warnings = profiles.captureWarnings.value;
  const editor = profiles.editor.value;
  const opened = profiles.opened.value;
  const base = profiles.listings.value.find((item) => item.file === listing.extends);
  return (
    <article class="page-body" aria-labelledby="profile-heading">
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
          <button
            class="button"
            type="button"
            onClick={() => {
              setDeleting(true);
            }}
          >
            Delete profile
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
        <DeleteProfile
          listing={listing}
          profiles={profiles}
          onClose={() => {
            setDeleting(false);
          }}
        />
      )}
      {warnings?.file === listing.file && (
        <div class="notice notice-drift" role="status">
          <p>The capture left out what a profile can't hold:</p>
          <ul>
            {warnings.warnings.map((warning) => (
              <li>{warning}</li>
            ))}
          </ul>
        </div>
      )}
      {listing.problem !== null && (
        <p class="notice notice-problem" role="alert">
          {listing.problem}
        </p>
      )}
      {editor?.loaded.value === true && (
        <ProfileSettings
          key={editor.file}
          name={listing.name}
          editor={editor}
          profiles={profiles}
          pushes={listing.owner_type !== 'user'}
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
  /** Set while the new profile form is open, with the repository it was asked to capture. */
  readonly creating: { readonly repository: string | undefined } | undefined;
}

export function ProfilesPage({ profiles, repositories, router, creating }: ProfilesProps): JSX.Element {
  const source = profiles.source.value;
  const tree = profiles.tree.value;
  const selected = profiles.selected.value;
  const conflicts = profiles.conflicts.value;
  const busy = profiles.busy.value;
  const total = profiles.listings.value.length;

  return (
    <div class="page page-with-sidebar">
      <aside class="sidebar" aria-label="Profiles">
        <div class="sidebar-heading">
          <div class="sidebar-source">
            <strong class={source.kind === 'repository' ? 'mono' : undefined}>
              {source.kind === 'repository' ? source.repository : 'This browser'}
            </strong>
            <span class="muted count">{total}</span>
          </div>
          <button
            class="button button-quiet button-small"
            type="button"
            disabled={busy}
            onClick={() => {
              run(profiles.refresh());
            }}
          >
            {source.kind === 'repository' ? 'Sync' : 'Refresh'}
          </button>
        </div>
        <Link class="button button-primary" router={router} to="/profiles/new">
          New profile
        </Link>
        {total > 0 && (
          <input
            class="field"
            type="search"
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
        )}
        {total > 0 && tree.count === 0 && (
          <p class="muted small">No profile matches "{profiles.search.value.trim()}".</p>
        )}
        <Folder
          node={tree}
          profiles={profiles}
          onOpen={() => {
            router.go('/profiles');
          }}
        />
      </aside>

      <div class="page-main">
        {(conflicts.length > 0 || profiles.sync.value.status === 'failed' || profiles.error.value !== undefined) && (
          <div class="banners">
            {profiles.error.value !== undefined && (
              <p class="notice notice-problem" role="alert">
                Couldn't list the profiles: {profiles.error.value}
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
                    ? `${conflicts[0]} changed both here and on GitHub since the last sync.`
                    : `${conflicts.length} profiles changed both here and on GitHub since the last sync: ${conflicts.join(', ')}.`}{' '}
                  Which version do you want to keep?
                </p>
                <div class="notice-actions">
                  <button
                    class="button"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      run(profiles.keep('local'));
                    }}
                  >
                    Keep mine
                  </button>
                  <button
                    class="button"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      run(profiles.keep('remote'));
                    }}
                  >
                    Use GitHub's
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        {creating !== undefined ? (
          <NewProfileForm
            profiles={profiles}
            repositories={repositories}
            router={router}
            repository={creating.repository}
          />
        ) : selected !== undefined ? (
          <Profile key={selected.file} listing={selected} profiles={profiles} />
        ) : (
          <div class="page-body">
            <div class="page-heading">
              <div>
                <h1>Profiles</h1>
                <p class="muted">A profile describes how a repository should be set up.</p>
              </div>
            </div>
            <div class="empty">
              {total > 0 ? (
                <p>Choose a profile from the list.</p>
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
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
