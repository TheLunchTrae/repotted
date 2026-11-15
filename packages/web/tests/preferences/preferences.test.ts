import { expect, test } from 'vitest';

import { browserPreferences } from '../src/app/preferences.js';

function storage(start: Record<string, string> = {}): Storage & { readonly kept: Map<string, string> } {
  const kept = new Map(Object.entries(start));
  return {
    kept,
    length: 0,
    clear: () => undefined,
    key: () => null,
    getItem: (key) => kept.get(key) ?? null,
    setItem: (key, value) => {
      kept.set(key, value);
    },
    removeItem: (key) => {
      kept.delete(key);
    },
  };
}

test("keeps a value under the site's prefix and drops it when it is set to nothing", () => {
  const browser = storage();
  const preferences = browserPreferences(() => browser);

  preferences.write('hidden-repository-owners', ['acme']);
  expect(browser.kept.get('repotted:hidden-repository-owners')).toBe('["acme"]');
  expect(preferences.read('hidden-repository-owners')).toEqual(['acme']);

  preferences.write('hidden-repository-owners', undefined);
  expect(browser.kept.size).toBe(0);
  expect(preferences.read('hidden-repository-owners')).toBeUndefined();
});

test('reads a value that is not JSON as nothing', () => {
  const preferences = browserPreferences(() => storage({ 'repotted:profiles-source': '{half' }));

  expect(preferences.read('profiles-source')).toBeUndefined();
});

test("a browser that blocks the site's storage, or has it full, keeps nothing and fails nothing", () => {
  const blocked = browserPreferences(() => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  });
  expect(blocked.read('profiles-source')).toBeUndefined();
  expect(() => {
    blocked.write('profiles-source', { kind: 'browser' });
  }).not.toThrow();

  const browser = storage();
  browser.setItem = () => {
    throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
  };
  const full = browserPreferences(() => browser);
  expect(() => {
    full.write('profiles-source', { kind: 'browser' });
  }).not.toThrow();
});
