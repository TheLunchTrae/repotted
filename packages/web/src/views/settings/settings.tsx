import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import type { Account, User } from '../../app/account/account.js';
import { repottedAppInstallUrl } from '../../app/account/github-app.js';
import type { ConfigProtection } from '../../app/profiles/config-protection.js';
import type { Profiles } from '../../app/profiles/profiles.js';
import type { Repositories } from '../../app/repositories/repositories.js';
import type { Keeping } from '../../app/storage/kept-files.js';
import { run } from '../layout/run.js';
import { SyncNote } from '../profiles/sync-note.js';

interface ConnectFormProps {
  readonly profiles: Profiles;
  readonly repositories: Repositories;
  readonly onClose: () => void;
  /** Called once the profiles are kept in the repository named. */
  readonly onConnected: () => void;
}

function ConnectForm({ profiles, repositories, onClose, onConnected }: ConnectFormProps): JSX.Element {
  const source = profiles.source.value;
  const [repository, setRepository] = useState(source.kind === 'repository' ? source.repository : '');
  const [path, setPath] = useState(source.kind === 'repository' ? source.path : '');
  const [addLocal, setAddLocal] = useState(false);
  const [working, setWorking] = useState(false);
  const error = profiles.connectError.value;
  const count = profiles.listings.value.length;
  const alreadyKeptThere =
    source.kind === 'repository' &&
    source.repository.toLowerCase() === repository.trim().toLowerCase() &&
    source.path === path.trim().replace(/^\/+|\/+$/gu, '');

  const connect = async (): Promise<void> => {
    setWorking(true);
    const problem = await profiles.connect(repository, path, addLocal && !alreadyKeptThere);
    setWorking(false);
    if (problem === undefined) {
      onConnected();
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
      {count > 0 && !alreadyKeptThere && (
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
            {source.kind === 'browser' ? 'this browser' : source.kind === 'folder' ? source.name : source.repository}
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

const protectionText =
  'Stops the default branch from being deleted or force pushed, and keeps workflow tokens read-only. Your profiles still commit straight to it.';

interface ProtectionProps {
  readonly protection: ConfigProtection;
  /** The repository the profiles are kept in. */
  readonly repository: string;
  readonly onReview: () => void;
}

/** The offer to protect the repository the profiles were just put in, until it is taken or put off. */
function ProtectionOffer({
  protection,
  repository,
  onReview,
  onDismiss,
}: ProtectionProps & { readonly onDismiss: () => void }): JSX.Element | null {
  const state = protection.state.value;
  if (state.kind !== 'checked' || state.repository !== repository || state.changeCount === 0) {
    return null;
  }
  return (
    <div class="notice" role="region" aria-labelledby="protection-offer">
      <strong id="protection-offer">
        Protect <span class="mono">{repository}</span>?
      </strong>
      <p class="small">
        Repotted has a built-in protection for a personal config repository: it blocks deleting and force pushing the
        default branch and keeps workflow tokens read-only. You review the changes before anything is applied.
      </p>
      <div class="notice-actions">
        <button class="button button-primary" type="button" onClick={onReview}>
          Review protection…
        </button>
        <button class="button button-quiet" type="button" onClick={onDismiss}>
          Not now
        </button>
      </div>
    </div>
  );
}

/** Whether the repository the profiles are kept in has Repotted's built-in protection, with the way to apply it. */
function ProtectionRow({ protection, repository, onReview }: ProtectionProps): JSX.Element | null {
  const state = protection.state.value;
  if (state.kind === 'idle' || state.kind === 'none' || state.repository !== repository) {
    return null;
  }
  const limits = state.kind === 'checked' ? state.limits.join('; ') : '';
  return (
    <div class="setting-row">
      <div class="setting-text">
        <strong>Protect this repository</strong>
        <span class="muted small">{protectionText}</span>
        {state.kind === 'checking' ? (
          <span class="muted small" role="status">
            Checking the repository…
          </span>
        ) : state.kind === 'failed' ? (
          <span class="problem small" role="alert">
            Couldn't check the repository. {/[.!?]$/u.test(state.message) ? state.message : `${state.message}.`}
          </span>
        ) : (
          <span class="muted small" role="status">
            {state.changeCount === 0
              ? limits === ''
                ? 'Protected.'
                : `Protected as far as GitHub allows here: ${limits}.`
              : `Not protected: ${state.changeCount === 1 ? '1 change' : `${state.changeCount} changes`} to review.${
                  limits === '' ? '' : ` GitHub can't add all of it here: ${limits}.`
                }`}
          </span>
        )}
      </div>
      {state.kind === 'failed' ? (
        <button
          class="button button-quiet"
          type="button"
          onClick={() => {
            run(protection.check(repository));
          }}
        >
          Check again
        </button>
      ) : (
        state.kind === 'checked' &&
        state.changeCount > 0 && (
          <button class="button button-quiet" type="button" onClick={onReview}>
            Review protection…
          </button>
        )
      )}
    </div>
  );
}

interface SettingsProps {
  readonly account: Account;
  readonly user: User;
  readonly profiles: Profiles;
  readonly repositories: Repositories;
  readonly keeping: Keeping;
  readonly protection: ConfigProtection;
  readonly onReviewProtection: () => void;
  readonly onSignOut: () => void;
}

export function SettingsPage({
  account,
  user,
  profiles,
  repositories,
  keeping,
  protection,
  onReviewProtection,
  onSignOut,
}: SettingsProps): JSX.Element {
  const [connecting, setConnecting] = useState(false);
  // The repository the profiles were just put in, which the protection is offered for until it is put off.
  const [offered, setOffered] = useState<string | undefined>(undefined);
  const source = profiles.source.value;
  const kept = source.kind === 'repository' ? source.repository : undefined;
  useEffect(() => {
    if (kept === undefined) {
      protection.forget();
    } else {
      run(protection.check(kept));
    }
  }, [protection, kept]);
  const busy = profiles.profileWorkUnderWay.value;
  const onGitHub = source.kind === 'repository';
  const inFolder = source.kind === 'folder';
  const [addToFolder, setAddToFolder] = useState(false);
  const count = profiles.listings.value.length;

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
              <a class="button button-quiet" href={repottedAppInstallUrl} target="_blank" rel="noreferrer">
                Add repositories
              </a>
              <button class="button button-quiet" type="button" disabled={account.signingOut.value} onClick={onSignOut}>
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
                onConnected={() => {
                  // Read when the form closes, by when the profiles are kept in the repository.
                  const now = profiles.source.peek();
                  setOffered(now.kind === 'repository' ? now.repository : undefined);
                }}
              />
            </div>
          ) : (
            <>
              {kept !== undefined && offered === kept && (
                <ProtectionOffer
                  protection={protection}
                  repository={kept}
                  onReview={onReviewProtection}
                  onDismiss={() => {
                    setOffered(undefined);
                  }}
                />
              )}
              <div class="settings">
                {profiles.connectError.value !== undefined && (
                  <p class="setting-row problem" role="alert">
                    Couldn't change where profiles are kept: {profiles.connectError.value}
                  </p>
                )}
                <div class="setting-row">
                  <div class="setting-text">
                    <strong>
                      {onGitHub
                        ? 'In a GitHub repository'
                        : inFolder
                          ? 'In a folder on this computer'
                          : 'In this browser'}
                    </strong>
                    {onGitHub ? (
                      <span class="mono small">
                        {source.repository}
                        {source.path === '' ? '' : `/${source.path}`}
                      </span>
                    ) : inFolder ? (
                      <span class="mono small">{source.name}</span>
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
                    {onGitHub || inFolder ? 'Sync now' : 'Refresh'}
                  </button>
                </div>
                {kept !== undefined && (
                  <ProtectionRow protection={protection} repository={kept} onReview={onReviewProtection} />
                )}
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
                <div class="setting-row">
                  <div class="setting-text">
                    <strong>{inFolder ? 'Use another folder' : 'Keep profiles in a folder on this computer'}</strong>
                    {profiles.foldersSupported ? (
                      <>
                        <span class="muted small">
                          Profiles are files in a folder you pick, which other tools can read and change. Pick one that
                          holds only profiles: every YAML file in it and its subfolders is read as one. The browser may
                          ask again on a later visit before Repotted uses it.
                        </span>
                        {!inFolder && count > 0 && (
                          <label class="check small">
                            <input
                              type="checkbox"
                              checked={addToFolder}
                              onChange={(event) => {
                                setAddToFolder(event.currentTarget.checked);
                              }}
                            />
                            <span>
                              Add the {count === 1 ? 'profile' : `${count} profiles`} from{' '}
                              {source.kind === 'browser' ? 'this browser' : source.repository}
                            </span>
                          </label>
                        )}
                      </>
                    ) : (
                      <span class="muted small">
                        This browser can't give a site a folder. Chrome, Edge, and other Chromium browsers can.
                      </span>
                    )}
                  </div>
                  {profiles.foldersSupported && (
                    <button
                      class="button button-quiet"
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        run(profiles.useFolder(addToFolder && !inFolder));
                      }}
                    >
                      {inFolder ? 'Change folder…' : 'Choose a folder…'}
                    </button>
                  )}
                </div>
                {(onGitHub || inFolder) && (
                  <div class="setting-row">
                    <div class="setting-text">
                      <strong>Keep profiles in this browser</strong>
                      <span class="muted small">
                        {onGitHub
                          ? 'The repository keeps every profile it has.'
                          : 'The folder keeps every profile it has.'}
                      </span>
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
            </>
          )}
        </section>
      </div>
    </div>
  );
}
