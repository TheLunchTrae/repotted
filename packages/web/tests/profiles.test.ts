import { afterEach, expect, test, vi } from 'vitest';

import { FakeGitRepository } from '../../core/tests/fake-git.js';
import { answered, FakeGitHub } from '../../core/tests/fake-github.js';
import type { Preferences } from '../src/app/preferences.js';
import { type ProfileFolderNode, Profiles } from '../src/app/profiles.js';
import { mkdir, readdir, readFile, rm, writeFile } from '../src/engine/files.js';

afterEach(async () => {
  await rm('/', { recursive: true });
});

function memory(start: Record<string, unknown> = {}): Preferences & { readonly kept: Record<string, unknown> } {
  const kept = { ...start };
  return {
    kept,
    read: (key) => kept[key],
    write: (key, value) => {
      kept[key] = value;
    },
  };
}

const base = 'repository:\n  has_wiki: false\n';
const web = 'extends: ../base.yaml\nmerge:\n  allow_squash_merge: true\n';
const copy = '/profiles/github/lunch/config/@profiles';

/** A repository whose request for the repository itself, which starts every sync, can be made to fail. */
class Unreliable extends FakeGitRepository {
  #failures: Error[] = [];

  /** Fails the next `times` syncs with `error`, or every one. */
  fail(error: Error, times = Infinity): this {
    this.#failures = Array.from({ length: Math.min(times, 100) }, () => error);
    return this;
  }

  override request(...args: Parameters<FakeGitRepository['request']>): Promise<unknown> {
    const [method, path] = args;
    const failure = method === 'GET' && path === '/repos/lunch/config' ? this.#failures.shift() : undefined;
    return failure === undefined ? super.request(...args) : Promise.reject(failure);
  }
}

/** A config repository with a base profile and one in a subfolder, under `profiles/`. */
function repository(): Unreliable {
  const github = new Unreliable();
  github.write({ 'profiles/base.yaml': base, 'profiles/teams/web.yaml': web, 'README.md': '# Config' });
  return github;
}

async function inBrowser(files: Record<string, string>): Promise<void> {
  for (const [file, text] of Object.entries(files)) {
    await mkdir(`/profiles/browser/${file}`.replace(/\/[^/]+$/u, ''), { recursive: true });
    await writeFile(`/profiles/browser/${file}`, text);
  }
}

/** The sidebar's tree as text: each folder with its count, then what it holds, indented. */
function drawn(node: ProfileFolderNode, indent = ''): string[] {
  return [
    ...node.profiles.map((profile) => `${indent}${profile.name}`),
    ...node.folders.flatMap((folder) => [
      `${indent}${folder.name}/ ${folder.count}${folder.open ? '' : ' closed'}`,
      ...(folder.open ? drawn(folder, `${indent}  `) : []),
    ]),
  ];
}

async function connected(github: FakeGitRepository, preferences: Preferences = memory()): Promise<Profiles> {
  const profiles = new Profiles(github, preferences, () => undefined);
  expect(await profiles.connect(' lunch/config ', '/profiles/', false)).toBeUndefined();
  return profiles;
}

test('profiles start in this browser, listed with their subfolders', async () => {
  await inBrowser({ 'base.yaml': base, 'teams/web.yaml': web, 'teams/ios/app.yaml': base, '.hidden/x.yaml': base });
  const profiles = new Profiles(new FakeGitRepository(), memory(), () => undefined);

  await profiles.refresh();

  expect(profiles.source.value).toEqual({ kind: 'browser' });
  expect(profiles.sync.value).toEqual({ status: 'none' });
  expect(drawn(profiles.tree.value)).toEqual(['base', 'teams/ 2', '  web', '  ios/ 1', '    app']);
});

test('a search shows what it finds inside closed folders, and a closed folder hides what it holds', async () => {
  await inBrowser({ 'base.yaml': base, 'teams/web.yaml': web, 'teams/ios/app.yaml': base });
  const profiles = new Profiles(new FakeGitRepository(), memory(), () => undefined);
  await profiles.refresh();

  profiles.toggleFolder('teams');
  expect(drawn(profiles.tree.value)).toEqual(['base', 'teams/ 2 closed']);

  profiles.search.value = ' IOS ';
  expect(drawn(profiles.tree.value)).toEqual(['teams/ 1', '  ios/ 1', '    app']);

  profiles.search.value = '';
  profiles.toggleFolder('teams');
  expect(drawn(profiles.tree.value)).toEqual(['base', 'teams/ 2', '  web', '  ios/ 1', '    app']);
});

