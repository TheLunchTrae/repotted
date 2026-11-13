import type { GitHub } from '@repotted/core';
import type { JSX } from 'preact';
import { useEffect, useMemo } from 'preact/hooks';

import type { Account, User } from '../app/account.js';
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

interface AppProps {
  readonly account: Account;
  readonly github: GitHub;
  readonly preferences: Preferences;
  readonly router: Router;
  /** Whether the browser keeps files between visits. */
  readonly keepsFiles: boolean;
}

function SignedIn({
  account,
  github,
  preferences,
  router,
  keepsFiles,
  user,
}: AppProps & { readonly user: User }): JSX.Element {
  // One of each per sign-in, so nothing of one account's shows under another.
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
  const path = router.path.value;
  return (
    <Shell account={account} user={user} router={router}>
      {path === '/' ? (
        <RepositoriesPage repositories={repositories} />
      ) : path === '/profiles' ? (
        <ProfilesPage profiles={profiles} router={router} />
      ) : path === '/settings' ? (
        <SettingsPage
          account={account}
          user={user}
          profiles={profiles}
          repositories={repositories}
          keepsFiles={keepsFiles}
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
  if (state.status === 'signed-in') {
    return <SignedIn {...props} user={state.user} />;
  }
  return <SignIn account={props.account} />;
}
