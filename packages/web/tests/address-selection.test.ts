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
  const fake = browser(start, true);
  const address = new AddressSelection(repositories, fake.router);
  /** Lets the backs asked for arrive, and the page follow the address, as it does on each change of the address. */
  const traverse = (phone: boolean): void => {
    fake.traversals.splice(0).forEach((arrive) => {
      arrive();
    });
    address.follow(phone);
  };
  return { repositories, address, traverse, ...fake, refreshing: repositories.refresh() };
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
  phone.traverse(true);
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
  const { repositories, address, entries, history, traverse, refreshing } = page('/?repository=octo/app');
  address.arrive(true);
  await refreshing;
  address.update(true);

  address.close();
  traverse(true);

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
  opened.traverse(true);
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
  const { repositories, address, entries, history, router, forward, traverse } = await hiddenFromItsScreen();
  forward();

  traverse(true);
  address.update(true);

  expect(router.search.value).toBe('');
  expect(entries()).toEqual(['/', '/']);
  expect(history.back).toHaveBeenCalledTimes(1);
  expect(repositories.selectedName).toBeUndefined();
  expect(repositories.justHidden.value).toEqual(['octo/app']);
});

test('on a phone a link in another case corrects the address in place, adding no entry', async () => {
  const { repositories, address, entries, refreshing } = page('/?repository=OCTO/Web');
  address.arrive(true);
  address.update(true);
  await refreshing;

  address.update(true);

  expect(repositories.selected.value?.full_name).toBe('octo/web');
  expect(entries()).toEqual(['/?repository=octo/web']);
});

test("on a wide screen arriving keeps a selection a search took out of view, and the address it writes isn't followed", async () => {
  const { repositories, address, router, traverse, refreshing } = page('/');
  await refreshing;
  repositories.select({ full_name: 'octo/app' });
  repositories.search.value = 'web';

  address.arrive(false);
  traverse(false);
  address.update(false);
  expect(router.search.value).toBe('?repository=octo/app');
  repositories.search.value = '';

  expect(repositories.selected.value?.full_name).toBe('octo/app');
});

test('on a wide screen back or forward to a repository a search took out of view keeps it selected', async () => {
  const { repositories, address, traverse, forward, refreshing } = page('/');
  await refreshing;
  // An entry for it, as a phone's screen leaves behind once the window grows.
  address.arrive(true);
  repositories.select({ full_name: 'octo/app' });
  address.update(true);
  address.close();
  traverse(true);
  repositories.search.value = 'web';

  forward();
  traverse(false);
  repositories.search.value = '';

  expect(repositories.selected.value?.full_name).toBe('octo/app');
});

test('closing a screen opened from the list keeps the selection until the back arrives', async () => {
  const { repositories, address, traverse, history, refreshing } = page('/');
  await refreshing;
  address.arrive(true);
  repositories.select({ full_name: 'octo/app' });
  address.update(true);

  address.close();
  address.close();
  expect(history.back).toHaveBeenCalledTimes(1);
  expect(repositories.selectedName).toBe('octo/app');

  traverse(true);
  expect(repositories.selectedName).toBeUndefined();
});