test('connecting a repository pulls its profiles and remembers it', async () => {
  const preferences = memory();
  const profiles = await connected(repository(), preferences);

  expect(profiles.source.value).toEqual({ kind: 'repository', repository: 'lunch/config', path: 'profiles' });
  expect(preferences.kept['profiles-source']).toEqual(profiles.source.value);
  expect(profiles.sync.value).toEqual({ status: 'synced', pulled: 2, pushed: 0 });
  expect(drawn(profiles.tree.value)).toEqual(['base', 'teams/ 1', '  web']);
  expect(profiles.listings.value.every((listing) => listing.problem === null)).toBe(true);

  const reopened = new Profiles(repository(), preferences, () => undefined);
  expect(reopened.source.value).toEqual(profiles.source.value);
});

test('connecting can add the profiles kept in the browser, except names the repository copy has', async () => {
  await inBrowser({ 'base.yaml': 'repository:\n  has_wiki: true\n', 'mine.yaml': base });
  const github = repository();
  const profiles = new Profiles(github, memory(), () => undefined);
  await profiles.refresh();
  // An earlier connection left a copy that already has base.yaml.
  await profiles.connect('lunch/config', 'profiles', false);
  await profiles.keepInBrowser();

  expect(await profiles.connect('lunch/config', 'profiles', true)).toBeUndefined();

  expect(github.files()['profiles/mine.yaml']).toBe(base);
  expect(github.files()['profiles/base.yaml']).toBe(base);
  expect(profiles.sync.value).toEqual({ status: 'synced', pulled: 0, pushed: 1 });
});

test('a repository that cannot be reached leaves the profiles where they were and no copy behind', async () => {
  await inBrowser({ 'mine.yaml': base });
  const github = repository().fail(answered(404, 'Not Found'));
  const preferences = memory();
  const profiles = new Profiles(github, preferences, () => undefined);
  await profiles.refresh();

  const problem = await profiles.connect('lunch/config', 'profiles', true);

  expect(problem).toContain('Repotted cannot reach the profiles in lunch/config');
  expect(profiles.source.value).toEqual({ kind: 'browser' });
  expect(preferences.kept['profiles-source']).toBeUndefined();
  expect(drawn(profiles.tree.value)).toEqual(['mine']);
  await expect(readdir(copy, { withFileTypes: true })).rejects.toMatchObject({ code: 'ENOENT' });
});

test('a failed change to a copy that had synced takes back only what the try copied in', async () => {
  await inBrowser({ 'mine.yaml': base });
  const github = repository();
  const profiles = new Profiles(github, memory(), () => undefined);
  await profiles.connect('lunch/config', 'profiles', false);
  await profiles.keepInBrowser();
  github.fail(answered(500, 'GitHub is having a moment'));

  expect(await profiles.connect('lunch/config', 'profiles', true)).toBe('GitHub is having a moment');

  expect((await readdir(copy, { withFileTypes: true })).map((entry) => entry.name).sort()).toEqual([
    '.repotted-sync.json',
    'base.yaml',
    'teams',
  ]);
});

test('a name that is not owner/name is refused before anything is asked of GitHub', async () => {
  const github = repository();
  const profiles = new Profiles(github, memory(), () => undefined);

  expect(await profiles.connect('just-a-name', '', false)).toBe(
    'Name the repository as owner/name, such as you/repotted-config.',
  );
  expect(github.calls).toEqual([]);
});

