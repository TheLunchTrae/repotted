import type { RefObject } from 'preact';
import { useEffect } from 'preact/hooks';

import { phoneMediaQuery } from './phone.js';

/**
 * Wider than a phone, a menu panel opens from its button's start edge, so a
 * button late in a toolbar can push it past the page's end. Such a panel
 * opens toward the start instead, when that keeps it on the page, and is
 * placed again whenever it, its button or the window changes size.
 */
export function useMenuPanelKeptOnPage(menu: RefObject<HTMLDetailsElement | null>): void {
  useEffect(() => {
    const element = menu.current;
    if (element === null) {
      return;
    }
    const panel = element.querySelector<HTMLElement>(':scope > .menu-panel');
    const summary = element.querySelector<HTMLElement>(':scope > summary');
    if (panel === null || summary === null) {
      return;
    }
    const place = (): void => {
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
    // The open attribute changes within the click that opens the menu, while
    // the toggle event comes a task later, after the panel may have shown off the page.
    const openChanges = new MutationObserver(place);
    openChanges.observe(element, { attributes: true, attributeFilter: ['open'] });
    const sizeChanges = new ResizeObserver(place);
    sizeChanges.observe(panel);
    sizeChanges.observe(summary);
    window.addEventListener('resize', place);
    return () => {
      openChanges.disconnect();
      sizeChanges.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [menu]);
}
