import { afterEach, expect, test, vi } from 'vitest';

import { FakeGitRepository } from '../../../core/tests/support/fake-git.js';
import { answered, FakeGitHub } from '../../../core/tests/support/fake-github.js';
import type { Preferences } from '../../src/app/preferences/preferences.js';
import { type ProfileFolderNode, type ProfileListing, Profiles } from '../../src/app/profiles/profiles.js';
import { mkdir, readdir, readFile, rm, writeFile } from '../../src/engine/files.js';

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
const web = 'merge:\n  allow_squash_merge: true\n';
const copy = '/profiles/github/lunch/config/@profiles';

class RepositoryWithFailingSyncs extends FakeGitRepository {
  #failures: Error[] = [];

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

function repository(): RepositoryWithFailingSyncs {
  const github = new RepositoryWithFailingSyncs();
  github.write({ 'profiles/base.yaml': base, 'profiles/teams/web.yaml': web, 'README.md': '# Config' });
  return github;
}

async function inBrowser(files: Record<string, string>): Promise<void> {
  for (const [file, text] of Object.entries(files)) {
    await mkdir(`/profiles/browser/${file}`.replace(/\/[^/]+$/u, ''), { recursive: true });
    await writeFile(`/profiles/browser/${file}`, text);
  }
}

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

test('an unread profile folder becomes empty only after a successful read, and an initial failure can recover', async () => {
  const profiles = new Profiles(new FakeGitRepository(), memory(), () => undefined);
  expect(profiles.listed.value).toBe(false);
  await mkdir('/profiles', { recursive: true });
  await writeFile('/profiles/browser', 'A file where the folder belongs');
  await profiles.refresh();
  expect(profiles.listingError.value).toBeDefined();
  expect(profiles.listed.value).toBe(false);
  await rm('/profiles/browser');
  await profiles.refresh();
  expect(profiles.listed.value).toBe(true);
  expect(profiles.listingError.value).toBeUndefined();
  expect(profiles.listings.value).toEqual([]);
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
  expect(profiles.profileWorkUnderWay.value).toBe(true);
  expect(profiles.source.value).toEqual({ kind: 'browser' });

  held.resolve(undefined);
  await Promise.all([connecting, refreshing]);

  expect(profiles.profileWorkUnderWay.value).toBe(false);
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

test('a new profile starts empty, in the folder asked for, and opens', async () => {
  await inBrowser({ 'base.yaml': `owner_type: organization\n${base}`, 'any.yaml': base });
  const profiles = new Profiles(new FakeGitRepository(), memory(), () => undefined);
  await profiles.refresh();

  expect(
    await profiles.create({ name: ' mine ', folder: '', start: { kind: 'empty' }, ownerType: 'user' }),
  ).toBeUndefined();
  expect(await readFile('/profiles/browser/mine.yaml', 'utf8')).toBe('owner_type: user\n');
  expect(profiles.selected.value?.name).toBe('mine');

  await profiles.create({ name: 'web', folder: 'teams', start: { kind: 'empty' }, ownerType: undefined });
  expect(await readFile('/profiles/browser/teams/web.yaml', 'utf8')).toBe('');

  expect(profiles.listings.value.map((listing) => [listing.name, listing.problem, listing.owner_type])).toEqual([
    ['any', null, null],
    ['base', null, 'organization'],
    ['mine', null, 'user'],
    ['web', null, null],
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
  expect(profiles.nameProblem('con.old', '')).toContain('Windows keeps the name con.old');
  expect(profiles.nameProblem('a\tb', '')).toContain('A name cannot');
  expect(profiles.nameProblem('mine.yaml', '')).toBe('Leave out the file ending; Repotted adds .yaml.');
  expect(await profiles.create({ name: 'out', folder: '../..', start, ownerType: undefined })).toBe(
    '../.. is not a folder a profile can go in.',
  );
  expect(await readFile('/profiles/browser/Base.yaml', 'utf8')).toBe(base);
});

test('a capture makes a profile of the repository, holds its name while it reads, and stays quiet about what its owner type can never hold', async () => {
  const github = new FakeGitHub(
    { repository: { has_wiki: false, allow_forking: true }, ownerType: 'User' },
    'trae/site',
  );
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
  expect(profiles.opened.value?.text).not.toContain('allow_forking');
  expect(profiles.settingsCaptureCouldNotRead.value).toBeUndefined();
});

test('a capture the installation lacks a permission for links to where an owner accepts it', async () => {
  const github = new FakeGitHub(
    {
      ownerType: 'User',
      account: {
        login: 'trae',
        name: null,
        repositories: [],
        installations: [
          { id: 4, permissions: { metadata: 'read' }, repositories: [{ full_name: 'trae/site', private: false }] },
        ],
      },
    },
    'trae/site',
  ).fail('GET /repos/trae/site/pages', answered(403, 'Resource not accessible by integration'));
  const profiles = new Profiles(github, memory(), () => undefined);
  await profiles.refresh();

  await profiles.create({
    name: 'site',
    folder: '',
    start: { kind: 'repository', repository: 'trae/site' },
    ownerType: undefined,
  });

  const uncaptured = profiles.settingsCaptureCouldNotRead.value?.uncaptured;
  expect(uncaptured?.groups).toContainEqual({
    settings: ['Pages'],
    reason: "Needs the Repotted App's Pages read permission.",
  });
  expect(uncaptured).toMatchObject({
    needsAppPermission: true,
    installationSettingsUrl: 'https://github.com/settings/installations/4',
  });
});

test('a capture keeps what it could not read when the installation link cannot be found, but not a lost sign-in', async () => {
  const withPagesRefused = (): FakeGitHub =>
    new FakeGitHub({ ownerType: 'User' }, 'trae/site').fail(
      'GET /repos/trae/site/pages',
      answered(403, 'Resource not accessible by integration'),
    );
  const failing = withPagesRefused().fail('GET /user/installations', answered(500, 'Server Error'));
  const profiles = new Profiles(failing, memory(), () => undefined);
  await profiles.refresh();

  await profiles.create({
    name: 'site',
    folder: '',
    start: { kind: 'repository', repository: 'trae/site' },
    ownerType: undefined,
  });
  expect(profiles.settingsCaptureCouldNotRead.value?.uncaptured).toMatchObject({
    count: 1,
    needsAppPermission: true,
    installationSettingsUrl: null,
  });

  const signedOut = vi.fn();
  const lost = withPagesRefused().fail('GET /user/installations', answered(401, 'Bad credentials'));
  const lostProfiles = new Profiles(lost, memory(), signedOut);
  await lostProfiles.refresh();
  expect(
    await lostProfiles.create({
      name: 'other',
      folder: '',
      start: { kind: 'repository', repository: 'trae/site' },
      ownerType: undefined,
    }),
  ).toContain('Bad credentials');
  expect(signedOut).toHaveBeenCalledOnce();
  expect(lostProfiles.listings.value.some((listing) => listing.name === 'other')).toBe(false);
});

test('a capture goes on past a setting GitHub withholds without a payment method, and says so', async () => {
  const github = new FakeGitHub({ ownerType: 'User' }, 'trae/site').fail(
    'GET /repos/trae/site/actions/cache/retention-limit',
    answered(402, 'Please ensure your account has a valid payment method on file to access this service.'),
  );
  const profiles = new Profiles(github, memory(), () => undefined);
  await profiles.refresh();

  expect(
    await profiles.create({
      name: 'site',
      folder: '',
      start: { kind: 'repository', repository: 'trae/site' },
      ownerType: undefined,
    }),
  ).toBeUndefined();
  expect(profiles.selected.value).toMatchObject({ name: 'site', problem: null });
  expect(profiles.settingsCaptureCouldNotRead.value).toEqual({
    file: '/profiles/browser/site.yaml',
    uncaptured: {
      count: 1,
      groups: [
        { settings: ['Cache retention, in days'], reason: 'GitHub shows it only with a payment method on file.' },
      ],
      needsAppPermission: false,
      installationSettingsUrl: null,
    },
  });

  const site = profiles.selected.value;
  if (site !== undefined) {
    await profiles.remove(site);
  }
  expect(profiles.settingsCaptureCouldNotRead.value).toBeUndefined();
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

test('the profiles that reference a definition are named before it is deleted', async () => {
  await inBrowser({
    'base.yaml': 'kind: ruleset\nrulesets: [{ name: Main }]\n',
    'mid.yaml': 'references: { rulesets: [base.yaml] }\n',
    'teams/leaf.yaml': 'references: { rulesets: [../base.yaml] }\n',
    'other.yaml': base,
  });
  const profiles = new Profiles(new FakeGitRepository(), memory(), () => undefined);
  await profiles.refresh();
  const root = profiles.listings.value.find((listing) => listing.name === 'base');
  if (root === undefined) {
    throw new Error('The folder should list base.');
  }

  expect(profiles.dependents(root).map((listing) => listing.name)).toEqual(['mid', 'leaf']);
});

test('a new profile asked for during a sync is checked against what the sync brings in', async () => {
  const github = new FakeGitRepository();
  github.write({ 'profiles/Base.yaml': base, 'profiles/teams/web.yml': web.replace('../base.yaml', '../Base.yaml') });
  const held = Promise.withResolvers<undefined>();
  const request = vi.fn<FakeGitRepository['request']>(async (method, path, body) => {
    await held.promise;
    return github.request(method, path, body);
  });
  const preferences = memory({
    'profiles-source': { kind: 'repository', repository: 'lunch/config', path: 'profiles' },
  });
  const profiles = new Profiles({ request }, preferences, () => undefined);
  const start = { kind: 'empty' } as const;

  // The first sync of the visit is under way, so nothing is listed yet.
  const syncing = profiles.refresh();
  const first = profiles.create({ name: 'base', folder: '', start, ownerType: undefined });
  const second = profiles.create({ name: 'web', folder: 'teams', start, ownerType: undefined });
  held.resolve(undefined);
  await syncing;

  expect(await first).toBe('Base.yaml is already in the profiles folder.');
  expect(await second).toBe('web.yml is already in teams.');
  expect(Object.keys(github.files()).sort()).toEqual(['profiles/Base.yaml', 'profiles/teams/web.yml']);
  expect(profiles.sync.value.status).toBe('synced');
});

test('a capture that ends after profiles moved elsewhere makes nothing there', async () => {
  const api = new FakeGitHub({}, 'trae/site');
  const config = repository();
  const held = Promise.withResolvers<undefined>();
  const request: FakeGitHub['request'] = async (method, path, body) => {
    if (path.startsWith('/repos/trae/site')) {
      await held.promise;
      return api.request(method, path, body);
    }
    return config.request(method, path, body);
  };
  const profiles = new Profiles({ request }, memory(), () => undefined);
  await profiles.refresh();

  const capturing = profiles.create({
    name: 'site',
    folder: '',
    start: { kind: 'repository', repository: 'trae/site' },
    ownerType: undefined,
  });
  expect(await profiles.connect('lunch/config', 'profiles', false)).toBeUndefined();
  held.resolve(undefined);

  expect(await capturing).toBe('Where profiles are kept changed, so the profile was not made.');
  expect(config.files()['profiles/site.yaml']).toBeUndefined();
  await expect(readFile('/profiles/browser/site.yaml', 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

test('a sign-in refused during a capture is reported as signed out, and nothing is made', async () => {
  const github = new FakeGitHub({}, 'trae/site').fail(/GET \/repos\/trae\/site$/u, answered(401, 'Bad credentials'));
  const signedOut = vi.fn();
  const profiles = new Profiles(github, memory(), signedOut);
  await profiles.refresh();

  const failure = await profiles.create({
    name: 'site',
    folder: '',
    start: { kind: 'repository', repository: 'trae/site' },
    ownerType: undefined,
  });

  expect(failure).toBe('Bad credentials');
  expect(signedOut).toHaveBeenCalledOnce();
  expect(profiles.listings.value).toEqual([]);
});

test('a profile made or deleted while GitHub is out of reach is kept here, and the next sync carries it', async () => {
  const github = repository();
  const profiles = await connected(github);
  github.fail(answered(500, 'GitHub is having a moment'), 1);

  expect(
    await profiles.create({ name: 'mine', folder: '', start: { kind: 'empty' }, ownerType: undefined }),
  ).toBeUndefined();
  expect(profiles.sync.value).toEqual({ status: 'failed', message: 'GitHub is having a moment' });
  expect(profiles.selected.value?.name).toBe('mine');
  expect(github.files()['profiles/mine.yaml']).toBeUndefined();

  await profiles.refresh();
  expect(github.files()['profiles/mine.yaml']).toBe('');

  const mine = profiles.selected.value;
  github.fail(answered(500, 'GitHub is having a moment'), 1);
  if (mine !== undefined) {
    await profiles.remove(mine);
  }
  expect(profiles.sync.value.status).toBe('failed');
  expect(drawn(profiles.tree.value)).toEqual(['base', 'teams/ 1', '  web']);
  expect(github.files()['profiles/mine.yaml']).toBe('');

  await profiles.refresh();
  expect(github.files()['profiles/mine.yaml']).toBeUndefined();
});

test('a delete asked of a list that has since changed deletes nothing', async () => {
  await inBrowser({ 'base.yaml': base });
  const profiles = await connected(repository());
  const [listed] = profiles.listings.value;
  if (listed === undefined) {
    throw new Error('The repository should list a profile.');
  }
  await profiles.keepInBrowser();

  expect(await profiles.remove(listed)).toBeUndefined();

  expect(await readFile(`${copy}/base.yaml`, 'utf8')).toBe(base);
  expect(drawn(profiles.tree.value)).toEqual(['base']);
});

test('a profile deleted here and changed on GitHub is a conflict that either side can win', async () => {
  const github = repository();
  const profiles = await connected(github);
  const theirs = 'repository:\n  has_issues: false\n';
  const find = (): ReturnType<Profiles['listings']['value']['find']> =>
    profiles.listings.value.find((listing) => listing.name === 'base');

  github.write({ 'profiles/base.yaml': theirs });
  const listed = find();
  if (listed !== undefined) {
    await profiles.remove(listed);
  }
  expect(profiles.conflicts.value).toEqual(['base.yaml']);
  expect(find()).toBeUndefined();

  await profiles.keep('remote');
  expect(await readFile(`${copy}/base.yaml`, 'utf8')).toBe(theirs);

  github.write({ 'profiles/base.yaml': base });
  const again = find();
  if (again !== undefined) {
    await profiles.remove(again);
  }
  await profiles.keep('local');
  expect(github.files()['profiles/base.yaml']).toBeUndefined();
});

test('unsaved changes outlast a look at another profile, hold a move back, and are committed by a save', async () => {
  const github = repository();
  const profiles = await connected(github);
  const [first, second] = profiles.listings.value;
  await profiles.select(first);
  const editor = profiles.editor.value;
  const wiki = editor?.sections.value
    .flatMap((section) => section.groups.flatMap((group) => group.rows))
    .find((row) => row.field.key === 'has_wiki')?.field;
  if (editor === undefined || wiki === undefined) {
    throw new Error('The open profile should have an editor with a wiki setting.');
  }

  await editor.set(wiki, true);
  await profiles.select(second);
  expect([...profiles.unsaved.value]).toEqual([`${copy}/base.yaml`]);
  await profiles.keepInBrowser();
  expect(profiles.connectError.value).toBe('Save or reset your unsaved changes first.');
  expect(profiles.source.value.kind).toBe('repository');

  // A sync reads the profile again and lays the change over it.
  await profiles.refresh();
  await profiles.select(first);
  expect(profiles.editor.value).toBe(editor);
  expect(editor.dirty.value).toBe(true);

  await profiles.save();
  expect(github.files()['profiles/base.yaml']).toBe('repository:\n  has_wiki: true\n');
  expect(profiles.unsaved.value.size).toBe(0);
  expect(profiles.opened.value?.text).toContain('has_wiki: true');
});

test('invalid profile corrections outlast navigation, hold a move back, and save through sync', async () => {
  const github = repository();
  github.write({ 'profiles/repair.yaml': 'repository: [\n' });
  const profiles = await connected(github);
  const listing = profiles.listings.value.find((item) => item.name === 'repair');
  await profiles.select(listing);
  const editor = profiles.editor.value;
  const repair = editor?.repair.value;
  if (editor === undefined || repair === undefined) {
    throw new Error('An invalid profile should offer its YAML for repair.');
  }
  await repair.type('repository:\n  has_issues: false\n');
  await profiles.select(undefined);
  expect(profiles.unsavedNames.value).toEqual(['repair']);
  await profiles.keepInBrowser();
  expect(profiles.connectError.value).toBe('Save or reset your unsaved changes first.');
  await profiles.refresh();
  await profiles.select(listing);
  expect(profiles.editor.value).toBe(editor);
  expect(editor.repair.value).toBe(repair);
  expect(await profiles.saveAll()).toBe('saved');
  expect(github.files()['profiles/repair.yaml']).toBe('repository:\n  has_issues: false\n');
  expect(editor.loaded.value).toBe(true);
  expect(profiles.unsavedNames.value).toEqual([]);
  expect(profiles.selected.value?.problem).toBeNull();
});

test('sync before a repair save refuses to overwrite remote changes and keeps corrections until discarded', async () => {
  const github = repository();
  github.write({ 'profiles/repair.yaml': 'repository: [\n' });
  const profiles = await connected(github);
  await profiles.select(profiles.listings.value.find((item) => item.name === 'repair'));
  const repair = profiles.editor.value?.repair.value;
  if (repair === undefined) {
    throw new Error('An invalid profile should offer its YAML for repair.');
  }
  await repair.type('repository:\n  has_wiki: true\n');
  const changed = 'repository:\n  description: A remote correction\n';
  github.write({ 'profiles/repair.yaml': changed });
  expect(await profiles.saveAll()).toBe('unsaved');
  expect(repair.saveError.value).toContain('changed elsewhere');
  expect(repair.text.value).toBe('repository:\n  has_wiki: true\n');
  expect(github.files()['profiles/repair.yaml']).toBe(changed);
  expect(await readFile(`${copy}/repair.yaml`, 'utf8')).toBe(changed);

  await profiles.discardAll();
  expect(profiles.unsavedNames.value).toEqual([]);
  expect(profiles.editor.value?.repair.value).toBeUndefined();
  expect(profiles.editor.value?.loaded.value).toBe(true);
});

test('closing the open profile leaves none open, and its unsaved changes wait for it to open again', async () => {
  await inBrowser({ 'base.yaml': base });
  const profiles = new Profiles(new FakeGitRepository(), memory(), () => undefined);
  await profiles.refresh();
  const [listed] = profiles.listings.value;
  await profiles.select(listed);
  const editor = profiles.editor.value;
  const field = editor?.sections.value[0]?.groups[1]?.rows[0]?.field;
  if (listed === undefined || editor === undefined || field === undefined) {
    throw new Error('The open profile should have an editor.');
  }
  await editor.set(field, false);

  await profiles.select(undefined);
  expect(profiles.selected.value).toBeUndefined();
  expect(profiles.editor.value).toBeUndefined();
  expect(profiles.opened.value).toBeUndefined();
  expect([...profiles.unsaved.value]).toEqual([listed.file]);

  await profiles.select(listed);
  expect(profiles.editor.value).toBe(editor);
  expect(editor.dirty.value).toBe(true);
});

test('every unsaved profile is saved or discarded at once, and one that cannot be saved keeps its changes', async () => {
  await inBrowser({ 'base.yaml': base, 'other.yaml': base });
  const profiles = new Profiles(new FakeGitRepository(), memory(), () => undefined);
  await profiles.refresh();
  const change = async (index: number, value: unknown): Promise<void> => {
    await profiles.select(profiles.listings.value[index]);
    const editor = profiles.editor.value;
    const wiki = editor?.sections.value
      .flatMap((section) => section.groups.flatMap((group) => group.rows))
      .find((row) => row.field.key === 'has_wiki')?.field;
    if (editor === undefined || wiki === undefined) {
      throw new Error('The open profile should have an editor with a wiki setting.');
    }
    await editor.set(wiki, value);
  };
  await change(0, true);
  await change(1, true);
  expect(profiles.unsavedNames.value).toEqual(['base', 'other']);

  expect(await profiles.saveAll()).toBe('saved');
  expect(await readFile('/profiles/browser/base.yaml', 'utf8')).toBe('repository:\n  has_wiki: true\n');
  expect(await readFile('/profiles/browser/other.yaml', 'utf8')).toBe('repository:\n  has_wiki: true\n');

  // A value that isn't valid can't be saved, so its profile stays unsaved while the other is saved.
  await change(0, 'sometimes');
  await change(1, false);
  expect(await profiles.saveAll()).toBe('unsaved');
  expect(profiles.unsavedNames.value).toEqual(['base']);
  expect(await readFile('/profiles/browser/other.yaml', 'utf8')).toBe('repository:\n  has_wiki: false\n');

  await profiles.discardAll();
  expect(profiles.unsavedNames.value).toEqual([]);
  expect(await readFile('/profiles/browser/base.yaml', 'utf8')).toBe('repository:\n  has_wiki: true\n');
});

test('saving every profile leaves one with a draft unsaved, and says when the sync did not take the rest', async () => {
  const github = repository();
  github.write({
    'profiles/drafted.yaml': 'repository:\n  has_wiki: false\ndrafts:\n  repository:\n    has_issues: false\n',
  });
  const profiles = await connected(github);
  const change = async (name: string): Promise<void> => {
    await profiles.select(profiles.listings.value.find((listing) => listing.name === name));
    const editor = profiles.editor.value;
    const wiki = editor?.sections.value
      .flatMap((section) => section.groups.flatMap((group) => group.rows))
      .find((row) => row.field.key === 'has_wiki')?.field;
    if (editor === undefined || wiki === undefined) {
      throw new Error('The open profile should have an editor with a wiki setting.');
    }
    await editor.set(wiki, true);
  };
  await change('drafted');

  // A save here would apply the draft unseen, so the profile keeps its changes and its draft.
  expect(await profiles.saveAll()).toBe('unsaved');
  expect(profiles.unsavedNames.value).toEqual(['drafted']);
  expect(github.files()['profiles/drafted.yaml']).toContain('drafts:');
  await profiles.discardAll();

  // A profile in a folder goes by its path from the profiles folder.
  await change('web');
  expect(profiles.unsavedNames.value).toEqual(['teams/web']);
  await profiles.discardAll();

  await change('base');
  github.fail(answered(500, 'Server Error'), 2);
  expect(await profiles.saveAll()).toBe('unsynced');
  expect(profiles.unsavedNames.value).toEqual([]);
  expect(github.files()['profiles/base.yaml']).toBe(base);

  // A profile changed in both places since is as much a reason to ask again as a failed sync.
  github.write({ 'profiles/base.yaml': 'repository:\n  has_issues: true\n' });
  await change('web');
  expect(await profiles.saveAll()).toBe('unsynced');
  expect(profiles.sync.value.status).toBe('synced');
  expect(profiles.conflicts.value).toEqual(['base.yaml']);
});

test('a deleted profile takes its unsaved changes with it', async () => {
  await inBrowser({ 'base.yaml': base });
  const profiles = new Profiles(new FakeGitRepository(), memory(), () => undefined);
  await profiles.refresh();
  const [listed] = profiles.listings.value;
  await profiles.select(listed);
  const editor = profiles.editor.value;
  const field = editor?.sections.value[0]?.groups[1]?.rows[0]?.field;
  if (listed === undefined || editor === undefined || field === undefined) {
    throw new Error('The open profile should have an editor.');
  }
  await editor.set(field, false);

  await profiles.remove(listed);

  expect(profiles.unsaved.value.size).toBe(0);
  expect(profiles.editor.value).toBeUndefined();
  expect(profiles.selected.value).toBeUndefined();
});

test('an editor goes with its profile when a sync removes it, and every editor goes when profiles move', async () => {
  const github = repository();
  const profiles = await connected(github);
  const [first] = profiles.listings.value;
  await profiles.select(first);
  const editor = profiles.editor.value;
  expect(editor?.file).toBe(`${copy}/base.yaml`);

  github.write({ 'profiles/base.yaml': null, 'profiles/teams/web.yaml': base });
  await profiles.refresh();
  expect(profiles.editor.value).toBeUndefined();

  await profiles.select(profiles.listings.value[0]);
  const web = profiles.editor.value;
  await profiles.keepInBrowser();
  await profiles.connect('lunch/config', 'profiles', false);
  await profiles.select(profiles.listings.value[0]);
  expect(profiles.editor.value).toBeDefined();
  expect(profiles.editor.value).not.toBe(web);
});

test('unsaved changes hold back a move to another repository, and a save waits its turn behind a sync', async () => {
  const github = repository();
  const held = { gate: Promise.resolve<undefined>(undefined) };
  const request: FakeGitRepository['request'] = async (method, path, body) => {
    await held.gate;
    return github.request(method, path, body);
  };
  const profiles = new Profiles({ request }, memory(), () => undefined);
  await profiles.connect('lunch/config', 'profiles', false);
  await profiles.select(profiles.listings.value[0]);
  const editor = profiles.editor.value;
  const wiki = editor?.sections.value
    .flatMap((section) => section.groups.flatMap((group) => group.rows))
    .find((row) => row.field.key === 'has_wiki')?.field;
  if (editor === undefined || wiki === undefined) {
    throw new Error('The open profile should have an editor with a wiki setting.');
  }
  await editor.set(wiki, true);

  expect(await profiles.connect('lunch/other', '', false)).toBe('Save or reset your unsaved changes first.');
  expect(profiles.source.value).toMatchObject({ repository: 'lunch/config' });

  const release = Promise.withResolvers<undefined>();
  held.gate = release.promise;
  const syncing = profiles.refresh();
  const saving = profiles.save();
  expect(editor.saving.value).toBe(true);
  expect(await readFile(`${copy}/base.yaml`, 'utf8')).toBe(base);
  release.resolve(undefined);
  await Promise.all([syncing, saving]);

  expect(github.files()['profiles/base.yaml']).toBe('repository:\n  has_wiki: true\n');
  expect(editor.dirty.value).toBe(false);
});

test("a sign-in refused while a profile's action patterns are checked is reported as signed out", async () => {
  await inBrowser({
    'ci.yaml':
      'actions:\n  allowed_actions: selected\n  selected_actions:\n    patterns_allowed:\n      - octo-org/deploy\n',
  });
  const signedOut = vi.fn();
  const request = vi.fn(() => Promise.reject(answered(401, 'Bad credentials')));
  const profiles = new Profiles({ request }, memory(), signedOut);
  await profiles.refresh();

  await profiles.select(profiles.listings.value[0]);
  await vi.waitFor(() => {
    expect(signedOut).toHaveBeenCalledOnce();
  });

  expect(profiles.editor.value?.patterns?.lines.value[0]?.state).toEqual({
    kind: 'failed',
    message: 'Bad credentials',
  });
});

test('a sign-in refused while actions are searched for is reported as signed out', async () => {
  await inBrowser({ 'ci.yaml': 'actions:\n  allowed_actions: selected\n' });
  const signedOut = vi.fn();
  const request = vi.fn(() => Promise.reject(answered(401, 'Bad credentials')));
  const profiles = new Profiles({ request }, memory(), signedOut);
  await profiles.refresh();
  await profiles.select(profiles.listings.value[0]);
  const search = profiles.editor.value?.actionSearch;

  search?.type('checkout');
  search?.enter();
  await vi.waitFor(() => {
    expect(signedOut).toHaveBeenCalledOnce();
  });

  expect(search?.state.value).toEqual({ kind: 'message', text: 'Bad credentials' });
});

function listed(profiles: Profiles, name: string): ProfileListing {
  const listing = profiles.listings.value.find((item) => item.name === name);
  if (listing === undefined) {
    throw new Error(`The list should have ${name}.`);
  }
  return listing;
}

test('moving profiles kept on GitHub moves their files and keeps the one open open', async () => {
  const github = repository();
  const profiles = await connected(github);
  await profiles.select(listed(profiles, 'base'));
  profiles.selectForBatch([listed(profiles, 'base'), listed(profiles, 'web')], true);

  expect(await profiles.move(profiles.batch.value, 'shared')).toBeUndefined();

  const files = github.files();
  expect(files['profiles/base.yaml']).toBeUndefined();
  expect(files['profiles/teams/web.yaml']).toBeUndefined();
  expect(files['profiles/shared/base.yaml']).toBe(base);
  expect(files['profiles/shared/web.yaml']).toBe(web);
  expect(profiles.listings.value.every((listing) => listing.problem === null)).toBe(true);
  expect(drawn(profiles.tree.value)).toEqual(['shared/ 2', '  base', '  web']);
  expect(profiles.selected.value?.file).toBe(`${copy}/shared/base.yaml`);
  expect(profiles.opened.value?.file).toBe(`${copy}/shared/base.yaml`);
  expect(profiles.batch.value).toEqual([]);
});

test('a move is one commit, keeps a .yml name, and opens the folder it went to', async () => {
  const github = repository();
  github.write({ 'profiles/apps/site.yml': 'labels: [{ name: bug }]\n' });
  const profiles = await connected(github);
  profiles.toggleFolder('teams');
  const commits = github.commits.size;

  expect(await profiles.move([listed(profiles, 'site')], 'teams')).toBeUndefined();

  expect(github.commits.size).toBe(commits + 1);
  expect(github.files()['profiles/teams/site.yml']).toBe('labels: [{ name: bug }]\n');
  expect(drawn(profiles.tree.value)).toEqual(['base', 'teams/ 2', '  site', '  web']);
});

test('a folder that matches another in case only, or runs through a profile, is refused', async () => {
  await inBrowser({ 'base.yaml': base, 'Teams/web.yaml': web, 'apps/ios/app.yaml': base, 'loose.yaml': base });
  const profiles = new Profiles(new FakeGitRepository(), memory(), () => undefined);
  await profiles.refresh();
  const before = drawn(profiles.tree.value);

  expect(await profiles.move([listed(profiles, 'loose')], 'teams')).toBe('There is already a folder named Teams.');
  expect(await profiles.move([listed(profiles, 'loose')], 'APPS/new')).toBe('There is already a folder named apps.');
  expect(await profiles.move([listed(profiles, 'loose')], 'base.yaml')).toBe(
    "base.yaml is a profile, so it can't be a folder.",
  );
  expect(await profiles.renameFolder('Teams', 'teams')).toBe(
    'teams differs from Teams only in case, which some computers take for the same folder. Give it another name.',
  );
  expect(await profiles.renameFolder('apps/ios', 'IOS')).toBe(
    'IOS differs from ios only in case, which some computers take for the same folder. Give it another name.',
  );

  expect(drawn(profiles.tree.value)).toEqual(before);
  expect(await profiles.renameFolder('apps', 'Apps-old')).toBeUndefined();
});

test('a write that fails partway takes back what the move wrote, and nothing is committed', async () => {
  const github = repository();
  github.write({ 'profiles/aaa.yaml': 'labels: [{ name: bug }]\n', 'profiles/zzz.yaml': base });
  const profiles = await connected(github);
  // A folder where base.yaml would go, which the list never shows, as it holds no profile.
  await mkdir(`${copy}/shared/base.yaml`, { recursive: true });
  const commits = github.commits.size;

  expect(
    await profiles.move([listed(profiles, 'aaa'), listed(profiles, 'base'), listed(profiles, 'zzz')], 'shared'),
  ).toBe('base.yaml is already in shared.');

  expect(github.commits.size).toBe(commits);
  expect(await readFile(`${copy}/aaa.yaml`, 'utf8')).toBe('labels: [{ name: bug }]\n');
  expect(await readFile(`${copy}/base.yaml`, 'utf8')).toBe(base);
  expect((await readdir(`${copy}/shared`, { withFileTypes: true })).map((entry) => entry.name)).toEqual(['base.yaml']);
  expect(profiles.listings.value.every((listing) => listing.problem === null)).toBe(true);
  expect(drawn(profiles.tree.value)).toEqual(['aaa', 'base', 'zzz', 'teams/ 1', '  web']);
});

test('a move that would replace a profile, would move one with unsaved changes, or holds one that does not load, moves nothing', async () => {
  await inBrowser({
    'base.yaml': base,
    'teams/base.yaml': base,
    'teams/web.yaml': web,
    'broken.yaml': 'repository: { has_wiki: broken }\n',
  });
  const profiles = new Profiles(new FakeGitRepository(), memory(), () => undefined);
  await profiles.refresh();
  const before = drawn(profiles.tree.value);

  expect(await profiles.move([listed(profiles, 'base')], 'teams')).toBe('base.yaml is already in teams.');
  expect(await profiles.move([listed(profiles, 'broken')], 'teams')).toBe(
    "broken doesn't load, so it can't be moved. Fix it first.",
  );
  expect(await profiles.move([listed(profiles, 'web')], '../out')).toBe('../out is not a folder a profile can go in.');

  await profiles.select(profiles.listings.value.find((listing) => listing.file.endsWith('/teams/web.yaml')));
  const editor = profiles.editor.value;
  const squash = editor?.sections.value
    .flatMap((section) => section.groups.flatMap((group) => group.rows))
    .find((row) => row.field.key === 'allow_squash_merge')?.field;
  if (editor === undefined || squash === undefined) {
    throw new Error('The open profile should have an editor with a squash merge setting.');
  }
  await editor.set(squash, false);
  expect(await profiles.move([listed(profiles, 'web')], '')).toBe('Save or reset the changes to web first.');

  expect(drawn(profiles.tree.value)).toEqual(before);
  expect(await readFile('/profiles/browser/teams/web.yaml', 'utf8')).toBe(web);
});

test('renaming a folder moves the profiles in it and under it, and refuses a name another folder has', async () => {
  await inBrowser({
    'base.yaml': base,
    'teams/web.yaml': web,
    'teams/ios/app.yaml': base,
    'apps/site.yaml': base,
  });
  const profiles = new Profiles(new FakeGitRepository(), memory(), () => undefined);
  await profiles.refresh();

  expect(await profiles.renameFolder('teams', 'apps')).toBe('There is already a folder named apps.');
  expect(await profiles.renameFolder('teams', 'Apps')).toBe('There is already a folder named apps.');
  expect(await profiles.renameFolder('teams', 'squads')).toBeUndefined();

  expect(drawn(profiles.tree.value)).toEqual([
    'base',
    'apps/ 1',
    '  site',
    'squads/ 2',
    '  web',
    '  ios/ 1',
    '    app',
  ]);
  expect(await readFile('/profiles/browser/squads/web.yaml', 'utf8')).toBe(web);
  expect(await readFile('/profiles/browser/squads/ios/app.yaml', 'utf8')).toBe(base);
  expect(profiles.listings.value.every((listing) => listing.problem === null)).toBe(true);

  profiles.toggleFolder('squads/ios');
  expect(await profiles.renameFolder('squads', 'teams')).toBeUndefined();
  expect(drawn(profiles.tree.value)).toEqual(['base', 'apps/ 1', '  site', 'teams/ 2', '  web', '  ios/ 1 closed']);
});

test('deleting the selected profiles together commits once', async () => {
  const github = repository();
  github.write({ 'profiles/teams/ios.yaml': base, 'profiles/leaf.yaml': web });
  const profiles = await connected(github);
  profiles.selectForBatch([listed(profiles, 'base'), listed(profiles, 'ios')], true);
  const commits = github.commits.size;

  expect(await profiles.remove(...profiles.batch.value)).toBeUndefined();

  expect(github.commits.size).toBe(commits + 1);
  expect(
    Object.keys(github.files())
      .filter((file) => file.startsWith('profiles/'))
      .sort(),
  ).toEqual(['profiles/leaf.yaml', 'profiles/teams/web.yaml']);
  expect(profiles.batch.value).toEqual([]);
});

test('Actions definitions move with references and refuse deletion while consumers remain', async () => {
  await inBrowser({
    'trusted.yaml': 'kind: actions-policy\nactions_policies: [{ name: Approved, enforcement: active }]\n',
    'service.yaml': 'references:\n  actions_policies: [trusted.yaml]\nrepository:\n  has_wiki: false\n',
  });
  const profiles = new Profiles(new FakeGitHub(), memory(), () => undefined);
  await profiles.refresh();
  const definition = profiles.listings.value.find((item) => item.name === 'trusted');
  if (definition === undefined) {
    throw new Error('Missing definition');
  }
  expect(profiles.dependents(definition).map((item) => item.name)).toEqual(['service']);
  expect(await profiles.remove(definition)).toContain('service');
  expect(await profiles.move([definition], 'shared')).toBeUndefined();
  expect(await readFile('/profiles/browser/service.yaml', 'utf8')).toContain('shared/trusted.yaml');
  expect(profiles.listings.value.every((item) => item.problem === null)).toBe(true);
});

test('reference saves preserve unrelated inline values', async () => {
  await inBrowser({
    'trusted.yaml': 'kind: actions-policy\nactions_policies: [{ name: Approved, enforcement: active }]\n',
    'service.yaml': 'repository:\n  has_wiki: false\n',
  });
  const profiles = new Profiles(new FakeGitHub(), memory(), () => undefined);
  await profiles.refresh();
  const service = profiles.listings.value.find((item) => item.name === 'service')!;
  await profiles.select(service);
  await profiles.editor.value!.setReferences({ actions_policies: ['trusted.yaml'] });
  await profiles.save();
  const saved = await readFile(service.file, 'utf8');
  expect(saved).toContain('has_wiki: false');
  expect(saved).toContain('trusted.yaml');
});

test('definitions duplicate across folders without changing their source', async () => {
  await inBrowser({
    'trusted.yaml': 'kind: actions-policy\nactions_policies: [{ name: Approved, enforcement: active }]\n',
  });
  const profiles = new Profiles(new FakeGitHub(), memory(), () => undefined);
  await profiles.refresh();
  const source = profiles.listings.value[0];
  if (source === undefined) {
    throw new Error('Missing source');
  }
  expect(
    await profiles.create({
      name: 'copy',
      folder: 'shared',
      start: { kind: 'duplicate', source },
      ownerType: undefined,
    }),
  ).toBeUndefined();
  expect(await readFile('/profiles/browser/shared/copy.yaml', 'utf8')).toBe(await readFile(source.file, 'utf8'));
});

test('refuses deleting or moving sources used by repository assignments without partial changes', async () => {
  await inBrowser({ 'shared.yaml': base });
  const used = new Set(['/profiles/browser/shared.yaml']);
  const profiles = new Profiles(
    new FakeGitRepository(),
    memory(),
    () => undefined,
    undefined,
    (files) => (files.some((file) => used.has(file)) ? ['lunch/app'] : []),
  );
  await profiles.refresh();
  const listing = profiles.listings.value[0];
  if (listing === undefined) {
    throw new Error('Missing source');
  }

  expect(await profiles.remove(listing)).toContain('lunch/app');
  expect(await profiles.move([listing], 'moved')).toContain('lunch/app');
  expect(await readFile(listing.file, 'utf8')).toBe(base);
  expect(profiles.listings.value.map((item) => item.file)).toEqual([listing.file]);

  used.clear();
  expect(await profiles.remove(listing)).toBeUndefined();
  expect(profiles.listings.value).toEqual([]);
});

test('reference controls treat equivalent paths as the same source', async () => {
  await inBrowser({
    'trusted.yaml': 'kind: actions-policy\nactions_policies: [{ name: Approved, enforcement: active }]\n',
    'service.yaml': 'references: { actions_policies: [./shared/../trusted.yaml] }\n',
  });
  const profiles = new Profiles(new FakeGitHub(), memory(), () => undefined);
  await profiles.refresh();
  await profiles.select(profiles.listings.value.find((item) => item.name === 'service'));
  const editor = profiles.editor.value!;
  await editor.setReferences({ actions_policies: ['trusted.yaml'] });
  expect(editor.dirty.value).toBe(false);
});

test('a duplicate whose source disappeared reports an error without leaving a destination', async () => {
  await inBrowser({ 'source.yaml': base });
  const profiles = new Profiles(new FakeGitHub(), memory(), () => undefined);
  await profiles.refresh();
  const source = profiles.listings.value[0];
  if (source === undefined) {
    throw new Error('Missing source');
  }
  await rm(source.file);
  expect(
    await profiles.create({ name: 'copy', folder: '', start: { kind: 'duplicate', source }, ownerType: undefined }),
  ).toContain('source.yaml');
  expect(await readdir('/profiles/browser', { withFileTypes: true })).toEqual([]);
});

test('an unread profile folder becomes empty only after a successful read, and an initial failure can recover', async () => {
  const profiles = new Profiles(new FakeGitRepository(), memory(), () => undefined);
  expect(profiles.listed.value).toBe(false);
  await mkdir('/profiles', { recursive: true });
  await writeFile('/profiles/browser', 'A file where the folder belongs');
  await profiles.refresh();
  expect(profiles.listingError.value).toBeDefined();
  expect(profiles.listed.value).toBe(false);
  await rm('/profiles/browser');
  await profiles.refresh();
  expect(profiles.listed.value).toBe(true);
  expect(profiles.listingError.value).toBeUndefined();
  expect(profiles.listings.value).toEqual([]);
});
