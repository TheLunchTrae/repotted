import type { GitHub } from '@repotted/core';
import { expect, test, vi } from 'vitest';

import { FakeGitRepository } from '../../core/tests/fake-git.js';
import { answered, type FakeAccount, FakeGitHub } from '../../core/tests/fake-github.js';
import type { Preferences } from '../src/app/preferences.js';
import { Repositories, type Repository } from '../src/app/repositories.js';
import { preferencesFile, SharedPreferences } from '../src/app/shared-preferences.js';

const user = { login: 'Trae', name: null };

function account(names: readonly string[]): FakeAccount {
  return {
    login: 'trae',
    name: null,
    repositories: [],
    installations: [
      {
        id: 1,
        repositories: names.map((full_name) => ({ full_name, private: false, permissions: { admin: true } })),
      },
    ],
  };
}

const everyone = ['zeta/site', 'trae/dotfiles', 'Acme/api', 'acme/web'];

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

function names(repositories: Repositories): string[] {
  return repositories.groups.value.flatMap((group) => [
    `${group.owner}:`,
    ...group.repositories.map((repository) => repository.full_name),
  ]);
}

/** Preferences kept in this browser, as when profiles are not kept in a repository. */
function inBrowser(github: GitHub, preferences: Preferences = memory()): SharedPreferences {
  return new SharedPreferences(github, preferences, () => undefined);
}

async function opened(github: FakeGitHub, preferences: Preferences = memory()): Promise<Repositories> {
  const repositories = new Repositories(github, user, inBrowser(github, preferences), () => undefined);
  await repositories.refresh();
  return repositories;
}

test('groups the list by owner, the signed-in account first, whatever the case of a login', async () => {
  const repositories = await opened(new FakeGitHub({ account: account(everyone) }));

  expect(names(repositories)).toEqual([
    'trae:',
    'trae/dotfiles',
    'Acme:',
    'Acme/api',
    'acme/web',
    'zeta:',
    'zeta/site',
  ]);
  expect(repositories.owners.value.map((owner) => [owner.owner, owner.personal, owner.count])).toEqual([
    ['trae', true, 1],
    ['Acme', false, 2],
    ['zeta', false, 1],
  ]);
  expect(repositories.countLabel.value).toBe('All 4');
  expect(repositories.ownersLabel.value).toBe('All owners');
});

test('a search or a hidden owner that takes the selected repository out of view clears the selection', async () => {
  const repositories = await opened(new FakeGitHub({ account: account(everyone) }));
  const web = repositories.groups.value[1]?.repositories[1];
  repositories.select(web);
  expect(repositories.selected.value?.full_name).toBe('acme/web');

  repositories.search.value = ' API ';
  expect(names(repositories)).toEqual(['Acme:', 'Acme/api']);
  expect(repositories.selected.value).toBeUndefined();

  repositories.search.value = '';
  expect(repositories.selected.value?.full_name).toBe('acme/web');
  repositories.setOwnerShown('acme', false);
  expect(repositories.selected.value).toBeUndefined();
});

test('keeps the hidden owners, and an owner new to the list shows', async () => {
  const preferences = memory();
  const github = new FakeGitHub({ account: account(everyone) });
  const repositories = await opened(github, preferences);

  repositories.setOwnerShown('Acme', false);
  expect(preferences.kept['hidden-repository-owners']).toEqual(['Acme']);
  expect(repositories.countLabel.value).toBe('2 of 4');
  expect(repositories.ownersLabel.value).toBe('2 owners');

  github.state.account = account([...everyone, 'newco/app']);
  const reopened = await opened(github, preferences);
  expect(names(reopened)).toEqual(['trae:', 'trae/dotfiles', 'newco:', 'newco/app', 'zeta:', 'zeta/site']);

  reopened.showOnlyPersonal();
  expect(reopened.ownersLabel.value).toBe('Personal');
  expect(names(reopened)).toEqual(['trae:', 'trae/dotfiles']);
});

