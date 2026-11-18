import { type GitHub, GitHubError } from '@repotted/core';
import { afterEach, expect, test, vi } from 'vitest';

import { FakeGitRepository } from '../../../core/tests/support/fake-git.js';
import { answered, type FakeAccount, FakeGitHub } from '../../../core/tests/support/fake-github.js';
import type { BrowserPreferences } from '../../src/app/preferences/preferences.js';
import { preferencesFile, SharedPreferences } from '../../src/app/preferences/shared-preferences.js';
import { refreshPause, Repositories, type Repository } from '../../src/app/repositories/repositories.js';

const user = { login: 'Trae', name: null };

afterEach(() => {
  vi.useRealTimers();
});

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

function memory(start: Record<string, unknown> = {}): BrowserPreferences & { readonly kept: Record<string, unknown> } {
  const kept = { ...start };
  return {
    kept,
    read: (key) => kept[key],
    write: (key, value) => {
      kept[key] = value;
      return true;
    },
  };
}

function names(repositories: Repositories): string[] {
  return repositories.groups.value.flatMap((group) => [
    `${group.owner}:`,
    ...group.repositories.map((repository) => repository.full_name),
  ]);
}

function inBrowser(github: GitHub, preferences: BrowserPreferences = memory()): SharedPreferences {
  return new SharedPreferences(github, preferences, () => undefined);
}

