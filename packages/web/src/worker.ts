// The Worker answers /api/* for the web app; wrangler.jsonc sends every other
// path to the static assets. It holds the GitHub App's client secret, which the
// page never sees, and keeps the refresh token and the current access token in
// HttpOnly cookies, so the page only ever holds a short-lived access token.

import * as z from 'zod/mini';

interface Env {
  REPOTTED_APP_CLIENT_ID: string;
  REPOTTED_APP_CLIENT_SECRET: string;
}

const authorizeUrl = 'https://github.com/login/oauth/authorize';
const tokenUrl = 'https://github.com/login/oauth/access_token';

// The `__Host-` prefix makes the browser refuse these cookies unless they are
// Secure, set by this origin, and scoped to the whole site, so no subdomain or
// plain-HTTP page can plant or read them.
const signInCookie = '__Host-repotted-sign-in';
const refreshCookie = '__Host-repotted-refresh';
const accessCookie = '__Host-repotted-access';
// How long a sign-in started here may take on GitHub before its state expires.
const signInSeconds = 10 * 60;
// An access token this close to expiry is replaced rather than handed out, the
// same margin the page refreshes at.
const refreshMarginMs = 5 * 60 * 1000;
// How long the Worker waits on GitHub's token endpoint; the page waits longer.
const gitHubTimeoutMs = 10_000;

/** Why a sign-in came back without one, as the page reads it from `?sign-in=`. */
type SignInFailure = 'denied' | 'expired' | 'failed';

// A token without an expiry comes without a refresh token: the App's "Expire
// user authorization tokens" setting is off, and the web app can't keep a
// sign-in, so such an answer doesn't match.
const tokenResponse = z.object({
  access_token: z.string().check(z.minLength(1)),
  expires_in: z.number(),
  refresh_token: z.string().check(z.minLength(1)),
  refresh_token_expires_in: z.number(),
});

type GitHubTokens = z.infer<typeof tokenResponse>;

type TokenResult = { kind: 'tokens'; tokens: GitHubTokens } | { kind: 'refused' } | { kind: 'unavailable' };

/** The access token the browser's tabs share, as its cookie keeps it. */
interface AccessToken {
  token: string;
  expiresAt: number;
}

// The page names the access token GitHub just refused, so the Worker replaces
// it instead of handing it back.
const tokenRequest = z.object({ replace: z.optional(z.string()) });

function apiHeaders(extra: Record<string, string> = {}): Headers {
  return new Headers({
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  });
}

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: apiHeaders({ 'Content-Type': 'application/json', ...extra }),
  });
}

function redirect(location: string, cookies: string[]): Response {
  const headers = apiHeaders({ Location: location });
  for (const value of cookies) {
    headers.append('Set-Cookie', value);
  }
  return new Response(null, { status: 302, headers });
}