test('an owner hidden while out of the list stays hidden until every owner is shown', async () => {
  const preferences = memory({ 'hidden-repository-owners': ['gone', 'ZETA'] });
  const repositories = await opened(new FakeGitHub({ account: account(everyone) }), preferences);
  expect(names(repositories)).not.toContain('zeta:');

  repositories.setOwnerShown('zeta', true);
  expect(preferences.kept['hidden-repository-owners']).toEqual(['gone']);
  expect(repositories.ownersFiltered.value).toBe(false);

  repositories.setOwnerShown('trae', false);
  repositories.showAllOwners();
  expect(preferences.kept['hidden-repository-owners']).toBeUndefined();
});

test('says when every owner in the list is hidden, even a lone one', async () => {
  const preferences = memory({ 'hidden-repository-owners': ['trae'] });
  const repositories = await opened(new FakeGitHub({ account: account(['trae/dotfiles']) }), preferences);

  expect(repositories.everyOwnerHidden.value).toBe(true);
  expect(repositories.ownersLabel.value).toBe('No owners');
  expect(repositories.countLabel.value).toBe('0 of 1');
});

test('a refresh that fails keeps the list it had and says why', async () => {
  const github = new FakeGitHub({ account: account(everyone) });
  const repositories = await opened(github);
  github.fail('GET /user/installations', answered(500, 'GitHub is having a moment'), 1);

  await repositories.refresh();

  expect(repositories.error.value).toBe('GitHub is having a moment');
  expect(repositories.list.value?.repositories).toHaveLength(4);
  expect(repositories.loading.value).toBe(false);

  await repositories.refresh();
  expect(repositories.error.value).toBeUndefined();
});

test('a refused sign-in is reported as signed out, not as an error on the page', async () => {
  const github = new FakeGitHub({ account: account(everyone) });
  github.fail('GET /user/installations', answered(401, 'Bad credentials'));
  const signedOut = vi.fn();
  const repositories = new Repositories(github, user, inBrowser(github), signedOut);

  await repositories.refresh();

  expect(signedOut).toHaveBeenCalledOnce();
  expect(repositories.error.value).toBeUndefined();
});

test('a refresh asked for while one runs starts no second read', async () => {
  const held = Promise.withResolvers<unknown>();
  const request = vi.fn<FakeGitHub['request']>(() => held.promise);
  const repositories = new Repositories({ request }, user, inBrowser({ request }), () => undefined);

  const first = repositories.refresh();
  await repositories.refresh();
  expect(repositories.loading.value).toBe(true);
  expect(request).toHaveBeenCalledTimes(1);

  held.resolve({ total_count: 0, installations: [] });
  await first;
  expect(repositories.loading.value).toBe(false);
  expect(repositories.list.value).toEqual({ source: 'installations', repositories: [] });
});

test('a refresh keeps the list in use while it reads, and the selection when the new list has it', async () => {
  const github = new FakeGitHub({ account: account(everyone) });
  const repositories = await opened(github);
  repositories.select(repositories.groups.value[1]?.repositories[0]);
  github.state.account = account(['Acme/api', 'trae/dotfiles']);

  const refreshing = repositories.refresh();
  expect(repositories.loading.value).toBe(true);
  expect(repositories.list.value?.repositories).toHaveLength(4);
  await refreshing;

  expect(repositories.list.value?.repositories).toHaveLength(2);
  expect(repositories.selected.value?.full_name).toBe('Acme/api');
});

test('ticked repositories stay ticked through a search, and one the account no longer lists drops out', async () => {
  const github = new FakeGitHub({ account: account(everyone) });
  const repositories = new Repositories(github, user, inBrowser(github), () => undefined);
  await repositories.refresh();
  const all = repositories.list.value?.repositories ?? [];
  const named = (name: string): (typeof all)[number] => {
    const found = all.find((repository) => repository.full_name === name);
    if (found === undefined) {
      throw new Error(`The list has no ${name}.`);
    }
    return found;
  };

  repositories.tick(named('zeta/site'), true);
  repositories.tick(named('Acme/api'), true);
  repositories.search.value = 'dotfiles';
  expect(repositories.ticked.value.map((repository) => repository.full_name).toSorted()).toEqual([
    'Acme/api',
    'zeta/site',
  ]);

  repositories.tick(named('zeta/site'), false);
  expect(repositories.ticked.value.map((repository) => repository.full_name)).toEqual(['Acme/api']);

  github.state.account = account(['trae/dotfiles']);
  await repositories.refresh();
  expect(repositories.ticked.value).toEqual([]);

  repositories.clearTicks();
  expect(repositories.ticked.value).toEqual([]);
});

