import { render } from 'preact';

import { Account, signInFailure } from './app/account/account.js';
import { Session } from './app/account/session.js';
import { Router } from './app/navigation/router.js';
import { browserPreferences } from './app/preferences/preferences.js';
import { browserFiles, keepFiles } from './app/storage/kept-files.js';
import { sessionGitHub } from './engine/github.js';
import { browserFolders } from './engine/local-folders.js';
import { App } from './views/app.js';
import { run } from './views/layout/run.js';

const session = new Session();
const github = sessionGitHub(session);
const account = new Account(session, github);

// Dropped so a reload doesn't report the failed sign-in again.
const signInFailureMessage = signInFailure(new URLSearchParams(location.search));
if (signInFailureMessage !== undefined) {
  history.replaceState(null, '', location.pathname);
}
run(account.load(signInFailureMessage));

// The kept files are in memory before anything reads a profile.
const kept = await keepFiles(
  browserFiles(() => indexedDB),
  // Undefined in a browser without Web Locks, whatever the type says.
  navigator.locks,
);
// Held here rather than by a page, so it still asks once the page that made the change is gone, such as after sign-out.
window.addEventListener('beforeunload', (event) => {
  if (kept.writing.value) {
    event.preventDefault();
  }
});

render(
  <App
    account={account}
    github={github}
    preferences={browserPreferences(() => localStorage)}
    router={new Router(location, history, window)}
    keeping={kept.keeping}
    filesKept={kept.settled}
    folders={browserFolders(
      () => indexedDB,
      // Undefined outside Chromium browsers, which is how the app knows to offer no folder.
      () => ('showDirectoryPicker' in window ? window.showDirectoryPicker : undefined),
      window,
    )}
  />,
  document.body,
);
