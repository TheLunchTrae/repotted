import { expect, test } from 'vitest';

import { FakeGitHub } from '../../core/tests/fake-github.js';
import { AddressSelection } from '../src/app/address-selection.js';
import type { Preferences } from '../src/app/preferences.js';
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
  const inBrowser: Preferences = { read: (key) => kept[key], write: (key, value) => (kept[key] = value) };
  const preferences = new SharedPreferences(github, inBrowser, () => undefined);
  const repositories = new Repositories(github, { login: 'octo', name: null }, preferences, inBrowser, () => undefined);
  const fake = browser(start);
  const address = new AddressSelection(repositories, fake.router);
  return { repositories, address, ...fake, refreshing: repositories.refresh() };
}

test('a link to a repository opens it once the list has it, with no entry of its own', async () => {
  const { repositories, address, entries, refreshing } = page('/?repository=octo/web');

  address.arrive(true);
  address.update(true);
  expect(repositories.selected.value).toBeUndefined();
  await refreshing;
  address.update(true);

  expect(repositories.selected.value?.full_name).toBe('octo/web');
  expect(entries()).toEqual(['/?repository=octo/web']);
});

test('a link to a repository in another case takes its name as GitHub has it', async () => {
  const { repositories, address, entries, refreshing } = page('/?repository=OCTO/Web');
  address.arrive(false);
  await refreshing;

  address.update(false);

  expect(repositories.selectedName).toBe('octo/web');
  expect(entries()).toEqual(['/?repository=octo/web']);
});

test('arriving with no repository named shows the list on a phone, and the kept selection beside it elsewhere', async () => {
  const phone = page('/');
  await phone.refreshing;
  phone.repositories.select({ full_name: 'octo/app' });
  phone.address.arrive(true);
  expect(phone.repositories.selectedName).toBeUndefined();
  expect(phone.entries()).toEqual(['/']);

  const wide = page('/');
  await wide.refreshing;
  wide.repositories.select({ full_name: 'octo/app' });
  wide.address.arrive(false);
  expect(wide.repositories.selectedName).toBe('octo/app');
  expect(wide.entries()).toEqual(['/?repository=octo/app']);
});

test('on a phone a repository opened from the list gets an entry that back leaves; elsewhere it takes the one shown', async () => {
  const phone = page('/');
  await phone.refreshing;
  phone.address.arrive(true);
  phone.repositories.select({ full_name: 'octo/app' });
  phone.address.update(true);
  expect(phone.entries()).toEqual(['/', '/?repository=octo/app']);
  phone.address.close();
  phone.address.follow();
  phone.address.update(true);
  expect(phone.history.back).toHaveBeenCalledTimes(1);
  expect(phone.repositories.selectedName).toBeUndefined();

  const wide = page('/');
  await wide.refreshing;
  wide.address.arrive(false);
  wide.repositories.select({ full_name: 'octo/app' });
  wide.address.update(false);
  wide.repositories.select({ full_name: 'octo/web' });
  wide.address.update(false);
  expect(wide.entries()).toEqual(['/?repository=octo/web']);
});

test('a repository opened by a link has no list entry before it, so closing it puts the list in its place', async () => {
  const { repositories, address, entries, history, refreshing } = page('/?repository=octo/app');
  address.arrive(true);
  await refreshing;
  address.update(true);

  address.close();
  address.follow();

  expect(history.back).not.toHaveBeenCalled();
  expect(entries()).toEqual(['/']);
  expect(repositories.selectedName).toBeUndefined();
});

test('on a phone a link to a repository the list does not show is let go of in place, and the next one opened gets an entry', async () => {
  const { repositories, address, entries, history, refreshing } = page('/?repository=octo/nope');
  address.arrive(true);
  await refreshing;
  address.update(true);
  expect(history.back).not.toHaveBeenCalled();
  expect(entries()).toEqual(['/']);

  repositories.select({ full_name: 'octo/app' });
  address.update(true);

  expect(entries()).toEqual(['/', '/?repository=octo/app']);
});

/** A phone with octo/app opened from the list, then hidden from its screen. */
async function hiddenFromItsScreen() {
  const opened = page('/');
  await opened.refreshing;
  opened.address.arrive(true);
  opened.repositories.select({ full_name: 'octo/app' });
  opened.address.update(true);
  const app = opened.repositories.selected.value;
  if (app === undefined) {
    throw new Error('octo/app is not in view');
  }
  opened.repositories.hide([app]);
  opened.address.update(true);
  return opened;
}

test('on a phone a repository hidden from its screen is let go of, back at the list entry, with its Undo', async () => {
  const { repositories, entries, history, router } = await hiddenFromItsScreen();

  expect(history.back).toHaveBeenCalledTimes(1);
  expect(router.search.value).toBe('');
  expect(entries()).toEqual(['/', '/?repository=octo/app']);
  expect(repositories.selectedName).toBeUndefined();
  expect(repositories.justHidden.value).toEqual(['octo/app']);
});

test('showing hidden repositories brings back no repository let go of', async () => {
  const { repositories } = await hiddenFromItsScreen();

  repositories.setShowHidden(true);

  expect(repositories.selected.value).toBeUndefined();
});

test('Undo of the hide opens the repository again, in an entry of its own', async () => {
  const { repositories, address, entries } = await hiddenFromItsScreen();

  repositories.undoHide();
  address.update(true);

  expect(repositories.selected.value?.full_name).toBe('octo/app');
  expect(entries()).toEqual(['/', '/?repository=octo/app']);
});

test('forward to a repository hidden since takes it off the address in place, keeping its Undo', async () => {
  const { repositories, address, entries, history, router, forward } = await hiddenFromItsScreen();
  forward();

  address.follow();
  address.update(true);

  expect(router.search.value).toBe('');
  expect(entries()).toEqual(['/', '/']);
  expect(history.back).toHaveBeenCalledTimes(1);
  expect(repositories.selectedName).toBeUndefined();
  expect(repositories.justHidden.value).toEqual(['octo/app']);
});
