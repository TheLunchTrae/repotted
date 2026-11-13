// The page's GitHub access token. The Worker keeps the refresh token in a
// cookie the page can't read, and each refresh spends it, so refreshes run one
// at a time across every tab of the site under a Web Lock: a tab that refreshed
// with a spent token would otherwise read as signed out.

import * as z from 'zod/mini';

const lockName = 'repotted-session';
// A token this close to expiry is refreshed before use, so it can't lapse
// partway through a run of requests.
const refreshMarginMs = 5 * 60 * 1000;

const tokenAnswer = z.object({ accessToken: z.string().check(z.minLength(1)), expiresAt: z.number() });

type Token = z.infer<typeof tokenAnswer>;

function isFresh(token: Token | undefined): token is Token {
  return token !== undefined && token.expiresAt - Date.now() > refreshMarginMs;
}

/** Thrown when the Worker or GitHub can't refresh the sign-in right now; the sign-in itself is kept. */
export class SessionUnavailableError extends Error {}

/** This tab's sign-in. The page keeps one for its lifetime. */
export class Session {
  #current: Token | undefined;

  /** The current access token, refreshed when needed, or undefined when the browser isn't signed in. */
  async accessToken(): Promise<string | undefined> {
    if (isFresh(this.#current)) {
      return this.#current.accessToken;
    }
    return navigator.locks.request(lockName, async () => {
      // Another call in this tab may have refreshed while this one waited.
      if (isFresh(this.#current)) {
        return this.#current.accessToken;
      }
      const response = await fetch('/api/auth/token', { method: 'POST' });
      if (response.status === 401) {
        this.#current = undefined;
        return undefined;
      }
      if (!response.ok) {
        throw new SessionUnavailableError(`The sign-in couldn't be refreshed: ${response.status}.`);
      }
      this.#current = tokenAnswer.parse(await response.json());
      return this.#current.accessToken;
    });
  }

  /**
   * Signs this browser out. It holds the lock, so a refresh that another tab
   * started can't store a new refresh token after the cookie is cleared. Other
   * tabs keep their access token until it expires.
   */
  async signOut(): Promise<void> {
    await navigator.locks.request(lockName, async () => {
      const response = await fetch('/api/auth/sign-out', { method: 'POST' });
      if (!response.ok) {
        throw new SessionUnavailableError(`Signing out failed: ${response.status}.`);
      }
      this.#current = undefined;
    });
  }
}
