import { expect, test } from 'vitest';

import { browser } from './fake-browser.js';

test("follows links and the browser's back button, and reads a trailing slash as the same page", () => {
  const { router, history, listeners, show } = browser('/profiles/');
  expect(router.path.value).toBe('/profiles');

  router.go('/settings');
  expect(router.path.value).toBe('/settings');
  expect(history.pushState).toHaveBeenCalledWith(null, '', '/settings');

  router.go('/settings');
  expect(history.pushState).toHaveBeenCalledTimes(1);

  show('/?repository=octo/app');
  listeners.forEach((listener) => {
    listener();
  });
  expect(router.path.value).toBe('/');
  expect(router.search.value).toBe('?repository=octo/app');
});

test('a query pushed on the page is left by back, and one put in place leaves the history as it was', () => {
  const { router, history, entries } = browser('/');

  router.query('?repository=octo/app', 'push');
  router.query('?repository=octo/web', 'replace');
  expect(entries()).toEqual(['/', '/?repository=octo/web']);

  router.returnTo('');
  expect(history.back).toHaveBeenCalledTimes(1);
  expect(entries()).toEqual(['/', '/?repository=octo/web']);
  expect(router.search.value).toBe('');
});

test('a return to a query that no entry before holds, as after a link to the address, is put in place', () => {
  const { router, history, entries } = browser('/?repository=octo/app');

  router.returnTo('');

  expect(history.back).not.toHaveBeenCalled();
  expect(entries()).toEqual(['/']);
  expect(router.search.value).toBe('');
});

test('a link to the page shown goes back to it without its query when that entry is the one before', () => {
  const { router, history, entries } = browser('/');
  router.query('?repository=octo/app', 'push');

  router.go('/');

  expect(history.back).toHaveBeenCalledTimes(1);
  expect(entries()).toEqual(['/', '/?repository=octo/app']);
  expect(router.search.value).toBe('');
});

test('a link to the page shown drops its query in place when no entry before has it without, and else does nothing', () => {
  const { router, history, entries } = browser('/?repository=octo/app');

  router.go('/');
  router.go('/');

  expect(history.back).not.toHaveBeenCalled();
  expect(history.pushState).not.toHaveBeenCalled();
  expect(entries()).toEqual(['/']);
  expect(router.search.value).toBe('');
});

test('a link to another page with a query takes both', () => {
  const { router, entries } = browser('/apply');

  router.go('/?repository=octo/app');

  expect(entries()).toEqual(['/apply', '/?repository=octo/app']);
  expect(router.path.value).toBe('/');
  expect(router.search.value).toBe('?repository=octo/app');
});

test('a second return while the first back is under way asks for no second back', () => {
  const { router, history, traversals } = browser('/', true);
  router.query('?repository=octo/app', 'push');

  router.returnTo('');
  router.returnTo('');
  router.query('?repository=octo/web', 'replace');
  expect(history.back).toHaveBeenCalledTimes(1);
  expect(history.replaceState).not.toHaveBeenCalled();

  traversals.forEach((traverse) => {
    traverse();
  });
  expect(router.search.value).toBe('');
});
