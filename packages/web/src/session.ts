// The page's GitHub access token. The Worker keeps the refresh token and the
// current access token in cookies the page can't read, and hands every tab the
// same access token, since GitHub revokes the old access token on each
// refresh. Requests for a token run one at a time across every tab of the site
// under a Web Lock, so no two of them spend the same refresh token.

import * as z from 'zod/mini';

const lockName = 'repotted-session';
// A token this close to expiry is refreshed before use, so it can't lapse
// partway through a run of requests. The Worker uses the same margin.
const refreshMarginMs = 5 * 60 * 1000;
// Longer than the Worker waits on GitHub, so the Worker's own answer arrives first.
const workerTimeoutMs = 20_000;
const gitHubApi = 'https://api.github.com';

const tokenAnswer = z.object({
  accessToken: z.string().check(z.minLength(1)),
  expiresIn: z.number(),
});

interface Token {
  accessToken: string;
  expiresAt: number;
}

function isFresh(token: Token | undefined): token is Token {
  return token !== undefined && token.expiresAt - Date.now() > refreshMarginMs;
}

/** Thrown when the Worker or GitHub can't refresh the sign-in right now; the sign-in itself is kept. */
export class SessionUnavailableError extends Error {}

/** This tab's sign-in. The page keeps one for its lifetime. */
export class Session {
  #current: Token | undefined;

  /** The current access token, refreshed when needed, or undefined when the browser isn't signed in. */
  accessToken(): Promise<string | undefined> {
    return this.#token(undefined);
  }

  /**
   * Calls GitHub's API with the access token, or answers undefined when the
   * browser isn't signed in. When GitHub refuses the token, which happens when
   * a refresh elsewhere replaced it, it asks the Worker for a new one and tries
   * once more; a second refusal comes back as GitHub's answer.
   */
  async fetchGitHub(path: string, init: RequestInit = {}): Promise<Response | undefined> {
    const send = (token: string): Promise<Response> => {
      const headers = new Headers(init.headers);
      headers.set('Accept', 'application/vnd.github+json');
      headers.set('Authorization', `Bearer ${token}`);
      // GitHub lets a browser cache a read for a minute, which would hide a change made elsewhere since.
      return fetch(`${gitHubApi}${path}`, { cache: 'no-store', ...init, headers });
    };
    const token = await this.accessToken();
    if (token === undefined) {
      return undefined;
    }
    const response = await send(token);
    if (response.status !== 401) {
      return response;
    }
    const replacement = await this.#token(token);
    return replacement === undefined ? undefined : send(replacement);
  }

  /**
   * Signs this browser out. It holds the lock, so a refresh that another tab
   * started can't store new tokens after the cookies are cleared. Other tabs
   * keep the access token they hold until it expires.
   */
  async signOut(): Promise<void> {
    await navigator.locks.request(lockName, async () => {
      const response = await this.#post('/api/auth/sign-out', undefined);
      if (!response.ok) {
        throw new SessionUnavailableError(`Signing out failed: ${response.status}.`);
      }
      this.#current = undefined;
    });
  }

  /** The access token, asking the Worker for one when this tab's is near expiry or is the one to replace. */
  async #token(replace: string | undefined): Promise<string | undefined> {
    const usable = (): boolean => isFresh(this.#current) && this.#current.accessToken !== replace;
    if (usable()) {
      return this.#current?.accessToken;
    }
    return navigator.locks.request(lockName, async () => {
      // Another call in this tab may have got a new token while this one waited.
      if (usable()) {
        return this.#current?.accessToken;
      }
      const response = await this.#post('/api/auth/token', replace === undefined ? undefined : { replace });
      if (response.status === 401) {
        this.#current = undefined;
        return undefined;
      }
      if (!response.ok) {
        throw new SessionUnavailableError(`The sign-in couldn't be refreshed: ${response.status}.`);
      }
      const answer = tokenAnswer.safeParse(await response.json().catch(() => undefined));
      if (!answer.success) {
        throw new SessionUnavailableError("The Worker's answer had no access token.");
      }
      this.#current = {
        accessToken: answer.data.accessToken,
        expiresAt: Date.now() + answer.data.expiresIn * 1000,
      };
      return this.#current.accessToken;
    });
  }

  /** Posts to the Worker, reading a network failure or a timeout as the Worker being out of reach. */
  async #post(path: string, body: unknown): Promise<Response> {
    try {
      return await fetch(path, {
        method: 'POST',
        ...(body === undefined
          ? {}
          : {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            }),
        signal: AbortSignal.timeout(workerTimeoutMs),
      });
    } catch (error) {
      throw new SessionUnavailableError("Repotted's server can't be reached.", {
        cause: error,
      });
    }
  }
}
