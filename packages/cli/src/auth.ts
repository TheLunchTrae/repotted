import { execFile } from 'node:child_process';
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

// A GitHub App's client ID is public, so it ships in the package.
export const repottedGitHubApp: { readonly clientId: string; readonly slug: string } = {
  clientId: 'Iv23liAnsCkUv2UeQoiK',
  slug: 'repotted-app',
};

export const installUrl = `https://github.com/apps/${repottedGitHubApp.slug}/installations/new`;

function clientIdOverride(env: NodeJS.ProcessEnv): string {
  return env['REPOTTED_GITHUB_CLIENT_ID']?.trim() ?? '';
}

export function usesRepottedApp(env: NodeJS.ProcessEnv = process.env): boolean {
  return clientIdOverride(env) === '';
}

export function definedTokenVariables(env: NodeJS.ProcessEnv = process.env): string[] {
  return ['GITHUB_TOKEN', 'GH_TOKEN'].filter((name) => (env[name]?.trim() ?? '') !== '');
}

export class NotSignedInError extends AuthError {
  readonly signInProblems: readonly string[];
  // False when a passing problem, such as an unreadable keychain or a refresh
  // that could not reach GitHub, hides a sign-in that may work on the next try.
  readonly lost: boolean;

  constructor(message: string, signInProblems: readonly string[] = [], lost = true) {
    super(message);
    this.name = 'NotSignedInError';
    this.signInProblems = signInProblems;
    this.lost = lost;
  }
}

function appClientId(env: NodeJS.ProcessEnv): string {
  const override = clientIdOverride(env);
  return override === '' ? repottedGitHubApp.clientId : override;
}

export interface TokenStore {
  read(): Promise<StoredToken | undefined>;
  write(token: StoredToken): Promise<void>;
  /** Resolves to whether there was a token to remove. */
  clear(): Promise<boolean>;
}

async function keychainEntry(): Promise<AsyncEntry> {
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

// The native module loads on first use, so commands that take GITHUB_TOKEN
// still run where it has no build or no keychain.
export const keychain: TokenStore = {
  async read() {
    const text = await (await keychainEntry()).getPassword();
    if (text === null) {
      return undefined;
    }
    const parsed = storedToken.safeParse(parseJson(text));
    return parsed.success ? parsed.data : undefined;
  },
  async write(token) {
    await (await keychainEntry()).setPassword(JSON.stringify(token));
  },
  async clear() {
    return (await keychainEntry()).deletePassword();
  },
};

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function endWithFullStop(text: string): string {
  return /[.!?]$/u.test(text) ? text : `${text}.`;
}

export interface TokenSources {
  readonly env?: NodeJS.ProcessEnv;
  readonly store?: TokenStore;
  readonly environment?: FlowEnvironment;
  readonly readGitHubCliToken?: () => Promise<string>;
}

async function ghCliToken(): Promise<string> {
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

const waitForConcurrentRefreshMilliseconds = 1000;

async function tokenStoredByConcurrentRun(
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
    // The refresh's own failure is the one to report.
    return undefined;
  }
}

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
    let newer = await tokenStoredByConcurrentRun(store, stored, environment);
    if (newer === undefined && refused) {
      await environment.sleep(waitForConcurrentRefreshMilliseconds);
      newer = await tokenStoredByConcurrentRun(store, stored, environment);
    }
    if (newer !== undefined) {
      return { token: newer };
    }
    return {
      problem: endWithFullStop(`The Repotted sign-in could not be refreshed: ${describe(error)}`),
      // A refresh token works once, so one spent on a token the keychain
      // would not keep is as gone as one GitHub refused.
      lost: refreshed || refused,
    };
  }
}

export async function resolveToken(sources: TokenSources = {}): Promise<string> {
  const env = sources.env ?? process.env;
  // The token variables come first, so CI and scripts can override a stored sign-in.
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
    problems.push(endWithFullStop(`Could not read the OS keychain: ${describe(error)}`));
    lost = false;
  }
  try {
    const token = await (sources.readGitHubCliToken ?? ghCliToken)();
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

export class KeychainError extends AuthError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'KeychainError';
  }
}

export interface SignIn {
  readonly code: DeviceCode;
  readonly finished: Promise<void>;
}

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
      endWithFullStop(`The OS keychain is not available, so a sign-in could not be kept: ${describe(error)}`) +
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
        endWithFullStop(`Signed in, but the OS keychain could not store the token: ${describe(error)}`) +
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

// An agent cannot answer a prompt, so with no token a call starts the device
// flow and fails with the code for the user. The flow finishes in the
// background, and a later call finds the stored token.
export function tokenOrSignIn(sources: TokenSources = {}): () => Promise<string> {
  let pendingSignIn: Promise<SignIn> | undefined;
  let failure: string | undefined;
  let keychainFailure: KeychainError | undefined;
  let tokenLookupInFlight: Promise<string> | undefined;
  return async () => {
    try {
      // Concurrent calls share one lookup, so they refresh an expiring token
      // once: GitHub takes each refresh token only once.
      tokenLookupInFlight ??= resolveToken(sources).finally(() => {
        tokenLookupInFlight = undefined;
      });
      return await tokenLookupInFlight;
    } catch (error) {
      if (!(error instanceof NotSignedInError)) {
        throw error;
      }
    }
    if (keychainFailure !== undefined) {
      throw keychainFailure;
    }
    const previous = failure === undefined ? '' : `${endWithFullStop(failure)} `;
    failure = undefined;
    // Concurrent calls share one sign-in, and so one code.
    pendingSignIn ??= startSignIn(sources).then((started) => {
      started.finished.then(
        () => {
          pendingSignIn = undefined;
        },
        (error: unknown) => {
          pendingSignIn = undefined;
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
      signIn = await pendingSignIn;
    } catch (error) {
      // Not remembered: the keychain is checked again on the next call, so a
      // passing problem, such as a dismissed unlock prompt, clears itself.
      pendingSignIn = undefined;
      throw error;
    }
    throw new AuthError(
      `${previous}Not signed in to GitHub. Ask the user to ${enterCode(signIn.code)}, then call this tool again.`,
    );
  };
}
