import { signal } from '@preact/signals';
import { currentUser, type GitHub, GitHubError } from '@repotted/core';

import * as z from 'zod/mini';

import {
  GitHubApiUnreachableError,
  type Session,
  SessionUnavailableError,
  type SessionUnavailableReason,
} from './session.js';

export interface User {
  readonly login: string;
  readonly name: string | null;
}

export type AccountState =
  | { readonly status: 'checking' }
  | { readonly status: 'signed-out'; readonly message: string | undefined }
  | { readonly status: 'check-failed'; readonly failure: SignInCheckFailure }
  | { readonly status: 'signed-in'; readonly user: User };

export type SignInCheckFailure =
  | SessionUnavailableReason
  | { readonly kind: 'github-unreachable' }
  | { readonly kind: 'github-rate-limited'; readonly retryAt: Date | undefined }
  | { readonly kind: 'github-unavailable'; readonly status: number }
  | { readonly kind: 'github-account-answer-unreadable' }
  | { readonly kind: 'unexpected'; readonly detail: string };

const maximumCauseDepth = 10;

function findInCauseChain<Found>(
  error: unknown,
  matches: (candidate: unknown) => candidate is Found,
): Found | undefined {
  let candidate = error;
  for (let depth = 0; depth < maximumCauseDepth && candidate !== undefined; depth += 1) {
    if (matches(candidate)) {
      return candidate;
    }
    candidate = candidate instanceof Error ? candidate.cause : undefined;
  }
  return undefined;
}

const isSessionUnavailableError = (candidate: unknown): candidate is SessionUnavailableError =>
  candidate instanceof SessionUnavailableError;

const isGitHubApiUnreachableError = (candidate: unknown): candidate is GitHubApiUnreachableError =>
  candidate instanceof GitHubApiUnreachableError;

export function signInCheckFailure(error: unknown): SignInCheckFailure {
  const sessionUnavailable = findInCauseChain(error, isSessionUnavailableError);
  if (sessionUnavailable !== undefined) {
    return sessionUnavailable.reason;
  }
  if (findInCauseChain(error, isGitHubApiUnreachableError) !== undefined) {
    return { kind: 'github-unreachable' };
  }
  if (error instanceof GitHubError) {
    if (!error.receivedResponse) {
      return { kind: 'unexpected', detail: error.message };
    }
    if (error.rateLimited) {
      return { kind: 'github-rate-limited', retryAt: error.retryAt };
    }
    if (error.status >= 500) {
      return { kind: 'github-unavailable', status: error.status };
    }
    return { kind: 'unexpected', detail: `GitHub answered ${error.status}: ${error.message}` };
  }
  if (error instanceof z.core.$ZodError) {
    return { kind: 'github-account-answer-unreadable' };
  }
  return { kind: 'unexpected', detail: error instanceof Error ? error.message : String(error) };
}

// A Map, since the reason comes from the address and an object would also
// answer names such as "constructor".
const signInFailureMessagesByRedirectReason: ReadonlyMap<string, string> = new Map([
  ['denied', 'The sign-in was cancelled on GitHub.'],
  ['expired', 'That sign-in expired. Sign in again.'],
]);

// The address is anyone's to write, so the page shows only error codes GitHub
// documents for a sign-in and a status, never other words from the address.
const signInErrorCodesGitHubDocuments = new Set([
  'redirect_uri_mismatch',
  'application_suspended',
  'incorrect_client_credentials',
  'bad_verification_code',
  'unverified_user_email',
]);

const cloudflareConnectionFailureStatuses = new Set(['520', '521', '522', '523', '524', '525', '526', '530']);

function failedSignInMessage(query: URLSearchParams): string {
  const oauthError = query.get('github-error');
  if (oauthError !== null && signInErrorCodesGitHubDocuments.has(oauthError)) {
    return `GitHub didn't complete the sign-in (GitHub sent ${oauthError}). Try again.`;
  }
  const status = query.get('github-status');
  if (status === null || !/^\d{3}$/u.test(status)) {
    return "GitHub didn't complete the sign-in. Try again.";
  }
  return cloudflareConnectionFailureStatuses.has(status)
    ? `Cloudflare couldn't connect to GitHub to finish the sign-in (status ${status}). Try again.`
    : `GitHub didn't complete the sign-in (GitHub sent status ${status}). Try again.`;
}

export function signInFailure(query: URLSearchParams): string | undefined {
  const redirectReason = query.get('sign-in');
  return redirectReason === null
    ? undefined
    : (signInFailureMessagesByRedirectReason.get(redirectReason) ?? failedSignInMessage(query));
}

export function isSignedOut(error: unknown): boolean {
  return error instanceof GitHubError && error.status === 401;
}

export class Account {
  readonly state = signal<AccountState>({ status: 'checking' });
  readonly signOutError = signal<string | undefined>(undefined);
  readonly signingOut = signal(false);

  readonly #session: Session;
  readonly #github: GitHub;
  #signedOutMessageOfLastCheck: string | undefined;

  constructor(session: Session, github: GitHub) {
    this.#session = session;
    this.#github = github;
  }

  async load(signedOutMessage?: string): Promise<void> {
    this.#signedOutMessageOfLastCheck = signedOutMessage;
    this.state.value = { status: 'checking' };
    try {
      this.state.value = { status: 'signed-in', user: await currentUser(this.#github) };
    } catch (error) {
      this.state.value = isSignedOut(error)
        ? { status: 'signed-out', message: signedOutMessage }
        : { status: 'check-failed', failure: signInCheckFailure(error) };
    }
  }

  checkAgain(): Promise<void> {
    return this.load(this.#signedOutMessageOfLastCheck);
  }

  gitHubRefusedSignIn(): void {
    if (this.state.value.status === 'signed-in') {
      this.state.value = { status: 'signed-out', message: 'GitHub no longer accepts this sign-in. Sign in again.' };
    }
  }

  async signOut(): Promise<void> {
    if (this.signingOut.value) {
      return;
    }
    this.signingOut.value = true;
    this.signOutError.value = undefined;
    try {
      await this.#session.signOut();
      this.state.value = { status: 'signed-out', message: 'Signed out.' };
    } catch {
      this.signOutError.value = "Signing out didn't finish. Try again.";
    } finally {
      this.signingOut.value = false;
    }
  }
}
