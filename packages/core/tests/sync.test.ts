import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { responseError } from '../src/github.js';
import { listProfiles } from '../src/profile.js';
import { syncFolder, syncStateFile } from '../src/sync.js';
import { FakeGitRepository } from './fake-git.js';

const folders: string[] = [];

async function folder(): Promise<string> {
  const made = await mkdtemp(path.join(tmpdir(), 'repotted-sync-'));
  folders.push(made);
  return made;
}

afterEach(async () => {
  await Promise.all(folders.splice(0).map((made) => rm(made, { recursive: true, force: true })));
});

async function text(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** The profiles in a folder, as text by path; hidden files are left out. */
async function contents(directory: string): Promise<Record<string, string>> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const files: Record<string, string> = {};
  for (const entry of entries.filter((item) => item.isFile() && !item.name.startsWith('.'))) {
    const file = path.relative(directory, path.join(entry.parentPath, entry.name)).split(path.sep).join('/');
    files[file] = (await text(path.join(directory, file))) ?? '';
  }
  return files;
}

/** Why a sync failed; the test fails when it succeeds. */
async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return String(error);
  }
  throw new Error('Expected the sync to fail');
}

const base = 'repository:\n  has_wiki: false\n';
const app = 'extends: base.yaml\nmerge:\n  allow_squash_merge: true\n';

