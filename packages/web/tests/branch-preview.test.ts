import { afterEach, expect, test } from 'vitest';

import { FakeGitRepository } from '../../core/tests/fake-git.js';
import { BranchPreview, type PreviewState } from '../src/app/branch-preview.js';
import type { Preferences } from '../src/app/preferences.js';
import { Profiles } from '../src/app/profiles.js';
import { readdir, rm } from '../src/engine/files.js';

afterEach(async () => {
  await rm('/', { recursive: true });
});

function memory(): Preferences {
  const kept: Record<string, unknown> = {};
  return {
    read: (key) => kept[key],
    write: (key, value) => {
      kept[key] = value;
    },
  };
}

const base = 'repository:\n  has_wiki: false\nlabels:\n  - name: bug\n    color: d73a4a\n';
const web = 'extends: ../base.yaml\nmerge:\n  allow_squash_merge: true\n';
const site = 'merge:\n  allow_rebase_merge: false\n';

function repository(): FakeGitRepository {
  const github = new FakeGitRepository();
  github.write({ 'profiles/base.yaml': base, 'profiles/teams/web.yaml': web, 'profiles/site.yaml': site });
  return github;
}

async function setUp(github: FakeGitRepository): Promise<{ profiles: Profiles; preview: BranchPreview }> {
  const profiles = new Profiles(github, memory(), () => undefined);
  expect(await profiles.connect('lunch/config', 'profiles', false)).toBeUndefined();
  return { profiles, preview: new BranchPreview(github, profiles, () => undefined) };
}

function ready(state: PreviewState): Extract<PreviewState, { kind: 'ready' }> {
  if (state.kind !== 'ready') {
    throw new Error(`Expected a ready preview, got ${JSON.stringify(state)}`);
  }
  return state;
}

test('shows what a branch changes in each profile, including those that change only through their base', async () => {
  const github = repository();
  const { preview } = await setUp(github);
  github.write(
    {
      'profiles/base.yaml':
        'repository:\n  has_wiki: true\nlabels:\n  - name: bug\n    color: ffffff\n  - name: docs\n',
      'profiles/new.yaml': 'merge:\n  allow_squash_merge: false\n',
      'profiles/site.yaml': null,
    },
    { branch: 'agent/wiki' },
  );

  await preview.open('agent/wiki');
  const state = ready(preview.state.value);
  expect(state).toMatchObject({
    branch: 'agent/wiki',
    base: 'main',
    behind: 0,
    stale: false,
    truncated: false,
    unchanged: 0,
  });
  expect(state.profiles.map((profile) => [profile.path, profile.status])).toEqual([
    ['base.yaml', 'changed'],
    ['new.yaml', 'added'],
    ['site.yaml', 'removed'],
    ['teams/web.yaml', 'through-base'],
  ]);
  const [changed, added, removed, through] = state.profiles;
  expect(changed?.sections).toEqual([
    {
      section: 'repository',
      title: 'Repository',
      rows: [
        { kind: 'changes', label: 'Wiki', key: 'repository.has_wiki', before: 'Off', after: 'On', from: undefined },
      ],
    },
    {
      section: 'labels',
      title: 'Labels',
      rows: [
        { kind: 'changes', label: 'bug', key: 'color', before: 'd73a4a', after: 'ffffff', from: undefined },
        { kind: 'adds', label: 'docs', key: 'new label', before: 'Not set', after: 'Added', from: undefined },
      ],
    },
  ]);
  expect(changed?.text).toEqual({ before: base, after: expect.stringContaining('has_wiki: true') as unknown });
  expect(added?.sections.flatMap((section) => section.rows.map((row) => [row.key, row.kind]))).toEqual([
    ['merge.allow_squash_merge', 'adds'],
  ]);
  expect(removed).toMatchObject({ file: undefined, sections: [], text: { before: site, after: '' } });
  // A base's change is a change to the profile that extends it, which says where it comes from.
  expect(through?.text).toBeUndefined();
  expect(through?.sections.flatMap((section) => section.rows.map((row) => [row.key, row.from]))).toEqual([
    ['repository.has_wiki', 'base.yaml'],
    ['color', 'base.yaml'],
    ['new label', 'base.yaml'],
  ]);
  // The branch's profiles are kept in a folder of the preview's own, which a comparison reads.
  expect(through?.file).toBe(`${state.folder}/teams/web.yaml`);
});

