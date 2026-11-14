import { afterEach, expect, test, vi } from 'vitest';

import { answered, FakeGitHub } from '../../core/tests/fake-github.js';
import { type CompareRow, compareSections, Comparison } from '../src/app/comparison.js';
import { mkdir, rm, writeFile } from '../src/engine/files.js';

afterEach(async () => {
  await rm('/', { recursive: true });
});

const profile = { file: '/profiles/web.yaml', name: 'web' };

async function saved(text: string): Promise<void> {
  await mkdir('/profiles', { recursive: true });
  await writeFile(profile.file, text);
}

function rows(comparison: Comparison): string[] {
  return comparison.shown.value.flatMap((section) =>
    section.rows.map((row) => `${section.title} | ${row.label} | ${row.key} | ${row.now} -> ${row.wanted}`),
  );
}

function failure(comparison: Comparison): string {
  const state = comparison.state.value;
  return state.kind === 'failed' ? state.message : '';
}

const text = `repository:
  has_wiki: false
  has_issues: true
actions:
  allowed_actions: selected
  selected_actions:
    github_owned_allowed: true
labels:
  - name: bug
    color: d73a4a
  - name: old
    absent: true
drafts:
  repository:
    has_projects: false
`;

test('a comparison says what the profile would change, by section, and leaves out what matches and its drafts', async () => {
  await saved(text);
  const github = new FakeGitHub({
    labels: [{ id: 1, name: 'old', color: 'ffffff', description: null, default: false }],
  });
  const comparison = new Comparison(github, () => undefined);

  await comparison.compare('lunch/app', profile);

  expect(comparison.state.value).toMatchObject({ kind: 'compared', repository: 'lunch/app', profile: 'web' });
  expect(rows(comparison)).toEqual([
    'Repository | Wiki | repository.has_wiki | On -> Off',
    'Actions | Allowed actions | actions.allowed_actions | All -> Selected',
    'Actions | Actions by GitHub | actions.selected_actions.github_owned_allowed | Not set -> On',
    'Labels | old | label removed | On GitHub -> Removed',
    'Labels | bug | new label | Not on GitHub -> Created',
  ]);
  expect(comparison.state.value).toMatchObject({ skipped: ['repository.has_projects'] });
  expect(comparison.counts.value).toEqual({ differences: 5, locked: 0 });
  // GitHub didn't say which installations the account has, so nothing is locked and there is nowhere to send them.
  expect(comparison.state.value).toMatchObject({ appAccess: undefined });
  // Comparing only reads.
  expect(github.calls.every((call) => call.method === 'GET')).toBe(true);
});

test('the search and the filter narrow the differences, and a new comparison clears them', async () => {
  await saved(text);
  const github = new FakeGitHub({
    account: {
      login: 'lunch',
      name: null,
      repositories: [],
      installations: [
        { id: 1, permissions: { administration: 'write' }, repositories: [{ full_name: 'lunch/app', private: true }] },
      ],
    },
  });
  const comparison = new Comparison(github, () => undefined);
  await comparison.compare('lunch/app', profile);

  comparison.search.value = 'has_wiki';
  expect(rows(comparison)).toEqual(['Repository | Wiki | repository.has_wiki | On -> Off']);
  comparison.search.value = 'labels bug';
  expect(rows(comparison)).toEqual(['Labels | bug | new label | Not on GitHub -> Created']);

  comparison.search.value = '';
  comparison.onlyLocked.value = true;
  // The installation was granted Administration, which settings need, and not Issues, which labels need.
  expect(comparison.shown.value.map((section) => section.title)).toEqual(['Labels']);
  expect(comparison.shown.value[0]?.rows[0]?.lock).toBe('Needs Issues write');
  expect(comparison.counts.value).toEqual({ differences: 4, locked: 1 });
  const compared = comparison.state.value;
  expect(compared.kind === 'compared' && compared.appAccess !== 'install' && compared.appAccess !== undefined).toBe(
    true,
  );

  // Comparing again reads the profile as it is saved by then.
  await saved('repository:\n  has_wiki: false\n');
  await comparison.again();
  expect(comparison.onlyLocked.value).toBe(false);
  expect(comparison.search.value).toBe('');
  expect(rows(comparison)).toEqual(['Repository | Wiki | repository.has_wiki | On -> Off']);
});

