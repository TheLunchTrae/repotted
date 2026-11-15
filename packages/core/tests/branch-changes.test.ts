import { describe, expect, test } from 'vitest';

import { type BranchFileChange, listBranches, readBranchChanges } from '../src/branch-changes.js';
import { GitHubError } from '../src/github.js';
import { FakeGitRepository } from './fake-git.js';

/** Each change as text, so a test reads what the branch holds. */
function shown(files: readonly BranchFileChange[]): unknown[] {
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
    expect(shown(changes.files)).toEqual([
      { status: 'modified', file: 'base.yaml', content: 'merge:\n  allow_squash_merge: false\n' },
      { status: 'removed', file: 'gone.yaml' },
      { status: 'added', file: 'new.yaml', content: 'repository:\n  has_wiki: false\n' },
      { status: 'renamed', file: 'teams/old.yaml', previous: 'old.yaml', content: 'extends: base.yaml\n' },
    ]);
    expect(changes.others).toEqual(['.repotted-preferences.json']);
    expect(changes).toMatchObject({ base: 'main', branch: 'agent/tidy', ahead: 1, behind: 0, truncated: false });
    expect(changes.headCommit).toBe(github.refs.get('agent/tidy'));
    expect(changes.baseCommit).toBe(github.refs.get('main'));
  });

  test('leaves out what the default branch changed since the branch left it, and counts how far behind it is', async () => {
    const github = repository();
    github.write({ 'profiles/new.yaml': 'labels: []\n' }, { branch: 'feature' });
    github.write({ 'profiles/base.yaml': 'merge: {}\n' });
    const changes = await readBranchChanges(github, 'feature', { repository: 'lunch/config', path: 'profiles' });
    expect(changes.files.map((change) => change.file)).toEqual(['new.yaml']);
    expect(changes).toMatchObject({ ahead: 1, behind: 1 });
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
    expect(changes.files.map((change) => change.file)).toEqual(['top.yml']);
    expect(changes.others).toEqual(['.github/workflows/ci.yaml']);
  });

  test('says when a profile is moved out of the profiles folder that it is gone from them', async () => {
    const github = repository();
    github.write({ 'profiles/gone.yaml': null, 'archive/gone.yaml': 'labels: []\n' }, { branch: 'feature' });
    const changes = await readBranchChanges(github, 'feature', { repository: 'lunch/config', path: 'profiles' });
    expect(changes.files).toEqual([{ status: 'removed', file: 'gone.yaml' }]);
  });

  test('says when GitHub listed as many files as it lists, so some may be missing', async () => {
    const github = repository();
    const many = Object.fromEntries(
      Array.from({ length: 301 }, (_, index) => [`profiles/p${index}.yaml`, `labels: []\n# ${index}\n`]),
    );
    github.write(many, { branch: 'feature' });
    const changes = await readBranchChanges(github, 'feature', { repository: 'lunch/config', path: 'profiles' });
    expect(changes.files).toHaveLength(300);
    expect(changes.truncated).toBe(true);
  });

  test('takes a branch name only as a whole name, not as the start of others', async () => {
    const github = repository();
    github.write({ 'profiles/a.yaml': 'labels: []\n' }, { branch: 'agent/fix' });
    await expect(readBranchChanges(github, 'agent', { repository: 'lunch/config' })).rejects.toThrow(
      'lunch/config has no branch named agent',
    );
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
      base: 'main',
      branches: ['agent/fix', 'feature'],
      more: false,
    });
  });
});
