import { promisify } from 'node:util';

import type { AsyncEntry } from '@napi-rs/keyring';

import {
  AuthError,
  defaultEnvironment,
  type DeviceCode,
  type FlowEnvironment,
  GrantRefusedError,
  refreshToken,
  requestDeviceCode,
  type StoredToken,
  storedToken,
  waitForToken,
} from './device-flow.js';

/**
 * The Repotted GitHub App, registered as "Repotted App". A client ID is
 * public, so it ships in the package; REPOTTED_GITHUB_CLIENT_ID signs in with
 * another App instead. The slug is the App's name as GitHub writes it in URLs.
 */
export const app: { readonly clientId: string; readonly slug: string } = {
  clientId: 'Iv23liAnsCkUv2UeQoiK',
  slug: 'repotted-app',
};

export const installUrl = `https://github.com/apps/${app.slug}/installations/new`;

function clientIdOverride(env: NodeJS.ProcessEnv): string {
  return env['REPOTTED_GITHUB_CLIENT_ID']?.trim() ?? '';
}

/** Whether a sign-in uses the Repotted App, whose install page `installUrl` is. */
export function usesRepottedApp(env: NodeJS.ProcessEnv = process.env): boolean {
  return clientIdOverride(env) === '';
}

/** The token variables that are set, which take precedence over the sign-in. */
export function tokenVariables(env: NodeJS.ProcessEnv = process.env): string[] {
  return ['GITHUB_TOKEN', 'GH_TOKEN'].filter((name) => (env[name]?.trim() ?? '') !== '');
}

/** Thrown when no token source is set up, so the caller can offer the device flow. */
export class NotSignedInError extends AuthError {
  /** Why a sign-in that should exist could not be used, such as an unreadable keychain; empty when there is none. */
  readonly problems: readonly string[];
  /**
   * Whether the sign-in is gone: there is none, or GitHub refused it. False
   * when a passing problem, such as an unreadable keychain or a refresh that
   * could not reach GitHub, hides a sign-in that may work on the next try.
   */
  readonly lost: boolean;

  constructor(message: string, problems: readonly string[] = [], lost = true) {
    super(message);
    this.name = 'NotSignedInError';
    this.problems = problems;
    this.lost = lost;
  }
}

function appClientId(env: NodeJS.ProcessEnv): string {
  const override = clientIdOverride(env);
  return override === '' ? app.clientId : override;
}

/** Where the user token from `repotted login` lives between runs. */
export interface TokenStore {
  read(): Promise<StoredToken | undefined>;
  write(token: StoredToken): Promise<void>;
  /** Returns whether there was a token to remove. */
  clear(): Promise<boolean>;
}

async function entry(): Promise<AsyncEntry> {
  const { AsyncEntry } = await import('@napi-rs/keyring');
  // Without a Secret Service, the library would fall back to the kernel
  // keyring, which forgets the token at reboot and is not shared between
  // sessions. Failing instead sends the user to GITHUB_TOKEN or gh.
  return new AsyncEntry('repotted', 'github.com', { linux: { store: 'secret-service' } });
}

function parseJson(text: string): unknown {
  try {
    const data: unknown = JSON.parse(text);
    return data;
  } catch {
    return undefined;
  }
}

/**
 * The OS keychain: Keychain on macOS, Credential Manager on Windows, and the
 * Secret Service (GNOME Keyring or KWallet) on Linux. The native module loads on first use, so commands
 * that take GITHUB_TOKEN still run where it has no build or no keychain, and
 * so the desktop app's startup snapshot can be built: a snapshot can't hold a
 * native module.
 */
export const keychain: TokenStore = {
  async read() {
    const text = await (await entry()).getPassword();
    if (text === null) {
      return undefined;
    }
    const parsed = storedToken.safeParse(parseJson(text));
    return parsed.success ? parsed.data : undefined;
  },
  async write(token) {
    await (await entry()).setPassword(JSON.stringify(token));
  },
  async clear() {
    return (await entry()).deletePassword();
  },
};

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Ends text with a full stop, so problems read as sentences when joined. */
function sentence(text: string): string {
  return /[.!?]$/u.test(text) ? text : `${text}.`;
}

