import type { ComponentChildren, JSX, RefObject } from 'preact';
import { useEffect, useRef } from 'preact/hooks';

import type { Account, User } from '../../app/account/account.js';
import { repottedAppInstallUrl } from '../../app/account/github-app.js';
import type { Router } from '../../app/navigation/router.js';
import { Link } from './link.js';
import { usePhone } from './phone.js';

export function useDismissibleMenu(): RefObject<HTMLDetailsElement | null> {
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

interface AccountMenuProps extends Omit<ShellProps, 'children'> {
  readonly holdsPageLinks: boolean;
}

function AccountMenu({ account, user, router, onSignOut, holdsPageLinks }: AccountMenuProps): JSX.Element {
  const menu = useDismissibleMenu();
  // A phone's button shows only the avatar, so its menu names who's signed in even without a display name.
  const signedIn = user.name ?? (holdsPageLinks ? user.login : null);
  const heldPageLinksBefore = useRef(holdsPageLinks);
  // Crossing the phone width adds or removes the menu's pages, which can take
  // the focused link with them, so an open menu closes and gives focus back to its button.
  useEffect(() => {
    const element = menu.current;
    if (heldPageLinksBefore.current === holdsPageLinks || element === null) {
      return;
    }
    heldPageLinksBefore.current = holdsPageLinks;
    if (element.open) {
      const focusLost = document.activeElement === document.body || element.contains(document.activeElement);
      element.open = false;
      if (focusLost) {
        element.querySelector('summary')?.focus();
      }
    }
  }, [holdsPageLinks, menu]);
  return (
    <details class="menu account-menu" ref={menu}>
      <summary aria-label={holdsPageLinks ? `Menu: ${user.login}` : `Account: ${user.login}`}>
        <img
          src={`https://avatars.githubusercontent.com/${encodeURIComponent(user.login)}?size=64`}
          alt=""
          width="28"
          height="28"
        />
        {holdsPageLinks ? (
          <svg class="menu-icon" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        ) : (
          <span>{user.login}</span>
        )}
      </summary>
      <div
        class="menu-panel menu-panel-end"
        onClick={(event) => {
          // Following a link in the menu closes it; sign-out keeps it open for what it reports.
          if (event.target instanceof HTMLAnchorElement && menu.current !== null) {
            menu.current.open = false;
          }
        }}
      >
        {holdsPageLinks && (
          <nav class="menu-pages" aria-label="Pages">
            <Link class="menu-item" router={router} to="/" marksCurrentPage>
              Repositories
            </Link>
            <Link class="menu-item" router={router} to="/profiles" marksCurrentPage>
              Profiles
            </Link>
            <Link class="menu-item" router={router} to="/settings" marksCurrentPage>
              Settings
            </Link>
          </nav>
        )}
        <p class="menu-heading">
          {signedIn !== null && <strong>{signedIn}</strong>}
          <span class="muted">Signed in with the Repotted App</span>
        </p>
        {!holdsPageLinks && (
          <Link class="menu-item" router={router} to="/settings">
            Settings
          </Link>
        )}
        <a class="menu-item" href={repottedAppInstallUrl} target="_blank" rel="noreferrer">
          Add repositories
        </a>
        <button class="menu-item" type="button" disabled={account.signingOut.value} onClick={onSignOut}>
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
  readonly router: Router;
  readonly onSignOut: () => void;
  readonly children: ComponentChildren;
}

export function Shell({ account, user, router, onSignOut, children }: ShellProps): JSX.Element {
  const onPhone = usePhone();
  return (
    <div class="shell">
      <header class="shell-bar">
        <Link class="wordmark" router={router} to="/">
          Repotted
        </Link>
        {!onPhone && (
          <nav aria-label="Pages">
            <Link class="nav-link" router={router} to="/" marksCurrentPage>
              Repositories
            </Link>
            <Link class="nav-link" router={router} to="/profiles" marksCurrentPage>
              Profiles
            </Link>
            <Link class="nav-link nav-link-end" router={router} to="/settings" marksCurrentPage>
              Settings
            </Link>
          </nav>
        )}
        <AccountMenu account={account} user={user} router={router} onSignOut={onSignOut} holdsPageLinks={onPhone} />
      </header>
      <main class="shell-main">{children}</main>
    </div>
  );
}
