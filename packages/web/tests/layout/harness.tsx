// The web app as src/main.tsx starts it, against an in-memory GitHub with a
// signed-in account, eight repositories, and two kept profiles, so the layout
// test sees full pages with no sign-in and no network. `?signed-out` starts it
// with GitHub refusing the sign-in, which shows the sign-in page.

import type { GitHub } from '@repotted/core';
import { render } from 'preact';

import { answered, type FakeAccount, FakeFleet, FakeGitHub } from '../../../core/tests/fake-github.js';
import { Account } from '../../src/app/account.js';
import { browserFiles, keepFiles } from '../../src/app/kept-files.js';
import { browserPreferences } from '../../src/app/preferences.js';
import { Router } from '../../src/app/router.js';
import { mkdir, writeFile } from '../../src/engine/files.js';
import { browserFolders } from '../../src/engine/local-folders.js';
import type { Session } from '../../src/session.js';
import { App } from '../../src/views/app.js';
import { run } from '../../src/views/run.js';

// A long name, as some repositories have, is what pushes a row past a phone's width.
const names = [
  'lunch/app',
  'lunch/website-with-a-rather-long-repository-name',
  'lunch/api',
  'lunch/docs',
  'trae/dotfiles',
  'trae/claude-plugins',
  'lunch/mobile',
  'lunch/infra',
];
const repositories = names.map((name, index) => ({
  full_name: name,
  private: index % 2 === 0,
  archived: name === 'trae/claude-plugins',
  permissions: { admin: true },
}));
const account: FakeAccount = {
  login: 'trae',
  name: 'Trae Stevens',
  repositories,
  installations: [
    {
      id: 1,
      account: 'lunch',
      selection: 'selected',
      permissions: { administration: 'write', actions: 'write', contents: 'write', metadata: 'read' },
      repositories: repositories.filter((item) => item.full_name.startsWith('lunch/')),
    },
    {
      id: 2,
      account: 'trae',
      selection: 'all',
      permissions: { administration: 'write', metadata: 'read' },
      repositories: repositories.filter((item) => item.full_name.startsWith('trae/')),
    },
  ],
};
const app = new FakeGitHub(
  {
    account,
    rulesets: [
      {
        id: 1,
        name: 'Protect the default branch with required reviews',
        target: 'branch',
        enforcement: 'active',
        bypass_actors: [],
        conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
        rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }],
      },
    ],
    labels: [{ id: 1, name: 'bug', color: 'd73a4a', description: "Something isn't working", default: true }],
  },
  'lunch/app',
);
const others = names
  .slice(1)
  .map((name) => new FakeGitHub({ account, ownerType: name.startsWith('trae/') ? 'User' : 'Organization' }, name));

const signedOut = new URLSearchParams(location.search).has('signed-out');
const github: GitHub = signedOut
  ? { request: () => Promise.reject(answered(401, 'Bad credentials')) }
  : new FakeFleet([app, ...others]);
// eslint-disable-next-line typescript/no-unsafe-type-assertion -- a Session can't be built without the Worker, and Account only calls signOut on it
const session = { signOut: () => Promise.resolve() } as unknown as Session;
const signIn = new Account(session, github);
run(signIn.load());

const keeping = await keepFiles(
  browserFiles(() => indexedDB),
  navigator.locks,
);
// Two kept profiles, one in a folder, so the profiles list has rows to lay out.
await mkdir('/profiles/browser/teams', { recursive: true });
await writeFile('/profiles/browser/base.yaml', 'repository:\n  has_wiki: false\n  delete_branch_on_merge: true\n');
await writeFile(
  '/profiles/browser/teams/website.yaml',
  'extends: ../base.yaml\n\nrepository:\n  has_projects: false\n',
);

render(
  <App
    account={signIn}
    github={github}
    preferences={browserPreferences(() => localStorage)}
    router={new Router(location, history, window)}
    keeping={keeping}
    folders={browserFolders(
      () => indexedDB,
      () => ('showDirectoryPicker' in window ? window.showDirectoryPicker : undefined),
      window,
    )}
  />,
  document.body,
);
