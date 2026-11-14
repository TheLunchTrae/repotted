import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import { useDismiss } from './shell.js';

/** The width at and under which the page is laid out for a phone, as in app.css. */
const phone = '(max-width: 760px)';

/** Whether the window is phone-sized now, following it as it changes. */
export function usePhone(): boolean {
  const [matches, setMatches] = useState(() => matchMedia(phone).matches);
  useEffect(() => {
    const query = matchMedia(phone);
    const change = (): void => {
      setMatches(query.matches);
    };
    change();
    query.addEventListener('change', change);
    return () => {
      query.removeEventListener('change', change);
    };
  }, []);
  return matches;
}

interface BarActionsProps {
  /** The page's main action, which stays in sight. */
  readonly main: ComponentChildren;
  /** Everything else, which a phone keeps under More. */
  readonly others: ComponentChildren;
}

/** An action bar's buttons: in a row, or on a phone the main one beside a More menu holding the rest, kept together. */
export function BarActions({ main, others }: BarActionsProps): JSX.Element {
  const onPhone = usePhone();
  const menu = useDismiss();
  if (!onPhone) {
    return (
      <>
        {others}
        {main}
      </>
    );
  }
  return (
    <div class="bar-actions">
      <details class="menu bar-more" ref={menu}>
        <summary class="button">More</summary>
        <div
          class="menu-panel menu-panel-end menu-panel-up"
          onClick={(event) => {
            // A pressed action closes the menu, handing focus back to More as the button it was on hides;
            // a press beside one, or on a disabled one, leaves it open.
            const details = menu.current;
            if (
              event.target instanceof Element &&
              event.target.closest('button:not(:disabled)') !== null &&
              details !== null
            ) {
              details.open = false;
              details.querySelector('summary')?.focus();
            }
          }}
        >
          {others}
        </div>
      </details>
      {main}
    </div>
  );
}