export interface TokenSources {
  readonly env?: NodeJS.ProcessEnv;
  readonly store?: TokenStore;
  readonly environment?: FlowEnvironment;
  /** Reads the GitHub CLI's token; a failure means no token from it. */
  readonly ghToken?: () => Promise<string>;
}

async function ghCliToken(): Promise<string> {
  // Loaded on use: Node hasn't verified child_process in startup snapshots.
  const { execFile } = await import('node:child_process');
  const { stdout } = await promisify(execFile)('gh', ['auth', 'token', '--hostname', 'github.com'], {
    timeout: 10_000,
  });
  return stdout.trim();
}

// A token this close to expiry is refreshed first, so it cannot lapse mid-apply.
const expiryMargin = 5 * 60 * 1000;

function usable(token: StoredToken, now: number): boolean {
  return token.expires_at === undefined || token.expires_at - now > expiryMargin;
}

// How long a run whose refresh GitHub refused waits for a concurrent run to store its token.
const refusedRefreshWait = 1000;

/**
 * A usable token in the store other than `stored`, as a run that refreshed
 * first leaves there. Undefined when there is none, or the store can't be
 * read now, which leaves the refresh's own failure to report.
 */
async function newerToken(
  store: TokenStore,
  stored: StoredToken,
  environment: FlowEnvironment,
): Promise<string | undefined> {
  try {
    const latest = await store.read();
    return latest !== undefined && latest.access_token !== stored.access_token && usable(latest, environment.now())
      ? latest.access_token
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Turns the stored sign-in into a token that works now, refreshing it when
 * it is about to expire. Without a token, `problem` says why the sign-in no
 * longer works, if there was one, and `lost` whether GitHub refused it rather
 * than a passing failure stopping the refresh.
 */
async function signedInToken(
  store: TokenStore,
  env: NodeJS.ProcessEnv,
  environment: FlowEnvironment,
): Promise<{ token?: string; problem?: string; lost?: boolean }> {
  const stored = await store.read();
  if (stored === undefined) {
    return {};
  }
  const now = environment.now();
  if (usable(stored, now)) {
    return { token: stored.access_token };
  }
  if (
    stored.refresh_token === undefined ||
    (stored.refresh_expires_at !== undefined && stored.refresh_expires_at <= now)
  ) {
    return { problem: 'The Repotted sign-in expired.', lost: true };
  }
  let refreshed = false;
  try {
    const fresh = await refreshToken(appClientId(env), stored.refresh_token, environment);
    refreshed = true;
    await store.write(fresh);
    return { token: fresh.access_token };
  } catch (error) {
    // A refresh token works once. Another run may have refreshed it first and
    // stored the result, so take that before giving up. When GitHub refused
    // this refresh, that run may still be storing its token, so look again
    // after a moment.
    const refused = !refreshed && error instanceof GrantRefusedError;
    let newer = await newerToken(store, stored, environment);
    if (newer === undefined && refused) {
      await environment.sleep(refusedRefreshWait);
      newer = await newerToken(store, stored, environment);
    }
    if (newer !== undefined) {
      return { token: newer };
    }
    return {
      problem: sentence(`The Repotted sign-in could not be refreshed: ${describe(error)}`),
      // A refresh token works once, so one spent on a token the keychain
      // would not keep is as gone as one GitHub refused.
      lost: refreshed || refused,
    };
  }
}

/**
 * Finds a GitHub token, first match wins: GITHUB_TOKEN or GH_TOKEN, so CI and
 * scripts can override; then the `repotted login` token in the OS keychain;
 * then the GitHub CLI's sign-in for github.com, since requests go to
 * api.github.com. Apart from the keychain entry, a token is only ever held in
 * memory.
 */
export async function resolveToken(sources: TokenSources = {}): Promise<string> {
  const env = sources.env ?? process.env;
  for (const name of ['GITHUB_TOKEN', 'GH_TOKEN'] as const) {
    const value = env[name]?.trim();
    if (value !== undefined && value !== '') {
      return value;
    }
  }
  const problems: string[] = [];
  let lost = true;
  try {
    const signedIn = await signedInToken(sources.store ?? keychain, env, sources.environment ?? defaultEnvironment);
    if (signedIn.token !== undefined) {
      return signedIn.token;
    }
    if (signedIn.problem !== undefined) {
      problems.push(signedIn.problem);
      lost = signedIn.lost === true;
    }
  } catch (error) {
    problems.push(sentence(`Could not read the OS keychain: ${describe(error)}`));
    lost = false;
  }
  try {
    const token = await (sources.ghToken ?? ghCliToken)();
    if (token !== '') {
      return token;
    }
  } catch {
    // No GitHub CLI, or it is not signed in: nothing more to try.
  }
  throw new NotSignedInError(
    [...problems, 'Not signed in to GitHub. Run repotted login, or set GITHUB_TOKEN.'].join(' '),
    problems,
    lost,
  );
}

/** The keychain cannot hold a sign-in, so starting another one would not help. */
export class KeychainError extends AuthError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'KeychainError';
  }
}

