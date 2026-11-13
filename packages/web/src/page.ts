// A placeholder page that proves the sign-in end to end: it signs in with
// GitHub through the Worker and shows who is signed in.

import * as z from 'zod/mini';

import { Session } from './session.js';

const failures: Record<string, string> = {
  denied: 'The sign-in was cancelled on GitHub.',
  expired: 'That sign-in expired. Sign in again.',
  failed: "GitHub didn't complete the sign-in. Try again.",
};

const session = new Session();
const gitHubUser = z.object({ login: z.string(), avatar_url: z.string() });

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
  let token: string | undefined;
  try {
    token = await session.accessToken();
  } catch {
    status.textContent = "Repotted can't reach GitHub right now. Reload to try again.";
    return;
  }
  if (token === undefined) {
    showSignedOut(failure ?? 'Sign in to manage your repositories.');
    return;
  }
  const response = await fetch('https://api.github.com/user', {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` },
  }).catch(() => undefined);
  if (response?.status === 401) {
    showSignedOut('GitHub no longer accepts this sign-in. Sign in again.');
    return;
  }
  if (response?.ok !== true) {
    status.textContent = "Repotted can't reach GitHub right now. Reload to try again.";
    return;
  }
  const user = gitHubUser.parse(await response.json());
  status.textContent = 'Signed in.';
  login.textContent = user.login;
  avatar.src = user.avatar_url;
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