function listed(repositories: Repositories, name: string): Repository {
  const found = repositories.list.value?.repositories.find((repository) => repository.full_name === name);
  if (found === undefined) {
    throw new Error(`The list has no ${name}.`);
  }
  return found;
}

test('a hidden repository leaves the list, unticked and out of the selection, until Undo or Show hidden', async () => {
  const preferences = memory();
  const repositories = await opened(new FakeGitHub({ account: account(everyone) }), preferences);
  const web = listed(repositories, 'acme/web');
  repositories.select(web);
  repositories.tick(web, true);

  repositories.hide([web]);

  expect(names(repositories)).toEqual(['trae:', 'trae/dotfiles', 'Acme:', 'Acme/api', 'zeta:', 'zeta/site']);
  expect(preferences.kept['hidden-repositories']).toEqual(['acme/web']);
  expect(repositories.selected.value).toBeUndefined();
  expect(repositories.ticked.value).toEqual([]);
  expect(repositories.hiddenCount.value).toBe(1);
  expect(repositories.countLabel.value).toBe('3 of 4');
  expect(repositories.justHidden.value).toEqual(['acme/web']);

  repositories.setShowHidden(true);
  expect(names(repositories)).toContain('acme/web');
  expect(repositories.isHidden(web)).toBe(true);
  expect(repositories.countLabel.value).toBe('All 4');
  expect(repositories.justHidden.value).toEqual([]);

  repositories.setShowHidden(false);
  repositories.unhide([web]);
  expect(preferences.kept['hidden-repositories']).toBeUndefined();
  repositories.hide([web]);
  repositories.undoHide();
  expect(names(repositories)).toContain('acme/web');
  expect(preferences.kept['hidden-repositories']).toBeUndefined();
});

test('hidden repositories stay hidden across visits in any case, and one out of the list stays hidden', async () => {
  const preferences = memory({ 'hidden-repositories': ['ACME/WEB', 'gone/app'] });
  const repositories = await opened(new FakeGitHub({ account: account(everyone) }), preferences);

  expect(names(repositories)).not.toContain('acme/web');

  repositories.unhide([listed(repositories, 'acme/web')]);
  expect(preferences.kept['hidden-repositories']).toEqual(['gone/app']);
});

test('says when every repository of the shown owners is hidden, and when only hidden ones match a search', async () => {
  const preferences = memory({ 'hidden-repositories': ['acme/api', 'acme/web'], 'hidden-repository-owners': ['trae'] });
  const repositories = await opened(new FakeGitHub({ account: account(everyone) }), preferences);

  repositories.search.value = 'web';
  expect(repositories.groups.value).toEqual([]);
  expect(repositories.hiddenMatches.value).toBe(1);
  expect(repositories.everyRepositoryHidden.value).toBe(false);

  repositories.search.value = '';
  repositories.setOwnerShown('zeta', false);
  expect(repositories.hiddenCount.value).toBe(2);
  expect(repositories.everyRepositoryHidden.value).toBe(true);
  expect(repositories.everyOwnerHidden.value).toBe(false);
  expect(repositories.countLabel.value).toBe('0 of 4');

  repositories.setShowHidden(true);
  expect(repositories.everyRepositoryHidden.value).toBe(false);
  expect(repositories.hiddenMatches.value).toBe(0);
});

