import type { Signal } from '@preact/signals';
import type { GitHub } from '@repotted/core';
import type { JSX } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';

import type { Account, User } from '../app/account.js';
import type { Keeping } from '../app/kept-files.js';
import type { Preferences } from '../app/preferences.js';
import { Profiles } from '../app/profiles.js';
import { Repositories } from '../app/repositories.js';
import type { Router } from '../app/router.js';
import { Link } from './link.js';
import { ProfilesPage } from './profiles.js';
import { RepositoriesPage } from './repositories.js';
import { run } from './run.js';
import { SettingsPage } from './settings.js';
import { Shell } from './shell.js';
import { SignIn } from './sign-in.js';

const titles: Readonly<Record<string, string>> = {
  '/': 'Repositories',
  '/profiles': 'Profiles',
  '/profiles/new': 'New profile',
  '/settings': 'Settings',
};

interface AppProps {
  readonly account: Account;
  readonly github: GitHub;
  readonly preferences: Preferences;
  readonly router: Router;
  /** Whether the browser keeps the engine's files between visits. */
  readonly keeping: Signal<Keeping>;
}

function SignedIn({
  account,
  github,
  preferences,
  router,
  keeping,
  user,
}: AppProps & { readonly user: User }): JSX.Element {
  // One of each per sign-in. The repository list is the account's; the profiles are the browser's, whoever signs in.
  const { repositories, profiles } = useMemo(() => {
    const refused = (): void => {
      account.refused();
    };
    return {
      repositories: new Repositories(github, user, preferences, refused),
      profiles: new Profiles(github, preferences, refused),
    };
  }, [account, github, preferences, user]);
  useEffect(() => {
    run(repositories.refresh());
    run(profiles.refresh());
  }, [repositories, profiles]);
  // The repository a new profile was asked to capture, from the repositories page.
  const [captureFrom, setCaptureFrom] = useState<string | undefined>(undefined);
  const path = router.path.value;
  useEffect(() => {
    if (path !== '/profiles/new') {
      setCaptureFrom(undefined);
    }
  }, [path]);
  const title = titles[path];
  useEffect(() => {
    document.title = title === undefined ? 'Repotted' : `${title} - Repotted`;
  }, [title]);
  return (
    <Shell account={account} user={user} router={router}>
      {keeping.value === 'stopped' && (
        <p class="notice notice-problem shell-notice" role="alert">
          This browser stopped keeping your changes, as it does when its storage is full. What you change now lasts
          until this tab closes. Free some space, then reload the page.
        </p>
      )}
      {path === '/' ? (
        <RepositoriesPage
          repositories={repositories}
          onCapture={(repository) => {
            setCaptureFrom(repository);
            router.go('/profiles/new');
          }}
        />
      ) : path === '/profiles' || path === '/profiles/new' ? (
        <ProfilesPage
          profiles={profiles}
          repositories={repositories}
          router={router}
          creating={path === '/profiles/new' ? { repository: captureFrom } : undefined}
        />
      ) : path === '/settings' ? (
        <SettingsPage
          account={account}
          user={user}
          profiles={profiles}
          repositories={repositories}
          keeping={keeping.value}
        />
      ) : (
        <div class="page">
          <div class="page-body">
            <h1>There's no page here</h1>
            <p>
              <Link router={router} to="/">
                Go to your repositories
              </Link>
            </p>
          </div>
        </div>
      )}
    </Shell>
  );
}

export function App(props: AppProps): JSX.Element {
  const state = props.account.state.value;
  if (props.keeping.value === 'elsewhere') {
    return (
      <main class="sign-in">
        <div class="sign-in-card">
          <p class="wordmark">Repotted</p>
          <h1>Repotted is open in another tab</h1>
          <p class="muted">
            One tab at a time keeps your profiles, so that two can't save over each other. Go on in the other tab, or
            close it and reload this one.
          </p>
          <button
            class="button button-primary"
            type="button"
            onClick={() => {
              location.reload();
            }}
          >
            Reload
          </button>
        </div>
      </main>
    );
  }
  if (state.status === 'signed-in') {
    return <SignedIn {...props} user={state.user} />;
  }
  return <SignIn account={props.account} />;
}
