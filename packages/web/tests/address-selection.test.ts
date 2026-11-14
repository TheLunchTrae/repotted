import { expect, test } from 'vitest';

import { FakeGitHub } from '../../core/tests/fake-github.js';
import { AddressSelection } from '../src/app/address-selection.js';
import { Repositories } from '../src/app/repositories.js';
import { SharedPreferences } from '../src/app/shared-preferences.js';
import { browser } from './fake-browser.js';

const names = ['octo/app', 'octo/web'];

function page(start: string) {
  const github = new FakeGitHub({
    account: {
      login: 'octo',
      name: null,
      repositories: [],
      installations: [
        {
          id: 1,
          repositories: names.map((full_name) => ({ full_name, private: false, permissions: { admin: true } })),
        },
      ],
    },
  });
  const kept: Record<string, unknown> = {};
  const preferences = new SharedPreferences(
    github,
    { read: (key) => kept[key], write: (key, value) => (kept[key] = value) },
    () => undefined,
  );
  const repositories = new Repositories(github, { login: 'octo', name: null }, preferences, () => undefined);
  const fake = browser(start);
  const address = new AddressSelection(repositories, fake.router);
  return { repositories, address, ...fake, refreshing: repositories.refresh() };
}

test('a link to a repository selects it once the list has it', async () => {
  const { repositories, address, entries, refreshing } = page('/?repository=octo/web');

  address.arrive();
  expect(repositories.selected.value).toBeUndefined();
  await refreshing;

  expect(repositories.selected.value?.full_name).toBe('octo/web');
  expect(entries()).toEqual(['/?repository=octo/web']);
});

test('an address that names no repository takes the selection kept from before', async () => {
  const { repositories, address, entries, refreshing } = page('/');
  await refreshing;
  repositories.select({ full_name: 'octo/app' });

  address.arrive();

  expect(repositories.selectedName).toBe('octo/app');
  expect(entries()).toEqual(['/?repository=octo/app']);
});

test("a repository opened in a screen of its own is closed by the browser's back, or by Back to the list", async () => {
  const { repositories, address, entries, history, router, refreshing } = page('/');
  await refreshing;
  address.arrive();

  repositories.select({ full_name: 'octo/app' });
  address.keep('push');
  expect(entries()).toEqual(['/', '/?repository=octo/app']);

  // Back, whether the browser's or the screen's, returns to the list's entry, and the selection follows.
  address.close();
  expect(history.back).toHaveBeenCalledTimes(1);
  expect(router.search.value).toBe('');
  address.follow();
  expect(repositories.selectedName).toBeUndefined();
  expect(entries()).toEqual(['/', '/?repository=octo/app']);
});

test('a repository opened from a link has no list entry before it, so closing it puts the list in its place', async () => {
  const { repositories, address, entries, history, refreshing } = page('/?repository=octo/app');
  address.arrive();
  await refreshing;

  address.close();
  address.follow();

  expect(history.back).not.toHaveBeenCalled();
  expect(entries()).toEqual(['/']);
  expect(repositories.selectedName).toBeUndefined();
});

test('following the address keeps the Undo of a hide while the selection is already the one it names', async () => {
  const { repositories, address, refreshing } = page('/?repository=octo/app');
  address.arrive();
  await refreshing;
  const app = repositories.selected.value;
  expect(app).toBeDefined();
  repositories.hide(app === undefined ? [] : [app]);

  address.follow();

  expect(repositories.justHidden.value).toEqual(['octo/app']);
});
