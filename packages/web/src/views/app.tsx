import type { GitHub } from '@repotted/core';
import type { JSX } from 'preact';
import { useMemo } from 'preact/hooks';

import type { Account, User } from '../app/account.js';
import type { Preferences } from '../app/preferences.js';
import { Repositories } from '../app/repositories.js';
import { RepositoriesPage } from './repositories.js';
import { run } from './run.js';
import { Shell } from './shell.js';
import { SignIn } from './sign-in.js';

interface AppProps {
  readonly account: Account;
  readonly github: GitHub;
  readonly preferences: Preferences;
}

function SignedIn({ account, github, preferences, user }: AppProps & { readonly user: User }): JSX.Element {
  // One per sign-in, so nothing of one account's list shows under another.
  const repositories = useMemo(() => {
    const model = new Repositories(github, user, preferences, () => {
      account.refused();
    });
    run(model.refresh());
    return model;
  }, [account, github, preferences, user]);
  return (
    <Shell account={account} user={user}>
      <RepositoriesPage repositories={repositories} />
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
