import { vi } from 'vitest';

import { Router } from '../src/app/router.js';

/**
 * A browser's history of addresses, with a back that tells the router as the
 * browser does: at once, or `later`, when `traversals` are run, as a browser's
 * back arrives after the call that asks for it.
 */
export function browser(start: string, later = false) {
  const traversals: (() => void)[] = [];
  const [pathname = start, query = ''] = start.split('?');
  const location = { pathname, search: query === '' ? '' : `?${query}` };
  const entries: { address: string; state: unknown }[] = [{ address: start, state: null }];
  let at = 0;
  const listeners: (() => void)[] = [];
  const show = (address: string): void => {
    const [path = address, rest = ''] = address.split('?');
    location.pathname = path;
    location.search = rest === '' ? '' : `?${rest}`;
  };
  const history = {
    get state(): unknown {
      return entries[at]?.state;
    },
    pushState: vi.fn<History['pushState']>((state, _unused, url) => {
      entries.splice(at + 1, entries.length, { address: String(url), state });
      at += 1;
      show(String(url));
    }),
    replaceState: vi.fn<History['replaceState']>((state, _unused, url) => {
      entries[at] = { address: String(url), state };
      show(String(url));
    }),
    back: vi.fn<History['back']>(() => {
      const traverse = (): void => {
        at -= 1;
        show(entries[at]?.address ?? '/');
        listeners.forEach((listener) => {
          listener();
        });
      };
      if (later) {
        traversals.push(traverse);
      } else {
        traverse();
      }
    }),
  };
  const router = new Router(location, history, {
    addEventListener: (_type, listener) => {
      listeners.push(listener);
    },
  });
  return { router, history, traversals, entries: () => entries.map((entry) => entry.address), listeners, show };
}
