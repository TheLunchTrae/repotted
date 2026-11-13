import { expect, test, vi } from 'vitest';

import { Router } from '../src/app/router.js';

test("follows links and the browser's back button, and reads a trailing slash as the same page", () => {
  const location = { pathname: '/profiles/' };
  const pushState = vi.fn<History['pushState']>((_state, _unused, url) => {
    location.pathname = String(url);
  });
  const listeners: (() => void)[] = [];
  const router = new Router(
    location,
    { pushState },
    {
      addEventListener: (_type, listener) => {
        listeners.push(listener);
      },
    },
  );
  expect(router.path.value).toBe('/profiles');

  router.go('/settings');
  expect(router.path.value).toBe('/settings');
  expect(pushState).toHaveBeenCalledWith(null, '', '/settings');

  router.go('/settings');
  expect(pushState).toHaveBeenCalledTimes(1);

  location.pathname = '/';
  listeners.forEach((listener) => {
    listener();
  });
  expect(router.path.value).toBe('/');
});