describe('syncFolder', () => {
  test('pulls only the profiles, from the folder it names, into a folder that lists them', async () => {
    const github = new FakeGitRepository();
    github.write({
      'profiles/base.yaml': base,
      'profiles/app.yml': app,
      'profiles/team/web.yaml': 'extends: ../base.yaml\n',
      'profiles/README.md': '# Profiles\n',
      'profiles/.hidden.yaml': base,
      'other.yaml': base,
      '.github/workflows/plan.yml': 'on: push\n',
    });
    github.write({ 'profiles/link.yaml': 'base.yaml' }, { mode: '120000' });
    const local = await folder();

    const result = await syncFolder(github, local, { repository: 'lunch/config', path: '/profiles/' });

    expect(result).toMatchObject({
      repository: 'lunch/config',
      path: 'profiles',
      branch: 'main',
      pushed: [],
      conflicts: [],
    });
    expect(await contents(local)).toEqual({
      'base.yaml': base,
      'app.yml': app,
      'team/web.yaml': 'extends: ../base.yaml\n',
    });
    expect((await listProfiles(local)).map((listing) => [listing.name, listing.problem])).toEqual([
      ['app', null],
      ['base', null],
    ]);
    // Later syncs need no repository: the folder remembers it.
    expect(await syncFolder(github, local)).toMatchObject({ pulled: [], pushed: [] });
  });

  test('commits every local change in one commit and pulls what changed on GitHub', async () => {
    const github = new FakeGitRepository();
    github.write({ 'base.yaml': base, 'app.yaml': app, 'old.yaml': base, 'gone.yaml': base });
    const local = await folder();
    await syncFolder(github, local, { repository: 'lunch/config' });

    await writeFile(path.join(local, 'base.yaml'), 'repository:\n  has_wiki: true\n');
    await writeFile(path.join(local, 'new.yaml'), app);
    await rm(path.join(local, 'old.yaml'));
    github.write({ 'app.yaml': `${app}# edited on GitHub\n`, 'gone.yaml': null, 'added.yaml': base });
    const before = github.log().length;

    const result = await syncFolder(github, local);

    expect(result.pulled).toEqual(['added.yaml', 'app.yaml', 'gone.yaml']);
    expect(result.pushed).toEqual(['base.yaml', 'new.yaml', 'old.yaml']);
    expect(github.log().length).toBe(before + 1);
    expect(github.log()[0]).toBe('Update 3 profiles\n\n- update base.yaml\n- add new.yaml\n- delete old.yaml');
    const expected = {
      'base.yaml': 'repository:\n  has_wiki: true\n',
      'app.yaml': `${app}# edited on GitHub\n`,
      'new.yaml': app,
      'added.yaml': base,
    };
    expect(github.files()).toEqual(expected);
    expect(await contents(local)).toEqual(expected);
    expect(result.commit).toBe(github.refs.get('main') ?? null);
  });

  test('leaves a file changed on both sides alone until a side is preferred', async () => {
    const github = new FakeGitRepository();
    github.write({ 'base.yaml': base, 'app.yaml': app });
    const local = await folder();
    await syncFolder(github, local, { repository: 'lunch/config' });
    await writeFile(path.join(local, 'base.yaml'), '# mine\n');
    await writeFile(path.join(local, 'app.yaml'), '# also mine\n');
    github.write({ 'base.yaml': '# theirs\n' });

    const first = await syncFolder(github, local);
    const second = await syncFolder(github, local);

    // app.yaml changed only here, so it still goes up.
    expect(first).toMatchObject({ conflicts: ['base.yaml'], pushed: ['app.yaml'] });
    expect(second).toMatchObject({ conflicts: ['base.yaml'], pushed: [], pulled: [] });
    expect(await text(path.join(local, 'base.yaml'))).toBe('# mine\n');
    expect(github.files()['base.yaml']).toBe('# theirs\n');

    const kept = await syncFolder(github, local, { prefer: 'local' });
    expect(kept).toMatchObject({ conflicts: [], pushed: ['base.yaml'] });
    expect(github.files()['base.yaml']).toBe('# mine\n');

    await writeFile(path.join(local, 'base.yaml'), '# mine again\n');
    github.write({ 'base.yaml': '# theirs again\n' });
    const taken = await syncFolder(github, local, { prefer: 'remote' });
    expect(taken).toMatchObject({ conflicts: [], pulled: ['base.yaml'] });
    expect(await text(path.join(local, 'base.yaml'))).toBe('# theirs again\n');
  });

  test('a first sync into a folder that has profiles treats a file on both sides as a conflict', async () => {
    const github = new FakeGitRepository();
    github.write({ 'base.yaml': base, 'remote.yaml': app });
    const local = await folder();
    await writeFile(path.join(local, 'base.yaml'), '# local\n');
    await writeFile(path.join(local, 'local.yaml'), app);

    const result = await syncFolder(github, local, { repository: 'lunch/config' });

    expect(result).toMatchObject({ conflicts: ['base.yaml'], pulled: ['remote.yaml'], pushed: ['local.yaml'] });
    expect(await text(path.join(local, 'base.yaml'))).toBe('# local\n');
  });

  test('builds on a commit that lands first instead of losing it', async () => {
    const github = new FakeGitRepository();
    github.write({ 'base.yaml': base, 'app.yaml': app });
    const local = await folder();
    await syncFolder(github, local, { repository: 'lunch/config' });
    await writeFile(path.join(local, 'base.yaml'), '# mine\n');
    github.beforeRefUpdate = () => github.write({ 'app.yaml': '# landed first\n' });

    const result = await syncFolder(github, local);

    expect(result).toMatchObject({ pushed: ['base.yaml'], pulled: ['app.yaml'], conflicts: [] });
    expect(github.files()).toEqual({ 'base.yaml': '# mine\n', 'app.yaml': '# landed first\n' });
    expect(await contents(local)).toEqual(github.files());
  });

  test('starts an empty repository with the folder it is given', async () => {
    const github = new FakeGitRepository();
    const local = await folder();
    await writeFile(path.join(local, 'base.yaml'), base);
    await writeFile(path.join(local, 'app.yaml'), app);

    const result = await syncFolder(github, local, { repository: 'lunch/config', path: 'profiles' });

    expect(result).toMatchObject({ pushed: ['app.yaml', 'base.yaml'], conflicts: [] });
    expect(github.files()).toEqual({ 'profiles/app.yaml': app, 'profiles/base.yaml': base });
    expect(github.log()).toEqual(['Add base.yaml', 'Add app.yaml']);
    expect(await syncFolder(github, local)).toMatchObject({ pushed: [], pulled: [] });
  });

  test('never syncs links, hidden files or what is outside the folder', async () => {
    const github = new FakeGitRepository();
    github.write({ 'base.yaml': base });
    const local = await folder();
    const outside = await folder();
    await writeFile(path.join(outside, 'secret.yaml'), 'token: x\n');
    await symlink(path.join(outside, 'secret.yaml'), path.join(local, 'linked.yaml'));
    await mkdir(path.join(local, '.git'));
    await writeFile(path.join(local, '.git', 'config.yaml'), base);
    await writeFile(path.join(local, 'notes.txt'), 'hi\n');

    await syncFolder(github, local, { repository: 'lunch/config' });

    expect(Object.keys(github.files())).toEqual(['base.yaml']);
  });

  test('keeps a folder to one repository and refuses names that clash on macOS and Windows', async () => {
    const github = new FakeGitRepository();
    github.write({ 'base.yaml': base });
    const local = await folder();
    await syncFolder(github, local, { repository: 'lunch/config' });

    expect(await syncFolder(github, local, { repository: 'LUNCH/Config' })).toMatchObject({ pulled: [] });
    expect(await failure(syncFolder(github, local, { repository: 'lunch/other' }))).toContain(
      'syncs with lunch/config',
    );
    expect(await failure(syncFolder(github, local, { path: 'profiles' }))).toContain('syncs with lunch/config');
    expect(await failure(syncFolder(github, await folder()))).toContain('does not sync with a repository yet');
    expect(await failure(syncFolder(github, await folder(), { repository: 'lunch/config', path: '../x' }))).toContain(
      'Expected a folder in the repository',
    );

    github.write({ 'Base.yaml': base });
    expect(await failure(syncFolder(github, local))).toContain('differ only in case');
    expect(JSON.parse((await text(path.join(local, syncStateFile))) ?? '{}')).toMatchObject({
      repository: 'lunch/config',
    });
  });

  test('says what to change when GitHub refuses the commit or the repository', async () => {
    const github = new FakeGitRepository();
    github.write({ 'base.yaml': base });
    const local = await folder();
    await syncFolder(github, local, { repository: 'lunch/config' });
    await writeFile(path.join(local, 'base.yaml'), '# mine\n');

    const docs = { documentation_url: 'https://docs.github.com/rest' };
    github.refuseWrites = responseError(422, {
      message: 'Repository rule violations found\n\nChanges must be made through a pull request.\n\n',
      ...docs,
    });
    const ruleset = await failure(syncFolder(github, local));
    github.refuseWrites = responseError(403, { message: 'Resource not accessible by integration', ...docs });
    const permission = await failure(syncFolder(github, local));
    github.refuseWrites = undefined;
    const missing = await failure(syncFolder(github, await folder(), { repository: 'lunch/missing' }));

    expect(ruleset).toContain('GitHub refused the commit to main in lunch/config: Repository rule violations found.');
    expect(ruleset).toContain('needs a bypass for you or the Repotted App');
    expect(permission).toContain('Contents permission, read and write');
    expect(missing).toContain('Repotted App must be installed on it');
    // Nothing was lost: the edit is still here to sync once GitHub allows it.
    expect(await text(path.join(local, 'base.yaml'))).toBe('# mine\n');
    expect((await syncFolder(github, local)).pushed).toEqual(['base.yaml']);
  });

  test('keeps an edit made here while the sync runs, as a conflict', async () => {
    const github = new FakeGitRepository();
    github.write({ 'base.yaml': base, 'app.yaml': app });
    const local = await folder();
    await syncFolder(github, local, { repository: 'lunch/config' });
    github.write({ 'base.yaml': '# theirs\n' });
    // A save lands between the sync reading the folder and writing GitHub's version.
    github.beforeBlobRead = () => writeFileSync(path.join(local, 'base.yaml'), '# saved meanwhile\n');

    const result = await syncFolder(github, local);

    expect(result).toMatchObject({ conflicts: ['base.yaml'], pulled: [] });
    expect(await text(path.join(local, 'base.yaml'))).toBe('# saved meanwhile\n');
    expect(github.files()['base.yaml']).toBe('# theirs\n');
  });

  test('a commit that lands during the sync is not mistaken for a conflict', async () => {
    const github = new FakeGitRepository();
    github.write({ 'a.yaml': '# v1\n', 'b.yaml': base });
    const local = await folder();
    await syncFolder(github, local, { repository: 'lunch/config' });
    github.write({ 'a.yaml': '# v2\n' });
    await writeFile(path.join(local, 'b.yaml'), '# mine\n');
    github.beforeRefUpdate = () => github.write({ 'a.yaml': '# v3\n' });

    const result = await syncFolder(github, local, { prefer: 'local' });

    expect(result).toMatchObject({ conflicts: [], pulled: ['a.yaml'], pushed: ['b.yaml'] });
    expect(github.files()).toEqual({ 'a.yaml': '# v3\n', 'b.yaml': '# mine\n' });
    expect(await contents(local)).toEqual(github.files());
  });

  test('a repository made again under the same name, or emptied, deletes nothing here', async () => {
    const first = new FakeGitRepository();
    first.write({ 'base.yaml': base, 'app.yaml': app });
    const local = await folder();
    await syncFolder(first, local, { repository: 'lunch/config' });

    const again = new FakeGitRepository();
    again.write({ 'base.yaml': '# new\n' });
    const recreated = await syncFolder(again, local);
    expect(recreated).toMatchObject({ conflicts: ['base.yaml'], pushed: ['app.yaml'], pulled: [] });
    expect(await contents(local)).toEqual({ 'base.yaml': base, 'app.yaml': app });

    const emptied = new FakeGitRepository();
    emptied.write({ 'base.yaml': base });
    const copy = await folder();
    await syncFolder(emptied, copy, { repository: 'lunch/config' });
    emptied.refs.clear();
    expect(await syncFolder(emptied, copy)).toMatchObject({ pulled: [], pushed: ['base.yaml'] });
    expect(await contents(copy)).toEqual({ 'base.yaml': base });
    expect(emptied.files()).toEqual({ 'base.yaml': base });
  });

  test('follows a renamed default branch, deletes included', async () => {
    const github = new FakeGitRepository();
    github.write({ 'base.yaml': base, 'old.yaml': base });
    const local = await folder();
    await syncFolder(github, local, { repository: 'lunch/config' });
    await writeFile(path.join(local, 'app.yaml'), app);
    await rm(path.join(local, 'old.yaml'));
    github.refs.set('trunk', github.refs.get('main') ?? '');
    github.refs.delete('main');
    github.defaultBranch = 'trunk';

    const result = await syncFolder(github, local);

    expect(result).toMatchObject({ branch: 'trunk', pushed: ['app.yaml', 'old.yaml'], pulled: [], conflicts: [] });
    expect(github.files()).toEqual({ 'base.yaml': base, 'app.yaml': app });
  });

  test('a branch whose history was replaced deletes nothing here', async () => {
    const github = new FakeGitRepository();
    github.write({ 'base.yaml': base, 'app.yaml': app });
    const local = await folder();
    await syncFolder(github, local, { repository: 'lunch/config' });
    // A force push of a new first commit.
    github.refs.delete('main');
    github.write({ 'readme.yaml': base });

    const result = await syncFolder(github, local);

    expect(result).toMatchObject({ pulled: ['readme.yaml'], pushed: ['app.yaml', 'base.yaml'], conflicts: [] });
    expect(await contents(local)).toEqual({ 'base.yaml': base, 'app.yaml': app, 'readme.yaml': base });
  });

  test('a record from before repository ids syncs as a first sync', async () => {
    const github = new FakeGitRepository();
    github.write({ 'base.yaml': base });
    const local = await folder();
    await syncFolder(github, local, { repository: 'lunch/config' });
    const record = path.join(local, syncStateFile);
    await writeFile(record, ((await text(record)) ?? '').replace(/\n {2}"id": \d+,/u, ''));
    expect(await text(record)).not.toContain('"id"');
    github.write({ 'base.yaml': null });

    expect(await syncFolder(github, local)).toMatchObject({ pulled: [], pushed: ['base.yaml'] });
  });

  test('prefer settles only the files it names', async () => {
    const github = new FakeGitRepository();
    github.write({ 'a.yaml': base, 'b.yaml': base });
    const local = await folder();
    await syncFolder(github, local, { repository: 'lunch/config' });
    await writeFile(path.join(local, 'a.yaml'), '# mine\n');
    await writeFile(path.join(local, 'b.yaml'), '# mine\n');
    github.write({ 'a.yaml': '# theirs\n', 'b.yaml': '# theirs\n' });

    const result = await syncFolder(github, local, { prefer: 'remote', only: ['a.yaml'] });

    expect(result).toMatchObject({ pulled: ['a.yaml'], conflicts: ['b.yaml'] });
    expect(await text(path.join(local, 'b.yaml'))).toBe('# mine\n');
  });

  test('never writes through a linked folder, and refuses names that clash in case', async () => {
    const github = new FakeGitRepository();
    github.write({ 'base.yaml': base });
    const local = await folder();
    const outside = await folder();
    await syncFolder(github, local, { repository: 'lunch/config' });
    await symlink(outside, path.join(local, 'team'));
    github.write({ 'team/web.yaml': app });

    expect(await failure(syncFolder(github, local))).toContain('is a link or a file');
    expect(await readdir(outside)).toEqual([]);

    const other = new FakeGitRepository();
    other.write({ 'Base.yaml': base });
    const copy = await folder();
    await writeFile(path.join(copy, 'base.yaml'), '# mine\n');
    expect(await failure(syncFolder(other, copy, { repository: 'lunch/config' }))).toContain('differ only in case');
    expect(await contents(copy)).toEqual({ 'base.yaml': '# mine\n' });
  });

  test('applies a rename made only in case on GitHub', async () => {
    const github = new FakeGitRepository();
    github.write({ 'base.yaml': base });
    const local = await folder();
    await syncFolder(github, local, { repository: 'lunch/config' });
    github.write({ 'base.yaml': null, 'Base.yaml': base });

    const result = await syncFolder(github, local);

    expect(result).toMatchObject({ pulled: ['Base.yaml', 'base.yaml'], conflicts: [] });
    expect(await contents(local)).toEqual({ 'Base.yaml': base });
    expect(await syncFolder(github, local)).toMatchObject({ pulled: [], pushed: [] });
    expect(github.files()).toEqual({ 'Base.yaml': base });
  });
});
