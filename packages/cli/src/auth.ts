import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { AsyncEntry } from '@napi-rs/keyring';

import {
  AuthError,
  defaultEnvironment,
  type DeviceCode,
  type FlowEnvironment,
  refreshToken,
  requestDeviceCode,
  type StoredToken,
  storedToken,
  waitForToken,
} from './device-flow.js';

const run = promisify(execFile);

/**
 * The Repotted GitHub App. A client ID is public, so it ships in the package;
 * REPOTTED_GITHUB_CLIENT_ID signs in with another App instead.
 */
export const app: { readonly clientId: string; readonly slug: string } = { clientId: '', slug: 'repotted' };

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
  constructor(message: string) {
    super(message);
    this.name = 'NotSignedInError';
  }
}

function appClientId(env: NodeJS.ProcessEnv): string {
  const override = clientIdOverride(env);
  const clientId = override === '' ? app.clientId : override;
  if (clientId === '') {
    throw new AuthError(
      'This build of Repotted has no GitHub App to sign in with. Set GITHUB_TOKEN, or set REPOTTED_GITHUB_CLIENT_ID to the client ID of your own GitHub App.',
    );
  }
  return clientId;
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
 * that take GITHUB_TOKEN still run where it has no build or no keychain.
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
  const { stdout } = await run('gh', ['auth', 'token', '--hostname', 'github.com'], { timeout: 10_000 });
  return stdout.trim();
}

// A token this close to expiry is refreshed first, so it cannot lapse mid-apply.
const expiryMargin = 5 * 60 * 1000;

function usable(token: StoredToken, now: number): boolean {
  return token.expires_at === undefined || token.expires_at - now > expiryMargin;
}

/**
 * Turns the stored sign-in into a token that works now, refreshing it when
 * it is about to expire. Without a token, `problem` says why the sign-in no
 * longer works, if there was one.
 */
async function signedInToken(
  store: TokenStore,
  env: NodeJS.ProcessEnv,
  environment: FlowEnvironment,
): Promise<{ token?: string; problem?: string }> {
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
    return { problem: 'The Repotted sign-in expired.' };
  }
  try {
    const fresh = await refreshToken(appClientId(env), stored.refresh_token, environment);
    await store.write(fresh);
    return { token: fresh.access_token };
  } catch (error) {
    // A refresh token works once. Another run may have refreshed it first and
    // stored the result, so take that before giving up.
    const latest = await store.read();
    if (latest !== undefined && latest.access_token !== stored.access_token && usable(latest, environment.now())) {
      return { token: latest.access_token };
    }
    return { problem: sentence(`The Repotted sign-in could not be refreshed: ${describe(error)}`) };
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
  try {
    const signedIn = await signedInToken(sources.store ?? keychain, env, sources.environment ?? defaultEnvironment);
    if (signedIn.token !== undefined) {
      return signedIn.token;
    }
    if (signedIn.problem !== undefined) {
      problems.push(signedIn.problem);
    }
  } catch (error) {
    problems.push(sentence(`Could not read the OS keychain: ${describe(error)}`));
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
  return async () => {
    try {
      return await resolveToken(sources);
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
      pending = undefined;
      if (error instanceof KeychainError) {
        keychainFailure = error;
      }
      throw error;
    }
    throw new AuthError(
      `${previous}Not signed in to GitHub. Ask the user to ${enterCode(signIn.code)}, then call this tool again.`,
    );
  };
}
