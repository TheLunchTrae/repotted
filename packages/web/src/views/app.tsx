import type { Signal } from '@preact/signals';
import type { GitHub } from '@repotted/core';
import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import type { Account, User } from '../app/account/account.js';
import { Apply } from '../app/apply/apply.js';
import { BatchApply } from '../app/apply/batch-apply.js';
import { Comparison } from '../app/apply/comparison.js';
import { AddressedRepository } from '../app/navigation/addressed-repository.js';
import type { Router } from '../app/navigation/router.js';
import { Notifications } from '../app/notifications.js';
import { repositoryFoldersKey } from '../app/preferences/preference-changes.js';
import type { BrowserPreferences } from '../app/preferences/preferences.js';
import { SharedPreferences } from '../app/preferences/shared-preferences.js';
import { BranchPreview } from '../app/profiles/branch-preview.js';
import { ConfigDiscovery } from '../app/profiles/config-discovery.js';
import { ConfigProtection } from '../app/profiles/config-protection.js';
import { definitionTypes } from '../app/profiles/definition-types.js';
import type { LocalFolders } from '../app/profiles/local-folder.js';
import { Profiles } from '../app/profiles/profiles.js';
import { reviewAssignedProfiles } from '../app/repositories/profile-reviews.js';
import { Repositories } from '../app/repositories/repositories.js';
import { RepositoryProfiles } from '../app/repositories/repository-profiles.js';
import { repositoryProfilesKey } from '../app/repositories/saved-assignments.js';
import type { Keeping } from '../app/storage/kept-files.js';
import { SignIn } from './account/sign-in.js';
import { ApplyPage } from './apply/apply.js';
import { BatchPage } from './apply/batch.js';
import { ComparePage } from './apply/compare.js';
import { Link } from './layout/link.js';
import { NotificationContext, Toasts } from './layout/notifications.js';
import { run } from './layout/run.js';
import { Shell } from './layout/shell.js';
import { BranchPreviewPage } from './profiles/branch-preview.js';
import { DefinitionsPage } from './profiles/definitions.js';
import { FoundConfig } from './profiles/found-config.js';
import { SignOutQuestion } from './profiles/leave.js';
import { ProfilesPage } from './profiles/profiles.js';
import { RepositoriesPage } from './repositories/repositories.js';
import { SettingsPage } from './settings/settings.js';

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
  readonly preferences: BrowserPreferences;
  readonly router: Router;
  readonly keeping: Signal<Keeping>;
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
  const notifications = useMemo(() => new Notifications(), []);
  const {
    repositories,
    profiles,
    assignments,
    discovery,
    comparison,
    apply,
    batch,
    protection,
    preview,
    reviewProfiles,
  } = useMemo(() => {
    const refused = (): void => {
      account.gitHubRefusedSignIn();
    };
    const kept = new Profiles(github, preferences, refused, folders);
    // The hidden repositories and owners follow the profiles: to their repository, or this browser. Using
    // the profiles' place from the start means the first list shows what that place hides. Folders follow them
    // too, but which folders are closed stays in this browser, so opening one commits nothing.
    const shared = new SharedPreferences(github, preferences, refused, (keys, destination) => {
      if (keys.includes(repositoryProfilesKey)) {
        notifications.show({
          message: 'Repository profiles saved.',
          detail: destination === 'repository' ? 'Synced with GitHub.' : 'Saved in this browser.',
        });
      }
    });
    run(shared.use(kept.source.value));
    // Which profiles each repository uses follows the profiles too, since it names them by their paths.
    const assigned = new RepositoryProfiles(shared, kept);
    kept.protectAssignments((files) =>
      assigned.repositoriesWithProfiles.value.filter((repository) =>
        assigned.profilesOf(repository).some((path) => files.includes(assigned.fileOf(path))),
      ),
    );
    const applying = new Apply(github, refused, (work) => kept.write(work), assigned);
    const batching = new BatchApply(github, refused, assigned, (count) => {
      notifications.show({ message: `Applied to ${count === 1 ? '1 repository' : `${count} repositories`}.` });
    });
    const reviewProfiles = (names: readonly string[]): boolean => {
      const review = reviewAssignedProfiles(names, assigned, kept.folder.value, applying, batching);
      if (review === undefined) {
        return false;
      }
      run(review.work);
      router.go(review.path);
      return true;
    };
    return {
      repositories: new Repositories(github, user, shared, preferences, refused, reviewProfiles),
      profiles: kept,
      assignments: assigned,
      discovery: new ConfigDiscovery(github, kept, refused),
      comparison: new Comparison(github, refused),
      // An apply's edits saved to a profile take their turn among the profiles' syncs.
      apply: applying,
      batch: batching,
      protection: new ConfigProtection(github, refused),
      preview: new BranchPreview(github, kept, refused),
      reviewProfiles,
    };
  }, [account, github, preferences, folders, user, router, notifications]);
  const address = useMemo(() => new AddressedRepository(repositories, router), [repositories, router]);
  const applyWriting = apply.state.value.kind === 'applying' || batch.state.value.kind === 'applying';
  useEffect(() => {
    run(repositories.load());
    run(profiles.refresh());
  }, [repositories, profiles]);
  // Looked for once the first list arrives, since it carries each repository's topics.
  const listed = repositories.list.value;
  useEffect(() => {
    if (listed !== undefined) {
      run(discovery.look(listed.repositories));
    }
  }, [discovery, listed]);
  const source = profiles.source.value;
  useEffect(() => {
    run(repositories.preferences.use(source));
  }, [repositories, source]);
  // Each profile a repository uses is read again whenever the profiles or the lists change.
  const listings = profiles.listings.value;
  const savedAssignments = repositories.preferences.read(repositoryProfilesKey);
  const savedFolders = repositories.preferences.read(repositoryFoldersKey);
  useEffect(() => {
    run(assignments.check());
  }, [assignments, listings, savedAssignments, savedFolders]);
  const [repositoryToCapture, setRepositoryToCapture] = useState<string | undefined>(undefined);
  const openingProtection = useRef(false);
  useEffect(() => {
    const ask = (event: BeforeUnloadEvent): void => {
      if (
        profiles.unsaved.value.size > 0 ||
        apply.editor.value?.dirty.value === true ||
        batch.editor.value?.dirty.value === true
      ) {
        event.preventDefault();
      }
    };
    window.addEventListener('beforeunload', ask);
    return () => {
      window.removeEventListener('beforeunload', ask);
    };
  }, [profiles, apply, batch]);
  const path = router.path.value;
  const library = definitionTypes.find((definition) => definition.path === path);
  const previewedBranch = path === '/profiles' ? (new URLSearchParams(router.search.value).get('preview') ?? '') : '';
  // A preview is of the profiles' repository, so it goes when they are kept somewhere else, before
  // the one the address asks for opens of the new one.
  useEffect(() => {
    run(preview.close());
  }, [source, preview]);
  useEffect(() => {
    if (previewedBranch !== '') {
      run(preview.open(previewedBranch));
    } else if (path !== '/compare') {
      // A comparison made from the preview comes back to it, so the preview waits while one is open.
      run(preview.close());
    }
  }, [previewedBranch, path, preview, source]);
  // A comparison is put away with its page, so one still being made shows nothing later.
  useEffect(() => {
    if (path !== '/compare') {
      comparison.close();
    }
    // Pending applies belong to their pages; a write already under way finishes.
    if (path !== '/apply') {
      run(apply.close());
    }
    if (path !== '/batch') {
      run(batch.close());
    }
  }, [path, comparison, apply, batch]);
  useEffect(() => {
    if (path !== '/profiles/new') {
      setRepositoryToCapture(undefined);
    }
  }, [path]);
  const title = library?.title ?? titles[path];
  useEffect(() => {
    document.title = title === undefined ? 'Repotted' : `${title} - Repotted`;
  }, [title]);
  const [leaving, setLeaving] = useState(false);
  const [signOutBlockedWhileApplyWrites, setSignOutBlockedWhileApplyWrites] = useState(false);
  const leave = (): void => {
    run(Promise.all([apply.close(), batch.close()]).then(() => account.signOut()));
  };
  const writing = apply.state.value.kind === 'applying' || batch.state.value.kind === 'applying';
  // Signing out drops what the profiles' editors hold, so unsaved changes are asked about first,
  // and it ends the sign-in an apply that is writing still needs.
  const signOut = (): void => {
    if (writing) {
      setSignOutBlockedWhileApplyWrites(true);
      return;
    }
    setSignOutBlockedWhileApplyWrites(false);
    if (profiles.unsaved.value.size > 0) {
      setLeaving(true);
    } else {
      leave();
    }
  };
  // The account menu, where this is also said, closes with the question, so it is said on the page too.
  const signOutProblem =
    signOutBlockedWhileApplyWrites && writing
      ? 'Changes are being written to GitHub. Sign out once the apply has finished.'
      : account.signOutError.value;
  return (
    <NotificationContext.Provider value={notifications}>
      <Shell account={account} user={user} router={router} onSignOut={signOut}>
        {signOutProblem !== undefined && (
          <p class="notice notice-problem shell-notice" role="alert">
            {signOutProblem}
          </p>
        )}
        <FoundConfig discovery={discovery} profiles={profiles} />
        {repositories.moveReviewNotice.value !== undefined && (
          <div class="notice notice-drift shell-notice" role="status">
            <p>{repositories.moveReviewNotice.value}</p>
            <button
              class="button button-quiet button-small"
              type="button"
              onClick={() => {
                repositories.moveReviewNotice.value = undefined;
              }}
            >
              Dismiss
            </button>
          </div>
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
            address={address}
            profiles={profiles}
            onCapture={(repository) => {
              setRepositoryToCapture(repository);
              router.go('/profiles/new');
            }}
            onBatch={(names, profile) => {
              run(
                (profile === 'once' ? batch.startWithoutProfile(names) : batch.start(names, profile)).then(() => {
                  // The selection has done its work once a batch started from it holds the repositories.
                  if (batch.state.value.kind === 'reviewed' || batch.state.value.kind === 'editing') {
                    repositories.deselectAll();
                  }
                }),
              );
              router.go('/batch');
            }}
            onApply={(repository, profile) => {
              run(profile === 'once' ? apply.startWithoutProfile(repository) : apply.start(repository, profile));
              router.go('/apply');
            }}
            onApplyProfiles={(repository, assigned) => {
              run(apply.startFromProfiles(repository, assigned));
              router.go('/apply');
            }}
            assignments={assignments}
            onReviewProfiles={reviewProfiles}
            applyWriting={applyWriting}
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
        ) : previewedBranch !== '' ? (
          <BranchPreviewPage
            preview={preview}
            repositories={repositories}
            router={router}
            branch={previewedBranch}
            onCompare={(repository, profile) => {
              run(comparison.compare(repository, profile));
              router.go('/compare');
            }}
          />
        ) : library !== undefined ? (
          <DefinitionsPage
            key={library.kind}
            kind={library.kind}
            profiles={profiles}
            repositories={repositories}
            router={router}
          />
        ) : path === '/profiles' || path === '/profiles/new' ? (
          <ProfilesPage
            profiles={profiles}
            repositories={repositories}
            router={router}
            preview={preview}
            newProfileForm={path === '/profiles/new' ? { repository: repositoryToCapture } : undefined}
          />
        ) : path === '/settings' ? (
          <SettingsPage
            account={account}
            user={user}
            profiles={profiles}
            repositories={repositories}
            keeping={keeping.value}
            protection={protection}
            onReviewProtection={() => {
              const state = protection.state.value;
              // A second press while the first is starting would start a second apply over the first.
              if (state.kind === 'checked' && !openingProtection.current) {
                openingProtection.current = true;
                return protection
                  .writeProfileForApply()
                  .then((profile) => {
                    if (profile !== undefined) {
                      router.go('/apply');
                      return apply.start(state.repository, profile);
                    }
                    return undefined;
                  })
                  .finally(() => {
                    openingProtection.current = false;
                  });
              }
              return Promise.resolve();
            }}
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
      <Toasts notifications={notifications} />
    </NotificationContext.Provider>
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
