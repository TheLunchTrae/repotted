import { expect, test, vi } from 'vitest';

import { answered, FakeGitHub } from '../../core/tests/fake-github.js';
import { Account, signInFailure } from '../src/app/account.js';
import { type Session, SessionUnavailableError } from '../src/session.js';

function session(signOut: () => Promise<void> = () => Promise.resolve()): Session {
  // The account uses only the session's sign-out; requests go through the GitHub client.
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
  expect(account.state.value).toEqual({ status: 'unreachable' });

  await account.load();
  expect(account.state.value).toEqual(signedIn);
});

test('a sign-out that fails stays signed in and says so, and the next try clears it', async () => {
  const signOut = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new SessionUnavailableError('offline'))
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

  account.refused();

  expect(account.state.value).toEqual({
    status: 'signed-out',
    message: 'GitHub no longer accepts this sign-in. Sign in again.',
  });
});

test('a refusal that arrives after a sign-out leaves what the sign-out said', async () => {
  const account = new Account(session(), new FakeGitHub());
  await account.load();
  await account.signOut();

  account.refused();

  expect(account.state.value).toEqual({ status: 'signed-out', message: 'Signed out.' });
});
