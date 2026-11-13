// A placeholder page that proves the sign-in and the engine end to end: it
// signs in with GitHub through the Worker and has the engine read who is
// signed in.

import { currentUser, GitHubError } from '@repotted/core';

import { sessionGitHub } from './engine/github.js';
import { Session } from './session.js';

const failures: Record<string, string> = {
  denied: 'The sign-in was cancelled on GitHub.',
  expired: 'That sign-in expired. Sign in again.',
  failed: "GitHub didn't complete the sign-in. Try again.",
};

const session = new Session();
const github = sessionGitHub(session);

function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const found = document.getElementById(id);
  if (!(found instanceof type)) {
    throw new TypeError(`The page has no #${id} of the expected kind.`);
  }
  return found;
}

const status = element('status', HTMLElement);
const signInLink = element('sign-in', HTMLAnchorElement);
const account = element('account', HTMLElement);
const avatar = element('avatar', HTMLImageElement);
const login = element('login', HTMLElement);
const signOutButton = element('sign-out', HTMLButtonElement);

function showSignedOut(message: string): void {
  status.textContent = message;
  account.hidden = true;
  signInLink.hidden = false;
}

async function show(failure: string | undefined): Promise<void> {
  let user: Awaited<ReturnType<typeof currentUser>>;
  try {
    user = await currentUser(github);
  } catch (error) {
    if (error instanceof GitHubError && error.status === 401) {
      showSignedOut(failure ?? 'Sign in to manage your repositories.');
    } else {
      status.textContent = "Repotted can't reach GitHub right now. Reload to try again.";
    }
    return;
  }
  status.textContent = 'Signed in.';
  login.textContent = user.name ?? user.login;
  avatar.src = `https://avatars.githubusercontent.com/${encodeURIComponent(user.login)}?size=80`;
  signInLink.hidden = true;
  account.hidden = false;
}

signOutButton.addEventListener('click', () => {
  signOutButton.disabled = true;
  session
    .signOut()
    .then(() => showSignedOut('Signed out.'))
    .catch(() => {
      status.textContent = "Signing out didn't finish. Try again.";
    })
    .finally(() => {
      signOutButton.disabled = false;
    });
});

// The Worker reports a failed sign-in in the query; drop it so a reload
// doesn't show it again.
const reason = new URLSearchParams(location.search).get('sign-in');
if (reason !== null) {
  history.replaceState(null, '', location.pathname);
}
show(reason === null ? undefined : (failures[reason] ?? failures['failed'])).catch(() => {
  status.textContent = "Repotted can't reach GitHub right now. Reload to try again.";
});
