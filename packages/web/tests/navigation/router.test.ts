import { expect, test } from 'vitest';

import { browser } from '../support/fake-browser.js';

test("follows links and the browser's back button, and reads a trailing slash as the same page", () => {
  const { router, history, listeners, show } = browser('/profiles/');
  expect(router.path.value).toBe('/profiles');

  router.go('/settings');
  expect(router.path.value).toBe('/settings');
  expect(history.pushState).toHaveBeenCalledWith({ index: 1 }, '', '/settings');

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

test('a link away from held work asks first, and goes only once the answer is to leave', () => {
  const { router, entries } = browser('/apply');
  const opened: string[] = [];
  router.onTopOfPage((path) => opened.push(path));
  router.holdWhileLeaving(() => ({ kind: 'one-off-edits', repositories: ['octo/app'], savable: true }));

  router.go('/profiles', { landOnTop: true });
  expect(router.leaving.value?.question).toEqual({ kind: 'one-off-edits', repositories: ['octo/app'], savable: true });
  router.stay();
  expect(router.leaving.value).toBeUndefined();
  expect(router.path.value).toBe('/apply');
  expect(opened).toEqual([]);

  router.go('/profiles', { landOnTop: true });
  router.leave();
  expect(router.path.value).toBe('/profiles');
  expect(entries()).toEqual(['/apply', '/profiles']);
  expect(opened).toEqual(['/profiles']);
});

test('nothing is asked for the address shown, for work done with, or once the work is let go', () => {
  const { router } = browser('/profiles/new');
  const release = router.holdWhileLeaving(() => ({ kind: 'new-profile', name: 'web' }));

  router.go('/profiles/new');
  router.go('/profiles', { withoutAsking: true });
  expect(router.leaving.value).toBeUndefined();
  expect(router.path.value).toBe('/profiles');

  release();
  router.go('/settings');
  expect(router.leaving.value).toBeUndefined();
  expect(router.path.value).toBe('/settings');
});

test("the browser's back away from held work puts the address back and asks, and leaving goes back after all", () => {
  const { router, history, entries } = browser('/');
  router.go('/apply');
  let held = true;
  router.holdWhileLeaving(() => (held ? { kind: 'capture', repository: 'octo/app' } : undefined));

  history.back();
  expect(router.leaving.value?.question).toEqual({ kind: 'capture', repository: 'octo/app' });
  expect(router.path.value).toBe('/apply');
  expect(entries()).toEqual(['/', '/apply']);

  router.leave();
  expect(router.leaving.value).toBeUndefined();
  expect(router.path.value).toBe('/');

  held = false;
  router.go('/apply');
  history.back();
  expect(router.leaving.value).toBeUndefined();
  expect(router.path.value).toBe('/');
});

test('a page link to the page shown still opens it at its top', () => {
  const { router } = browser('/profiles');
  const opened: string[] = [];
  router.onTopOfPage((path) => opened.push(path));

  router.go('/profiles', { landOnTop: true });
  router.go('/settings');

  expect(opened).toEqual(['/profiles']);
});

test('forward away from held work goes back to the entry shown, so back after Stay still goes where it did', () => {
  const { router, history, forward, entries } = browser('/');
  router.go('/settings');
  router.go('/apply');
  history.back();
  expect(router.path.value).toBe('/settings');
  let held = true;
  router.holdWhileLeaving(() => (held ? { kind: 'capture', repository: 'octo/app' } : undefined));

  forward();
  expect(router.leaving.value?.question).toEqual({ kind: 'capture', repository: 'octo/app' });
  router.stay();
  expect(router.path.value).toBe('/settings');
  expect(entries()).toEqual(['/', '/settings', '/apply']);

  held = false;
  history.back();
  expect(router.path.value).toBe('/');
});