test('follows a profile the branch moves, and says why one that no longer loads fails', async () => {
  const github = repository();
  const { preview } = await setUp(github);
  github.write(
    {
      'profiles/site.yaml': null,
      'profiles/sites/site.yaml': site,
      'profiles/teams/web.yaml': 'extends: ../gone.yaml\n',
    },
    { branch: 'feature' },
  );

  await preview.open('feature');
  const state = ready(preview.state.value);
  expect(state.profiles.map((profile) => [profile.path, profile.status, profile.previous])).toEqual([
    ['sites/site.yaml', 'renamed', 'site.yaml'],
    ['teams/web.yaml', 'changed', undefined],
  ]);
  expect(state.profiles[0]?.sections).toEqual([]);
  expect(state.profiles[1]?.problem).toContain('gone.yaml');
  expect(state.unchanged).toBe(1);
});

test('says when the profiles here are older than the default branch, and how far behind the branch is', async () => {
  const github = repository();
  const { preview } = await setUp(github);
  github.write({ 'profiles/new.yaml': site }, { branch: 'feature' });
  github.write({ 'profiles/site.yaml': 'merge: {}\n' });

  await preview.open('feature');
  expect(ready(preview.state.value)).toMatchObject({ stale: true, behind: 1 });
  expect(ready(preview.state.value).profiles.map((profile) => profile.path)).toEqual(['new.yaml']);
});

test('notes a change to the shared preferences, which it does not show', async () => {
  const github = repository();
  const { preview } = await setUp(github);
  github.write({ 'profiles/.repotted-preferences.json': '{}\n' }, { branch: 'feature' });

  await preview.open('feature');
  expect(ready(preview.state.value)).toMatchObject({ preferences: true, profiles: [], unchanged: 3 });
});

test('opening the same branch again reads nothing, and a refresh reads it again', async () => {
  const github = repository();
  const { preview } = await setUp(github);
  github.write({ 'profiles/new.yaml': site }, { branch: 'feature' });
  await preview.open('feature');
  const reads = github.calls.length;

  await preview.open('feature');
  expect(github.calls).toHaveLength(reads);

  github.write({ 'profiles/other.yaml': site }, { branch: 'feature' });
  await preview.refresh();
  expect(ready(preview.state.value).profiles.map((profile) => profile.path)).toEqual(['new.yaml', 'other.yaml']);
});

test('a later preview wins over a slower one, and each keeps only its own files', async () => {
  const github = repository();
  const { preview } = await setUp(github);
  github.write({ 'profiles/a.yaml': site }, { branch: 'a' });
  github.write({ 'profiles/b.yaml': site }, { branch: 'b' });

  await Promise.all([preview.open('a'), preview.open('b')]);
  const state = ready(preview.state.value);
  expect(state.branch).toBe('b');
  expect(
    await readdir('/preview', { withFileTypes: true }).then((entries) => entries.map((entry) => entry.name)),
  ).toEqual([state.folder.split('/')[2]]);

  await preview.close();
  expect(preview.state.value).toEqual({ kind: 'idle' });
  expect(await readdir('/preview', { withFileTypes: true })).toEqual([]);
});

test('a branch that cannot be read fails with why, and keeps no files', async () => {
  const github = repository();
  const { preview } = await setUp(github);

  await preview.open('nope');
  expect(preview.state.value).toEqual({
    kind: 'failed',
    branch: 'nope',
    message: 'lunch/config has no branch named nope, or Repotted cannot read it.',
  });
  expect(await readdir('/preview', { withFileTypes: true })).toEqual([]);

  // A branch pushed since is read on the next try.
  github.write({ 'profiles/new.yaml': site }, { branch: 'nope' });
  await preview.refresh();
  expect(ready(preview.state.value).profiles).toHaveLength(1);
});

test('needs profiles kept in a repository', async () => {
  const github = repository();
  const profiles = new Profiles(github, memory(), () => undefined);
  const preview = new BranchPreview(github, profiles, () => undefined);

  await preview.open('feature');
  expect(preview.state.value).toMatchObject({
    kind: 'failed',
    message: expect.stringContaining('GitHub repository') as unknown,
  });
});

test('lists the branches to preview, without the default one', async () => {
  const github = repository();
  const { preview } = await setUp(github);
  github.write({ 'profiles/a.yaml': site }, { branch: 'feature' });

  await preview.listBranches('lunch/config');
  expect(preview.branches.value).toEqual({ kind: 'listed', base: 'main', branches: ['feature'], more: false });
});
