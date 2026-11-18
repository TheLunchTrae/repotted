// The web app as src/main.tsx starts it, against an in-memory GitHub with a
// signed-in account, eight repositories, one of which GitHub won't show every
// setting of, an empty repository to keep profiles in, and two kept profiles
// that two repositories use, so the layout
// test sees full pages with no sign-in and no network. `?signed-out` starts it
// with GitHub refusing the sign-in, which shows the sign-in page.
// `?config-repositories` gives two repositories the repotted-config topic, which
// asks which one holds the profiles.

import type { GitHub } from '@repotted/core';
import { render } from 'preact';

import { FakeGitRepository } from '../../../core/tests/support/fake-git.js';
import { answered, type FakeAccount, FakeFleet, FakeGitHub } from '../../../core/tests/support/fake-github.js';
import { Account } from '../../src/app/account/account.js';
import type { Session } from '../../src/app/account/session.js';
import { Router } from '../../src/app/navigation/router.js';
import { browserPreferences } from '../../src/app/preferences/preferences.js';
import { browserFiles, keepFiles } from '../../src/app/storage/kept-files.js';
import { mkdir, writeFile } from '../../src/engine/files.js';
import { browserFolders } from '../../src/engine/local-folders.js';
import { App } from '../../src/views/app.js';
import { run } from '../../src/views/layout/run.js';

// A long name, as some repositories have, is what pushes a row past a phone's width.
const names = [
  'lunch/app',
  'lunch/a_repository_name_with_no_hyphens_in_it_at_all',
  'lunch/api',
  'lunch/docs',
  'trae/dotfiles',
  'trae/claude-plugins',
  'lunch/mobile',
  'lunch/infra',
];
const markedConfigNames = new URLSearchParams(location.search).has('config-repositories')
  ? new Set(['lunch/a_repository_name_with_no_hyphens_in_it_at_all', 'trae/dotfiles'])
  : new Set<string>();
// GitHub allows a topic up to 50 characters, which a filter chip has to wrap on a phone.
const longestTopic = 'an-unusually-long-github-topic-of-fifty-characters';
const topicsByName: Readonly<Record<string, readonly string[]>> = {
  'lunch/api': ['typescript', longestTopic],
  'trae/claude-plugins': ['typescript'],
};
const day = 86_400_000;
// The longest push label, on the archived row, is what sorting by last push adds to a row.
const daysSinceLastPushByName: Readonly<Record<string, number | null>> = {
  'trae/claude-plugins': 330,
  'lunch/mobile': null,
};
const repositories = names.map((name, index) => {
  const daysSinceLastPush = name in daysSinceLastPushByName ? daysSinceLastPushByName[name] : index + 1;
  return {
    full_name: name,
    private: index % 2 === 0,
    archived: name === 'trae/claude-plugins',
    permissions: { admin: true },
    topics: [...(markedConfigNames.has(name) ? ['repotted-config'] : []), ...(topicsByName[name] ?? [])],
    pushed_at:
      daysSinceLastPush === null || daysSinceLastPush === undefined
        ? null
        : new Date(Date.now() - daysSinceLastPush * day).toISOString(),
  };
});
const account: FakeAccount = {
  login: 'trae',
  // One long word, as a name or login can be, which the account menu has to wrap.
  name: 'TraeStevensWithAVeryLongNameAndNoSpaces',
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
const paymentMethodMissing = answered(
  402,
  'Please ensure your account has a valid payment method on file to access this service.',
);
const others = names.slice(1).map((name) => {
  const github = new FakeGitHub({ account, ownerType: name.startsWith('trae/') ? 'User' : 'Organization' }, name);
  return name === 'trae/dotfiles'
    ? github
        .fail(`GET /repos/${name}/code-scanning/ai-scan`, answered(403, 'Resource not accessible by integration'))
        .fail(`GET /repos/${name}/actions/cache/retention-limit`, paymentMethodMissing)
        .fail(`GET /repos/${name}/actions/cache/storage-limit`, paymentMethodMissing)
    : github;
});

// An empty personal repository to keep profiles in: its files from one fake, its settings from another.
const configName = 'trae/repotted-config';
const configFiles = new FakeGitRepository(configName);
const configSettings = new FakeGitHub({ account, ownerType: 'User' }, configName);
const config: GitHub = {
  request: async (method, path, body) => {
    const route = path.split('?')[0] ?? '';
    if (method === 'GET' && route === `/repos/${configName}`) {
      const answers = [await configSettings.request(method, path), await configFiles.request(method, path)];
      const merged: Record<string, unknown> = {};
      for (const answer of answers) {
        Object.assign(merged, answer);
      }
      return merged;
    }
    return /^\/repos\/[^/]+\/[^/]+\/(?:git|contents|compare)\//u.test(route)
      ? configFiles.request(method, path, body)
      : configSettings.request(method, path, body);
  },
};
const fleet = new FakeFleet([app, ...others]);

const signedOut = new URLSearchParams(location.search).has('signed-out');
const pendingRead = { value: Promise.resolve() };
window.addEventListener('hold-github', () => {
  pendingRead.value = new Promise<void>((resolve) =>
    window.addEventListener('release-github', () => resolve(), { once: true }),
  );
});
const github: GitHub = signedOut
  ? { request: () => Promise.reject(answered(401, 'Bad credentials')) }
  : {
      request: async (method, path, body) => {
        await pendingRead.value;
        return (path.startsWith(`/repos/${configName}`) ? config : fleet).request(method, path, body);
      },
    };
// eslint-disable-next-line typescript/no-unsafe-type-assertion -- a Session can't be built without the Worker, and Account only calls signOut on it
const session = { signOut: () => Promise.resolve() } as unknown as Session;
const signIn = new Account(session, github);
run(signIn.load());

const keeping = await keepFiles(
  browserFiles(() => indexedDB),
  navigator.locks,
);
await mkdir('/profiles/browser/teams', { recursive: true });
await writeFile('/profiles/browser/base.yaml', 'repository:\n  has_wiki: false\n  delete_branch_on_merge: true\n');
await writeFile(
  '/profiles/browser/teams/website.yaml',
  'extends: ../base.yaml\n\nrepository:\n  description: Our website\n  homepage: https://example.com\n  has_projects: false\n',
);
await writeFile(
  '/profiles/browser/unfinished.yaml',
  'labels:\n  - name: unfinished\n    draft: true\n    color: invalid\n',
);
await writeFile('/profiles/browser/invalid.yaml', 'repository: [\n');
await writeFile(
  '/profiles/browser/configuration.yaml',
  'ignored: true\nrepository: { has_wiki: broken }\nlabels: [42, { name: keep, color: abcdef }]\n',
);
await writeFile(
  '/profiles/browser/unknown-keys.yaml',
  '# Keep header\nmystery: true\nrepository: { has_wiki: true, has_wikki: false }\n',
);
// Two profiles on the long name, the most a phone shows as tags, and four on another, one of them gone.
localStorage.setItem(
  'repotted:repository-profiles',
  JSON.stringify({
    'lunch/a_repository_name_with_no_hyphens_in_it_at_all': { profiles: ['base.yaml', 'teams/website.yaml'] },
    'lunch/app': { profiles: ['base.yaml', 'teams/website.yaml', 'teams/mobile.yaml', 'archived.yaml'] },
  }),
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
