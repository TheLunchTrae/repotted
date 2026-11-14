import type { Signal } from '@preact/signals';
import type { GitHub } from '@repotted/core';
import type { JSX } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';

import type { Account, User } from '../app/account.js';
import { Apply } from '../app/apply.js';
import { BatchApply } from '../app/batch-apply.js';
import { Comparison } from '../app/comparison.js';
import type { Keeping } from '../app/kept-files.js';
import type { LocalFolders } from '../app/local-folder.js';
import type { Preferences } from '../app/preferences.js';
import { Profiles } from '../app/profiles.js';
import { Repositories } from '../app/repositories.js';
import type { Router } from '../app/router.js';
import { SharedPreferences } from '../app/shared-preferences.js';
import { ApplyPage } from './apply.js';
import { BatchPage } from './batch.js';
import { ComparePage } from './compare.js';
import { SignOutQuestion } from './leave.js';
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
  '/compare': 'Compare',
  '/apply': 'Apply',
  '/batch': 'Apply to several',
};

interface AppProps {
  readonly account: Account;
  readonly github: GitHub;
  readonly preferences: Preferences;
  readonly router: Router;
  /** Whether the browser keeps the engine's files between visits. */
  readonly keeping: Signal<Keeping>;
  /** The browser's way to a folder on this computer. */
  readonly folders: LocalFolders;
}

function SignedIn({
  account,
  github,
  preferences,
  router,
  keeping,
  folders,
  user,
}: AppProps & { readonly user: User }): JSX.Element {
  // One of each per sign-in. The repository list is the account's; the profiles are the browser's, whoever signs in.
  const { repositories, profiles, comparison, apply, batch } = useMemo(() => {
    const refused = (): void => {
      account.refused();
    };
    const kept = new Profiles(github, preferences, refused, folders);
    // The hidden repositories and owners follow the profiles: to their repository, or this browser. Using
    // the profiles' place from the start means the first list shows what that place hides.
    const shared = new SharedPreferences(github, preferences, refused);
    run(shared.use(kept.source.value));
    return {
      repositories: new Repositories(github, user, shared, refused),
      profiles: kept,
      comparison: new Comparison(github, refused),
      // An apply's edits saved to a profile take their turn among the profiles' syncs.
      apply: new Apply(github, refused, (work) => kept.write(work)),
      batch: new BatchApply(github, refused),
    };
  }, [account, github, preferences, folders, user]);
  useEffect(() => {
    run(repositories.refresh());
    run(profiles.refresh());
  }, [repositories, profiles]);
  const source = profiles.source.value;
  useEffect(() => {
    run(repositories.preferences.use(source));
  }, [repositories, source]);
  // The repository a new profile was asked to capture, from the repositories page.
  const [captureFrom, setCaptureFrom] = useState<string | undefined>(undefined);
  // The browser asks before a reload or a closed tab discards changes that aren't saved.
  useEffect(() => {
    const ask = (event: BeforeUnloadEvent): void => {
      if (profiles.unsaved.value.size > 0 || apply.editor.value?.dirty.value === true) {
        event.preventDefault();
      }
    };
    window.addEventListener('beforeunload', ask);
    return () => {
      window.removeEventListener('beforeunload', ask);
    };
  }, [profiles, apply]);
  const path = router.path.value;
  // A comparison is put away with its page, so one still being made shows nothing later.
  useEffect(() => {
    if (path !== '/compare') {
      comparison.close();
    }
    // An apply left before it is finished is kept, to pick up from its repository.
    if (path !== '/apply') {
      apply.close();
    }
    if (path !== '/batch') {
      batch.close();
    }
  }, [path, comparison, apply, batch]);
  useEffect(() => {
    if (path !== '/profiles/new') {
      setCaptureFrom(undefined);
    }
  }, [path]);
  const title = titles[path];
  useEffect(() => {
    document.title = title === undefined ? 'Repotted' : `${title} - Repotted`;
  }, [title]);
  const [leaving, setLeaving] = useState(false);
  /** Whether a press of Sign out did nothing because an apply was writing. */
  const [held, setHeld] = useState(false);
  const leave = (): void => {
    // An apply's edits that can be saved are, as when its page is left.
    apply.close();
    run(account.signOut());
  };
  const writing = apply.state.value.kind === 'applying' || batch.state.value.kind === 'applying';
  // Signing out drops what the profiles' editors hold, so unsaved changes are asked about first,
  // and it ends the sign-in an apply that is writing still needs.
  const signOut = (): void => {
    if (writing) {
      setHeld(true);
      return;
    }
    setHeld(false);
    if (profiles.unsaved.value.size > 0) {
      setLeaving(true);
    } else {
      leave();
    }
  };
  // The account menu, where this is also said, closes with the question, so it is said on the page too.
  const signOutProblem =
    held && writing
      ? 'Changes are being written to GitHub. Sign out once the apply has finished.'
      : account.signOutError.value;
  return (
    <Shell account={account} user={user} router={router} onSignOut={signOut}>
      {signOutProblem !== undefined && (
        <p class="notice notice-problem shell-notice" role="alert">
          {signOutProblem}
        </p>
      )}
      {leaving && (
        <SignOutQuestion
          profiles={profiles}
          onLeave={leave}
          onClose={() => {
            setLeaving(false);
          }}
        />
      )}
      {keeping.value === 'stopped' && (
        <p class="notice notice-problem shell-notice" role="alert">
          This browser stopped keeping your changes, as it does when its storage is full. What you change now lasts
          until this tab closes. Free some space, then reload the page.
        </p>
      )}
      {path === '/' ? (
        <RepositoriesPage
          repositories={repositories}
          profiles={profiles}
          onCapture={(repository) => {
            setCaptureFrom(repository);
            router.go('/profiles/new');
          }}
          batch={batch}
          onBatch={(names, profile) => {
            run(
              (profile === undefined ? batch.resume() : batch.start(names, profile)).then(() => {
                // The ticks have done their work once a batch started from them holds the repositories.
                if (profile !== undefined && batch.state.value.kind === 'reviewed') {
                  repositories.clearTicks();
                }
              }),
            );
            router.go('/batch');
          }}
          apply={apply}
          onApply={(repository, profile) => {
            run(
              profile === undefined
                ? apply.pickUp(repository)
                : profile === 'once'
                  ? apply.startWithoutProfile(repository)
                  : apply.start(repository, profile),
            );
            router.go('/apply');
          }}
          onCompare={(repository, profile) => {
            run(comparison.compare(repository, profile));
            router.go('/compare');
          }}
        />
      ) : path === '/batch' ? (
        <BatchPage batch={batch} router={router} />
      ) : path === '/apply' ? (
        <ApplyPage apply={apply} router={router} />
      ) : path === '/compare' ? (
        <ComparePage comparison={comparison} router={router} />
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
          onSignOut={signOut}
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
