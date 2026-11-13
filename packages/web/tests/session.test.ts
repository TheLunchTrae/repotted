import { afterEach, expect, test, vi } from 'vitest';

import { Session, SessionUnavailableError } from '../src/session.js';

const hour = 60 * 60 * 1000;

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
  worker.mockImplementation(() =>
    Promise.resolve(Response.json({ accessToken: 'ghu_one', expiresAt: Date.now() + 8 * hour })),
  );

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
    .mockResolvedValueOnce(Response.json({ accessToken: 'ghu_old', expiresAt: Date.now() + 4 * 60 * 1000 }))
    .mockResolvedValueOnce(Response.json({ accessToken: 'ghu_new', expiresAt: Date.now() + 8 * hour }));

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
  refresh.resolve(Response.json({ accessToken: 'ghu_one', expiresAt: Date.now() + 8 * hour }));
  await Promise.all([refreshing, signingOut]);

  expect(worker.mock.calls.map(([url]) => url)).toEqual(['/api/auth/token', '/api/auth/sign-out']);
  expect(await session.accessToken()).toBeUndefined();
});
