import { afterEach, expect, test, vi } from 'vitest';

import { answered, FakeGitHub } from '../../core/tests/fake-github.js';
import { Comparison } from '../src/app/comparison.js';
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

  await comparison.compare('lunch/app', profile);
  expect(comparison.onlyLocked.value).toBe(false);
  expect(comparison.search.value).toBe('');
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
