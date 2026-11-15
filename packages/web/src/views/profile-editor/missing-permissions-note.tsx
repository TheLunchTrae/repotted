import { permissionsInProse } from '@repotted/core';
import type { JSX } from 'preact';

export function MissingPermissionsNote({
  permissions,
  settingsUrl,
}: {
  readonly permissions: readonly string[];
  readonly settingsUrl: string | null;
}): JSX.Element {
  return (
    <p class="notice small">
      Turned off until an owner accepts the Repotted App's {permissionsInProse(permissions)}.
      {settingsUrl !== null && (
        <>
          {' '}
          <a href={settingsUrl} target="_blank" rel="noreferrer">
            Review on GitHub
          </a>
        </>
      )}
    </p>
  );
}
