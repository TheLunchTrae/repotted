import type { JSX } from 'preact';
import { useState } from 'preact/hooks';

import type { Account, User } from '../app/account.js';
import { installUrl } from '../app/github-app.js';
import type { Keeping } from '../app/kept-files.js';
import type { Profiles } from '../app/profiles.js';
import type { Repositories } from '../app/repositories.js';
import { run } from './run.js';

/** What the last sync did, or why it failed, as a line under where the profiles are kept. */
export function SyncNote({ profiles }: { readonly profiles: Profiles }): JSX.Element | null {
  const sync = profiles.sync.value;
  if (sync.status === 'failed') {
    return (
      <p class="problem small" role="alert">
        Not synced. {/[.!?]$/u.test(sync.message) ? sync.message : `${sync.message}.`} Profiles stay in this browser
        until a sync works.
      </p>
    );
  }
  if (sync.status === 'syncing') {
    return (
      <p class="muted small" role="status">
        Syncing with GitHub…
      </p>
    );
  }
  if (sync.status === 'synced') {
    const conflicts = profiles.conflicts.value.length;
    const moved = [
      sync.pulled > 0 ? `${sync.pulled} from GitHub` : undefined,
      sync.pushed > 0 ? `${sync.pushed} to GitHub` : undefined,
    ].filter((part) => part !== undefined);
    return (
      <p class="muted small" role="status">
        {conflicts > 0
          ? `Synced, with ${conflicts} ${conflicts === 1 ? 'profile' : 'profiles'} changed in both places.`
          : moved.length > 0
            ? `Synced: ${moved.join(', ')}.`
            : 'In sync with GitHub.'}
      </p>
    );
  }
  return null;
}

interface ConnectFormProps {
  readonly profiles: Profiles;
  readonly repositories: Repositories;
  readonly onClose: () => void;
}

function ConnectForm({ profiles, repositories, onClose }: ConnectFormProps): JSX.Element {
  const source = profiles.source.value;
  const [repository, setRepository] = useState(source.kind === 'repository' ? source.repository : '');
  const [path, setPath] = useState(source.kind === 'repository' ? source.path : '');
  const [addLocal, setAddLocal] = useState(false);
  const [working, setWorking] = useState(false);
  const error = profiles.connectError.value;
  const count = profiles.listings.value.length;
  // Adding is offered only for another place than the profiles are in now.
  const same =
    source.kind === 'repository' &&
    source.repository.toLowerCase() === repository.trim().toLowerCase() &&
    source.path === path.trim().replace(/^\/+|\/+$/gu, '');

  const connect = async (): Promise<void> => {
    setWorking(true);
    const problem = await profiles.connect(repository, path, addLocal && !same);
    setWorking(false);
    if (problem === undefined) {
      onClose();
    }
  };

  return (
    <form
      class="form"
      onSubmit={(event) => {
        event.preventDefault();
        run(connect());
      }}
    >
      <h2>Keep profiles on GitHub</h2>
      <p class="muted">
        Profiles live in a repository, so they follow you to any browser and keep their history. Each save is a commit
        to the repository's default branch.
      </p>
      <label class="form-field">
        <span>Repository</span>
        <input
          class="field mono"
          list="connect-repositories"
          required
          placeholder="owner/name, such as you/repotted-config"
          value={repository}
          onInput={(event) => {
            setRepository(event.currentTarget.value);
          }}
        />
        <datalist id="connect-repositories">
          {(repositories.list.value?.repositories ?? []).map((item) => (
            <option key={item.full_name} value={item.full_name} />
          ))}
        </datalist>
        <span class="muted small">
          Any repository the Repotted App is installed on, with the Contents permission. An empty one works.
        </span>
      </label>
      <label class="form-field">
        <span>Folder in the repository</span>
        <input
          class="field mono"
          placeholder="The repository's root"
          value={path}
          onInput={(event) => {
            setPath(event.currentTarget.value);
          }}
        />
        <span class="muted small">
          Only YAML files sync, from this folder and the folders in it. Hidden folders such as .github stay out.
        </span>
      </label>
      {count > 0 && !same && (
        <label class="check">
          <input
            type="checkbox"
            checked={addLocal}
            onChange={(event) => {
              setAddLocal(event.currentTarget.checked);
            }}
          />
          <span>
            Add the {count === 1 ? 'profile' : `${count} profiles`} from{' '}
            {source.kind === 'browser' ? 'this browser' : source.repository}
          </span>
        </label>
      )}
      {error !== undefined && (
        <p class="notice notice-problem" role="alert">
          {error}
        </p>
      )}
      <div class="form-actions">
        <button class="button button-primary" type="submit" disabled={working}>
          Use this repository
        </button>
        <button class="button button-quiet" type="button" disabled={working} onClick={onClose}>
          Cancel
        </button>
        {working && (
          <span class="muted small" role="status">
            Syncing with GitHub…
          </span>
        )}
      </div>
    </form>
  );
}

