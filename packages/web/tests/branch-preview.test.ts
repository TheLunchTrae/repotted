import { afterEach, expect, test } from 'vitest';

import { FakeGitRepository } from '../../core/tests/fake-git.js';
import { BranchPreview, type PreviewState } from '../src/app/branch-preview.js';
import type { Preferences } from '../src/app/preferences.js';
import { Profiles } from '../src/app/profiles.js';
import { mkdir, readdir, rm, writeFile } from '../src/engine/files.js';

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
    defaultBranch: 'main',
    commitsBehindDefaultBranch: 0,
    localProfilesOlderThanDefaultBranch: false,
    profilesChangedSinceLastSync: [],
    changedFilesTruncated: false,
    unchangedProfileCount: 0,
  });
  expect(state.changedProfiles.map((profile) => [profile.path, profile.status])).toEqual([
    ['base.yaml', 'changed'],
    ['new.yaml', 'added'],
    ['site.yaml', 'removed'],
    ['teams/web.yaml', 'through-base'],
  ]);
  const [changed, added, removed, through] = state.changedProfiles;
  expect(changed?.sections).toEqual([
    {
      section: 'repository',
      title: 'Repository',
      rows: [
        {
          kind: 'changes',
          label: 'Wiki',
          key: 'repository.has_wiki',
          before: 'Off',
          after: 'On',
          fromExtendedProfile: undefined,
        },
      ],
    },
    {
      section: 'labels',
      title: 'Labels',
      rows: [
        {
          kind: 'changes',
          label: 'bug',
          key: 'color',
          before: 'd73a4a',
          after: 'ffffff',
          fromExtendedProfile: undefined,
        },
        {
          kind: 'adds',
          label: 'docs',
          key: 'new label',
          before: 'Not set',
          after: 'Added',
          fromExtendedProfile: undefined,
        },
      ],
    },
  ]);
  expect(changed?.changedFileText).toEqual({
    before: base,
    after: expect.stringContaining('has_wiki: true') as unknown,
  });
  expect(added?.sections.flatMap((section) => section.rows.map((row) => [row.key, row.kind]))).toEqual([
    ['merge.allow_squash_merge', 'adds'],
  ]);
  expect(removed).toMatchObject({
    fileOnBranch: undefined,
    sections: [],
    changedFileText: { before: site, after: '' },
  });
  expect(through?.changedFileText).toBeUndefined();
  expect(through?.sections.flatMap((section) => section.rows.map((row) => [row.key, row.fromExtendedProfile]))).toEqual(
    [
      ['repository.has_wiki', 'base.yaml'],
      ['color', 'base.yaml'],
      ['new label', 'base.yaml'],
    ],
  );
  expect(through?.fileOnBranch).toBe(`${state.branchProfilesFolder}/teams/web.yaml`);
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
  expect(state.changedProfiles.map((profile) => [profile.path, profile.status, profile.movedFromPath])).toEqual([
    ['sites/site.yaml', 'renamed', 'site.yaml'],
    ['teams/web.yaml', 'changed', undefined],
  ]);
  expect(state.changedProfiles[0]?.sections).toEqual([]);
  expect(state.changedProfiles[1]?.problemOnBranch).toContain('gone.yaml');
  expect(state.unchangedProfileCount).toBe(1);
});

test('says when the profiles here are older than the default branch, and how far behind the branch is', async () => {
  const github = repository();
  const { preview } = await setUp(github);
  github.write({ 'profiles/new.yaml': site }, { branch: 'feature' });
  github.write({ 'profiles/site.yaml': 'merge: {}\n' });

  await preview.open('feature');
  expect(ready(preview.state.value)).toMatchObject({
    localProfilesOlderThanDefaultBranch: true,
    commitsBehindDefaultBranch: 1,
  });
  expect(ready(preview.state.value).changedProfiles.map((profile) => profile.path)).toEqual(['new.yaml']);
});

