// Two tabs' sessions against the real Worker, sharing one browser's cookies and
// lock, with a stand-in GitHub that, like the real one, revokes the old access
// token whenever its refresh token is used.

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { Session } from '../src/session.js';
import worker from '../src/worker.js';

const origin = 'https://repotted.dev';
const env = {
  REPOTTED_CLIENT_ID: 'Iv1.client',
  REPOTTED_CLIENT_SECRET: 'client-secret',
};

interface Browser {
  refreshes: () => number;
  /** GitHub refuses the current access token once, as if it had revoked it. */
  revokeAccess: () => void;
}

function setup(): Browser {
  const jar = new Map<string, string>([['__Host-repotted-refresh', 'ghr_0']]);
  const gitHub = { generation: 0, refusedOnce: false };

  const callWorker = async (path: string, init: RequestInit): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set('Origin', origin);
    headers.set('Cookie', [...jar].map(([name, value]) => `${name}=${value}`).join('; '));
    const response = await worker.fetch(new Request(`${origin}${path}`, { ...init, headers }), env);
    for (const set of response.headers.getSetCookie()) {
      const [pair = ''] = set.split(';');
      const [name = '', value = ''] = pair.split('=');
      if (value === '') {
        jar.delete(name);
      } else {
        jar.set(name, value);
      }
    }
    return response;
  };

  const tokenEndpoint = (body: URLSearchParams): Response => {
    if (body.get('refresh_token') !== `ghr_${gitHub.generation}`) {
      return Response.json({ error: 'bad_refresh_token' });
    }
    gitHub.generation += 1;
    return Response.json({
      access_token: `ghu_${gitHub.generation}`,
      expires_in: 28_800,
      refresh_token: `ghr_${gitHub.generation}`,
      refresh_token_expires_in: 15_811_200,
    });
  };

  const api = (headers: Headers): Response => {
    const current = headers.get('Authorization') === `Bearer ghu_${gitHub.generation}`;
    if (!current || gitHub.refusedOnce) {
      gitHub.refusedOnce = false;
      return new Response(null, { status: 401 });
    }
    return Response.json({ login: 'octocat' });
  };

  vi.stubGlobal('fetch', (input: string, init: RequestInit = {}): Promise<Response> => {
    if (input.startsWith('/')) {
      return callWorker(input, init);
    }
    if (input === 'https://github.com/login/oauth/access_token') {
      return Promise.resolve(tokenEndpoint(new URLSearchParams(init.body instanceof URLSearchParams ? init.body : '')));
    }
    return Promise.resolve(api(new Headers(init.headers)));
  });

  const lock = { queue: Promise.resolve() };
  const request = (_name: string, callback: () => Promise<unknown>): Promise<unknown> => {
    const run = lock.queue.then(callback);
    lock.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  vi.stubGlobal('navigator', { locks: { request } });

  return {
    refreshes: () => gitHub.generation,
    revokeAccess: () => {
      gitHub.refusedOnce = true;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: 1_000_000 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('a second tab uses the first tab’s access token instead of revoking it', async () => {
  const browser = setup();
  const first = new Session();
  const second = new Session();

  expect((await first.fetchGitHub('/user'))?.status).toBe(200);
  expect((await second.fetchGitHub('/user'))?.status).toBe(200);
  expect((await first.fetchGitHub('/user'))?.status).toBe(200);
  expect(browser.refreshes()).toBe(1);
});

test('tabs near expiry refresh once between them', async () => {
  const browser = setup();
  const first = new Session();
  const second = new Session();
  await first.fetchGitHub('/user');

  vi.setSystemTime(1_000_000 + 28_800_000 - 4 * 60 * 1000);

  expect((await second.fetchGitHub('/user'))?.status).toBe(200);
  expect((await first.fetchGitHub('/user'))?.status).toBe(200);
  expect(browser.refreshes()).toBe(2);
});

test('a tab whose token GitHub refused picks up the token another tab already replaced it with', async () => {
  const browser = setup();
  const first = new Session();
  const second = new Session();
  await first.fetchGitHub('/user');
  await second.fetchGitHub('/user');

  browser.revokeAccess();
  expect((await first.fetchGitHub('/user'))?.status).toBe(200);
  expect(browser.refreshes()).toBe(2);

  // The second tab still holds the revoked token; the Worker hands it the new one.
  expect((await second.fetchGitHub('/user'))?.status).toBe(200);
  expect(browser.refreshes()).toBe(2);
});

test('after sign-out, no tab gets a token', async () => {
  setup();
  const first = new Session();
  const second = new Session();
  await first.fetchGitHub('/user');

  await first.signOut();

  expect(await first.accessToken()).toBeUndefined();
  expect(await second.accessToken()).toBeUndefined();
});
