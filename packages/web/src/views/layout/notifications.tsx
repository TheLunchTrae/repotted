import { createContext, type JSX } from 'preact';
import { useContext, useEffect, useRef } from 'preact/hooks';

import type { Confirmation, Notifications } from '../../app/notifications.js';
import type { Profiles } from '../../app/profiles/profiles.js';

export const NotificationContext = createContext<Notifications | undefined>(undefined);

export function useNotifications(): Notifications | undefined {
  return useContext(NotificationContext);
}

export function profileConfirmation(profiles: Profiles, message: string): Confirmation | undefined {
  if (
    profiles.sync.value.status === 'failed' ||
    profiles.conflicts.value.length > 0 ||
    profiles.listingError.value !== undefined
  ) {
    return undefined;
  }
  const source = profiles.source.value;
  return {
    message,
    detail:
      source.kind === 'repository'
        ? `Synced with ${source.repository}.`
        : source.kind === 'folder'
          ? `Synced with ${source.name}.`
          : 'Available in this tab.',
  };
}

export function useProfileConfirmation(profiles: Profiles): (message: string) => void {
  const notifications = useNotifications();
  return (message) => {
    const confirmation = profileConfirmation(profiles, message);
    if (confirmation !== undefined) {
      notifications?.show(confirmation);
    }
  };
}

export function Toasts({ notifications }: { readonly notifications: Notifications }): JSX.Element {
  const region = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const place = (): void => {
      const element = region.current;
      if (element === null) {
        return;
      }
      const stored = Number.parseFloat(element.style.getPropertyValue('--toast-clearance'));
      const previous = Number.isFinite(stored) ? stored : 0;
      const edge = Number.parseFloat(getComputedStyle(element).bottom) - previous;
      const height = element.getBoundingClientRect().height;
      const bottom = window.innerHeight - edge;
      const top = bottom - height;
      const clearance = Math.max(
        0,
        ...Array.from(document.querySelectorAll('.save-bar')).map((bar) => {
          const box = bar.getBoundingClientRect();
          return box.bottom > top && box.top < bottom ? bottom - box.top + 16 : 0;
        }),
      );
      element.style.setProperty('--toast-clearance', `${Math.min(clearance, Math.max(0, top - 16))}px`);
    };
    const resized = new ResizeObserver(place);
    let bars: readonly Element[] = [];
    const visibility = (): void => {
      if (document.hidden) {
        notifications.pause('hidden');
      } else {
        notifications.resume('hidden');
      }
    };
    const modal = (): void => {
      const currentBars = Array.from(document.querySelectorAll('.save-bar'));
      if (currentBars.length !== bars.length || currentBars.some((bar, index) => bar !== bars[index])) {
        resized.disconnect();
        currentBars.forEach((bar) => resized.observe(bar));
        bars = currentBars;
      }
      place();
      if (document.querySelector('dialog[open]') !== null) {
        notifications.pause('dialog');
      } else {
        notifications.resume('dialog');
      }
    };
    const observer = new MutationObserver(modal);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    visibility();
    modal();
    return () => {
      observer.disconnect();
      resized.disconnect();
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      document.removeEventListener('visibilitychange', visibility);
      notifications.dispose();
    };
  }, [notifications]);
  const confirmation = notifications.current.value;
  return (
    <div
      class="toasts"
      ref={region}
      onMouseEnter={() => notifications.pause('hover')}
      onMouseLeave={() => notifications.resume('hover')}
      onFocusIn={() => notifications.pause('focus')}
      onFocusOut={(event) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
          notifications.resume('focus');
        }
      }}
    >
      <div role="status" aria-atomic="true">
        {confirmation !== undefined && (
          <div class="toast-copy" key={confirmation.id}>
            <strong>{confirmation.message}</strong>
            {confirmation.detail !== undefined && <span class="muted small">{confirmation.detail}</span>}
          </div>
        )}
      </div>
      {confirmation !== undefined && (
        <button
          class="button button-quiet button-small"
          type="button"
          aria-label="Dismiss confirmation"
          onClick={() => notifications.dismiss()}
        >
          Dismiss
        </button>
      )}
    </div>
  );
}
