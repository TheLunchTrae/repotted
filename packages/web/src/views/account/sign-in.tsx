import type { JSX } from 'preact';

import type { Account, SignInCheckFailure } from '../../app/account/account.js';
import { run } from '../layout/run.js';

function clockTime(time: Date): string {
  return time.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function checkFailureMessage(failure: SignInCheckFailure): string {
  switch (failure.kind) {
    case 'sign-in-service-unreachable':
      return "Repotted's sign-in service didn't answer. Check your connection and try again.";
    case 'sign-in-service-failed':
      return `Repotted's sign-in service answered with an error (${failure.status}). Try again; if it keeps happening, the service needs a fix.`;
    case 'sign-in-service-answer-unreadable':
      return `Repotted's sign-in service sent an answer Repotted couldn't read (${failure.status}). Try again; if it keeps happening, the service needs a fix.`;
    case 'github-sign-in-renewal-unavailable':
      return "GitHub couldn't renew your sign-in just now. Try again in a minute.";
    case 'github-rate-limited':
      return failure.retryAt === undefined
        ? "GitHub's rate limit for your account is used up. Try again in a few minutes."
        : `GitHub's rate limit for your account is used up until ${clockTime(failure.retryAt)}. Try again then.`;
    case 'github-unavailable':
      return `GitHub is having trouble right now (it answered ${failure.status}). Try again in a few minutes.`;
    case 'github-unreachable':
      return "Repotted can't reach GitHub. Check your connection, and that nothing in this browser blocks api.github.com.";
    case 'github-account-answer-unreadable':
      return "GitHub's answer about your account couldn't be read. Try again.";
    case 'unexpected':
      return `Checking your sign-in failed: ${failure.detail}`;
  }
}

export function SignIn({ account }: { readonly account: Account }): JSX.Element {
  const state = account.state.value;
  return (
    <main class="sign-in">
      <div class="sign-in-card">
        <p class="wordmark">Repotted</p>
        <h1>Set up every repository the same way</h1>
        <p class="muted">
          Write down a repository's settings, rulesets, environments, and labels once, as a profile. Compare any
          repository with it, review what differs, and apply the changes.
        </p>
        {state.status === 'checking' && (
          <p class="muted" role="status">
            Checking your sign-in…
          </p>
        )}
        {state.status === 'check-failed' && (
          <>
            <p class="notice notice-problem" role="alert">
              {checkFailureMessage(state.failure)}
            </p>
            <button
              class="button"
              type="button"
              onClick={() => {
                run(account.checkAgain());
              }}
            >
              Try again
            </button>
          </>
        )}
        {state.status === 'signed-out' && (
          <>
            {state.message !== undefined && (
              <p class="notice" role="status">
                {state.message}
              </p>
            )}
            <a class="button button-primary" href="/api/auth/sign-in">
              Sign in with GitHub
            </a>
            <p class="muted small">
              Repotted signs in with its GitHub App and can reach only the repositories you install the App on.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