interface SettingsProps {
  readonly account: Account;
  readonly user: User;
  readonly profiles: Profiles;
  readonly repositories: Repositories;
  readonly keeping: Keeping;
}

export function SettingsPage({ account, user, profiles, repositories, keeping }: SettingsProps): JSX.Element {
  const [connecting, setConnecting] = useState(false);
  const source = profiles.source.value;
  const busy = profiles.busy.value;
  const onGitHub = source.kind === 'repository';

  return (
    <div class="page">
      <div class="page-body page-narrow">
        <div class="page-heading">
          <div>
            <h1>Settings</h1>
            <p class="muted">For the whole app, in this browser.</p>
          </div>
        </div>

        <section class="settings-group" aria-labelledby="settings-account">
          <h2 id="settings-account">Account</h2>
          <div class="settings">
            <div class="setting-row">
              <img
                class="avatar"
                src={`https://avatars.githubusercontent.com/${encodeURIComponent(user.login)}?size=80`}
                alt=""
                width="40"
                height="40"
              />
              <div class="setting-text">
                <strong>{user.login}</strong>
                <span class="muted small">Signed in with the Repotted App</span>
                {account.signOutError.value !== undefined && (
                  <span class="problem small" role="alert">
                    {account.signOutError.value}
                  </span>
                )}
              </div>
              <a class="button button-quiet" href={installUrl} target="_blank" rel="noreferrer">
                Add repositories
              </a>
              <button
                class="button button-quiet"
                type="button"
                disabled={account.signingOut.value}
                onClick={() => {
                  run(account.signOut());
                }}
              >
                Sign out
              </button>
            </div>
          </div>
        </section>

        <section class="settings-group" aria-labelledby="settings-profiles">
          <div>
            <h2 id="settings-profiles">Profiles</h2>
            <p class="muted small">Where your profiles are kept.</p>
          </div>
          {connecting ? (
            <div class="settings">
              <ConnectForm
                profiles={profiles}
                repositories={repositories}
                onClose={() => {
                  setConnecting(false);
                }}
              />
            </div>
          ) : (
            <div class="settings">
              {profiles.connectError.value !== undefined && (
                <p class="setting-row problem" role="alert">
                  Couldn't use the repository: {profiles.connectError.value}
                </p>
              )}
              <div class="setting-row">
                <div class="setting-text">
                  <strong>{onGitHub ? 'In a GitHub repository' : 'In this browser'}</strong>
                  {onGitHub ? (
                    <span class="mono small">
                      {source.repository}
                      {source.path === '' ? '' : `/${source.path}`}
                    </span>
                  ) : (
                    <span class="muted small">
                      {keeping === 'visit-only'
                        ? 'This browser keeps no files for the site, so they last until the tab closes.'
                        : 'Only this browser has them. Clearing the site’s data deletes them.'}
                    </span>
                  )}
                  <SyncNote profiles={profiles} />
                </div>
                <button
                  class="button button-quiet"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    run(profiles.refresh());
                  }}
                >
                  {onGitHub ? 'Sync now' : 'Refresh'}
                </button>
              </div>
              <div class="setting-row">
                <div class="setting-text">
                  <strong>{onGitHub ? 'Use another repository' : 'Keep profiles on GitHub'}</strong>
                  <span class="muted small">Profiles follow you to any browser and keep their history.</span>
                </div>
                <button
                  class="button button-quiet"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setConnecting(true);
                  }}
                >
                  {onGitHub ? 'Change repository…' : 'Use a GitHub repository…'}
                </button>
              </div>
              {onGitHub && (
                <div class="setting-row">
                  <div class="setting-text">
                    <strong>Keep profiles in this browser</strong>
                    <span class="muted small">The repository keeps every profile it has.</span>
                  </div>
                  <button
                    class="button button-quiet"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      run(profiles.keepInBrowser());
                    }}
                  >
                    Use this browser
                  </button>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
