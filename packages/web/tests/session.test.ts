import { afterEach, describe, expect, test, vi } from 'vitest';

import { Session, SessionUnavailableError } from '../src/session.js';

/** Stubs the Worker, and a Web Lock that runs its callbacks one at a time, as the browser's does. */
function setup(): ReturnType<typeof vi.fn<typeof fetch>> {
  const worker = vi.fn<typeof fetch>();
  const lock = { queue: Promise.resolve() };
  const request = (_name: string, callback: () => Promise<unknown>): Promise<unknown> => {
    const run = lock.queue.then(callback);
    lock.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  vi.stubGlobal('fetch', worker);
  vi.stubGlobal('navigator', { locks: { request } });
  return worker;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test('refreshes once for calls made together, then reuses the token until it nears expiry', async () => {
  const worker = setup();
  const session = new Session();
  worker.mockImplementation(() => Promise.resolve(Response.json({ accessToken: 'ghu_one', expiresIn: 8 * 3600 })));

  const tokens = await Promise.all([session.accessToken(), session.accessToken()]);

  expect(tokens).toEqual(['ghu_one', 'ghu_one']);
  expect(worker).toHaveBeenCalledTimes(1);
  expect(await session.accessToken()).toBe('ghu_one');
  expect(worker).toHaveBeenCalledTimes(1);
});

test('refreshes a token within five minutes of expiry', async () => {
  const worker = setup();
  const session = new Session();
  worker
    .mockResolvedValueOnce(Response.json({ accessToken: 'ghu_old', expiresIn: 4 * 60 }))
    .mockResolvedValueOnce(Response.json({ accessToken: 'ghu_new', expiresIn: 8 * 3600 }));

  expect(await session.accessToken()).toBe('ghu_old');
  expect(await session.accessToken()).toBe('ghu_new');
});

test('reads as signed out when the Worker answers 401, and throws when it is unavailable', async () => {
  const worker = setup();
  const session = new Session();
  worker.mockResolvedValueOnce(Response.json({ error: 'signed_out' }, { status: 401 }));
  expect(await session.accessToken()).toBeUndefined();

  worker.mockResolvedValueOnce(Response.json({ error: 'unavailable' }, { status: 502 }));
  await expect(session.accessToken()).rejects.toBeInstanceOf(SessionUnavailableError);
});

test.each([
  ['the Worker is out of reach', () => Promise.reject(new TypeError('network'))],
  ['the Worker is too slow', () => Promise.reject(new DOMException('timed out', 'TimeoutError'))],
  ['the answer has no token', () => Promise.resolve(Response.json({ accessToken: '' }))],
  ['the answer is not JSON', () => Promise.resolve(new Response('<html>'))],
])('throws SessionUnavailableError when %s', async (_name, answer) => {
  const worker = setup();
  worker.mockImplementation(answer);

  await expect(new Session().accessToken()).rejects.toBeInstanceOf(SessionUnavailableError);
});

describe('fetchGitHub', () => {
  const user = (): Response => Response.json({ login: 'octocat' });
  const refused = (): Response => new Response(null, { status: 401 });

  test('calls GitHub with the token, and answers undefined when signed out', async () => {
    const worker = setup();
    const session = new Session();
    worker.mockResolvedValueOnce(Response.json({ accessToken: 'ghu_one', expiresIn: 3600 }));
    worker.mockResolvedValueOnce(user());

    const response = await session.fetchGitHub('/user');

    expect(response?.status).toBe(200);
    const [url, init] = worker.mock.calls[1] ?? [];
    expect(url).toBe('https://api.github.com/user');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer ghu_one');

    worker.mockReset();
    worker.mockResolvedValueOnce(Response.json({ error: 'signed_out' }, { status: 401 }));
    expect(await new Session().fetchGitHub('/user')).toBeUndefined();
  });

  test('asks the Worker to replace a token GitHub refuses, then tries once more', async () => {
    const worker = setup();
    const session = new Session();
    worker
      .mockResolvedValueOnce(Response.json({ accessToken: 'ghu_one', expiresIn: 3600 }))
      .mockResolvedValueOnce(refused())
      .mockResolvedValueOnce(Response.json({ accessToken: 'ghu_two', expiresIn: 3600 }))
      .mockResolvedValueOnce(user());

    const response = await session.fetchGitHub('/user');

    expect(response?.status).toBe(200);
    const replacing = worker.mock.calls[2]?.[1];
    expect(replacing?.body).toBe(JSON.stringify({ replace: 'ghu_one' }));
    expect(new Headers(worker.mock.calls[3]?.[1]?.headers).get('Authorization')).toBe('Bearer ghu_two');
  });

  test('returns a second refusal as GitHub answered it', async () => {
    const worker = setup();
    worker
      .mockResolvedValueOnce(Response.json({ accessToken: 'ghu_one', expiresIn: 3600 }))
      .mockResolvedValueOnce(refused())
      .mockResolvedValueOnce(Response.json({ accessToken: 'ghu_two', expiresIn: 3600 }))
      .mockResolvedValueOnce(refused());

    const response = await new Session().fetchGitHub('/user');

    expect(response?.status).toBe(401);
    expect(worker).toHaveBeenCalledTimes(4);
  });
});

test('signs out under the lock a refresh holds, and forgets the token', async () => {
  const worker = setup();
  const session = new Session();
  const refresh = Promise.withResolvers<Response>();
  worker.mockReturnValueOnce(refresh.promise);
  worker.mockResolvedValueOnce(new Response(null, { status: 204 }));
  worker.mockResolvedValueOnce(Response.json({ error: 'signed_out' }, { status: 401 }));

  const refreshing = session.accessToken();
  const signingOut = session.signOut();
  await vi.waitFor(() => expect(worker).toHaveBeenCalledTimes(1));
  await new Promise((resolve) => {
    setTimeout(resolve, 10);
  });
  expect(worker).toHaveBeenCalledTimes(1);
  refresh.resolve(Response.json({ accessToken: 'ghu_one', expiresIn: 8 * 3600 }));
  await Promise.all([refreshing, signingOut]);

  expect(worker.mock.calls.map(([url]) => url)).toEqual(['/api/auth/token', '/api/auth/sign-out']);
  expect(await session.accessToken()).toBeUndefined();
});