test('a profile changed in both places is a conflict until one side is kept', async () => {
  const github = repository();
  const profiles = await connected(github);
  const mine = 'repository:\n  has_wiki: true\n';
  const theirs = 'repository:\n  has_issues: false\n';

  await writeFile(`${copy}/base.yaml`, mine);
  github.write({ 'profiles/base.yaml': theirs });
  await profiles.refresh();
  expect(profiles.conflicts.value).toEqual(['base.yaml']);
  expect(await readFile(`${copy}/base.yaml`, 'utf8')).toBe(mine);

  await profiles.keep('remote');
  expect(profiles.conflicts.value).toEqual([]);
  expect(await readFile(`${copy}/base.yaml`, 'utf8')).toBe(theirs);

  await writeFile(`${copy}/base.yaml`, mine);
  github.write({ 'profiles/base.yaml': base });
  await profiles.refresh();
  await profiles.keep('local');
  expect(profiles.conflicts.value).toEqual([]);
  expect(github.files()['profiles/base.yaml']).toBe(mine);
});

test('a sync that fails keeps the profiles listed and says why, and the next one recovers', async () => {
  const github = repository();
  const profiles = await connected(github);
  github.fail(answered(500, 'GitHub is having a moment'), 1);

  await profiles.refresh();
  expect(profiles.sync.value).toEqual({ status: 'failed', message: 'GitHub is having a moment' });
  expect(drawn(profiles.tree.value)).toEqual(['base', 'teams/ 1', '  web']);

  await profiles.refresh();
  expect(profiles.sync.value).toEqual({ status: 'synced', pulled: 0, pushed: 0 });
});

test('a sign-in GitHub refuses during a sync is reported as signed out', async () => {
  const github = repository();
  const signedOut = vi.fn();
  const profiles = new Profiles(github, memory(), signedOut);
  await profiles.connect('lunch/config', 'profiles', false);
  github.fail(answered(401, 'Bad credentials'));

  await profiles.refresh();

  expect(signedOut).toHaveBeenCalledOnce();
});

test('an open profile shows its file, follows a sync, and closes when the sync removes it', async () => {
  const github = repository();
  const profiles = await connected(github);
  const [listing] = profiles.listings.value;

  await profiles.select(listing);
  expect(profiles.selected.value?.name).toBe('base');
  expect(profiles.opened.value?.text).toBe(base);

  github.write({ 'profiles/base.yaml': 'repository:\n  has_issues: false\n' });
  await profiles.refresh();
  expect(profiles.opened.value?.text).toBe('repository:\n  has_issues: false\n');

  github.write({ 'profiles/base.yaml': null, 'profiles/teams/web.yaml': base });
  await profiles.refresh();
  expect(profiles.selected.value).toBeUndefined();
  expect(profiles.opened.value).toBeUndefined();
});

test('going back to the browser lists its profiles and leaves the repository as it is', async () => {
  await inBrowser({ 'mine.yaml': base });
  const github = repository();
  const preferences = memory();
  const profiles = await connected(github, preferences);
  const before = github.log();

  await profiles.keepInBrowser();

  expect(preferences.kept['profiles-source']).toEqual({ kind: 'browser' });
  expect(profiles.sync.value).toEqual({ status: 'none' });
  expect(drawn(profiles.tree.value)).toEqual(['mine']);
  expect(github.log()).toEqual(before);
});

test('a refresh asked for during a connect waits its turn, then syncs with the new repository', async () => {
  const github = repository();
  const held = Promise.withResolvers<undefined>();
  const request = vi.fn<FakeGitRepository['request']>(async (method, path, body) => {
    await held.promise;
    return github.request(method, path, body);
  });
  const profiles = new Profiles({ request }, memory(), () => undefined);

  const connecting = profiles.connect('lunch/config', 'profiles', false);
  const refreshing = profiles.refresh();
  await vi.waitFor(() => {
    expect(request).toHaveBeenCalledTimes(1);
  });
  expect(profiles.busy.value).toBe(true);
  expect(profiles.source.value).toEqual({ kind: 'browser' });

  held.resolve(undefined);
  await Promise.all([connecting, refreshing]);

  expect(profiles.busy.value).toBe(false);
  expect(profiles.sync.value).toEqual({ status: 'synced', pulled: 0, pushed: 0 });
  expect(drawn(profiles.tree.value)).toEqual(['base', 'teams/ 1', '  web']);
});

