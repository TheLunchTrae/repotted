import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import worker from '../src/worker.js';

const origin = 'https://repotted.dev';
const env = {
  REPOTTED_CLIENT_ID: 'Iv1.client',
  REPOTTED_CLIENT_SECRET: 'client-secret',
};

const refreshKept = '__Host-repotted-refresh=ghr_refresh; Path=/; Max-Age=15811200; Secure; HttpOnly; SameSite=Strict';

const tokens = {
  access_token: 'ghu_access',
  expires_in: 28_800,
  refresh_token: 'ghr_refresh',
  refresh_token_expires_in: 15_811_200,
  token_type: 'bearer',
};

// GitHub's token endpoint, stubbed afresh for each test.
const github = vi.fn<typeof fetch>();

beforeEach(() => {
  github.mockReset();
  vi.stubGlobal('fetch', github);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function call(path: string, init: RequestInit = {}): Promise<Response> {
  return worker.fetch(new Request(`${origin}${path}`, init), env);
}

function cookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

/** The form GitHub's token endpoint received on its only call. */
function sentGrant(): URLSearchParams {
  expect(github).toHaveBeenCalledTimes(1);
  const [url, init] = github.mock.calls[0] ?? [];
  expect(url).toBe('https://github.com/login/oauth/access_token');
  const body = init?.body;
  expect(body).toBeInstanceOf(URLSearchParams);
  return new URLSearchParams(body instanceof URLSearchParams ? body : undefined);
}

async function startedSignIn(): Promise<{
  state: string;
  verifier: string;
  cookie: string;
}> {
  const response = await call('/api/auth/sign-in');
  const [cookie = ''] = cookies(response);
  const [state = '', verifier = ''] = (cookie.split(';')[0] ?? '').split('=')[1]?.split('.') ?? [];
  return { state, verifier, cookie };
}

describe('sign-in', () => {
  test('sends the browser to GitHub with a state and an S256 challenge of the kept verifier', async () => {
    const response = await call('/api/auth/sign-in');

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('Location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe('https://github.com/login/oauth/authorize');
    expect(location.searchParams.get('client_id')).toBe(env.REPOTTED_CLIENT_ID);
    expect(location.searchParams.get('redirect_uri')).toBe(`${origin}/api/auth/callback`);
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');

    const [cookie = ''] = cookies(response);
    const kept =
      /^__Host-repotted-sign-in=([\w-]+)\.([\w-]+); Path=\/; Max-Age=600; Secure; HttpOnly; SameSite=Lax$/u.exec(
        cookie,
      );
    expect(kept).not.toBeNull();
    const [, state = '', verifier = ''] = kept ?? [];
    expect(location.searchParams.get('state')).toBe(state);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const challenge = btoa(String.fromCharCode(...digest))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/u, '');
    expect(location.searchParams.get('code_challenge')).toBe(challenge);
  });

  test('starts each sign-in with its own state and verifier', async () => {
    const first = await startedSignIn();
    const second = await startedSignIn();

    expect(second.state).not.toBe(first.state);
    expect(second.verifier).not.toBe(first.verifier);
  });
});

describe('callback', () => {
  test('trades the code with the verifier and secret, keeps both tokens, and spends the sign-in', async () => {
    const { state, verifier, cookie } = await startedSignIn();
    github.mockResolvedValue(Response.json(tokens));
    vi.useFakeTimers({ toFake: ['Date'], now: 1_000_000 });

    const response = await call(`/api/auth/callback?code=the-code&state=${state}`, {
      headers: { Cookie: cookie.split(';')[0] ?? '' },
    });
    vi.useRealTimers();

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/');
    expect(Object.fromEntries(sentGrant())).toEqual({
      client_id: env.REPOTTED_CLIENT_ID,
      client_secret: env.REPOTTED_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: `${origin}/api/auth/callback`,
      code_verifier: verifier,
    });
    expect(cookies(response)).toEqual([
      '__Host-repotted-sign-in=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax',
      refreshKept,
      '__Host-repotted-access=29800000.ghu_access; Path=/; Max-Age=28800; Secure; HttpOnly; SameSite=Strict',
    ]);
  });

  test.each([
    ['a state that differs from the started one', 'code=the-code&state=other', true],
    ['no started sign-in', 'code=the-code&state=STATE', false],
    ['no code', 'state=STATE', true],
  ])('refuses a callback with %s without calling GitHub', async (_name, query, withCookie) => {
    const { state, cookie } = await startedSignIn();
    const response = await call(`/api/auth/callback?${query.replace('STATE', state)}`, {
      headers: withCookie ? { Cookie: cookie.split(';')[0] ?? '' } : {},
    });

    expect(response.headers.get('Location')).toBe('/?sign-in=expired');
    expect(github).not.toHaveBeenCalled();
    expect(cookies(response)).toEqual(['__Host-repotted-sign-in=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax']);
  });

  test('reports a sign-in cancelled on GitHub', async () => {
    const response = await call('/api/auth/callback?error=access_denied&state=x');

    expect(response.headers.get('Location')).toBe('/?sign-in=denied');
    expect(github).not.toHaveBeenCalled();
  });

  test('reports any other error from GitHub as a failed sign-in, not an expired one', async () => {
    const { state, cookie } = await startedSignIn();
    const response = await call(`/api/auth/callback?error=redirect_uri_mismatch&state=${state}`, {
      headers: { Cookie: cookie.split(';')[0] ?? '' },
    });

    expect(response.headers.get('Location')).toBe('/?sign-in=failed');
    expect(github).not.toHaveBeenCalled();
  });

  test.each([
    ['refuses the code', () => Promise.resolve(Response.json({ error: 'bad_verification_code' }))],
    ['issues a token that never expires', () => Promise.resolve(Response.json({ access_token: 'ghu_x' }))],
    ['is out of reach', () => Promise.reject(new TypeError('network'))],
  ])('fails the sign-in and keeps no token when GitHub %s', async (_name, answer) => {
    const { state, cookie } = await startedSignIn();
    github.mockImplementation(answer);

    const response = await call(`/api/auth/callback?code=the-code&state=${state}`, {
      headers: { Cookie: cookie.split(';')[0] ?? '' },
    });

    expect(response.headers.get('Location')).toBe('/?sign-in=failed');
    expect(cookies(response)).toEqual(['__Host-repotted-sign-in=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax']);
  });
});

describe('token', () => {
  const now = 1_000_000;
  const hour = 60 * 60 * 1000;
  const fromSite = {
    Origin: origin,
    Cookie: 'other=1; __Host-repotted-refresh=ghr_old',
  };
  const withAccess = (expiresAt: number): Record<string, string> => ({
    Origin: origin,
    Cookie: `__Host-repotted-refresh=ghr_old; __Host-repotted-access=${expiresAt}.ghu_kept`,
  });
  const askFor = (headers: Record<string, string>, body?: string): Promise<Response> =>
    call('/api/auth/token', {
      method: 'POST',
      headers,
      ...(body === undefined ? {} : { body }),
    });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('refreshes, returns the access token with its time left, and keeps both new tokens', async () => {
    github.mockResolvedValue(Response.json(tokens));

    const response = await askFor(fromSite);

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      accessToken: 'ghu_access',
      expiresIn: 28_800,
    });
    expect(Object.fromEntries(sentGrant())).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'ghr_old',
      client_secret: env.REPOTTED_CLIENT_SECRET,
    });
    expect(cookies(response)).toEqual([
      refreshKept,
      `__Host-repotted-access=${now + 28_800_000}.ghu_access; Path=/; Max-Age=28800; Secure; HttpOnly; SameSite=Strict`,
    ]);
  });

  test('hands out the kept access token while it has over five minutes left, without refreshing', async () => {
    const response = await askFor(withAccess(now + hour));

    expect(await response.json()).toEqual({
      accessToken: 'ghu_kept',
      expiresIn: 3600,
    });
    expect(github).not.toHaveBeenCalled();
    expect(cookies(response)).toEqual([]);
  });

  test('refreshes when the kept access token has five minutes or less left', async () => {
    github.mockResolvedValue(Response.json(tokens));

    const response = await askFor(withAccess(now + 5 * 60 * 1000));

    expect(await response.json()).toEqual({
      accessToken: 'ghu_access',
      expiresIn: 28_800,
    });
    expect(github).toHaveBeenCalledTimes(1);
  });

  test('refreshes when the page names the kept access token as refused', async () => {
    github.mockResolvedValue(Response.json(tokens));

    const response = await askFor(withAccess(now + hour), JSON.stringify({ replace: 'ghu_kept' }));

    expect(await response.json()).toEqual({
      accessToken: 'ghu_access',
      expiresIn: 28_800,
    });
    expect(github).toHaveBeenCalledTimes(1);
  });

  test('hands out the kept access token when the page names an older one, since another tab replaced it', async () => {
    const response = await askFor(withAccess(now + hour), JSON.stringify({ replace: 'ghu_older' }));

    expect(await response.json()).toEqual({
      accessToken: 'ghu_kept',
      expiresIn: 3600,
    });
    expect(github).not.toHaveBeenCalled();
  });

  test.each([
    ['is not JSON', 'replace'],
    ['names no string', '{"replace":1}'],
  ])('refuses a body that %s', async (_name, body) => {
    const response = await askFor(fromSite, body);

    expect(response.status).toBe(400);
    expect(github).not.toHaveBeenCalled();
  });

  test('answers signed out, and leaves the cookies, when GitHub refuses the refresh token', async () => {
    github.mockResolvedValue(Response.json({ error: 'bad_refresh_token' }));

    const response = await askFor(fromSite);

    expect(response.status).toBe(401);
    expect(cookies(response)).toEqual([]);
  });

  test.each([
    ['fails on its side', () => Promise.resolve(new Response('oops', { status: 503 }))],
    ['is too slow', () => Promise.reject(new DOMException('timed out', 'TimeoutError'))],
  ])('answers unavailable, and leaves the cookies, when GitHub %s', async (_name, answer) => {
    github.mockImplementation(answer);

    const response = await askFor(fromSite);

    expect(response.status).toBe(502);
    expect(cookies(response)).toEqual([]);
  });

  test('gives up on GitHub after ten seconds', async () => {
    github.mockResolvedValue(Response.json(tokens));

    await askFor(fromSite);

    const signal = github.mock.calls[0]?.[1]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  test('answers signed out without a refresh cookie', async () => {
    const response = await askFor({ Origin: origin });

    expect(response.status).toBe(401);
    expect(github).not.toHaveBeenCalled();
  });

  test.each([
    ['another site', { Origin: 'https://evil.example', Cookie: fromSite.Cookie }],
    ['no origin', { Cookie: fromSite.Cookie }],
  ])('refuses a request from %s', async (_name, headers) => {
    const response = await askFor(headers);

    expect(response.status).toBe(403);
    expect(github).not.toHaveBeenCalled();
  });
});

describe('sign-out', () => {
  test('clears both token cookies', async () => {
    const response = await call('/api/auth/sign-out', {
      method: 'POST',
      headers: { Origin: origin },
    });

    expect(response.status).toBe(204);
    expect(cookies(response)).toEqual([
      '__Host-repotted-refresh=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict',
      '__Host-repotted-access=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict',
    ]);
  });

  test('refuses a request from another site', async () => {
    const response = await call('/api/auth/sign-out', {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
    });

    expect(response.status).toBe(403);
    expect(cookies(response)).toEqual([]);
  });
});

describe('routing', () => {
  test('answers 404 for an unknown API path and 405 for a wrong method', async () => {
    expect((await call('/api/nothing')).status).toBe(404);
    const wrong = await call('/api/auth/token');
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('Allow')).toBe('POST');
  });
});
