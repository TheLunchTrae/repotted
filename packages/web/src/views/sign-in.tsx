import type { JSX } from 'preact';

import type { Account } from '../app/account.js';
import { run } from './run.js';

/** The page a browser that isn't signed in gets, whatever the address. */
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
        {state.status === 'unreachable' && (
          <>
            <p class="notice notice-problem" role="alert">
              Repotted can't reach GitHub right now.
            </p>
            <button
              class="button"
              type="button"
              onClick={() => {
                run(account.load());
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