test('keeping one side settles only the conflicts that were shown', async () => {
  const github = repository();
  const profiles = await connected(github);
  await writeFile(`${copy}/base.yaml`, 'repository:\n  has_wiki: true\n');
  github.write({ 'profiles/base.yaml': 'repository:\n  has_issues: false\n' });
  await profiles.refresh();
  expect(profiles.conflicts.value).toEqual(['base.yaml']);
  // Another profile changes in both places before the user answers.
  await writeFile(`${copy}/teams/web.yaml`, base);
  github.write({ 'profiles/teams/web.yaml': 'repository:\n  has_issues: false\n' });

  await profiles.keep('local');

  expect(profiles.conflicts.value).toEqual(['teams/web.yaml']);
  expect(github.files()['profiles/teams/web.yaml']).toBe('repository:\n  has_issues: false\n');
});

test('a remembered repository whose working copy the browser lost starts over as a first sync', async () => {
  const preferences = memory({
    'profiles-source': { kind: 'repository', repository: 'lunch/config', path: 'profiles' },
  });
  const profiles = new Profiles(repository(), preferences, () => undefined);

  await profiles.refresh();

  expect(profiles.sync.value).toEqual({ status: 'synced', pulled: 2, pushed: 0 });
  expect(drawn(profiles.tree.value)).toEqual(['base', 'teams/ 1', '  web']);
});

test('a sign-in refused while connecting is reported as signed out, and the reason stays for Settings', async () => {
  const github = repository().fail(answered(401, 'Bad credentials'));
  const signedOut = vi.fn();
  const profiles = new Profiles(github, memory(), signedOut);

  expect(await profiles.connect('lunch/config', 'profiles', false)).toBe('Bad credentials');

  expect(signedOut).toHaveBeenCalledOnce();
  expect(profiles.connectError.value).toBe('Bad credentials');
  expect(profiles.source.value).toEqual({ kind: 'browser' });

  await profiles.keepInBrowser();
  expect(profiles.connectError.value).toBeUndefined();
});

test('a new profile starts empty or extends another, in the folder asked for, and opens', async () => {
  await inBrowser({ 'base.yaml': `owner_type: organization\n${base}`, 'any.yaml': base });
  const profiles = new Profiles(new FakeGitRepository(), memory(), () => undefined);
  await profiles.refresh();
  const [any, typed] = profiles.listings.value;
  if (any === undefined || typed === undefined) {
    throw new Error('The folder should list both profiles.');
  }

  expect(
    await profiles.create({ name: ' mine ', folder: '', start: { kind: 'empty' }, ownerType: 'user' }),
  ).toBeUndefined();
  expect(await readFile('/profiles/browser/mine.yaml', 'utf8')).toBe('owner_type: user\n');
  expect(profiles.selected.value?.name).toBe('mine');

  await profiles.create({ name: 'web', folder: 'teams', start: { kind: 'extends', base: any }, ownerType: 'user' });
  expect(await readFile('/profiles/browser/teams/web.yaml', 'utf8')).toBe('extends: "../any.yaml"\nowner_type: user\n');

  // A typed base gives its type, so the new file names none.
  await profiles.create({ name: 'org', folder: 'teams', start: { kind: 'extends', base: typed }, ownerType: 'user' });
  expect(await readFile('/profiles/browser/teams/org.yaml', 'utf8')).toBe('extends: "../base.yaml"\n');

  expect(profiles.listings.value.map((listing) => [listing.name, listing.problem, listing.owner_type])).toEqual([
    ['any', null, null],
    ['base', null, 'organization'],
    ['mine', null, 'user'],
    ['org', null, 'organization'],
    ['web', null, 'user'],
  ]);
  expect(profiles.folders.value).toEqual(['', 'teams']);
});

test('a new profile never takes a name that is there, whatever its case, or one no file can have', async () => {
  await inBrowser({ 'Base.yaml': base, 'teams/web.yml': base });
  const profiles = new Profiles(new FakeGitRepository(), memory(), () => undefined);
  await profiles.refresh();
  const start = { kind: 'empty' } as const;

  expect(await profiles.create({ name: 'base', folder: '', start, ownerType: undefined })).toBe(
    'Base.yaml is already in the profiles folder.',
  );
  expect(profiles.nameProblem('WEB', 'teams')).toBe('web.yml is already in teams.');
  expect(profiles.nameProblem('web', '')).toBeUndefined();
  expect(profiles.nameProblem('  ', '')).toBe('Give the profile a name.');
  expect(profiles.nameProblem('a/b', '')).toContain('A name cannot');
  expect(profiles.nameProblem('.hidden', '')).toContain('A name cannot');
  expect(profiles.nameProblem('nul', '')).toContain('Windows keeps the name nul');
  expect(await readFile('/profiles/browser/Base.yaml', 'utf8')).toBe(base);
});

