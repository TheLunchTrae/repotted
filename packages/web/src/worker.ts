// The Worker answers /api/* for the web app; wrangler.jsonc sends every other
// path to the static assets. It holds the GitHub App's client secret, which the
// page never sees, and keeps the refresh token in an HttpOnly cookie, so the
// page only ever holds a short-lived access token.

import * as z from 'zod/mini';

interface Env {
  REPOTTED_CLIENT_ID: string;
  REPOTTED_CLIENT_SECRET: string;
}

const authorizeUrl = 'https://github.com/login/oauth/authorize';
const tokenUrl = 'https://github.com/login/oauth/access_token';

// The `__Host-` prefix makes the browser refuse these cookies unless they are
// Secure, set by this origin, and scoped to the whole site, so no subdomain or
// plain-HTTP page can plant or read them.
const signInCookie = '__Host-repotted-sign-in';
const refreshCookie = '__Host-repotted-refresh';
// How long a sign-in started here may take on GitHub before its state expires.
const signInSeconds = 10 * 60;

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

function apiHeaders(extra: Record<string, string> = {}): Headers {
  return new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
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

function refreshCookieFor(tokens: GitHubTokens): string {
  return cookie(refreshCookie, tokens.refresh_token, tokens.refresh_token_expires_in, 'Strict');
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
 * the web app can't use, is `refused`. GitHub out of reach or failing on its
 * side is `unavailable`.
 */
async function requestTokens(env: Env, grant: Record<string, string>): Promise<TokenResult> {
  let response: Response;
  let body: unknown;
  try {
    response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.REPOTTED_CLIENT_ID,
        client_secret: env.REPOTTED_CLIENT_SECRET,
        ...grant,
      }),
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
    client_id: env.REPOTTED_CLIENT_ID,
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

  if (params.get('error') === 'access_denied') {
    return failed('denied');
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
  return redirect('/', [cleared, refreshCookieFor(result.tokens)]);
}

/**
 * Trades the refresh token for a new access token, and keeps the new refresh
 * token GitHub issues with it, since each one works once.
 */
async function token(request: Request, env: Env): Promise<Response> {
  if (!fromThisSite(request)) {
    return json(403, { error: 'forbidden' });
  }
  const refreshToken = readCookie(request, refreshCookie);
  if (refreshToken === undefined) {
    return json(401, { error: 'signed_out' });
  }
  const result = await requestTokens(env, { grant_type: 'refresh_token', refresh_token: refreshToken });
  switch (result.kind) {
    case 'tokens':
      return json(
        200,
        { accessToken: result.tokens.access_token, expiresAt: Date.now() + result.tokens.expires_in * 1000 },
        { 'Set-Cookie': refreshCookieFor(result.tokens) },
      );
    // The cookie stays. A refused token is spent or revoked, so keeping it does
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
  const headers = apiHeaders({ 'Set-Cookie': cookie(refreshCookie, '', 0, 'Strict') });
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
