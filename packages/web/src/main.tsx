import { render } from 'preact';

import { Account, signInFailure } from './app/account.js';
import { browserPreferences } from './app/preferences.js';
import { sessionGitHub } from './engine/github.js';
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

render(<App account={account} github={github} preferences={browserPreferences(localStorage)} />, document.body);
