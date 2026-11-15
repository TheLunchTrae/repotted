import { afterEach, describe, expect, test, vi } from 'vitest';

import { answered, FakeGitHub } from '../../../core/tests/support/fake-github.js';
import { Account, signInFailure } from '../../src/app/account/account.js';
import { Session, SessionUnavailableError } from '../../src/app/account/session.js';
import { sessionGitHub } from '../../src/engine/github.js';

function session(signOut: () => Promise<void> = () => Promise.resolve()): Session {
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- a Session can't be built without a browser's locks and fetch, and Account calls nothing else on it
  return { signOut } as unknown as Session;
}

const signedIn = { status: 'signed-in', user: { login: 'lunch', name: null } };

test('reads who is signed in', async () => {
  const account = new Account(session(), new FakeGitHub());

  await account.load();

  expect(account.state.value).toEqual(signedIn);
});

test('a refused sign-in is signed out, with why the sign-in just failed when the Worker said', async () => {
  const github = new FakeGitHub().fail('GET /user', answered(401, 'Not signed in'));
  const account = new Account(session(), github);

  await account.load(signInFailure('denied'));
  expect(account.state.value).toEqual({ status: 'signed-out', message: 'The sign-in was cancelled on GitHub.' });

  await account.load(signInFailure('something-new'));
  expect(account.state.value).toEqual({
    status: 'signed-out',
    message: "GitHub didn't complete the sign-in. Try again.",
  });

  await account.load(signInFailure(null));
  expect(account.state.value).toEqual({ status: 'signed-out', message: undefined });
});

test('GitHub out of reach is not a sign-out, and a later try can sign in', async () => {
  const github = new FakeGitHub().fail('GET /user', answered(500, 'fetch failed'), 1);
  const account = new Account(session(), github);

  await account.load();
  expect(account.state.value).toEqual({
    status: 'check-failed',
    failure: { kind: 'github-unavailable', status: 500 },
  });

  await account.load();
  expect(account.state.value).toEqual(signedIn);
});

test('a sign-out that fails stays signed in and says so, and the next try clears it', async () => {
  const signOut = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new SessionUnavailableError({ kind: 'sign-in-service-unreachable' }, 'offline'))
    .mockResolvedValueOnce();
  const account = new Account(session(signOut), new FakeGitHub());
  await account.load();

  await account.signOut();
  expect(account.state.value).toEqual(signedIn);
  expect(account.signOutError.value).toBe("Signing out didn't finish. Try again.");

  await account.signOut();
  expect(account.state.value).toEqual({ status: 'signed-out', message: 'Signed out.' });
  expect(account.signOutError.value).toBeUndefined();
  expect(account.signingOut.value).toBe(false);
});

test('a second sign-out pressed while one runs sends no second request', async () => {
  const held = Promise.withResolvers<undefined>();
  const signOut = vi.fn(() => held.promise);
  const account = new Account(session(signOut), new FakeGitHub());
  await account.load();

  const first = account.signOut();
  await account.signOut();
  expect(signOut).toHaveBeenCalledTimes(1);

  held.resolve(undefined);
  await first;
  expect(account.state.value.status).toBe('signed-out');
});

test('a sign-in GitHub stops accepting returns to the sign-in page with why', async () => {
  const account = new Account(session(), new FakeGitHub());
  await account.load();

  account.gitHubRefusedSignIn();

  expect(account.state.value).toEqual({
    status: 'signed-out',
    message: 'GitHub no longer accepts this sign-in. Sign in again.',
  });
});

test('a refusal that arrives after a sign-out leaves what the sign-out said', async () => {
  const account = new Account(session(), new FakeGitHub());
  await account.load();
  await account.signOut();

  account.gitHubRefusedSignIn();

  expect(account.state.value).toEqual({ status: 'signed-out', message: 'Signed out.' });
});

