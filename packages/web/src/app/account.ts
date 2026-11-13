import { signal } from '@preact/signals';
import { currentUser, type GitHub, GitHubError } from '@repotted/core';

import type { Session } from '../session.js';

export interface User {
  readonly login: string;
  readonly name: string | null;
}

export type AccountState =
  | { readonly status: 'checking' }
  | { readonly status: 'signed-out'; readonly message: string | undefined }
  | { readonly status: 'unreachable' }
  | { readonly status: 'signed-in'; readonly user: User };

const failures: Readonly<Record<string, string>> = {
  denied: 'The sign-in was cancelled on GitHub.',
  expired: 'That sign-in expired. Sign in again.',
  failed: "GitHub didn't complete the sign-in. Try again.",
};

/** What to tell the user about a sign-in the Worker reports as failed, by the reason in its redirect. */
export function signInFailure(reason: string | null): string | undefined {
  return reason === null ? undefined : (failures[reason] ?? failures['failed']);
}

/** Whether GitHub refused the sign-in itself, which no retry with it can pass. */
export function isSignedOut(error: unknown): boolean {
  return error instanceof GitHubError && error.status === 401;
}

/** Who is signed in to this tab, and the ways that changes. */
export class Account {
  readonly state = signal<AccountState>({ status: 'checking' });
  /** Why signing out didn't finish, until the next try. */
  readonly signOutError = signal<string | undefined>(undefined);
  readonly signingOut = signal(false);

  readonly #session: Session;
  readonly #github: GitHub;

  constructor(session: Session, github: GitHub) {
    this.#session = session;
    this.#github = github;
  }

  /** Reads who is signed in. `failure` is what to say when no one is, such as why a sign-in just failed. */
  async load(failure?: string): Promise<void> {
    this.state.value = { status: 'checking' };
    try {
      this.state.value = { status: 'signed-in', user: await currentUser(this.#github) };
    } catch (error) {
      this.state.value = isSignedOut(error) ? { status: 'signed-out', message: failure } : { status: 'unreachable' };
    }
  }

  /** GitHub refused the sign-in while the app was in use, so the app returns to the sign-in page. */
  refused(): void {
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
