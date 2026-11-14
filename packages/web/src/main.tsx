import { render } from 'preact';

import { Account, signInFailure } from './app/account.js';
import { browserFiles, keepFiles } from './app/kept-files.js';
import { browserPreferences } from './app/preferences.js';
import { Router } from './app/router.js';
import { sessionGitHub } from './engine/github.js';
import { browserFolders } from './engine/local-folders.js';
import { Session } from './session.js';
import { App } from './views/app.js';
import { run } from './views/run.js';

const session = new Session();
const github = sessionGitHub(session);
const account = new Account(session, github);

// The Worker reports a failed sign-in in the query; drop it so a reload
// doesn't show it again.
const reason = new URLSearchParams(location.search).get('sign-in');
if (reason !== null) {
  history.replaceState(null, '', location.pathname);
}
run(account.load(signInFailure(reason)));

// The kept files are in memory before anything reads a profile.
const keeping = await keepFiles(
  browserFiles(() => indexedDB),
  // Undefined in a browser without Web Locks, whatever the type says.
  navigator.locks,
);

render(
  <App
    account={account}
    github={github}
    preferences={browserPreferences(() => localStorage)}
    router={new Router(location, history, window)}
    keeping={keeping}
    folders={browserFolders(
      () => indexedDB,
      // Undefined outside Chromium browsers, which is how the app knows to offer no folder.
      () => ('showDirectoryPicker' in window ? window.showDirectoryPicker : undefined),
      window,
    )}
  />,
  document.body,
);