test('Undo shows only what the hide took out of the list, and ticks again what it unticked', async () => {
  const preferences = memory({ 'hidden-repositories': ['acme/web'] });
  const repositories = await opened(new FakeGitHub({ account: account(everyone) }), preferences);
  repositories.setShowHidden(true);
  const web = listed(repositories, 'acme/web');
  const site = listed(repositories, 'zeta/site');
  repositories.tick(web, true);
  repositories.tick(site, true);

  repositories.hide([web, site]);
  expect(repositories.justHidden.value).toEqual(['zeta/site']);
  expect(repositories.ticked.value).toEqual([]);

  repositories.undoHide();
  expect(preferences.kept['hidden-repositories']).toEqual(['acme/web']);
  expect(repositories.ticked.value.map((repository) => repository.full_name).sort()).toEqual(['acme/web', 'zeta/site']);
});

test('with profiles in a repository, the list hides what its file holds and a hide is committed there', async () => {
  const config = new FakeGitRepository();
  const file = `profiles/${preferencesFile}`;
  config.write({ [file]: '{ "hidden-repositories": ["acme/web"], "hidden-repository-owners": ["zeta"] }' });
  const list = new FakeGitHub({ account: account(everyone) });
  const github: GitHub = {
    request: (method, path, body) =>
      path.startsWith('/repos/lunch/config/') ? config.request(method, path, body) : list.request(method, path, body),
  };
  const browser = memory({ 'hidden-repositories': ['trae/dotfiles'] });
  const preferences = new SharedPreferences(github, browser, () => undefined);
  const reading = preferences.use({ kind: 'repository', repository: 'lunch/config', path: 'profiles' });
  const repositories = new Repositories(github, user, preferences, () => undefined);

  await repositories.refresh();
  await reading;
  expect(names(repositories)).toEqual(['trae:', 'trae/dotfiles', 'Acme:', 'Acme/api']);

  // A file saved elsewhere arrives with the next refresh.
  config.write({ [file]: '{ "hidden-repositories": ["acme/web", "acme/api"], "hidden-repository-owners": ["zeta"] }' });
  await repositories.refresh();
  expect(names(repositories)).toEqual(['trae:', 'trae/dotfiles']);

  repositories.hide([listed(repositories, 'trae/dotfiles')]);
  repositories.setOwnerShown('zeta', true);
  await vi.waitFor(() => {
    expect(JSON.parse(config.files()[file] ?? '{}')).toEqual({
      'hidden-repositories': ['acme/web', 'acme/api', 'trae/dotfiles'],
    });
  });
  expect(names(repositories)).toEqual(['zeta:', 'zeta/site']);
  expect(browser.kept['hidden-repositories']).toEqual(['trae/dotfiles']);
});

function folders(repositories: Repositories): string[] {
  return repositories.folders.value.flatMap((folder) => [
    `${folder.name}${folder.open ? '' : ' (closed)'}${folder.empty ? ' (empty)' : ''}:`,
    ...folder.repositories.map((repository) => repository.full_name),
  ]);
}

function several(repositories: Repositories, ...wanted: readonly string[]): ReturnType<Repositories['ticked']['peek']> {
  return wanted.map((name) => {
    const found = repositories.list.value?.repositories.find((repository) => repository.full_name === name);
    if (found === undefined) {
      throw new Error(`The list has no ${name}.`);
    }
    return found;
  });
}

test('a folder holds repositories of any owner above the owner groups, which keep the rest', async () => {
  const preferences = memory();
  const github = new FakeGitHub({ account: account(everyone) });
  const repositories = await opened(github, preferences);

  expect(repositories.createFolder(' Sites ', several(repositories, 'zeta/site', 'acme/web'))).toBeUndefined();
  expect(repositories.createFolder('Apps')).toBeUndefined();

  expect(folders(repositories)).toEqual(['Apps (empty):', 'Sites:', 'acme/web', 'zeta/site']);
  expect(names(repositories)).toEqual(['trae:', 'trae/dotfiles', 'Acme:', 'Acme/api']);
  expect(preferences.kept['repository-folders']).toEqual([
    { name: 'Apps', repositories: [] },
    { name: 'Sites', repositories: ['zeta/site', 'acme/web'] },
  ]);

  const reopened = await opened(github, preferences);
  expect(folders(reopened)).toEqual(folders(repositories));
});

