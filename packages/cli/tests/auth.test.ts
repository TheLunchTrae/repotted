import { describe, expect, test } from 'bun:test';

import { app, resolveToken, startSignIn, type TokenSources, type TokenStore, tokenOrSignIn } from '../src/auth.js';
import type { FlowEnvironment, StoredToken } from '../src/device-flow.js';

const hour = 60 * 60 * 1000;

class BrokenKeychain implements TokenStore {
  read(): Promise<StoredToken | undefined> {
    return Promise.reject(new Error('no Secret Service'));
  }

  write(): Promise<void> {
    return Promise.reject(new Error('no Secret Service'));
  }

  clear(): Promise<boolean> {
    return Promise.reject(new Error('no Secret Service'));
  }
}

class MemoryStore implements TokenStore {
  token: StoredToken | undefined;

  constructor(token?: StoredToken) {
    this.token = token;
  }

  read(): Promise<StoredToken | undefined> {
    return Promise.resolve(this.token);
  }

  write(token: StoredToken): Promise<void> {
    this.token = token;
    return Promise.resolve();
  }

  clear(): Promise<boolean> {
    const had = this.token !== undefined;
    this.token = undefined;
    return Promise.resolve(had);
  }
}

/**
 * GitHub's sign-in endpoints, answering from a script, with a clock that
 * moves only when the flow sleeps.
 */
class FakeGitHubLogin implements FlowEnvironment {
  clock = 1_000_000;
  readonly sleeps: number[] = [];
  readonly requests: { url: string; fields: Record<string, string> }[] = [];
  readonly tokenAnswers: unknown[];

  constructor(tokenAnswers: unknown[]) {
    this.tokenAnswers = tokenAnswers;
  }

  readonly now = (): number => this.clock;

  readonly sleep = (milliseconds: number): Promise<void> => {
    this.sleeps.push(milliseconds);
    this.clock += milliseconds;
    return Promise.resolve();
  };

  readonly fetch = (url: string, init: RequestInit): Promise<Response> => {
    const fields = Object.fromEntries(new URLSearchParams(typeof init.body === 'string' ? init.body : ''));
    this.requests.push({ url, fields });
    const body =
      url === 'https://github.com/login/device/code'
        ? {
            device_code: 'device-1',
            user_code: 'ABCD-1234',
            verification_uri: 'https://github.com/login/device',
            interval: 5,
            expires_in: 900,
          }
        : (this.tokenAnswers.shift() ?? { error: 'authorization_pending' });
    return Promise.resolve(Response.json(body));
  };
}

const issued = {
  access_token: 'ghu_new',
  expires_in: 28_800,
  refresh_token: 'ghr_new',
  refresh_token_expires_in: 15_897_600,
};

function sources(store: TokenStore, environment: FlowEnvironment, extra: Partial<TokenSources> = {}): TokenSources {
  return {
    env: { REPOTTED_GITHUB_CLIENT_ID: 'Iv1.test' },
    store,
    environment,
    ghToken: () => Promise.reject(new Error('gh is not installed')),
    ...extra,
  };
}

function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('resolveToken', () => {
  test('takes GITHUB_TOKEN over the signed-in token, so CI can override', async () => {
    const login = new FakeGitHubLogin([]);
    const store = new MemoryStore({ access_token: 'ghu_stored' });

    expect(await resolveToken(sources(store, login, { env: { GITHUB_TOKEN: 'ghp_env' } }))).toBe('ghp_env');
    expect(await resolveToken(sources(store, login))).toBe('ghu_stored');
  });

  test('refreshes a token that is about to expire and stores the new one', async () => {
    const login = new FakeGitHubLogin([issued]);
    const store = new MemoryStore({
      access_token: 'ghu_old',
      expires_at: login.clock + 60_000,
      refresh_token: 'ghr_old',
      refresh_expires_at: login.clock + hour,
    });

    expect(await resolveToken(sources(store, login))).toBe('ghu_new');
    expect(login.requests[0]?.fields).toEqual({
      client_id: 'Iv1.test',
      grant_type: 'refresh_token',
      refresh_token: 'ghr_old',
    });
    expect(store.token).toEqual({
      access_token: 'ghu_new',
      expires_at: login.clock + 28_800_000,
      refresh_token: 'ghr_new',
      refresh_expires_at: login.clock + 15_897_600_000,
    });
  });

  test('takes the token another run stored when its own refresh is refused', async () => {
    const login = new FakeGitHubLogin([{ error: 'bad_refresh_token' }]);
    const store = new MemoryStore({ access_token: 'ghu_old', expires_at: 0, refresh_token: 'ghr_old' });
    const read = store.read.bind(store);
    let reads = 0;
    // The second read sees what a concurrent run wrote after refreshing first.
    store.read = () => {
      reads += 1;
      return reads === 2 ? Promise.resolve({ access_token: 'ghu_other' }) : read();
    };

    expect(await resolveToken(sources(store, login))).toBe('ghu_other');
  });

  test('says the sign-in expired, after the GitHub CLI has no token either', async () => {
    const login = new FakeGitHubLogin([]);
    const store = new MemoryStore({ access_token: 'ghu_old', expires_at: 0 });

    const error = await rejection(resolveToken(sources(store, login)));
    expect(String(error)).toContain('The Repotted sign-in expired. Not signed in to GitHub. Run repotted login');
    expect(await resolveToken(sources(store, login, { ghToken: () => Promise.resolve('gho_cli') }))).toBe('gho_cli');
  });
});

