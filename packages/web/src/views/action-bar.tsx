import type { ComponentChildren, JSX } from 'preact';
import { usePhone } from './phone.js';
import { useDismissibleMenu } from './shell.js';

interface BarActionsProps {
  readonly mainAction: ComponentChildren;
  readonly otherActions: ComponentChildren;
}

export function BarActions({ mainAction, otherActions }: BarActionsProps): JSX.Element {
  const onPhone = usePhone();
  const menu = useDismissibleMenu();
  if (!onPhone) {
    return (
      <>
        {otherActions}
        {mainAction}
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
          {otherActions}
        </div>
      </details>
      {mainAction}
    </div>
  );
}
