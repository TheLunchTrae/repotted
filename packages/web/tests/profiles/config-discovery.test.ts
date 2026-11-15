import { type GitHub, GitHubError } from '@repotted/core';
import { afterEach, expect, test } from 'vitest';

import { FakeGitRepository } from '../../../core/tests/support/fake-git.js';
import type { Preferences } from '../../src/app/preferences/preferences.js';
import { ConfigDiscovery } from '../../src/app/profiles/config-discovery.js';
import { configTopic, markerFile, readMarkedFolder } from '../../src/app/profiles/config-marker.js';
import { Profiles } from '../../src/app/profiles/profiles.js';
import type { Repository } from '../../src/app/repositories/repositories.js';
import { mkdir, rm, writeFile } from '../../src/engine/files.js';

afterEach(async () => {
  await rm('/', { recursive: true });
});

const base = 'repository:\n  has_wiki: false\n';

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

/** Each repository answers the requests under its own path. */
class Account implements GitHub {
  readonly #repositories: readonly FakeGitRepository[];

  constructor(...repositories: FakeGitRepository[]) {
    this.#repositories = repositories;
  }

  request(...[method, path, body]: Parameters<GitHub['request']>): Promise<unknown> {
    const repository = this.#repositories.find((each) => {
      const prefix = `/repos/${each.fullName}`;
      return path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`);
    });
    return repository === undefined
      ? Promise.reject(new GitHubError(404, `Not Found: ${method} ${path}`))
      : repository.request(method, path, body);
  }
}

function configRepository(name: string, files: Record<string, string>, topics = [configTopic]): FakeGitRepository {
  const repository = new FakeGitRepository(name);
  repository.write(files);
  repository.topics = [...topics];
  return repository;
}

function listed(...repositories: FakeGitRepository[]): Repository[] {
  return repositories.map((repository) => ({
    full_name: repository.fullName,
    private: true,
    archived: false,
    topics: repository.topics,
  }));
}

function setUp(
  github: GitHub,
  preferences: Preferences = memory(),
): { readonly profiles: Profiles; readonly discovery: ConfigDiscovery } {
  const profiles = new Profiles(github, preferences, () => undefined);
  return { profiles, discovery: new ConfigDiscovery(github, profiles, () => undefined) };
}

async function inBrowser(files: Record<string, string>): Promise<void> {
  await mkdir('/profiles/browser', { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    await writeFile(`/profiles/browser/${file}`, text);
  }
}

test('an empty browser uses the one repository with the topic, in the folder its marker names', async () => {
  const config = configRepository('trae/config', {
    'profiles/base.yaml': base,
    [markerFile]: '{ "folder": "profiles" }\n',
  });
  const preferences = memory();
  const { profiles, discovery } = setUp(new Account(config), preferences);
  await profiles.refresh();

  await discovery.look(listed(config));

  expect(discovery.state.value).toEqual({ status: 'found', repository: 'trae/config' });
  expect(profiles.source.value).toEqual({ kind: 'repository', repository: 'trae/config', path: 'profiles' });
  expect(preferences.kept['profiles-source']).toEqual(profiles.source.value);
  expect(profiles.listings.value.map((listing) => listing.name)).toEqual(['base']);
  expect(config.files()[markerFile]).toBe('{ "folder": "profiles" }\n');
});

test('it looks once a visit, however often the list loads', async () => {
  const config = configRepository('trae/config', { [markerFile]: '{"folder": ""}' });
  const { discovery } = setUp(new Account(config));

  await discovery.look(listed(config));
  discovery.dismiss();
  await discovery.look(listed(config));

  expect(discovery.state.value).toEqual({ status: 'done' });
});

test('a browser that holds profiles asks before using the repository, offering to add them', async () => {
  await inBrowser({ 'mine.yaml': base, 'yours.yaml': base });
  const config = configRepository('trae/config', { [markerFile]: '{"folder": "profiles"}' });
  const { profiles, discovery } = setUp(new Account(config));
  await profiles.refresh();

  await discovery.look(listed(config));

  expect(discovery.state.value).toMatchObject({
    status: 'asking',
    found: [{ repository: 'trae/config', folder: 'profiles' }],
    browserProfiles: 2,
  });
  expect(profiles.source.value).toEqual({ kind: 'browser' });

  await discovery.use('trae/config', 'profiles', true);

  expect(discovery.state.value).toEqual({ status: 'done' });
  expect(Object.keys(config.files()).sort()).toEqual([markerFile, 'profiles/mine.yaml', 'profiles/yours.yaml']);
});

test('two repositories with the topic are offered to pick from, with the folder each names', async () => {
  const first = configRepository('trae/config', { [markerFile]: '{"folder": "profiles"}' });
  const second = configRepository('lunch/org-config', { [markerFile]: '{"folder": ""}' });
  const plain = configRepository('trae/site', {}, ['website']);
  const { profiles, discovery } = setUp(new Account(first, second, plain));

  await discovery.look(listed(first, second, plain));

  expect(discovery.state.value).toMatchObject({
    status: 'asking',
    found: [
      { repository: 'trae/config', folder: 'profiles' },
      { repository: 'lunch/org-config', folder: '' },
    ],
    browserProfiles: 0,
  });

  await discovery.use('lunch/org-config', '', false);

  expect(profiles.source.value).toEqual({ kind: 'repository', repository: 'lunch/org-config', path: '' });
});

test.each([
  ['missing', undefined],
  ['not JSON', 'folder: profiles'],
  ['naming no folder', '{"path": "profiles"}'],
  ['naming a hidden folder', '{"folder": ".github/profiles"}'],
  ['leaving the repository', '{"folder": "../elsewhere"}'],
])('a marker %s asks for the folder rather than guessing it', async (_case, marker) => {
  const config = configRepository(
    'trae/config',
    marker === undefined ? { 'README.md': '#' } : { [markerFile]: marker },
  );
  const { profiles, discovery } = setUp(new Account(config));

  await discovery.look(listed(config));

  expect(discovery.state.value).toMatchObject({ status: 'asking', found: [{ repository: 'trae/config' }] });
  const asking = discovery.state.value;
  expect(asking.status === 'asking' ? asking.found[0]?.folder : 'not asking').toBeUndefined();
  expect(profiles.source.value).toEqual({ kind: 'browser' });
});

test('a marker naming its folder with slashes around it names the same folder', async () => {
  const config = configRepository('trae/config', { [markerFile]: '{"folder": " /profiles/teams/ "}' });

  expect(await readMarkedFolder(config, 'trae/config')).toBe('profiles/teams');
});

test('no repository with the topic leaves the browser as it is', async () => {
  const site = configRepository('trae/site', {}, []);
  const archived = configRepository('trae/old-config', { [markerFile]: '{"folder": ""}' });
  const { profiles, discovery } = setUp(new Account(site, archived));

  await discovery.look([...listed(site), { ...listed(archived)[0]!, archived: true }]);

  expect(discovery.state.value).toEqual({ status: 'done' });
  expect(profiles.chosen.value).toBe(false);
});

test('a place this browser already keeps profiles in stands, even the browser itself', async () => {
  const config = configRepository('trae/config', { [markerFile]: '{"folder": ""}' });
  const { profiles, discovery } = setUp(new Account(config), memory({ 'profiles-source': { kind: 'browser' } }));

  await discovery.look(listed(config));

  expect(discovery.state.value).toEqual({ status: 'done' });
  expect(profiles.source.value).toEqual({ kind: 'browser' });
});

test('keeping profiles in the browser is saved, so the next visit does not ask', async () => {
  const config = configRepository('trae/config', { [markerFile]: '{"folder": ""}' });
  await inBrowser({ 'mine.yaml': base });
  const preferences = memory();
  const { profiles, discovery } = setUp(new Account(config), preferences);
  await profiles.refresh();
  await discovery.look(listed(config));

  await discovery.keepInBrowser();

  expect(discovery.state.value).toEqual({ status: 'done' });
  expect(preferences.kept['profiles-source']).toEqual({ kind: 'browser' });
  const next = setUp(new Account(config), preferences);
  await next.discovery.look(listed(config));
  expect(next.discovery.state.value).toEqual({ status: 'done' });
});

test('a choice made in Settings while the markers are read stands over the one found', async () => {
  const config = configRepository('trae/config', { [markerFile]: '{"folder": ""}' });
  const other = configRepository('trae/other', {}, []);
  const { profiles, discovery } = setUp(new Account(config, other));
  const connecting = profiles.connect('trae/other', '', false);

  await discovery.look(listed(config, other));
  await connecting;

  expect(profiles.source.value).toEqual({ kind: 'repository', repository: 'trae/other', path: '' });
  expect(discovery.state.value).toEqual({ status: 'done' });
});

test('connecting marks the repository and moving away unmarks it, keeping its other topics', async () => {
  const first = configRepository('trae/config', {}, ['infra']);
  const second = configRepository('trae/next', {}, []);
  const { profiles } = setUp(new Account(first, second));

  expect(await profiles.connect('trae/config', '/profiles/', false)).toBeUndefined();

  expect(first.topics).toEqual(['infra', configTopic]);
  expect(first.files()[markerFile]).toBe('{\n  "folder": "profiles"\n}\n');
  expect(profiles.markProblem.value).toBeUndefined();
  // The marker's commit is synced past, so the copy here is not behind the default branch.
  expect(profiles.sync.value).toMatchObject({ status: 'synced' });

  expect(await profiles.connect('trae/next', '', false)).toBeUndefined();

  expect(first.topics).toEqual(['infra']);
  expect(second.topics).toEqual([configTopic]);

  await profiles.keepInBrowser();

  expect(second.topics).toEqual([]);
});

test('connecting to a folder elsewhere in the same repository rewrites its marker and keeps the topic', async () => {
  const config = configRepository('trae/config', {}, []);
  const { profiles } = setUp(new Account(config));
  await profiles.connect('trae/config', 'profiles', false);

  await profiles.connect('trae/config', 'teams', false);

  expect(config.topics).toEqual([configTopic]);
  expect(config.files()[markerFile]).toBe('{\n  "folder": "teams"\n}\n');
});

test('a repository chosen before repositories were marked gets its mark', async () => {
  const config = configRepository('trae/config', { 'profiles/base.yaml': base }, []);
  const { profiles, discovery } = setUp(
    new Account(config),
    memory({ 'profiles-source': { kind: 'repository', repository: 'trae/config', path: 'profiles' } }),
  );
  await profiles.refresh();

  await discovery.look(listed(config));

  expect(config.topics).toEqual([configTopic]);
  expect(config.files()[markerFile]).toBe('{\n  "folder": "profiles"\n}\n');
});

test('a topic GitHub refuses still connects, saying a new browser will not find the repository', async () => {
  const config = configRepository('trae/config', {}, []);
  const github: GitHub = {
    request: (method, path, body) =>
      method === 'PUT' && path.endsWith('/topics')
        ? Promise.reject(new GitHubError(403, 'Resource not accessible by integration'))
        : config.request(method, path, body),
  };
  const { profiles } = setUp(github);

  expect(await profiles.connect('trae/config', '', false)).toBeUndefined();

  expect(profiles.source.value).toEqual({ kind: 'repository', repository: 'trae/config', path: '' });
  expect(profiles.markProblem.value).toMatch(/^Couldn't mark trae\/config with the repotted-config topic/u);
});
