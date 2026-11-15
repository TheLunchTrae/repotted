import type { ComponentChildren, JSX } from 'preact';

import type { Router } from '../../app/navigation/router.js';

interface LinkProps {
  readonly router: Router;
  readonly to: string;
  readonly class?: string;
  readonly marksCurrentPage?: boolean;
  readonly children: ComponentChildren;
}

export function Link({ router, to, class: className, marksCurrentPage, children }: LinkProps): JSX.Element {
  const path = router.path.value;
  const current = marksCurrentPage === true && (to === '/' ? path === '/' : path === to || path.startsWith(`${to}/`));
  return (
    <a
      class={className}
      href={to}
      aria-current={current ? 'page' : undefined}
      onClick={(event) => {
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