test('a repository is in one folder at most, and moving it to no folder returns it to its owner', async () => {
  const preferences = memory({
    'repository-folders': [
      { name: 'Apps', repositories: ['ACME/API'] },
      { name: 'Sites', repositories: [] },
    ],
  });
  const repositories = await opened(new FakeGitHub({ account: account(everyone) }), preferences);
  const [api] = several(repositories, 'Acme/api');
  if (api === undefined) {
    throw new Error('No Acme/api.');
  }
  expect(repositories.folderOf(api)).toBe('Apps');

  repositories.moveToFolder([api], 'sites');
  expect(folders(repositories)).toEqual(['Apps (empty):', 'Sites:', 'Acme/api']);

  repositories.moveToFolder([api], undefined);
  expect(repositories.folderOf(api)).toBeUndefined();
  expect(names(repositories)).toContain('Acme/api');
});

test('a folder name must be new, in any case, except the folder being renamed', async () => {
  const preferences = memory();
  const repositories = await opened(new FakeGitHub({ account: account(everyone) }), preferences);
  repositories.createFolder('Apps');

  expect(repositories.createFolder('  ')).toBe('Give the folder a name.');
  expect(repositories.createFolder('apps')).toBe("There's already a folder called Apps.");
  expect(repositories.renameFolder('Apps', 'APPS')).toBeUndefined();
  expect(repositories.folderNames.value).toEqual(['APPS']);
});

test('a closed folder stays closed when renamed, opens while a search finds something in it, and is forgotten when deleted', async () => {
  const preferences = memory();
  const repositories = await opened(new FakeGitHub({ account: account(everyone) }), preferences);
  repositories.createFolder('Web', several(repositories, 'acme/web', 'zeta/site'));
  repositories.createFolder('Tools', several(repositories, 'trae/dotfiles'));
  repositories.createFolder('Empty');
  repositories.setFolderOpen('Web', false);
  repositories.renameFolder('Web', 'Sites');
  expect(preferences.kept['closed-repository-folders']).toEqual(['Sites']);
  expect(folders(repositories)).toContain('Sites (closed):');

  // A repository's name finds just that repository; a folder's name finds all of its own.
  repositories.search.value = 'site';
  expect(folders(repositories)).toEqual(['Sites:', 'acme/web', 'zeta/site']);
  repositories.search.value = 'web';
  expect(folders(repositories)).toEqual(['Sites:', 'acme/web']);
  expect(names(repositories)).toEqual([]);

  repositories.search.value = '';
  repositories.deleteFolder('sites');
  expect(preferences.kept['closed-repository-folders']).toBeUndefined();
  expect(folders(repositories)).toEqual(['Empty (empty):', 'Tools:', 'trae/dotfiles']);
  expect(names(repositories)).toEqual(['Acme:', 'Acme/api', 'acme/web', 'zeta:', 'zeta/site']);
});

test('a hidden owner hides its repositories in folders too, and a repository selected in a folder stays selected', async () => {
  const repositories = await opened(new FakeGitHub({ account: account(everyone) }));
  repositories.createFolder('Acme', several(repositories, 'Acme/api', 'acme/web'));
  repositories.createFolder('Mixed', several(repositories, 'zeta/site', 'trae/dotfiles'));
  repositories.select(several(repositories, 'zeta/site')[0]);
  expect(repositories.selected.value?.full_name).toBe('zeta/site');

  repositories.setOwnerShown('acme', false);
  repositories.setOwnerShown('zeta', false);
  expect(folders(repositories)).toEqual(['Mixed:', 'trae/dotfiles']);
  expect(repositories.selected.value).toBeUndefined();
});

test('a repository the list no longer has stays in its folder for when it comes back', async () => {
  const preferences = memory({ 'repository-folders': [{ name: 'Old', repositories: ['gone/app'] }] });
  const github = new FakeGitHub({ account: account(everyone) });
  const repositories = await opened(github, preferences);
  expect(folders(repositories)).toEqual(['Old (empty):']);

  repositories.createFolder('New', several(repositories, 'trae/dotfiles'));
  expect(preferences.kept['repository-folders']).toContainEqual({ name: 'Old', repositories: ['gone/app'] });

  github.state.account = account([...everyone, 'gone/app']);
  await repositories.refresh();
  expect(folders(repositories)).toContain('gone/app');
});

