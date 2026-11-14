import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { ActionSearch, type FoundAction } from '../src/app/action-search.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const checkout: FoundAction = {
  repository: 'actions/checkout',
  description: 'Check out a repository',
  stars: 6000,
  action_file: 'action.yml',
};

/** A search that answers when told to, and remembers what was asked. */
function held(): {
  readonly asked: string[];
  readonly find: (words: string) => Promise<FoundAction[]>;
  readonly land: (found: FoundAction[]) => Promise<void>;
  readonly fail: (error: Error) => Promise<void>;
} {
  const asked: string[] = [];
  const waiting: { resolve: (found: FoundAction[]) => void; reject: (error: Error) => void }[] = [];
  const settle = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  };
  return {
    asked,
    find: (words) =>
      new Promise((resolve, reject) => {
        asked.push(words);
        waiting.push({ resolve, reject });
      }),
    land: async (found) => {
      waiting.shift()?.resolve(found);
      await settle();
    },
    fail: async (error) => {
      waiting.shift()?.reject(error);
      await settle();
    },
  };
}

test('a search starts once typing has stopped, for two characters or more, or at once on Enter', async () => {
  const github = held();
  const search = new ActionSearch(github.find);

  search.type('c');
  vi.advanceTimersByTime(500);
  search.enter();
  expect(github.asked).toEqual([]);
  expect(search.state.value).toEqual({ kind: 'closed' });

  search.type('ch');
  search.type(' checkout ');
  vi.advanceTimersByTime(499);
  expect(search.state.value).toEqual({ kind: 'closed' });
  vi.advanceTimersByTime(1);
  expect(github.asked).toEqual(['checkout']);
  expect(search.state.value).toEqual({ kind: 'searching' });

  await github.land([checkout]);
  expect(search.state.value).toEqual({ kind: 'results', found: [checkout] });

  search.enter();
  expect(github.asked).toEqual(['checkout', 'checkout']);
  expect(search.state.value).toEqual({ kind: 'searching' });
});

test('an older answer never replaces a newer one, and a search left behind shows nothing', async () => {
  const github = held();
  const search = new ActionSearch(github.find);
  search.type('checkout');
  search.enter();

  search.type('setup node');
  // The list still says it is searching while the new words wait.
  expect(search.state.value).toEqual({ kind: 'searching' });
  await github.land([checkout]);
  expect(search.state.value).toEqual({ kind: 'searching' });

  vi.advanceTimersByTime(500);
  await github.land([]);
  expect(search.state.value).toEqual({ kind: 'message', text: 'GitHub found no repositories for “setup node”.' });

  search.enter();
  search.close();
  await github.land([checkout]);
  expect(search.state.value).toEqual({ kind: 'closed' });
  expect(search.text.value).toBe('setup node');

  search.enter();
  search.type('s');
  await github.land([checkout]);
  expect(search.state.value).toEqual({ kind: 'closed' });
});

test("a search that fails says why, and GitHub's limit says when to try again", async () => {
  const github = held();
  const search = new ActionSearch(github.find);
  search.type('checkout');

  search.enter();
  await github.fail(Object.assign(new Error('API rate limit exceeded'), { rateLimited: true }));
  expect(search.state.value).toEqual({
    kind: 'message',
    text: "GitHub's search limit is reached. Try again in a minute.",
  });

  search.enter();
  await github.fail(new Error('Failed to fetch'));
  expect(search.state.value).toEqual({ kind: 'message', text: 'Failed to fetch' });
});
