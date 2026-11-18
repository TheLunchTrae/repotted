import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

export function usePendingAction(): readonly [boolean, (work: () => Promise<unknown>) => Promise<void>] {
  const [pending, setPending] = useState(false);
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  return [
    pending,
    (work) => {
      if (running.current) {
        return Promise.resolve();
      }
      running.current = true;
      setPending(true);
      const finish = (): void => {
        running.current = false;
        if (mounted.current) {
          setPending(false);
        }
      };
      try {
        const completion = work()
          .then(() => undefined)
          .finally(finish);
        return completion;
      } catch (error) {
        finish();
        return Promise.reject(
          error instanceof Error ? error : new Error('The action could not start.', { cause: error }),
        );
      }
    },
  ];
}

type PendingButtonProps = JSX.IntrinsicElements['button'] & {
  readonly pending: boolean;
  readonly pendingLabel: string;
};

export function PendingButton({
  pending,
  pendingLabel,
  children,
  disabled,
  onClick,
  ...props
}: PendingButtonProps): JSX.Element {
  const idle = useRef(children);
  if (!pending) {
    idle.current = children;
  }
  const blocked = pending || disabled === true || props['aria-disabled'] === true || props['aria-disabled'] === 'true';
  return (
    <button
      {...props}
      disabled={pending ? false : disabled}
      aria-disabled={blocked || undefined}
      aria-busy={pending || undefined}
      onClick={(event) => {
        if (blocked) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
    >
      <span class="pending-label">
        <span aria-hidden={pending}>{idle.current}</span>
        <span class="pending-label-busy" aria-hidden={!pending}>
          <span class="pending-spinner" aria-hidden="true" />
          {pendingLabel}
        </span>
      </span>
    </button>
  );
}
