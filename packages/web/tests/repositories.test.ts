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

test('Undo shows only what the hide took out of the list, ticked as it was', async () => {
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
  expect(repositories.ticked.value.map((repository) => repository.full_name)).toEqual(['zeta/site']);
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