describe('a sign-in check that fails says what failed', () => {
  const tokenAnswer = (): Response => Response.json({ accessToken: 'ghu_one', expiresIn: 8 * 3600 });
  const user = (): Response => Response.json({ login: 'lunch', name: null });
  const rateLimitResetSeconds = 1_900_000_000;

  function answerRequests(worker: () => Promise<Response>, gitHub: () => Promise<Response>): void {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>((input) => {
        const url = input instanceof Request ? input.url : String(input);
        return url.startsWith('https://api.github.com/') ? gitHub() : worker();
      }),
    );
    vi.stubGlobal('navigator', {
      locks: { request: (_name: string, callback: () => Promise<unknown>) => callback() },
    });
  }

  function browserAccount(): Account {
    const browserSession = new Session();
    return new Account(browserSession, sessionGitHub(browserSession));
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test.each([
    [
      "Repotted's Worker is out of reach",
      () => Promise.reject(new TypeError('Failed to fetch')),
      () => Promise.resolve(user()),
      { kind: 'sign-in-service-unreachable' },
    ],
    [
      "the Worker can't reach GitHub's token endpoint",
      () =>
        Promise.resolve(
          Response.json({ error: 'unavailable', gitHubAnswer: 'status 403, text/html, not JSON' }, { status: 502 }),
        ),
      () => Promise.resolve(user()),
      { kind: 'github-sign-in-renewal-unavailable', gitHubAnswer: 'status 403, text/html, not JSON' },
    ],
    [
      'the Worker answers an error',
      () => Promise.resolve(Response.json({ error: 'forbidden' }, { status: 403 })),
      () => Promise.resolve(user()),
      { kind: 'sign-in-service-failed', status: 403 },
    ],
    [
      'the Worker answers a page instead of a token',
      () => Promise.resolve(new Response('<html>')),
      () => Promise.resolve(user()),
      { kind: 'sign-in-service-answer-unreadable', status: 200 },
    ],
    [
      "GitHub's API is out of reach",
      () => Promise.resolve(tokenAnswer()),
      () => Promise.reject(new TypeError('Failed to fetch')),
      { kind: 'github-unreachable' },
    ],
    [
      'GitHub fails on its side',
      () => Promise.resolve(tokenAnswer()),
      () => Promise.resolve(Response.json({ message: 'Service unavailable' }, { status: 503 })),
      { kind: 'github-unavailable', status: 503 },
    ],
    [
      "GitHub's rate limit is used up",
      () => Promise.resolve(tokenAnswer()),
      () =>
        Promise.resolve(
          Response.json(
            { message: 'API rate limit exceeded' },
            {
              status: 403,
              headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(rateLimitResetSeconds) },
            },
          ),
        ),
      { kind: 'github-rate-limited', retryAt: new Date(rateLimitResetSeconds * 1000) },
    ],
    [
      "GitHub's answer about the account isn't what Repotted reads",
      () => Promise.resolve(tokenAnswer()),
      () => Promise.resolve(Response.json({ name: 'no login' })),
      { kind: 'github-account-answer-unreadable' },
    ],
    [
      'the request to GitHub is aborted before an answer',
      () => Promise.resolve(tokenAnswer()),
      () => Promise.reject(new DOMException('The operation was aborted.', 'AbortError')),
      { kind: 'unexpected', detail: 'The operation was aborted.' },
    ],
    [
      'GitHub answers something else',
      () => Promise.resolve(tokenAnswer()),
      () => Promise.resolve(Response.json({ message: 'Not Found' }, { status: 404 })),
      { kind: 'unexpected', detail: 'GitHub answered 404: Not Found' },
    ],
  ])('when %s', async (_name, worker, gitHub, failure) => {
    answerRequests(worker, gitHub);
    const account = browserAccount();

    await account.load();

    expect(account.state.value).toEqual({ status: 'check-failed', failure });
  });

  test('a browser without Web Locks is not read as GitHub out of reach', async () => {
    answerRequests(
      () => Promise.resolve(tokenAnswer()),
      () => Promise.resolve(user()),
    );
    vi.stubGlobal('navigator', {});
    const account = browserAccount();

    await account.load();

    const { state } = account;
    expect(state.value).toMatchObject({ status: 'check-failed', failure: { kind: 'unexpected' } });
  });

  test('Try again keeps why the sign-in had just failed', async () => {
    const worker = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(Response.json({ error: 'unavailable' }, { status: 502 }))
      .mockResolvedValueOnce(Response.json({ error: 'signed_out' }, { status: 401 }));
    answerRequests(worker, () => Promise.resolve(user()));
    const account = browserAccount();

    await account.load(signInFailure('failed'));
    await account.checkAgain();

    expect(account.state.value).toEqual({
      status: 'signed-out',
      message: "GitHub didn't complete the sign-in. Try again.",
    });
  });

  test('Try again signs in once the cause has passed', async () => {
    const worker = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(Response.json({ error: 'unavailable' }, { status: 502 }))
      .mockResolvedValueOnce(tokenAnswer());
    answerRequests(worker, () => Promise.resolve(user()));
    const account = browserAccount();

    await account.load();
    expect(account.state.value.status).toBe('check-failed');

    await account.checkAgain();
    expect(account.state.value).toEqual(signedIn);
  });
});
