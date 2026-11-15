import { currentUser, GitHubError } from '@repotted/core';
import { expect, test, vi } from 'vitest';

import { sessionGitHub } from '../src/engine/github.js';
import { type Session, SessionUnavailableError } from '../src/session.js';

function session(fetchGitHub: Session['fetchGitHub']): Session {
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- a Session can't be built without a browser's locks, and the client calls only fetchGitHub
  return { fetchGitHub } as unknown as Session;
}

test('sends each request through the session by its path and query, with the body', async () => {
  const fetchGitHub = vi.fn<Session['fetchGitHub']>(() => Promise.resolve(Response.json({ id: 7 })));
  const github = sessionGitHub(session(fetchGitHub));

  expect(await github.request('PATCH', '/repos/lunch/app?page=2', { has_wiki: false })).toEqual({ id: 7 });

  const [path, init] = fetchGitHub.mock.calls[0] ?? [];
  expect(path).toBe('/repos/lunch/app?page=2');
  expect(init?.method).toBe('PATCH');
  expect(init?.body).toBe(JSON.stringify({ has_wiki: false }));
  expect(new Headers(init?.headers).get('x-github-api-version')).toBe('2022-11-28');
});

test('a browser that is not signed in gets the 401 a refused token gets', async () => {
  const github = sessionGitHub(session(() => Promise.resolve(undefined)));

  const error: unknown = await currentUser(github).catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(GitHubError);
  expect(error).toMatchObject({ status: 401, message: 'Not signed in' });
});

test('a session that cannot be refreshed right now is not a sign-out', async () => {
  const github = sessionGitHub(session(() => Promise.reject(new SessionUnavailableError('offline'))));

  const error: unknown = await currentUser(github).catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(GitHubError);
  expect(error).not.toMatchObject({ status: 401 });
});
