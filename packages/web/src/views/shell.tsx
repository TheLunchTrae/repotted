import type { ComponentChildren, JSX, RefObject } from 'preact';
import { useEffect, useRef } from 'preact/hooks';

import type { Account, User } from '../app/account.js';
import { installUrl } from '../app/github-app.js';
import { run } from './run.js';

/** Closes an open `details` menu when the user clicks outside it or presses Escape, as a menu does. */
export function useDismiss(): RefObject<HTMLDetailsElement | null> {
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: Event): void => {
      const element = menu.current;
      if (element?.open !== true) {
        return;
      }
      // Escape is the menu's only while the keyboard is in it; elsewhere it belongs to the field in use.
      const inside = event.composedPath().includes(element);
      if (event instanceof KeyboardEvent ? event.key === 'Escape' && inside : !inside) {
        element.open = false;
        if (event instanceof KeyboardEvent) {
          element.querySelector('summary')?.focus();
        }
      }
    };
    document.addEventListener('click', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', close);
    };
  }, []);
  return menu;
}

function AccountMenu({ account, user }: { readonly account: Account; readonly user: User }): JSX.Element {
  const menu = useDismiss();
  return (
    <details class="menu account-menu" ref={menu}>
      <summary aria-label={`Account: ${user.login}`}>
        <img
          src={`https://avatars.githubusercontent.com/${encodeURIComponent(user.login)}?size=64`}
          alt=""
          width="28"
          height="28"
        />
        <span>{user.login}</span>
      </summary>
      <div class="menu-panel menu-panel-end">
        <p class="menu-heading">
          {user.name !== null && <strong>{user.name}</strong>}
          <span class="muted">Signed in with the Repotted App</span>
        </p>
        <a class="menu-item" href={installUrl} target="_blank" rel="noreferrer">
          Add repositories
        </a>
        <button
          class="menu-item"
          type="button"
          disabled={account.signingOut.value}
          onClick={() => {
            run(account.signOut());
          }}
        >
          Sign out
        </button>
        {account.signOutError.value !== undefined && (
          <p class="menu-note" role="alert">
            {account.signOutError.value}
          </p>
        )}
      </div>
    </details>
  );
}

interface ShellProps {
  readonly account: Account;
  readonly user: User;
  readonly children: ComponentChildren;
}

/** The frame every signed-in page sits in: the app's name, its pages, and the account. */
export function Shell({ account, user, children }: ShellProps): JSX.Element {
  return (
    <div class="shell">
      <header class="shell-bar">
        <a class="wordmark" href="/">
          Repotted
        </a>
        <nav aria-label="Pages">
          <a class="nav-link" href="/" aria-current="page">
            Repositories
          </a>
        </nav>
        <AccountMenu account={account} user={user} />
      </header>
      <main class="shell-main">{children}</main>
    </div>
  );
}