test('notes a change to the shared preferences, which it does not show', async () => {
  const github = repository();
  const { preview } = await setUp(github);
  github.write({ 'profiles/.repotted-preferences.json': '{}\n' }, { branch: 'feature' });

  await preview.open('feature');
  expect(ready(preview.state.value)).toMatchObject({
    changesSharedPreferences: true,
    changedProfiles: [],
    unchangedProfileCount: 3,
  });
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
  expect(ready(preview.state.value).changedProfiles.map((profile) => profile.path)).toEqual(['new.yaml', 'other.yaml']);
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
  ).toEqual([state.branchProfilesFolder.split('/')[2]]);

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

  github.write({ 'profiles/new.yaml': site }, { branch: 'nope' });
  await preview.refresh();
  expect(ready(preview.state.value).changedProfiles).toHaveLength(1);
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
  expect(preview.branches.value).toEqual({
    kind: 'listed',
    defaultBranch: 'main',
    branches: ['feature'],
    moreBranchesThanListed: false,
  });
});

test('leaves out a profile broken alike on both sides, and names files by their path among the profiles', async () => {
  const github = repository();
  github.write({ 'profiles/bad.yaml': 'nonsense: true\n' });
  const { preview } = await setUp(github);
  github.write({ 'profiles/new.yaml': site, 'profiles/worse.yaml': 'extends: missing.yaml\n' }, { branch: 'feature' });

  await preview.open('feature');
  const state = ready(preview.state.value);
  expect(state.changedProfiles.map((profile) => profile.path)).toEqual(['new.yaml', 'worse.yaml']);
  expect(state.changedProfiles[1]?.problemOnBranch).toContain('missing.yaml');
  expect(state.changedProfiles[1]?.problemOnBranch).not.toContain('/preview');
});

test('says when a profile that is broken on the default branch loads on the branch', async () => {
  const github = repository();
  github.write({ 'profiles/bad.yaml': 'nonsense: true\n' });
  const { preview } = await setUp(github);
  github.write({ 'profiles/bad.yaml': site }, { branch: 'feature' });

  await preview.open('feature');
  const [fixed] = ready(preview.state.value).changedProfiles;
  expect(fixed).toMatchObject({ path: 'bad.yaml', status: 'changed', problemOnBranch: undefined });
  expect(fixed?.problemFixedByBranch).toContain('bad.yaml');
  expect(fixed?.problemFixedByBranch).not.toContain('/preview');
});

test('refuses a profile on the branch that extends a file outside the profiles', async () => {
  const github = repository();
  const { preview } = await setUp(github);
  await mkdir('/profiles/browser', { recursive: true });
  await writeFile('/profiles/browser/secret.yaml', 'repository:\n  has_wiki: true\n');
  github.write({ 'profiles/evil.yaml': 'extends: ../../../../profiles/browser/secret.yaml\n' }, { branch: 'feature' });

  await preview.open('feature');
  const [evil] = ready(preview.state.value).changedProfiles;
  expect(evil).toMatchObject({
    path: 'evil.yaml',
    problemOnBranch: 'It extends a profile outside the profiles folder.',
    sections: [],
  });
});

test('names the profiles changed here since the last sync, which it starts from', async () => {
  const github = repository();
  const { preview } = await setUp(github);
  const copy = '/profiles/github/lunch/config/@profiles';
  await writeFile(`${copy}/base.yaml`, 'repository:\n  has_wiki: true\n');
  await rm(`${copy}/site.yaml`);
  await writeFile(`${copy}/mine.yaml`, site);
  github.write({ 'profiles/new.yaml': site }, { branch: 'feature' });

  await preview.open('feature');
  expect(ready(preview.state.value)).toMatchObject({
    localProfilesOlderThanDefaultBranch: false,
    profilesChangedSinceLastSync: ['base.yaml', 'mine.yaml', 'site.yaml'],
  });
});

test('says when GitHub has more branches than one page lists', async () => {
  const github = repository();
  const { preview } = await setUp(github);
  for (let index = 0; index < 100; index += 1) {
    github.write({ 'profiles/a.yaml': `labels: []\n# ${index}\n` }, { branch: `b${String(index).padStart(3, '0')}` });
  }

  await preview.listBranches('lunch/config');
  expect(preview.branches.value).toMatchObject({ kind: 'listed', moreBranchesThanListed: true });
});
