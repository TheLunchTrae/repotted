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

export type SessionUnavailableReason =
  | { readonly kind: 'sign-in-service-unreachable' }
  | { readonly kind: 'sign-in-service-failed'; readonly status: number }
  | { readonly kind: 'sign-in-service-answer-unreadable'; readonly status: number }
  | { readonly kind: 'github-sign-in-renewal-unavailable'; readonly gitHubAnswer: string | undefined };

/** Thrown when the Worker or GitHub can't refresh the sign-in right now; the sign-in itself is kept. */
export class SessionUnavailableError extends Error {
  readonly reason: SessionUnavailableReason;

  constructor(reason: SessionUnavailableReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SessionUnavailableError';
    this.reason = reason;
  }
}

/** Thrown when a request to GitHub's API gets no answer at all, such as with no connection or a blocked address. */
export class GitHubApiUnreachableError extends Error {
  constructor(options?: ErrorOptions) {
    super("GitHub's API can't be reached.", options);
    this.name = 'GitHubApiUnreachableError';
  }
}

const workerErrorAnswer = z.object({
  error: z.string(),
  gitHubAnswer: z.optional(z.string().check(z.maxLength(200))),
});

async function tokenRefreshFailure(response: Response): Promise<SessionUnavailableReason> {
  const answer = workerErrorAnswer.safeParse(await response.json().catch(() => undefined));
  return response.status === 502 && answer.success && answer.data.error === 'unavailable'
    ? { kind: 'github-sign-in-renewal-unavailable', gitHubAnswer: answer.data.gitHubAnswer }
    : { kind: 'sign-in-service-failed', status: response.status };
}

export class Session {
  #current: Token | undefined;

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
    const send = async (token: string): Promise<Response> => {
      const headers = new Headers(init.headers);
      headers.set('Accept', 'application/vnd.github+json');
      headers.set('Authorization', `Bearer ${token}`);
      try {
        // GitHub lets a browser cache a read for a minute, which would hide a change made elsewhere since.
        return await fetch(`${gitHubApi}${path}`, { cache: 'no-store', ...init, headers });
      } catch (error) {
        // fetch rejects with a TypeError only when no answer arrived; an abort keeps its own error.
        throw error instanceof TypeError ? new GitHubApiUnreachableError({ cause: error }) : error;
      }
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
      const response = await this.#postToWorker('/api/auth/sign-out', undefined);
      if (!response.ok) {
        throw new SessionUnavailableError(
          { kind: 'sign-in-service-failed', status: response.status },
          `Signing out failed: ${response.status}.`,
        );
      }
      this.#current = undefined;
    });
  }

  async #token(accessTokenToReplace: string | undefined): Promise<string | undefined> {
    const usable = (): boolean => isFresh(this.#current) && this.#current.accessToken !== accessTokenToReplace;
    if (usable()) {
      return this.#current?.accessToken;
    }
    return navigator.locks.request(lockName, async () => {
      // Another call in this tab may have got a new token while this one waited.
      if (usable()) {
        return this.#current?.accessToken;
      }
      const response = await this.#postToWorker(
        '/api/auth/token',
        accessTokenToReplace === undefined ? undefined : { replace: accessTokenToReplace },
      );
      if (response.status === 401) {
        this.#current = undefined;
        return undefined;
      }
      if (!response.ok) {
        throw new SessionUnavailableError(
          await tokenRefreshFailure(response),
          `The sign-in couldn't be refreshed: ${response.status}.`,
        );
      }
      const answer = tokenAnswer.safeParse(await response.json().catch(() => undefined));
      if (!answer.success) {
        throw new SessionUnavailableError(
          { kind: 'sign-in-service-answer-unreadable', status: response.status },
          "The Worker's answer had no access token.",
        );
      }
      this.#current = {
        accessToken: answer.data.accessToken,
        expiresAt: Date.now() + answer.data.expiresIn * 1000,
      };
      return this.#current.accessToken;
    });
  }

  async #postToWorker(path: string, body: unknown): Promise<Response> {
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
      throw new SessionUnavailableError(
        { kind: 'sign-in-service-unreachable' },
        "Repotted's server can't be reached.",
        {
          cause: error,
        },
      );
    }
  }
}