test('a hidden repository leaves its folder until hidden ones show, and stays filed', async () => {
  const repositories = await opened(new FakeGitHub({ account: account(everyone) }));
  repositories.createFolder('Sites', several(repositories, 'zeta/site', 'acme/web'));

  repositories.hide(several(repositories, 'acme/web'));
  expect(folders(repositories)).toEqual(['Sites:', 'zeta/site']);
  expect(names(repositories)).not.toContain('acme/web');

  repositories.setShowHidden(true);
  expect(folders(repositories)).toEqual(['Sites:', 'acme/web', 'zeta/site']);

  repositories.setShowHidden(false);
  repositories.hide(several(repositories, 'zeta/site'));
  expect(folders(repositories)).toEqual([]);
  expect(repositories.folderNames.value).toEqual(['Sites']);
});

test('folders are kept in the preferences file beside the profiles when they are in a repository', async () => {
  const source = { kind: 'repository', repository: 'trae/config', path: 'profiles' } as const;
  const file = `profiles/${preferencesFile}`;
  const config = new FakeGitRepository('trae/config');
  config.write({ [file]: '{ "repository-folders": [{ "name": "Sites", "repositories": ["zeta/site"] }] }' });
  const browser = memory();
  const preferences = new SharedPreferences(config, browser, () => undefined);
  const github = new FakeGitHub({ account: account(everyone) });
  const repositories = new Repositories(github, user, preferences, () => undefined);
  await repositories.refresh();
  expect(folders(repositories)).toEqual([]);

  await preferences.use(source);
  expect(folders(repositories)).toEqual(['Sites:', 'zeta/site']);

  repositories.moveToFolder(several(repositories, 'acme/web'), 'Sites');
  repositories.setFolderOpen('Sites', false);
  await vi.waitFor(() => {
    expect(JSON.parse(config.files()[file] ?? '{}')).toEqual({
      'closed-repository-folders': ['Sites'],
      'repository-folders': [{ name: 'Sites', repositories: ['zeta/site', 'acme/web'] }],
    });
  });
  expect(browser.kept).toEqual({});
});

test('a folder change made before the preferences file is read keeps the folders it holds', async () => {
  const source = { kind: 'repository', repository: 'trae/config', path: 'profiles' } as const;
  const file = `profiles/${preferencesFile}`;
  const config = new FakeGitRepository('trae/config');
  config.write({ [file]: '{ "repository-folders": [{ "name": "Sites", "repositories": ["zeta/site"] }] }' });
  const read = config.request.bind(config);
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(config, 'request').mockImplementationOnce(async (...args) => {
    await held;
    return read(...args);
  });
  const preferences = new SharedPreferences(config, memory(), () => undefined);
  const repositories = new Repositories(
    new FakeGitHub({ account: account(everyone) }),
    user,
    preferences,
    () => undefined,
  );
  await repositories.refresh();
  const reading = preferences.use(source);

  repositories.createFolder('Tools', several(repositories, 'trae/dotfiles'));
  repositories.setFolderOpen('Tools', false);
  expect(folders(repositories)).toEqual(['Tools (closed):', 'trae/dotfiles']);
  release();
  await reading;

  expect(folders(repositories)).toEqual(['Sites:', 'zeta/site', 'Tools (closed):', 'trae/dotfiles']);
  await vi.waitFor(() => {
    expect(JSON.parse(config.files()[file] ?? '{}')).toEqual({
      'closed-repository-folders': ['Tools'],
      'repository-folders': [
        { name: 'Sites', repositories: ['zeta/site'] },
        { name: 'Tools', repositories: ['trae/dotfiles'] },
      ],
    });
  });
});

