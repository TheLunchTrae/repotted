import { setTimeout as delay } from 'node:timers/promises';

import { z } from 'zod';

export class AuthError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AuthError';
  }
}

/** A user token for the Repotted GitHub App, as the keychain holds it. */
export const storedToken = z.object({
  access_token: z.string().min(1),
  /** Epoch milliseconds; absent when the App does not expire user tokens. */
  expires_at: z.number().optional(),
  refresh_token: z.string().min(1).optional(),
  refresh_expires_at: z.number().optional(),
});

export type StoredToken = z.infer<typeof storedToken>;

export interface DeviceCode {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  /** Seconds between polls, as GitHub asks. */
  readonly interval: number;
  /** Epoch milliseconds after which the code no longer works. */
  readonly expiresAt: number;
}

/** The network and clock the device flow uses; tests pass their own. */
export interface FlowEnvironment {
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly now: () => number;
}

export const defaultEnvironment: FlowEnvironment = {
  fetch: (url, init) => fetch(url, init),
  sleep: (milliseconds) => delay(milliseconds),
  now: () => Date.now(),
};

const deviceCodeResponse = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  interval: z.number(),
  expires_in: z.number(),
});

// GitHub answers token requests with 200 and either a token or an error code.
const tokenResponse = z.union([
  z.object({
    access_token: z.string().min(1),
    expires_in: z.number().optional(),
    refresh_token: z.string().min(1).optional(),
    refresh_token_expires_in: z.number().optional(),
  }),
  z.object({ error: z.string(), error_description: z.string().optional() }),
]);

async function post(environment: FlowEnvironment, url: string, fields: Record<string, string>): Promise<unknown> {
  const response = await environment.fetch(url, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
  if (!response.ok) {
    throw new AuthError(`GitHub sign-in failed: ${url} answered ${response.status}`);
  }
  const data: unknown = await response.json();
  return data;
}

function toStored(environment: FlowEnvironment, token: z.infer<typeof tokenResponse>): StoredToken {
  if ('error' in token) {
    throw new AuthError(`GitHub sign-in failed: ${token.error_description ?? token.error}`);
  }
  const now = environment.now();
  return {
    access_token: token.access_token,
    ...(token.expires_in === undefined ? {} : { expires_at: now + token.expires_in * 1000 }),
    ...(token.refresh_token === undefined ? {} : { refresh_token: token.refresh_token }),
    ...(token.refresh_token_expires_in === undefined
      ? {}
      : { refresh_expires_at: now + token.refresh_token_expires_in * 1000 }),
  };
}

/** Asks GitHub for a code that the user enters at the verification page. */
export async function requestDeviceCode(
  clientId: string,
  environment: FlowEnvironment = defaultEnvironment,
): Promise<DeviceCode> {
  const code = deviceCodeResponse.parse(
    await post(environment, 'https://github.com/login/device/code', { client_id: clientId }),
  );
  return {
    deviceCode: code.device_code,
    userCode: code.user_code,
    verificationUri: code.verification_uri,
    interval: code.interval,
    expiresAt: environment.now() + code.expires_in * 1000,
  };
}

/** Polls until the user enters the code, declines, or the code expires. */
export async function waitForToken(
  clientId: string,
  code: DeviceCode,
  environment: FlowEnvironment = defaultEnvironment,
): Promise<StoredToken> {
  let interval = code.interval;
  while (environment.now() < code.expiresAt) {
    await environment.sleep(interval * 1000);
    const token = tokenResponse.parse(
      await post(environment, 'https://github.com/login/oauth/access_token', {
        client_id: clientId,
        device_code: code.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    );
    if ('error' in token && token.error === 'authorization_pending') {
      continue;
    }
    if ('error' in token && token.error === 'slow_down') {
      // GitHub asks for five more seconds between polls each time.
      interval += 5;
      continue;
    }
    return toStored(environment, token);
  }
  throw new AuthError('The sign-in code expired before it was entered. Sign in again.');
}

/** Trades a refresh token for a new token. Device-flow tokens refresh without a client secret. */
export async function refreshToken(
  clientId: string,
  refresh: string,
  environment: FlowEnvironment = defaultEnvironment,
): Promise<StoredToken> {
  return toStored(
    environment,
    tokenResponse.parse(
      await post(environment, 'https://github.com/login/oauth/access_token', {
        client_id: clientId,
        grant_type: 'refresh_token',
        refresh_token: refresh,
      }),
    ),
  );
}
