import type { JSX } from 'preact';
import { useState } from 'preact/hooks';

import type { ProfileFolderNode, ProfileListing, Profiles } from '../app/profiles.js';
import type { Router } from '../app/router.js';
import { Link } from './link.js';
import { run } from './run.js';
import { SyncNote } from './settings.js';

const ownerTypes = { user: 'For personal accounts', organization: 'For organizations' } as const;

function Folder({ node, profiles }: { readonly node: ProfileFolderNode; readonly profiles: Profiles }): JSX.Element {
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
              run(profiles.select(listing));
            }}
          >
            <span class="tree-name">{listing.name}</span>
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
            onClick={() => {
              profiles.toggleFolder(folder.path);
            }}
          >
            <span class="tree-name">{folder.name}</span>
            <span class="muted count">{folder.count}</span>
          </button>
          {folder.open && <Folder node={folder} profiles={profiles} />}
        </li>
      ))}
    </ul>
  );
}

function Profile({
  listing,
  profiles,
}: {
  readonly listing: ProfileListing;
  readonly profiles: Profiles;
}): JSX.Element {
  const [showYaml, setShowYaml] = useState(false);
  const opened = profiles.opened.value;
  const base = profiles.listings.value.find((item) => item.file === listing.extends);
  return (
    <article class="page-body" aria-labelledby="profile-heading">
      <div class="page-heading">
        <div>
          <h1 id="profile-heading">{listing.name}</h1>
          <p class="muted">
            {listing.owner_type === null ? 'For any owner' : ownerTypes[listing.owner_type]}
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
            aria-pressed={showYaml}
            onClick={() => {
              setShowYaml(!showYaml);
            }}
          >
            {showYaml ? 'Hide YAML' : 'Show YAML'}
          </button>
        </div>
      </div>
      {listing.problem !== null && (
        <p class="notice notice-problem" role="alert">
          {listing.problem}
        </p>
      )}
      {showYaml && opened?.file === listing.file && (
        <pre class="code" tabIndex={0} aria-label={`${listing.name} as YAML`}>
          {opened.text}
        </pre>
      )}
    </article>
  );
}

export function ProfilesPage({
  profiles,
  router,
}: {
  readonly profiles: Profiles;
  readonly router: Router;
}): JSX.Element {
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
        <Folder node={tree} profiles={profiles} />
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
        {selected !== undefined ? (
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