test('a folder renamed to, or moved into, a name changed elsewhere meanwhile keeps every repository filed', async () => {
  const source = { kind: 'repository', repository: 'trae/config', path: 'profiles' } as const;
  const file = `profiles/${preferencesFile}`;
  const config = new FakeGitRepository('trae/config');
  config.write({ [file]: '{ "repository-folders": [{ "name": "Sites", "repositories": ["zeta/site"] }] }' });
  const read = config.request.bind(config);
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(config, 'request').mockImplementationOnce(async (...args) => {
    await held;
    return read(...args);
  });
  const preferences = new SharedPreferences(config, memory(), () => undefined);
  const repositories = new Repositories(
    new FakeGitHub({ account: account(everyone) }),
    user,
    preferences,
    () => undefined,
  );
  await repositories.refresh();
  const reading = preferences.use(source);

  repositories.createFolder('Web', several(repositories, 'acme/web'));
  repositories.renameFolder('Web', 'sites');
  repositories.moveToFolder(several(repositories, 'trae/dotfiles'), 'Tools');
  release();
  await reading;

  expect(folders(repositories)).toEqual(['Sites:', 'acme/web', 'zeta/site', 'Tools:', 'trae/dotfiles']);
  await vi.waitFor(() => {
    expect(JSON.parse(config.files()[file] ?? '{}')).toEqual({
      'repository-folders': [
        { name: 'Sites', repositories: ['zeta/site', 'acme/web'] },
        { name: 'Tools', repositories: ['trae/dotfiles'] },
      ],
    });
  });
});

test('the ticked panel moves to the folder last picked or made, under its new name, else the first or a new one', async () => {
  const repositories = await opened(new FakeGitHub({ account: account(everyone) }));
  expect(repositories.moveTarget.value).toEqual({ kind: 'new' });

  repositories.createFolder('Web');
  repositories.createFolder('Apps');
  expect(repositories.moveTarget.value).toEqual({ kind: 'folder', name: 'Apps' });

  repositories.pickMoveTarget({ kind: 'folder', name: 'Web' });
  repositories.renameFolder('Web', 'WEB');
  expect(repositories.moveTarget.value).toEqual({ kind: 'folder', name: 'WEB' });

  repositories.pickMoveTarget({ kind: 'none' });
  expect(repositories.moveTarget.value).toEqual({ kind: 'none' });

  repositories.pickMoveTarget({ kind: 'folder', name: 'WEB' });
  repositories.deleteFolder('web');
  expect(repositories.moveTarget.value).toEqual({ kind: 'folder', name: 'Apps' });
});

test('closing the folder of the selected repository clears the selection until it opens again', async () => {
  const repositories = await opened(new FakeGitHub({ account: account(everyone) }));
  repositories.createFolder('Sites', several(repositories, 'zeta/site'));
  repositories.select(several(repositories, 'zeta/site')[0]);

  repositories.setFolderOpen('Sites', false);
  expect(repositories.selected.value).toBeUndefined();
  repositories.setFolderOpen('Sites', true);
  expect(repositories.selected.value?.full_name).toBe('zeta/site');
});

test("a search for a folder's name finds it empty or with only hidden repositories, which it counts", async () => {
  const repositories = await opened(new FakeGitHub({ account: account(everyone) }));
  repositories.createFolder('Later');
  repositories.createFolder('Old', several(repositories, 'zeta/site'));
  repositories.hide(several(repositories, 'zeta/site'));

  repositories.search.value = 'later';
  expect(folders(repositories)).toEqual(['Later (empty):']);
  repositories.search.value = 'old';
  expect(folders(repositories)).toEqual([]);
  expect(repositories.hiddenMatches.value).toBe(1);
});

test('a hand-edited file with a folder named twice or a repository in two folders keeps the first of each', async () => {
  const preferences = memory({
    'repository-folders': [
      { name: 'Web', repositories: ['zeta/site', 'acme/web', 'ZETA/site'] },
      { name: 'web', repositories: ['trae/dotfiles'] },
      { name: 'Apps', repositories: ['acme/web', 'Acme/api'] },
    ],
  });
  const repositories = await opened(new FakeGitHub({ account: account(everyone) }), preferences);

  expect(folders(repositories)).toEqual(['Apps:', 'Acme/api', 'Web:', 'acme/web', 'zeta/site']);
  expect(names(repositories)).toEqual(['trae:', 'trae/dotfiles']);
});