async function opened(github: FakeGitHub, preferences: BrowserPreferences = memory()): Promise<Repositories> {
  const repositories = new Repositories(github, user, inBrowser(github, preferences), preferences, () => undefined);
  await repositories.load();
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

test('a search or a hidden owner that takes the opened repository out of view closes it', async () => {
  const repositories = await opened(new FakeGitHub({ account: account(everyone) }));
  const web = repositories.groups.value[1]?.repositories[1];
  repositories.open(web);
  expect(repositories.opened.value?.full_name).toBe('acme/web');

  repositories.search.value = ' API ';
  expect(names(repositories)).toEqual(['Acme:', 'Acme/api']);
  expect(repositories.opened.value).toBeUndefined();

  repositories.search.value = '';
  expect(repositories.opened.value?.full_name).toBe('acme/web');
  repositories.setOwnerShown('acme', false);
  expect(repositories.opened.value).toBeUndefined();
});

test('names each shown owner whose installation lacks a permission the Repotted App asks for', async () => {
  const repository = (full_name: string) => ({ full_name, private: false, permissions: { admin: true } });
  const repositories = await opened(
    new FakeGitHub({
      account: {
        login: 'trae',
        name: null,
        repositories: [],
        installations: [
          { id: 1, permissions: { metadata: 'read' }, repositories: [repository('Acme/api')] },
          { id: 2, permissions: { metadata: 'read' }, repositories: [repository('trae/dotfiles')] },
        ],
      },
    }),
  );
  expect(repositories.installationsMissingPermissions.value.map((installation) => installation.owner)).toEqual([
    'Acme',
    'trae',
  ]);

  repositories.setOwnerShown('acme', false);
  expect(repositories.installationsMissingPermissions.value).toEqual([
    expect.objectContaining({ owner: 'trae', settings_url: 'https://github.com/settings/installations/2' }),
  ]);
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

  await repositories.load();
  expect(repositories.error.value).toBeUndefined();
});

test('Refresh waits a while after the read it started, counting down, while the opening read starts no wait', async () => {
  vi.useFakeTimers();
  const github = new FakeGitHub({ account: account(everyone) });
  const repositories = await opened(github);
  expect(repositories.refreshWait.value).toBeUndefined();

  github.state.account = account(['Acme/api']);
  await repositories.refresh();
  expect(repositories.list.value?.repositories).toHaveLength(1);
  expect(repositories.refreshWait.value?.rateLimited).toBe(false);
  expect(repositories.secondsUntilRefreshCanRun.value).toBe(refreshPause / 1000);

  github.state.account = account(everyone);
  await repositories.refresh();
  expect(repositories.list.value?.repositories).toHaveLength(1);

  vi.advanceTimersByTime(refreshPause - 1000);
  expect(repositories.secondsUntilRefreshCanRun.value).toBe(1);
  vi.advanceTimersByTime(1000);
  expect(repositories.secondsUntilRefreshCanRun.value).toBe(0);
  expect(repositories.refreshWait.value).toBeUndefined();

  await repositories.refresh();
  expect(repositories.list.value?.repositories).toHaveLength(4);
});

test("a rate limit holds Refresh until GitHub's time, or a minute when GitHub gives none", async () => {
  vi.useFakeTimers();
  const github = new FakeGitHub({ account: account(everyone) });
  const limited = (retryAt?: Date): GitHubError =>
    new GitHubError(403, 'API rate limit exceeded', {
      rateLimited: true,
      ...(retryAt === undefined ? {} : { retryAt }),
    });
  github.fail('GET /user/installations', limited(new Date(Date.now() + 120_000)), 1);
  const repositories = await opened(github);

  expect(repositories.error.value).toBe('API rate limit exceeded');
  expect(repositories.refreshWait.value?.rateLimited).toBe(true);
  expect(repositories.secondsUntilRefreshCanRun.value).toBe(120);
  vi.advanceTimersByTime(refreshPause);
  await repositories.refresh();
  expect(repositories.list.value).toBeUndefined();

  vi.advanceTimersByTime(120_000 - refreshPause);
  github.fail('GET /user/installations', limited(), 1);
  await repositories.refresh();
  expect(repositories.refreshWait.value?.rateLimited).toBe(true);
  expect(repositories.secondsUntilRefreshCanRun.value).toBe(60);

  // A reset time already past by this device's clock, as when it runs ahead of GitHub's, waits the minute too.
  vi.advanceTimersByTime(60_000);
  github.fail('GET /user/installations', limited(new Date(Date.now() - 30_000)), 1);
  await repositories.refresh();
  expect(repositories.refreshWait.value?.rateLimited).toBe(true);
  expect(repositories.secondsUntilRefreshCanRun.value).toBe(60);

  vi.advanceTimersByTime(60_000);
  await repositories.refresh();
  expect(repositories.list.value?.repositories).toHaveLength(4);
  expect(repositories.refreshWait.value?.rateLimited).toBe(false);
});

test('a refused sign-in is reported as signed out, not as an error on the page', async () => {
  const github = new FakeGitHub({ account: account(everyone) });
  github.fail('GET /user/installations', answered(401, 'Bad credentials'));
  const signedOut = vi.fn();
  const repositories = new Repositories(github, user, inBrowser(github), memory(), signedOut);

  await repositories.load();

  expect(signedOut).toHaveBeenCalledOnce();
  expect(repositories.error.value).toBeUndefined();
});

test('a refresh asked for while one runs starts no second read', async () => {
  const held = Promise.withResolvers<unknown>();
  const request = vi.fn<FakeGitHub['request']>(() => held.promise);
  const repositories = new Repositories({ request }, user, inBrowser({ request }), memory(), () => undefined);

  const first = repositories.refresh();
  await repositories.refresh();
  expect(repositories.loading.value).toBe(true);
  expect(request).toHaveBeenCalledTimes(1);

  held.resolve({ total_count: 0, installations: [] });
  await first;
  expect(repositories.loading.value).toBe(false);
  expect(repositories.list.value).toEqual({ source: 'installations', repositories: [], missing_permissions: [] });
});

test('a refresh keeps the list in use while it reads, and the opened repository when the new list has it', async () => {
  const github = new FakeGitHub({ account: account(everyone) });
  const repositories = await opened(github);
  repositories.open(repositories.groups.value[1]?.repositories[0]);
  github.state.account = account(['Acme/api', 'trae/dotfiles']);

  const refreshing = repositories.refresh();
  expect(repositories.loading.value).toBe(true);
  expect(repositories.list.value?.repositories).toHaveLength(4);
  await refreshing;

  expect(repositories.list.value?.repositories).toHaveLength(2);
  expect(repositories.opened.value?.full_name).toBe('Acme/api');
});

test('selected repositories stay selected through a search, and one the account no longer lists drops out', async () => {
  const github = new FakeGitHub({ account: account(everyone) });
  const repositories = new Repositories(github, user, inBrowser(github), memory(), () => undefined);
  await repositories.load();
  const all = repositories.list.value?.repositories ?? [];
  const named = (name: string): (typeof all)[number] => {
    const found = all.find((repository) => repository.full_name === name);
    if (found === undefined) {
      throw new Error(`The list has no ${name}.`);
    }
    return found;
  };

  repositories.select(named('zeta/site'), true);
  repositories.select(named('Acme/api'), true);
  repositories.search.value = 'dotfiles';
  expect(repositories.selected.value.map((repository) => repository.full_name).toSorted()).toEqual([
    'Acme/api',
    'zeta/site',
  ]);

  repositories.select(named('zeta/site'), false);
  expect(repositories.selected.value.map((repository) => repository.full_name)).toEqual(['Acme/api']);

  repositories.pickMoveTarget({ kind: 'none' });
  github.state.account = account(['trae/dotfiles']);
  await repositories.refresh();
  expect(repositories.selected.value).toEqual([]);
  // Nothing is selected any more, so the panel's Move choice goes too.
  expect(repositories.moveTarget.value).toBeUndefined();
  repositories.select(named('trae/dotfiles'), true);
  expect(repositories.moveTarget.value).toBeUndefined();

  repositories.deselectAll();
  expect(repositories.selected.value).toEqual([]);
});

function listed(repositories: Repositories, name: string): Repository {
  const found = repositories.list.value?.repositories.find((repository) => repository.full_name === name);
  if (found === undefined) {
    throw new Error(`The list has no ${name}.`);
  }
  return found;
}

test('a hidden repository is saved by its name as GitHub gives it, and matched in any case', async () => {
  const preferences = memory();
  const repositories = await opened(new FakeGitHub({ account: account(everyone) }), preferences);
  const api = listed(repositories, 'Acme/api');

  repositories.hide([api]);
  repositories.hide([api]);

  expect(preferences.kept['hidden-repositories']).toEqual(['Acme/api']);
  expect(repositories.isHidden({ ...api, full_name: 'acme/API' })).toBe(true);
  repositories.unhide([{ full_name: 'acme/api' }]);
  expect(preferences.kept['hidden-repositories']).toBeUndefined();
});

test('a hidden repository leaves the list, deselected and closed, until Undo or Show hidden', async () => {
  const preferences = memory();
  const repositories = await opened(new FakeGitHub({ account: account(everyone) }), preferences);
  const web = listed(repositories, 'acme/web');
  repositories.open(web);
  repositories.select(web, true);

  repositories.hide([web]);

  expect(names(repositories)).toEqual(['trae:', 'trae/dotfiles', 'Acme:', 'Acme/api', 'zeta:', 'zeta/site']);
  expect(preferences.kept['hidden-repositories']).toEqual(['acme/web']);
  expect(repositories.opened.value).toBeUndefined();
  expect(repositories.selected.value).toEqual([]);
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

test('Undo shows only what the hide took out of the list, and selects again what it deselected', async () => {
  const preferences = memory({ 'hidden-repositories': ['acme/web'] });
  const repositories = await opened(new FakeGitHub({ account: account(everyone) }), preferences);
  repositories.setShowHidden(true);
  const web = listed(repositories, 'acme/web');
  const site = listed(repositories, 'zeta/site');
  repositories.select(web, true);
  repositories.select(site, true);

  repositories.hide([web, site]);
  expect(repositories.justHidden.value).toEqual(['zeta/site']);
  expect(repositories.selected.value).toEqual([]);

  repositories.undoHide();
  expect(preferences.kept['hidden-repositories']).toEqual(['acme/web']);
  expect(repositories.selected.value.map((repository) => repository.full_name).sort()).toEqual([
    'acme/web',
    'zeta/site',
  ]);
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
  const repositories = new Repositories(github, user, preferences, browser, () => undefined);

  await repositories.load();
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
    `${folder.name}${folder.open ? '' : ' (closed)'}${folder.holdsNoListedRepository ? ' (empty)' : ''}:`,
    ...folder.repositories.map((repository) => repository.full_name),
  ]);
}

function several(
  repositories: Repositories,
  ...wanted: readonly string[]
): ReturnType<Repositories['selected']['peek']> {
  return wanted.map((name) => {
    const found = repositories.list.value?.repositories.find((repository) => repository.full_name === name);
    if (found === undefined) {
      throw new Error(`The list has no ${name}.`);
    }
    return found;
  });
}

test('folder profiles survive moves and renames, and only newly moved repositories request a review', async () => {
  const browser = memory();
  const github = new FakeGitHub({ account: account(everyone) });
  const review = vi.fn();
  const repositories = new Repositories(github, user, inBrowser(github, browser), browser, () => undefined, review);
  await repositories.load();
  repositories.createFolder('Work');
  repositories.setFolderProfiles('Work', ['base.yaml', 'base.yaml'], false);
  repositories.moveToFolder(several(repositories, 'zeta/site'), 'Work');
  expect(review).not.toHaveBeenCalled();

  repositories.setFolderProfiles('work', ['base.yaml'], true);
  expect(review).not.toHaveBeenCalled();
  repositories.moveToFolder(several(repositories, 'zeta/site', 'Acme/api', 'acme/web'), 'WORK', { deselect: true });
  expect(review.mock.calls).toEqual([[['Acme/api', 'acme/web']]]);
  repositories.renameFolder('Work', 'Clients');
  expect(repositories.folder('clients')).toMatchObject({ profiles: ['base.yaml'], applyProfilesOnMove: true });

  repositories.moveToFolder(several(repositories, 'trae/dotfiles'), 'Clients');
  expect(review.mock.calls).toEqual([[['Acme/api', 'acme/web']], [['trae/dotfiles']]]);
  repositories.moveToFolder(several(repositories, 'trae/dotfiles'), 'Clients');
  repositories.moveToFolder(several(repositories, 'trae/dotfiles'), undefined);
  repositories.deleteFolder('Clients');
  expect(review).toHaveBeenCalledTimes(2);
});

test('a remote move loads folder profiles without opening a review and saves local settings beside them', async () => {
  const source = { kind: 'repository', repository: 'trae/config', path: 'profiles' } as const;
  const file = `profiles/${preferencesFile}`;
  const config = new FakeGitRepository('trae/config');
  const saved = { name: 'Work', repositories: ['zeta/site'], profiles: ['base.yaml'], applyProfilesOnMove: true };
  config.write({ [file]: JSON.stringify({ 'repository-folders': [saved] }) });
  const browser = memory();
  const shared = new SharedPreferences(config, browser, () => undefined);
  const review = vi.fn();
  const github = new FakeGitHub({ account: account(everyone) });
  const repositories = new Repositories(github, user, shared, browser, () => undefined, review);
  await repositories.load();
  await shared.use(source);
  expect(repositories.folder('Work')).toEqual(saved);
  expect(review).not.toHaveBeenCalled();

  config.write({
    [file]: JSON.stringify({ 'repository-folders': [{ ...saved, repositories: [...saved.repositories, 'Acme/api'] }] }),
  });
  repositories.setFolderProfiles('Work', ['node.yaml'], true);
  await vi.waitFor(() => {
    expect(JSON.parse(config.files()[file] ?? '{}')).toEqual({
      'repository-folders': [
        {
          ...saved,
          profiles: ['node.yaml'],
          repositories: ['zeta/site', 'Acme/api'],
        },
      ],
    });
  });
  expect(review).not.toHaveBeenCalled();
  expect(browser.kept).toEqual({});
});

test('a refused move review keeps the move and explains how to review after the active write', async () => {
  const browser = memory();
  const github = new FakeGitHub({ account: account(everyone) });
  const repositories = new Repositories(
    github,
    user,
    inBrowser(github, browser),
    browser,
    () => undefined,
    () => false,
  );
  await repositories.load();
  repositories.createFolder('Work');
  repositories.setFolderProfiles('Work', ['base.yaml'], true);

  repositories.moveToFolder(several(repositories, 'Acme/api'), 'Work');

  expect(repositories.folder('Work')?.repositories).toEqual(['Acme/api']);
  expect(repositories.moveReviewNotice.value).toContain('Acme/api moved to Work');
  expect(repositories.moveReviewNotice.value).toContain('An apply is writing to GitHub');
});

test('quickly adding a folder profile keeps profiles and the move choice saved in another browser', async () => {
  const config = new FakeGitRepository('trae/config');
  const file = `profiles/${preferencesFile}`;
  const folder = { name: 'Work', repositories: ['zeta/site'], profiles: ['base.yaml'] };
  config.write({ [file]: JSON.stringify({ 'repository-folders': [folder] }) });
  const browser = memory();
  const shared = new SharedPreferences(config, browser, () => undefined);
  const repositories = new Repositories(config, user, shared, browser, () => undefined);
  await shared.use({ kind: 'repository', repository: 'trae/config', path: 'profiles' });
  config.write({
    [file]: JSON.stringify({
      'repository-folders': [{ ...folder, profiles: ['base.yaml', 'node.yaml'], applyProfilesOnMove: true }],
    }),
  });

  repositories.addFolderProfile('work', 'web.yaml');
  repositories.addFolderProfile('WORK', 'web.yaml');

  await vi.waitFor(() => {
    expect(JSON.parse(config.files()[file] ?? '{}')).toEqual({
      'repository-folders': [
        { ...folder, profiles: ['base.yaml', 'node.yaml', 'web.yaml'], applyProfilesOnMove: true },
      ],
    });
  });
});

test('reviewing folder profiles includes all members regardless of list visibility', async () => {
  const browser = memory();
  const github = new FakeGitHub({ account: account(everyone) });
  const review = vi.fn(() => true);
  const repositories = new Repositories(github, user, inBrowser(github, browser), browser, () => undefined, review);
  await repositories.load();
  repositories.createFolder('Work', several(repositories, 'zeta/site', 'Acme/api', 'acme/web'));
  repositories.setFolderProfiles('Work', ['base.yaml'], false);
  repositories.setOwnerShown('Acme', false);
  repositories.hide(several(repositories, 'zeta/site'));
  repositories.search.value = 'dotfiles';

  expect(repositories.reviewFolderProfiles('work')).toBeUndefined();

  expect(review.mock.calls).toEqual([[['zeta/site', 'Acme/api', 'acme/web']]]);
});

test('an empty folder or an active write cannot start a folder profile review', async () => {
  const browser = memory();
  const github = new FakeGitHub({ account: account(everyone) });
  const review = vi.fn(() => false);
  const repositories = new Repositories(github, user, inBrowser(github, browser), browser, () => undefined, review);
  await repositories.load();
  repositories.createFolder('Work');
  expect(repositories.reviewFolderProfiles('Work')).toBeDefined();
  repositories.setFolderProfiles('Work', ['base.yaml'], false);
  expect(repositories.reviewFolderProfiles('Work')).toBeDefined();
  expect(review).not.toHaveBeenCalled();

  repositories.moveToFolder(several(repositories, 'Acme/api'), 'Work');
  expect(repositories.reviewFolderProfiles('Work')).toContain('An apply is writing to GitHub');
  expect(repositories.folder('Work')?.profiles).toEqual(['base.yaml']);
});

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

test('selected repositories put in a new folder or moved are deselected, and others stay selected', async () => {
  const repositories = await opened(new FakeGitHub({ account: account(everyone) }));
  const selected = (): string[] => repositories.selected.value.map((repository) => repository.full_name);
  for (const repository of several(repositories, 'acme/web', 'zeta/site', 'trae/dotfiles')) {
    repositories.select(repository, true);
  }

  repositories.createFolder('Sites', several(repositories, 'acme/web', 'zeta/site'), { deselect: true });
  expect(folders(repositories)).toEqual(['Sites:', 'acme/web', 'zeta/site']);
  expect(selected()).toEqual(['trae/dotfiles']);

  // A name refused, or a folder made empty, as when its box is cleared, leaves the selection alone.
  expect(repositories.createFolder('sites', several(repositories, 'trae/dotfiles'), { deselect: true })).toBeDefined();
  repositories.createFolder('Tools', [], { deselect: true });
  expect(selected()).toEqual(['trae/dotfiles']);

  repositories.moveToFolder(several(repositories, 'trae/dotfiles'), 'Tools', { deselect: true });
  expect(selected()).toEqual([]);

  const web = several(repositories, 'acme/web');
  for (const repository of web) {
    repositories.select(repository, true);
  }
  repositories.moveToFolder(web, undefined, { deselect: true });
  expect(selected()).toEqual([]);
  expect(folders(repositories)).toEqual(['Sites:', 'zeta/site', 'Tools:', 'trae/dotfiles']);
});

test("a repository's own folder choice leaves the selection as it is", async () => {
  const repositories = await opened(new FakeGitHub({ account: account(everyone) }));
  const selected = (): string[] => repositories.selected.value.map((repository) => repository.full_name);
  for (const repository of several(repositories, 'acme/web', 'zeta/site')) {
    repositories.select(repository, true);
  }

  repositories.moveToFolder(several(repositories, 'acme/web'), undefined);
  repositories.createFolder('Sites', several(repositories, 'acme/web'));
  repositories.moveToFolder(several(repositories, 'zeta/site'), 'Sites');
  expect(folders(repositories)).toEqual(['Sites:', 'acme/web', 'zeta/site']);
  expect(selected().sort()).toEqual(['acme/web', 'zeta/site']);
});

test('Undo after a hide leaves deselected a repository since moved out of the selection', async () => {
  const repositories = await opened(new FakeGitHub({ account: account(everyone) }));
  repositories.setShowHidden(true);
  const web = listed(repositories, 'acme/web');
  repositories.select(web, true);
  repositories.hide([web]);
  repositories.select(web, true);

  repositories.moveToFolder([web], undefined, { deselect: true });
  repositories.undoHide();
  expect(repositories.selected.value).toEqual([]);
});

test("a folder's Select all selects only its repositories, keeps the rest, and Deselect all clears every one", async () => {
  const repositories = await opened(new FakeGitHub({ account: account(everyone) }));
  const selected = (): string[] => repositories.selected.value.map((repository) => repository.full_name).sort();
  repositories.createFolder('Sites', several(repositories, 'zeta/site', 'acme/web'));
  const [dotfiles] = several(repositories, 'trae/dotfiles');
  if (dotfiles === undefined) {
    throw new Error('No trae/dotfiles.');
  }
  repositories.select(dotfiles, true);

  const sites = several(repositories, 'zeta/site', 'acme/web');
  repositories.selectEach(sites, true);
  expect(selected()).toEqual(['acme/web', 'trae/dotfiles', 'zeta/site']);
  expect(sites.every((repository) => repositories.isSelected(repository))).toBe(true);

  repositories.selectEach(sites, false);
  expect(selected()).toEqual(['trae/dotfiles']);
  expect(repositories.isSelected(dotfiles)).toBe(true);

  repositories.selectEach(sites, true);
  repositories.deselectAll();
  expect(selected()).toEqual([]);
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

test('the folders closed in this browser are closed when the page opens again', async () => {
  const preferences = memory({
    'closed-repository-folders': ['sites'],
    'repository-folders': [{ name: 'Sites', repositories: ['zeta/site'] }],
  });
  const repositories = await opened(new FakeGitHub({ account: account(everyone) }), preferences);
  expect(folders(repositories)).toEqual(['Sites (closed):', 'zeta/site']);
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

test('a hidden owner hides its repositories in folders too, and a repository opened in a folder stays open', async () => {
  const repositories = await opened(new FakeGitHub({ account: account(everyone) }));
  repositories.createFolder('Acme', several(repositories, 'Acme/api', 'acme/web'));
  repositories.createFolder('Mixed', several(repositories, 'zeta/site', 'trae/dotfiles'));
  repositories.open(several(repositories, 'zeta/site')[0]);
  expect(repositories.opened.value?.full_name).toBe('zeta/site');

  repositories.setOwnerShown('acme', false);
  repositories.setOwnerShown('zeta', false);
  expect(folders(repositories)).toEqual(['Mixed:', 'trae/dotfiles']);
  expect(repositories.opened.value).toBeUndefined();
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
  const repositories = new Repositories(github, user, preferences, browser, () => undefined);
  await repositories.load();
  expect(folders(repositories)).toEqual([]);

  await preferences.use(source);
  expect(folders(repositories)).toEqual(['Sites:', 'zeta/site']);

  repositories.moveToFolder(several(repositories, 'acme/web'), 'Sites');
  await vi.waitFor(() => {
    expect(JSON.parse(config.files()[file] ?? '{}')).toEqual({
      'repository-folders': [{ name: 'Sites', repositories: ['zeta/site', 'acme/web'] }],
    });
  });
  expect(browser.kept).toEqual({});

  // Which folders are closed stays in this browser, so closing or opening one commits nothing.
  const request = vi.spyOn(config, 'request');
  repositories.setFolderOpen('Sites', false);
  expect(folders(repositories)).toEqual(['Sites (closed):', 'acme/web', 'zeta/site']);
  expect(browser.kept).toEqual({ 'closed-repository-folders': ['Sites'] });
  repositories.setFolderOpen('Sites', true);
  expect(browser.kept['closed-repository-folders']).toBeUndefined();
  await preferences.reload();
  expect(request.mock.calls.filter(([method]) => method !== 'GET')).toEqual([]);
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
  const browser = memory();
  const preferences = new SharedPreferences(config, browser, () => undefined);
  const repositories = new Repositories(
    new FakeGitHub({ account: account(everyone) }),
    user,
    preferences,
    browser,
    () => undefined,
  );
  await repositories.load();
  const reading = preferences.use(source);

  repositories.createFolder('Tools', several(repositories, 'trae/dotfiles'));
  repositories.setFolderOpen('Tools', false);
  expect(folders(repositories)).toEqual(['Tools (closed):', 'trae/dotfiles']);
  release();
  await reading;

  expect(folders(repositories)).toEqual(['Sites:', 'zeta/site', 'Tools (closed):', 'trae/dotfiles']);
  expect(browser.kept['closed-repository-folders']).toEqual(['Tools']);
  await vi.waitFor(() => {
    expect(JSON.parse(config.files()[file] ?? '{}')).toEqual({
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
  const browser = memory();
  const preferences = new SharedPreferences(config, browser, () => undefined);
  const repositories = new Repositories(
    new FakeGitHub({ account: account(everyone) }),
    user,
    preferences,
    browser,
    () => undefined,
  );
  await repositories.load();
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

test('the selected panel moves nowhere until a folder is chosen, then to it under any new name, until nothing is selected', async () => {
  const repositories = await opened(new FakeGitHub({ account: account(everyone) }));
  repositories.createFolder('Web');
  repositories.createFolder('Apps');
  // A folder made with nothing selected isn't chosen for a later selection.
  expect(repositories.moveTarget.value).toBeUndefined();

  const [site] = several(repositories, 'zeta/site');
  if (site === undefined) {
    throw new Error('No zeta/site.');
  }
  repositories.select(site, true);
  expect(repositories.moveTarget.value).toBeUndefined();

  repositories.pickMoveTarget({ kind: 'folder', name: 'Web' });
  repositories.renameFolder('Web', 'WEB');
  expect(repositories.moveTarget.value).toEqual({ kind: 'folder', name: 'WEB' });

  repositories.pickMoveTarget({ kind: 'none' });
  expect(repositories.moveTarget.value).toEqual({ kind: 'none' });

  // A folder made for one opened repository isn't chosen; one made from the panel, left empty, is.
  repositories.createFolder('Solo', several(repositories, 'trae/dotfiles'));
  expect(repositories.moveTarget.value).toEqual({ kind: 'none' });
  repositories.createFolder('Later', [], { deselect: true });
  expect(repositories.moveTarget.value).toEqual({ kind: 'folder', name: 'Later' });

  // A deleted folder's choice goes, and doesn't come back with a new folder of that name.
  repositories.deleteFolder('later');
  expect(repositories.moveTarget.value).toBeUndefined();
  repositories.moveToFolder(several(repositories, 'trae/dotfiles'), 'Later');
  expect(repositories.moveTarget.value).toBeUndefined();

  repositories.pickMoveTarget({ kind: 'folder', name: 'Apps' });
  repositories.deselectAll();
  repositories.select(site, true);
  expect(repositories.moveTarget.value).toBeUndefined();
});

test('closing the folder of the opened repository closes it until the folder opens again', async () => {
  const repositories = await opened(new FakeGitHub({ account: account(everyone) }));
  repositories.createFolder('Sites', several(repositories, 'zeta/site'));
  repositories.open(several(repositories, 'zeta/site')[0]);

  repositories.setFolderOpen('Sites', false);
  expect(repositories.opened.value).toBeUndefined();
  repositories.setFolderOpen('Sites', true);
  expect(repositories.opened.value?.full_name).toBe('zeta/site');
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

function detailed(repositories: readonly FakeAccount['repositories'][number][]): FakeAccount {
  return {
    login: 'trae',
    name: null,
    repositories: [],
    installations: [
      { id: 1, repositories: repositories.map((repository) => ({ ...repository, permissions: { admin: true } })) },
    ],
  };
}

const varied = detailed([
  { full_name: 'trae/app', private: true, topics: ['npm', 'web'], pushed_at: '2026-11-10T00:00:00Z' },
  { full_name: 'trae/blog', private: false, topics: ['web'], pushed_at: '2026-11-14T00:00:00Z' },
  { full_name: 'trae/empty', private: false, pushed_at: null },
  { full_name: 'trae/old', private: false, archived: true, topics: ['npm'], pushed_at: '2025-01-01T00:00:00Z' },
  { full_name: 'acme/api', private: true, topics: ['npm'], pushed_at: '2026-11-12T00:00:00Z' },
]);

function shown(repositories: Repositories): string[] {
  return [...folders(repositories), ...names(repositories)];
}

test('sorts each folder and owner group by name either way or by last push, with no push time last', async () => {
  const browser = memory({ 'repository-folders': [{ name: 'Kept', repositories: ['trae/old', 'trae/app'] }] });
  const repositories = await opened(new FakeGitHub({ account: varied }), browser);
  expect(shown(repositories)).toEqual([
    'Kept:',
    'trae/app',
    'trae/old',
    'trae:',
    'trae/blog',
    'trae/empty',
    'acme:',
    'acme/api',
  ]);

  repositories.setSortOrder('name-descending');
  expect(shown(repositories)).toEqual([
    'Kept:',
    'trae/old',
    'trae/app',
    'trae:',
    'trae/empty',
    'trae/blog',
    'acme:',
    'acme/api',
  ]);

  repositories.setSortOrder('pushed-oldest');
  expect(shown(repositories)).toEqual([
    'Kept:',
    'trae/old',
    'trae/app',
    'trae:',
    'trae/blog',
    'trae/empty',
    'acme:',
    'acme/api',
  ]);

  repositories.setSortOrder('pushed-newest');
  expect(names(repositories)).toEqual(['trae:', 'trae/blog', 'trae/empty', 'acme:', 'acme/api']);
  expect(browser.kept['repository-sort-order']).toBe('pushed-newest');

  repositories.setSortOrder('name-ascending');
  expect(browser.kept['repository-sort-order']).toBeUndefined();
});

test('filters folders and owner groups by visibility, archived, and any chosen topic', async () => {
  const browser = memory({ 'repository-folders': [{ name: 'Kept', repositories: ['trae/old'] }] });
  const repositories = await opened(new FakeGitHub({ account: varied }), browser);

  repositories.setTopicChosen('npm', true);
  expect(shown(repositories)).toEqual(['Kept:', 'trae/old', 'trae:', 'trae/app', 'acme:', 'acme/api']);
  expect(repositories.countLabel.value).toBe('3 of 5');

  repositories.setArchivedFilter('not-archived');
  expect(shown(repositories)).toEqual(['trae:', 'trae/app', 'acme:', 'acme/api']);

  repositories.setTopicChosen('web', true);
  repositories.setVisibilityFilter('public');
  expect(shown(repositories)).toEqual(['trae:', 'trae/blog']);
  expect(repositories.filterChips.value.map((chip) => chip.label)).toEqual([
    'Public',
    'Not archived',
    'Topic npm',
    'Topic web',
  ]);
  expect(repositories.topicChoices.value).toEqual([
    { topic: 'npm', count: 0, chosen: true },
    { topic: 'web', count: 1, chosen: true },
  ]);
  expect(browser.kept['repository-filters']).toEqual({
    visibility: 'public',
    archived: 'not-archived',
    topics: ['npm', 'web'],
  });

  repositories.setVisibilityFilter('private');
  repositories.setTopicChosen('web', false);
  repositories.setArchivedFilter('archived');
  expect(shown(repositories)).toEqual([]);

  repositories.clearFilters();
  expect(repositories.countLabel.value).toBe('All 5');
  expect(browser.kept['repository-filters']).toBeUndefined();
});

test('a chosen topic no repository has stays a choice, so it can be unchosen', async () => {
  const browser = memory({ 'repository-filters': { visibility: 'any', archived: 'any', topics: ['gone'] } });
  const repositories = await opened(new FakeGitHub({ account: varied }), browser);

  expect(shown(repositories)).toEqual([]);
  expect(repositories.topicChoices.value).toEqual([
    { topic: 'gone', count: 0, chosen: true },
    { topic: 'npm', count: 3, chosen: false },
    { topic: 'web', count: 2, chosen: false },
  ]);
});

test('while filtering, an empty folder hides, and the opened repository closes until it passes again', async () => {
  const browser = memory({ 'repository-folders': [{ name: 'New', repositories: [] }] });
  const repositories = await opened(new FakeGitHub({ account: varied }), browser);
  repositories.open(listed(repositories, 'trae/blog'));
  expect(folders(repositories)).toEqual(['New (empty):']);

  repositories.setVisibilityFilter('private');
  expect(folders(repositories)).toEqual([]);
  expect(repositories.opened.value).toBeUndefined();

  repositories.setVisibilityFilter('any');
  expect(repositories.opened.value?.full_name).toBe('trae/blog');
});

test('a filter that matches only hidden repositories counts the hidden ones it matches', async () => {
  const browser = memory({ 'hidden-repositories': ['trae/old', 'trae/blog'] });
  const repositories = await opened(new FakeGitHub({ account: varied }), browser);

  repositories.setArchivedFilter('archived');
  expect(shown(repositories)).toEqual([]);
  expect(repositories.hiddenMatches.value).toBe(1);
});

test('the sort order and filters stay in this browser while the other choices are in the config repository', async () => {
  const source = { kind: 'repository', repository: 'trae/config', path: 'profiles' } as const;
  const config = new FakeGitRepository('trae/config');
  const browser = memory();
  const preferences = new SharedPreferences(config, browser, () => undefined);
  const github = new FakeGitHub({ account: varied });
  const repositories = new Repositories(github, user, preferences, browser, () => undefined);
  await repositories.load();
  await preferences.use(source);
  const request = vi.spyOn(config, 'request');

  repositories.setSortOrder('pushed-newest');
  repositories.setTopicChosen('web', true);
  await preferences.reload();

  expect(request.mock.calls.filter(([method]) => method !== 'GET')).toEqual([]);
  expect(browser.kept).toEqual({
    'repository-sort-order': 'pushed-newest',
    'repository-filters': { visibility: 'any', archived: 'any', topics: ['web'] },
  });
  const again = new Repositories(github, user, preferences, browser, () => undefined);
  await again.load();
  expect(names(again)).toEqual(['trae:', 'trae/blog', 'trae/app']);
});

test('a saved sort order or filters it cannot read fall back to the defaults', async () => {
  const browser = memory({
    'repository-sort-order': 'stars',
    'repository-filters': { visibility: 'secret', archived: 'archived', topics: 'npm' },
  });
  const repositories = await opened(new FakeGitHub({ account: varied }), browser);

  expect(repositories.sortOrder.value).toBe('name-ascending');
  expect(repositories.filters.value).toEqual({ visibility: 'any', archived: 'archived', topics: [] });
});

test('a selected repository a filter takes out of view stays selected, and the selection still acts on it', async () => {
  const browser = memory();
  const repositories = await opened(new FakeGitHub({ account: varied }), browser);
  repositories.select(listed(repositories, 'trae/blog'), true);

  repositories.setVisibilityFilter('private');
  expect(names(repositories)).toEqual(['trae:', 'trae/app', 'acme:', 'acme/api']);
  expect(repositories.selected.value.map((repository) => repository.full_name)).toEqual(['trae/blog']);

  repositories.hide(repositories.selected.value);
  expect(browser.kept['hidden-repositories']).toEqual(['trae/blog']);
});