test('a capture makes a profile of the repository, holds its name while it reads, and says what it left out', async () => {
  const github = new FakeGitHub({ repository: { has_wiki: false }, ownerType: 'User' }, 'trae/site');
  const held = Promise.withResolvers<undefined>();
  const request: FakeGitHub['request'] = async (method, path, body) => {
    await held.promise;
    return github.request(method, path, body);
  };
  const profiles = new Profiles({ request }, memory(), () => undefined);
  await profiles.refresh();
  const capture = {
    name: 'site',
    folder: '',
    start: { kind: 'repository', repository: 'trae/site' },
    ownerType: undefined,
  } as const;

  const capturing = profiles.create(capture);
  expect(profiles.nameProblem('Site', '')).toBe('Another capture is making Site.yaml.');
  expect(profiles.listings.value).toEqual([]);
  held.resolve(undefined);

  expect(await capturing).toBeUndefined();
  expect(profiles.nameProblem('other', '')).toBeUndefined();
  expect(profiles.selected.value).toMatchObject({ name: 'site', problem: null, owner_type: 'user' });
  expect(profiles.opened.value?.text).toContain('has_wiki: false');
});

test('a capture that fails, or whose form closed, leaves no profile behind', async () => {
  const github = new FakeGitHub({}, 'trae/site').fail(/GET \/repos\/trae\/site$/u, answered(404, 'Not Found'), 1);
  const profiles = new Profiles(github, memory(), () => undefined);
  await profiles.refresh();
  const capture = {
    name: 'site',
    folder: '',
    start: { kind: 'repository', repository: 'trae/site' },
    ownerType: undefined,
  } as const;

  expect(await profiles.create(capture)).toBe('Not Found');
  expect(profiles.nameProblem('site', '')).toBeUndefined();

  const closed = new AbortController();
  const capturing = profiles.create(capture, closed.signal);
  closed.abort();
  expect(await capturing).toBeUndefined();

  expect(profiles.listings.value).toEqual([]);
  await expect(readFile('/profiles/browser/site.yaml', 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

test('making and deleting a profile kept on GitHub commits each', async () => {
  const github = repository();
  const profiles = await connected(github);

  await profiles.create({ name: 'mine', folder: 'teams', start: { kind: 'empty' }, ownerType: 'organization' });
  expect(github.files()['profiles/teams/mine.yaml']).toBe('owner_type: organization\n');

  const mine = profiles.selected.value;
  if (mine === undefined) {
    throw new Error('The new profile should be open.');
  }
  expect(await profiles.remove(mine)).toBeUndefined();

  expect(github.files()['profiles/teams/mine.yaml']).toBeUndefined();
  expect(profiles.selected.value).toBeUndefined();
  expect(drawn(profiles.tree.value)).toEqual(['base', 'teams/ 1', '  web']);
});

test('the profiles that extend one, directly or through another, are named before it is deleted', async () => {
  await inBrowser({
    'base.yaml': base,
    'mid.yaml': 'extends: base.yaml\n',
    'teams/leaf.yaml': 'extends: ../mid.yaml\n',
    'other.yaml': base,
  });
  const profiles = new Profiles(new FakeGitRepository(), memory(), () => undefined);
  await profiles.refresh();
  const root = profiles.listings.value.find((listing) => listing.name === 'base');
  if (root === undefined) {
    throw new Error('The folder should list base.');
  }

  expect(profiles.dependents(root).map((listing) => listing.name)).toEqual(['mid', 'leaf']);

  await profiles.remove(root);
  expect(profiles.listings.value.map((listing) => [listing.name, listing.problem === null])).toEqual([
    ['mid', false],
    ['other', true],
    ['leaf', false],
  ]);
});
