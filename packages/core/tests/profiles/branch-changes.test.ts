import { describe, expect, test } from 'vitest';

import { type BranchProfileChange, listBranches, readBranchChanges } from '../src/branch-changes.js';
import { GitHubError } from '../src/github.js';
import { FakeGitRepository } from './fake-git.js';

function withContentAsText(files: readonly BranchProfileChange[]): unknown[] {
  return files.map((change) =>
    'content' in change ? { ...change, content: new TextDecoder().decode(change.content) } : change,
  );
}

function repository(): FakeGitRepository {
  const github = new FakeGitRepository();
  github.write({
    'profiles/base.yaml': 'merge:\n  allow_squash_merge: true\n',
    'profiles/old.yaml': 'extends: base.yaml\n',
    'profiles/gone.yaml': 'labels: []\n',
    'README.md': 'hi\n',
  });
  return github;
}

describe('readBranchChanges', () => {
  test('reads the profiles a branch adds, changes, removes, and moves, with their content on the branch', async () => {
    const github = repository();
    github.write(
      {
        'profiles/base.yaml': 'merge:\n  allow_squash_merge: false\n',
        'profiles/new.yaml': 'repository:\n  has_wiki: false\n',
        'profiles/gone.yaml': null,
        'profiles/old.yaml': null,
        'profiles/teams/old.yaml': 'extends: base.yaml\n',
        'README.md': 'hello\n',
        'profiles/.repotted-preferences.json': '{}\n',
      },
      { branch: 'agent/tidy' },
    );
    const changes = await readBranchChanges(github, 'agent/tidy', { repository: 'lunch/config', path: 'profiles' });
    expect(withContentAsText(changes.changedProfiles)).toEqual([
      { status: 'modified', profilePath: 'base.yaml', content: 'merge:\n  allow_squash_merge: false\n' },
      { status: 'removed', profilePath: 'gone.yaml' },
      { status: 'added', profilePath: 'new.yaml', content: 'repository:\n  has_wiki: false\n' },
      {
        status: 'renamed',
        profilePath: 'teams/old.yaml',
        previousProfilePath: 'old.yaml',
        content: 'extends: base.yaml\n',
      },
    ]);
    expect(changes.otherChangedFiles).toEqual(['.repotted-preferences.json']);
    expect(changes).toMatchObject({
      defaultBranch: 'main',
      branch: 'agent/tidy',
      commitsAheadOfDefaultBranch: 1,
      commitsBehindDefaultBranch: 0,
      changedFilesTruncated: false,
    });
    expect(changes.branchCommit).toBe(github.refs.get('agent/tidy'));
    expect(changes.defaultBranchCommit).toBe(github.refs.get('main'));
  });

  test('leaves out what the default branch changed since the branch left it, and counts how far behind it is', async () => {
    const github = repository();
    github.write({ 'profiles/new.yaml': 'labels: []\n' }, { branch: 'feature' });
    github.write({ 'profiles/base.yaml': 'merge: {}\n' });
    const changes = await readBranchChanges(github, 'feature', { repository: 'lunch/config', path: 'profiles' });
    expect(changes.changedProfiles.map((change) => change.profilePath)).toEqual(['new.yaml']);
    expect(changes).toMatchObject({ commitsAheadOfDefaultBranch: 1, commitsBehindDefaultBranch: 1 });
  });

  test('reads only the blobs of changed profiles, in a few requests', async () => {
    const github = repository();
    github.write({ 'profiles/new.yaml': 'labels: []\n', 'docs/a.yaml': 'x: 1\n' }, { branch: 'feature' });
    github.calls.length = 0;
    await readBranchChanges(github, 'feature', { repository: 'lunch/config', path: 'profiles' });
    expect(github.calls.map((call) => call.path.split('?')[0]?.split('/').slice(4, 6).join('/'))).toEqual([
      '',
      'git/ref',
      'compare/main...' + (github.refs.get('feature') ?? ''),
      'git/blobs',
    ]);
  });

  test('takes the whole repository as the folder when no path is given, and skips hidden and non-profile files', async () => {
    const github = repository();
    github.write({ '.github/workflows/ci.yaml': 'on: push\n', 'top.yml': 'labels: []\n' }, { branch: 'feature' });
    const changes = await readBranchChanges(github, 'feature', { repository: 'lunch/config' });
    expect(changes.changedProfiles.map((change) => change.profilePath)).toEqual(['top.yml']);
    expect(changes.otherChangedFiles).toEqual(['.github/workflows/ci.yaml']);
  });

  test('says when a profile is moved out of the profiles folder that it is gone from them', async () => {
    const github = repository();
    github.write({ 'profiles/gone.yaml': null, 'archive/gone.yaml': 'labels: []\n' }, { branch: 'feature' });
    const changes = await readBranchChanges(github, 'feature', { repository: 'lunch/config', path: 'profiles' });
    expect(changes.changedProfiles).toEqual([{ status: 'removed', profilePath: 'gone.yaml' }]);
  });

  test('says when GitHub listed as many files as it lists, so some may be missing', async () => {
    const github = repository();
    const many = Object.fromEntries(
      Array.from({ length: 301 }, (_, index) => [`profiles/p${index}.yaml`, `labels: []\n# ${index}\n`]),
    );
    github.write(many, { branch: 'feature' });
    const changes = await readBranchChanges(github, 'feature', { repository: 'lunch/config', path: 'profiles' });
    expect(changes.changedProfiles).toHaveLength(300);
    expect(changes.changedFilesTruncated).toBe(true);
  });

  test('takes a branch name only as a whole name, not as the start of others', async () => {
    const github = repository();
    github.write({ 'profiles/a.yaml': 'labels: []\n' }, { branch: 'agent/fix' });
    await expect(readBranchChanges(github, 'agent', { repository: 'lunch/config' })).rejects.toThrow(
      'lunch/config has no branch named agent',
    );
  });

  test('refuses a name with a dot or empty part before asking GitHub, so it cannot reach another path', async () => {
    const github = repository();
    for (const name of ['../../user/repos', 'agent/./fix', 'agent//fix', '.hidden']) {
      await expect(readBranchChanges(github, name, { repository: 'lunch/config' })).rejects.toThrow(
        `${name} is not a branch name.`,
      );
    }
    expect(github.calls).toEqual([]);
  });

  test('refuses the default branch, which the profiles already come from', async () => {
    await expect(readBranchChanges(repository(), 'main', { repository: 'lunch/config' })).rejects.toThrow(
      'main is the default branch of lunch/config',
    );
  });

  test('names the branch when there is none of that name', async () => {
    await expect(readBranchChanges(repository(), 'nope', { repository: 'lunch/config' })).rejects.toThrow(
      'lunch/config has no branch named nope',
    );
  });

  test('says when a branch shares no history with the default branch, rather than calling it missing', async () => {
    const github = repository();
    const head = github.commits.get(github.refs.get('main') ?? '');
    expect(head).toBeDefined();
    // A branch started with no parent, as `git checkout --orphan` makes one.
    github.commits.set('orphan-commit', { tree: head?.tree ?? '', parents: [], message: 'Start again' });
    github.refs.set('orphan', 'orphan-commit');
    await expect(readBranchChanges(github, 'orphan', { repository: 'lunch/config' })).rejects.toThrow(
      "orphan shares no history with main in lunch/config, so it can't be compared.",
    );
  });

  test('says what the app needs when GitHub refuses to read the repository', async () => {
    const refuse = (): Promise<unknown> =>
      Promise.reject(new GitHubError(403, 'Resource not accessible by integration'));
    await expect(readBranchChanges({ request: refuse }, 'feature', { repository: 'lunch/config' })).rejects.toThrow(
      'Repotted cannot read lunch/config: Resource not accessible by integration. The Repotted App must be installed on it',
    );
  });

  test('refuses a profiles folder that no profile can be in', async () => {
    await expect(
      readBranchChanges(repository(), 'feature', { repository: 'lunch/config', path: '.github' }),
    ).rejects.toThrow('Expected a folder in the repository');
  });
});

describe('listBranches', () => {
  test('lists the branches other than the default one', async () => {
    const github = repository();
    github.write({ 'profiles/a.yaml': 'labels: []\n' }, { branch: 'feature' });
    github.write({ 'profiles/b.yaml': 'labels: []\n' }, { branch: 'agent/fix' });
    expect(await listBranches(github, 'lunch/config')).toEqual({
      defaultBranch: 'main',
      branches: ['agent/fix', 'feature'],
      moreBranchesThanListed: false,
    });
  });
});
