import { expect, test, vi } from 'vitest';

import { answered, type FakeAccount, FakeGitHub } from '../../core/tests/fake-github.js';
import type { Preferences } from '../src/app/preferences.js';
import { Repositories } from '../src/app/repositories.js';

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

async function opened(github: FakeGitHub, preferences: Preferences = memory()): Promise<Repositories> {
  const repositories = new Repositories(github, user, preferences, () => undefined);
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
  const repositories = new Repositories(github, user, memory(), signedOut);

  await repositories.refresh();

  expect(signedOut).toHaveBeenCalledOnce();
  expect(repositories.error.value).toBeUndefined();
});

test('a refresh asked for while one runs starts no second read', async () => {
  const held = Promise.withResolvers<unknown>();
  const request = vi.fn<FakeGitHub['request']>(() => held.promise);
  const repositories = new Repositories({ request }, user, memory(), () => undefined);

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
  const repositories = new Repositories(github, user, memory(), () => undefined);
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
