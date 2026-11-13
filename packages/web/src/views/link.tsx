import type { ComponentChildren, JSX } from 'preact';

import type { Router } from '../app/router.js';

interface LinkProps {
  readonly router: Router;
  readonly to: string;
  readonly class?: string;
  /** Marks the link as the current page when the address is `to` or under it. */
  readonly nav?: boolean;
  readonly children: ComponentChildren;
}

/** A link to one of the app's own pages, which changes the page without loading it again. */
export function Link({ router, to, class: className, nav, children }: LinkProps): JSX.Element {
  const path = router.path.value;
  const current = nav === true && (to === '/' ? path === '/' : path === to || path.startsWith(`${to}/`));
  return (
    <a
      class={className}
      href={to}
      aria-current={current ? 'page' : undefined}
      onClick={(event) => {
        // A click that asks for a new tab or window is the browser's.
        if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
          event.preventDefault();
          router.go(to);
        }
      }}
    >
      {children}
    </a>
  );
}