/** A device-flow sign-in that waits for the user to enter its code. */
export interface SignIn {
  readonly code: DeviceCode;
  /** Settles once the user enters the code and the token is stored, or the flow fails. */
  readonly finished: Promise<void>;
}

/** Starts the GitHub App device flow; the token goes to the store once the user enters the code. */
export async function startSignIn(sources: Pick<TokenSources, 'env' | 'store' | 'environment'> = {}): Promise<SignIn> {
  const clientId = appClientId(sources.env ?? process.env);
  const environment = sources.environment ?? defaultEnvironment;
  const store = sources.store ?? keychain;
  // Check the keychain first, so the user does not enter a code for a
  // token that cannot be kept.
  try {
    await store.read();
  } catch (error) {
    throw new KeychainError(
      sentence(`The OS keychain is not available, so a sign-in could not be kept: ${describe(error)}`) +
        ' Set GITHUB_TOKEN, or sign in to the GitHub CLI.',
      { cause: error },
    );
  }
  const code = await requestDeviceCode(clientId, environment);
  const finished = (async () => {
    const token = await waitForToken(clientId, code, environment);
    try {
      await store.write(token);
    } catch (error) {
      throw new KeychainError(
        sentence(`Signed in, but the OS keychain could not store the token: ${describe(error)}`) +
          ' Set GITHUB_TOKEN, or sign in to the GitHub CLI.',
        { cause: error },
      );
    }
  })();
  return { code, finished };
}

export function enterCode(code: DeviceCode): string {
  return `open ${code.verificationUri} and enter the code ${code.userCode}`;
}

/**
 * Token lookup for the MCP server. An agent cannot answer a prompt, so with
 * no token a call starts the device flow and fails with the code for the
 * user. The flow finishes in the background, and a later call finds the
 * stored token.
 */
export function tokenOrSignIn(sources: TokenSources = {}): () => Promise<string> {
  let pending: Promise<SignIn> | undefined;
  let failure: string | undefined;
  let keychainFailure: KeychainError | undefined;
  let resolving: Promise<string> | undefined;
  return async () => {
    try {
      // Concurrent calls share one lookup, so they refresh an expiring token
      // once: GitHub takes each refresh token only once.
      resolving ??= resolveToken(sources).finally(() => {
        resolving = undefined;
      });
      return await resolving;
    } catch (error) {
      if (!(error instanceof NotSignedInError)) {
        throw error;
      }
    }
    if (keychainFailure !== undefined) {
      throw keychainFailure;
    }
    const previous = failure === undefined ? '' : `${sentence(failure)} `;
    failure = undefined;
    // Concurrent calls share one sign-in, and so one code.
    pending ??= startSignIn(sources).then((started) => {
      started.finished.then(
        () => {
          pending = undefined;
        },
        (error: unknown) => {
          pending = undefined;
          // The user entered a code and the token was lost; another code
          // would end the same way.
          if (error instanceof KeychainError) {
            keychainFailure = error;
          } else {
            failure = describe(error);
          }
        },
      );
      return started;
    });
    let signIn: SignIn;
    try {
      signIn = await pending;
    } catch (error) {
      // Not remembered: the keychain is checked again on the next call, so a
      // passing problem, such as a dismissed unlock prompt, clears itself.
      pending = undefined;
      throw error;
    }
    throw new AuthError(
      `${previous}Not signed in to GitHub. Ask the user to ${enterCode(signIn.code)}, then call this tool again.`,
    );
  };
}