describe('device flow', () => {
  test('polls at the pace GitHub asks for and stores the token', async () => {
    const login = new FakeGitHubLogin([{ error: 'authorization_pending' }, { error: 'slow_down' }, issued]);
    const store = new MemoryStore();

    const signIn = await startSignIn(sources(store, login));
    expect(signIn.code.userCode).toBe('ABCD-1234');
    await signIn.finished;

    expect(login.sleeps).toEqual([5000, 5000, 10_000]);
    expect(login.requests.at(-1)?.fields).toEqual({
      client_id: 'Iv1.test',
      device_code: 'device-1',
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    expect(store.token?.access_token).toBe('ghu_new');
  });

  test('stops when the code expires before the user enters it', async () => {
    const login = new FakeGitHubLogin([]);
    const store = new MemoryStore();

    const signIn = await startSignIn(sources(store, login));
    expect(String(await rejection(signIn.finished))).toContain('The sign-in code expired');
    expect(store.token).toBeUndefined();
  });

  test("passes on GitHub's reason when it refuses the request", async () => {
    const login = new FakeGitHubLogin([]);
    const refusing: FlowEnvironment = {
      now: login.now,
      sleep: login.sleep,
      fetch: () =>
        Promise.resolve(
          Response.json(
            { error: 'device_flow_disabled', error_description: 'Device Flow must be explicitly enabled' },
            { status: 400 },
          ),
        ),
    };

    expect(String(await rejection(startSignIn(sources(new MemoryStore(), refusing))))).toContain(
      'GitHub sign-in failed: Device Flow must be explicitly enabled',
    );
  });

  test('asks for no code when the keychain could not keep the token', async () => {
    const login = new FakeGitHubLogin([]);
    const token = tokenOrSignIn(sources(new BrokenKeychain(), login));

    const first = String(await rejection(token()));
    expect(first).toContain('The OS keychain is not available');
    expect(String(await rejection(token()))).toBe(first);
    expect(login.requests).toEqual([]);
  });

  test('gives the MCP server the code on first use and the token once the user enters it', async () => {
    const login = new FakeGitHubLogin([issued]);
    const store = new MemoryStore();
    const entered = Promise.withResolvers<undefined>();
    // The poll waits until the user has entered the code.
    const environment: FlowEnvironment = { fetch: login.fetch, now: login.now, sleep: () => entered.promise };
    const token = tokenOrSignIn(sources(store, environment));

    const first = String(await rejection(token()));
    expect(first).toContain('Ask the user to open https://github.com/login/device and enter the code ABCD-1234');
    expect(String(await rejection(token()))).toBe(first);
    expect(login.requests.filter((request) => request.url.endsWith('/device/code'))).toHaveLength(1);

    entered.resolve(undefined);
    await Bun.sleep(0);
    expect(await token()).toBe('ghu_new');
  });

  test('tells the MCP server why a sign-in failed, with a new code', async () => {
    const login = new FakeGitHubLogin([{ error: 'access_denied', error_description: 'The user denied the request' }]);
    const answered = Promise.withResolvers<undefined>();
    // Polls wait until the user has answered, and then move the clock, so the
    // second sign-in's code runs out instead of polling forever.
    const environment: FlowEnvironment = {
      fetch: login.fetch,
      now: login.now,
      sleep: async (milliseconds) => {
        await answered.promise;
        await login.sleep(milliseconds);
      },
    };
    const token = tokenOrSignIn(sources(new MemoryStore(), environment));

    await rejection(token());
    answered.resolve(undefined);
    await Bun.sleep(0);

    const next = String(await rejection(token()));
    expect(next).toContain('GitHub sign-in failed: The user denied the request. Not signed in to GitHub. Ask the user');
    expect(login.requests.filter((request) => request.url.endsWith('/device/code'))).toHaveLength(2);
  });

  test('gives the MCP server the refreshed token once the old one expires', async () => {
    const login = new FakeGitHubLogin([issued]);
    const store = new MemoryStore({
      access_token: 'ghu_old',
      expires_at: login.clock + hour,
      refresh_token: 'ghr_old',
      refresh_expires_at: login.clock + 2 * hour,
    });
    const token = tokenOrSignIn(sources(store, login));

    expect(await token()).toBe('ghu_old');
    login.clock += hour;
    expect(await token()).toBe('ghu_new');
  });
});

describe('release', () => {
  // The publish workflow sets RELEASE_TAG, so a release cannot ship without the App.
  test.if(process.env['RELEASE_TAG'] !== undefined)('ships with the Repotted GitHub App client ID', () => {
    expect(app.clientId).not.toBe('');
  });
});