test("a profile for the other kind of owner can't be compared, and says how to use its settings there", async () => {
  await saved('owner_type: organization\nrepository:\n  has_wiki: false\n');
  const comparison = new Comparison(new FakeGitHub({ ownerType: 'User' }), () => undefined);

  await comparison.compare('lunch/app', profile);

  expect(comparison.state.value).toMatchObject({ kind: 'failed', mismatch: true });
  expect(failure(comparison)).toContain('make a copy of the profile');
});

test('a comparison that fails says why by the profile’s name, and a refused sign-in is reported', async () => {
  await saved('repository:\n  has_wikis: 5\n');
  const signedOut = vi.fn();
  const github = new FakeGitHub();
  const comparison = new Comparison(github, signedOut);

  await comparison.compare('lunch/app', profile);
  expect(comparison.state.value).toMatchObject({ kind: 'failed', mismatch: false });
  expect(failure(comparison)).toContain('web is not a valid profile');
  expect(signedOut).not.toHaveBeenCalled();

  await saved('repository:\n  has_wiki: false\n');
  github.fail('GET /repos/lunch/app', answered(401, 'Bad credentials'));
  await comparison.compare('lunch/app', profile);
  expect(comparison.state.value).toMatchObject({ kind: 'failed', message: 'Bad credentials' });
  expect(signedOut).toHaveBeenCalledOnce();
});

test('a slower comparison never replaces a later one, and one put away shows nothing when it lands', async () => {
  await saved('repository:\n  has_wiki: false\n');
  await writeFile('/profiles/other.yaml', 'repository:\n  has_issues: false\n');
  const comparison = new Comparison(new FakeGitHub(), () => undefined);

  const first = comparison.compare('lunch/app', profile);
  const second = comparison.compare('lunch/app', { file: '/profiles/other.yaml', name: 'other' });
  await Promise.all([first, second]);
  expect(comparison.state.value).toMatchObject({ kind: 'compared', profile: 'other' });

  const third = comparison.compare('lunch/app', profile);
  comparison.close();
  await third;
  expect(comparison.state.value).toEqual({ kind: 'idle' });
});

type Changes = Parameters<typeof compareSections>[0]['changes'];

/** The rows a plan of these changes compares as, each in a line. */
function compared(changes: Changes, locks: ReadonlyMap<number, string> = new Map()): string[] {
  const plan = { repository: 'lunch/app', desired: {}, changes, skipped: [], warnings: [] };
  return compareSections(plan, locks).flatMap((section) =>
    section.rows.map(
      (row: CompareRow) =>
        `${row.kind} | ${row.label} | ${row.key} | ${row.now} -> ${row.wanted}${row.lock === undefined ? '' : ` | ${row.lock}`}`,
    ),
  );
}

const request = { method: 'PUT', path: '/repos/lunch/app/x' } as const;

test('a Pages site made or deleted whole is a difference, with its settings after it', () => {
  expect(
    compared(
      [{ section: 'pages', action: 'delete', target: 'pages', fields: [], request }],
      new Map([[0, 'Needs Pages write']]),
    ),
  ).toEqual(['removes | GitHub Pages site | pages | On GitHub -> Deleted | Needs Pages write']);
  expect(
    compared([
      { section: 'pages', action: 'create', target: 'pages', fields: [{ field: 'https_enforced', to: true }], request },
    ]),
  ).toEqual([
    'adds | GitHub Pages site | pages | Not on GitHub -> Created',
    'adds | Enforce HTTPS | pages.https_enforced | Not set -> On',
  ]);
});

