import type { ComponentChildren, JSX } from 'preact';

export function Spinner(): JSX.Element {
  return <span class="loading-spinner" aria-hidden="true" />;
}

export function Loading({ children }: { readonly children: ComponentChildren }): JSX.Element {
  return (
    <p class="loading muted" role="status">
      <Spinner />
      {children}
    </p>
  );
}

export function LoadingList({ children }: { readonly children: ComponentChildren }): JSX.Element {
  return (
    <div>
      <Loading>{children}</Loading>
      <div class="skeleton-list" aria-hidden="true">
        {[0, 1, 2].map((row) => (
          <div class="skeleton-row" key={row}>
            <span />
            <span />
          </div>
        ))}
      </div>
    </div>
  );
}