function cookie(name: string, value: string, maxAge: number, sameSite: 'Lax' | 'Strict'): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=${sameSite}`;
}

function issuedAccessToken(tokens: GitHubTokens): AccessToken {
  return {
    token: tokens.access_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  };
}

/** The cookies that keep a new pair of tokens: the refresh token, and the access token with its expiry. */
function tokenCookies(tokens: GitHubTokens, access: AccessToken): string[] {
  return [
    cookie(refreshCookie, tokens.refresh_token, tokens.refresh_token_expires_in, 'Strict'),
    cookie(accessCookie, `${access.expiresAt}.${access.token}`, tokens.expires_in, 'Strict'),
  ];
}

function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator !== -1 && part.slice(0, separator).trim() === name) {
      const value = part.slice(separator + 1).trim();
      return value === '' ? undefined : value;
    }
  }
  return undefined;
}

function readAccessToken(request: Request): AccessToken | undefined {
  const value = readCookie(request, accessCookie) ?? '';
  const separator = value.indexOf('.');
  const expiresAt = Number(value.slice(0, separator));
  const token = value.slice(separator + 1);
  return separator > 0 && Number.isSafeInteger(expiresAt) && token !== '' ? { token, expiresAt } : undefined;
}

/**
 * The page gets the time left rather than the expiry, so its own clock, not
 * the Worker's, decides when the token is near its end.
 */
function accessAnswer(access: AccessToken): Response {
  return json(200, {
    accessToken: access.token,
    expiresIn: Math.floor((access.expiresAt - Date.now()) / 1000),
  });
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

function randomToken(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** GitHub sends the browser back to the origin that started the sign-in, and the App must list that URL. */
function callbackUrl(request: Request): string {
  return new URL('/api/auth/callback', request.url).toString();
}

/**
 * Browsers send `Origin` with every POST, so a request without this site's
 * origin came from another site's page. The Strict cookie already stays off
 * those; this also stops them signing the user out.
 */
function fromThisSite(request: Request): boolean {
  return request.headers.get('Origin') === new URL(request.url).origin;
}

/**
 * Calls GitHub's token endpoint. GitHub answers an OAuth error, such as
 * `bad_refresh_token`, with status 200 and an `error` field; that, or tokens
 * the web app can't use, is `refused`. GitHub out of reach, too slow, or
 * failing on its side is `unavailable`.
 */
async function requestTokens(env: Env, grant: Record<string, string>): Promise<TokenResult> {
  let response: Response;
  let body: unknown;
  try {
    response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: env.REPOTTED_APP_CLIENT_ID,
        client_secret: env.REPOTTED_APP_CLIENT_SECRET,
        ...grant,
      }),
      signal: AbortSignal.timeout(gitHubTimeoutMs),
    });
    if (response.status >= 500) {
      return { kind: 'unavailable' };
    }
    body = await response.json();
  } catch {
    return { kind: 'unavailable' };
  }
  const tokens = tokenResponse.safeParse(body);
  return response.ok && tokens.success ? { kind: 'tokens', tokens: tokens.data } : { kind: 'refused' };
}

/** Sends the browser to GitHub with a fresh state and PKCE challenge, kept in a short-lived cookie. */
async function signIn(request: Request, env: Env): Promise<Response> {
  const state = randomToken();
  const verifier = randomToken();
  const challenge = base64Url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
  );
  const location = new URL(authorizeUrl);
  location.search = new URLSearchParams({
    client_id: env.REPOTTED_APP_CLIENT_ID,
    redirect_uri: callbackUrl(request),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  // Lax, not Strict: the browser comes back from GitHub on a cross-site
  // navigation, and only a Lax cookie goes with it.
  return redirect(location.toString(), [cookie(signInCookie, `${state}.${verifier}`, signInSeconds, 'Lax')]);
}

/** Finishes a sign-in: checks the state, trades the code for tokens, and keeps the refresh token. */
async function callback(request: Request, env: Env): Promise<Response> {
  const params = new URL(request.url).searchParams;
  // The started sign-in is spent whatever happens next.
  const cleared = cookie(signInCookie, '', 0, 'Lax');
  const failed = (reason: SignInFailure): Response => redirect(`/?sign-in=${reason}`, [cleared]);

  // GitHub reports other errors, such as a callback URL the App doesn't list,
  // the same way; signing in again won't fix those, so they aren't "expired".
  const error = params.get('error');
  if (error !== null) {
    return failed(error === 'access_denied' ? 'denied' : 'failed');
  }
  const [state = '', verifier = ''] = (readCookie(request, signInCookie) ?? '').split('.');
  const code = params.get('code') ?? '';
  // A missing or different state is a sign-in that expired, that another tab
  // replaced, or that this browser never started.
  if (state === '' || verifier === '' || code === '' || params.get('state') !== state) {
    return failed('expired');
  }

  const result = await requestTokens(env, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: callbackUrl(request),
    code_verifier: verifier,
  });
  if (result.kind !== 'tokens') {
    return failed('failed');
  }
  return redirect('/', [cleared, ...tokenCookies(result.tokens, issuedAccessToken(result.tokens))]);
}

/** The request's JSON body, `{}` when it has none, or undefined when it isn't JSON. */
async function readJson(request: Request): Promise<unknown> {
  try {
    const text = await request.text();
    return text === '' ? {} : JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Answers the page's request for an access token. Every tab gets the one in the
 * access cookie while it has more than the margin left, since GitHub revokes
 * an access token when its refresh token is used: a tab that refreshed for
 * itself would cut off the others. Otherwise, or when the page names that
 * token as one GitHub refused, it trades the refresh token for new tokens and
 * keeps both, since each refresh token works once.
 */
async function token(request: Request, env: Env): Promise<Response> {
  if (!fromThisSite(request)) {
    return json(403, { error: 'forbidden' });
  }
  const asked = tokenRequest.safeParse(await readJson(request));
  if (!asked.success) {
    return json(400, { error: 'bad_request' });
  }
  const access = readAccessToken(request);
  if (access !== undefined && access.token !== asked.data.replace && access.expiresAt - Date.now() > refreshMarginMs) {
    return accessAnswer(access);
  }
  const refreshToken = readCookie(request, refreshCookie);
  if (refreshToken === undefined) {
    return json(401, { error: 'signed_out' });
  }
  const result = await requestTokens(env, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  switch (result.kind) {
    case 'tokens': {
      const issued = issuedAccessToken(result.tokens);
      const response = accessAnswer(issued);
      for (const value of tokenCookies(result.tokens, issued)) {
        response.headers.append('Set-Cookie', value);
      }
      return response;
    }
    // The cookies stay. A refused token is spent or revoked, so keeping it does
    // no harm, while clearing it could replace a newer token that a request
    // from another tab stored meanwhile.
    case 'refused':
      return json(401, { error: 'signed_out' });
    case 'unavailable':
      return json(502, { error: 'unavailable' });
  }
}

function signOut(request: Request): Promise<Response> {
  if (!fromThisSite(request)) {
    return Promise.resolve(json(403, { error: 'forbidden' }));
  }
  const headers = apiHeaders();
  headers.append('Set-Cookie', cookie(refreshCookie, '', 0, 'Strict'));
  headers.append('Set-Cookie', cookie(accessCookie, '', 0, 'Strict'));
  return Promise.resolve(new Response(null, { status: 204, headers }));
}

type Handler = (request: Request, env: Env) => Promise<Response>;

const routes: Record<string, { method: string; handle: Handler }> = {
  '/api/auth/sign-in': { method: 'GET', handle: signIn },
  '/api/auth/callback': { method: 'GET', handle: callback },
  '/api/auth/token': { method: 'POST', handle: token },
  '/api/auth/sign-out': { method: 'POST', handle: signOut },
};

// eslint-disable-next-line standards/no-default-export -- the Workers runtime calls the module's default export
export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const route = routes[new URL(request.url).pathname];
    if (route === undefined) {
      return Promise.resolve(json(404, { error: 'not_found' }));
    }
    if (request.method !== route.method) {
      return Promise.resolve(json(405, { error: 'method_not_allowed' }, { Allow: route.method }));
    }
    return route.handle(request, env);
  },
};