test("an environment's branch policy is what is made or removed, not the environment", () => {
  const policy = (name: string, type: 'branch' | 'tag', action: 'create' | 'delete'): Changes[number] => ({
    section: 'environments',
    action,
    target: 'prod',
    fields: [],
    request,
    entry: { name: 'prod', branch_policy: { name, type } },
  });

  expect(compared([policy('release/*', 'branch', 'delete'), policy('v*', 'tag', 'create')])).toEqual([
    'removes | prod: release/* | branch policy removed | On GitHub -> Removed',
    'adds | prod: v* | new tag policy | Not on GitHub -> Created',
  ]);
});

test("a changed entry is a row for each thing that differs, down to one rule's number", () => {
  const rule = (count: number): unknown => ({
    type: 'pull_request',
    parameters: { required_approving_review_count: count, dismiss_stale_reviews_on_push: true },
  });
  expect(
    compared([
      {
        section: 'rulesets',
        action: 'update',
        target: 'Main',
        request,
        entry: { name: 'Main' },
        fields: [
          { field: 'enforcement', from: 'evaluate', to: 'active' },
          { field: 'rules', from: [{ type: 'deletion' }, rule(1)], to: [rule(2), { type: 'non_fast_forward' }] },
        ],
      },
    ]),
  ).toEqual([
    'changes | Main | enforcement | evaluate -> active',
    'removes | Main | rules[deletion] | {"type":"deletion"} -> Not set',
    'changes | Main | rules[pull_request].parameters.required_approving_review_count | 1 -> 2',
    'adds | Main | rules[non_fast_forward] | Not set -> {"type":"non_fast_forward"}',
  ]);
});

test('an autolink GitHub has to remake is one change to it, and a group of settings is a row for each', () => {
  const autolink = (action: 'create' | 'delete'): Changes[number] => ({
    section: 'autolinks',
    action,
    target: 'JIRA-',
    request,
    entry: { name: 'JIRA-' },
    fields: action === 'delete' ? [] : [{ field: 'url_template', from: 'https://old/<num>', to: 'https://new/<num>' }],
  });
  expect(compared([autolink('delete'), autolink('create')], new Map([[0, 'Needs Administration write']]))).toEqual([
    'changes | JIRA- | url_template | https://old/<num> -> https://new/<num> | Needs Administration write',
  ]);

  expect(
    compared([
      {
        section: 'pages',
        action: 'update',
        target: 'pages',
        request,
        fields: [{ field: 'source', from: { branch: 'main', path: '/' }, to: { branch: 'main', path: '/docs' } }],
      },
    ]),
  ).toEqual(['changes | Folder | pages.source.path | / (root) -> /docs']);
});

test('an App that is not installed on the repository locks every difference and offers to install it', async () => {
  await saved('repository:\n  has_wiki: false\n');
  const github = new FakeGitHub({ account: { login: 'lunch', name: null, repositories: [], installations: [] } });
  const comparison = new Comparison(github, () => undefined);

  await comparison.compare('lunch/app', profile);

  expect(comparison.state.value).toMatchObject({ kind: 'compared', appAccess: 'install' });
  expect(comparison.shown.value[0]?.rows[0]?.lock).toBe('Needs the GitHub App installed on this repository');
});

test('a failure names a base profile by its file beside the profile, not by where the browser keeps it', async () => {
  await saved('extends: base.yaml\n');
  const comparison = new Comparison(new FakeGitHub(), () => undefined);

  await comparison.compare('lunch/app', profile);

  expect(failure(comparison)).toContain('base.yaml');
  expect(failure(comparison)).not.toContain('/profiles/');

  await mkdir('/profiles/teams', { recursive: true });
  await writeFile('/profiles/teams/api.yaml', 'extends: ../base.yaml\n');
  await comparison.compare('lunch/app', { file: '/profiles/teams/api.yaml', name: 'teams/api', folder: '/profiles' });
  expect(failure(comparison)).toContain('base.yaml');
  expect(failure(comparison)).not.toContain('/profiles/');
});
