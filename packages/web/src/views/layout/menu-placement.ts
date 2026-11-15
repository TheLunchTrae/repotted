import type { RefObject } from 'preact';
import { useEffect } from 'preact/hooks';

import { phoneMediaQuery } from './phone.js';

/**
 * Wider than a phone, a menu panel opens from its button's start edge, so a
 * button late in a toolbar can push it past the page's end. On opening, such
 * a panel opens toward the start instead, when that keeps it on the page.
 */
export function useMenuPanelKeptOnPage(menu: RefObject<HTMLDetailsElement | null>): void {
  useEffect(() => {
    const element = menu.current;
    if (element === null) {
      return;
    }
    const place = (): void => {
      const panel = element.querySelector<HTMLElement>(':scope > .menu-panel');
      const summary = element.querySelector<HTMLElement>(':scope > summary');
      if (panel === null || summary === null) {
        return;
      }
      delete panel.dataset['opensToward'];
      if (!element.open || matchMedia(phoneMediaQuery).matches) {
        return;
      }
      const panelBox = panel.getBoundingClientRect();
      const runsPastPageEnd = panelBox.right > document.documentElement.clientWidth;
      const fitsTowardStart = summary.getBoundingClientRect().right - panelBox.width >= 0;
      if (runsPastPageEnd && fitsTowardStart) {
        panel.dataset['opensToward'] = 'start';
      }
    };
    element.addEventListener('toggle', place);
    return () => {
      element.removeEventListener('toggle', place);
    };
  }, [menu]);
}
