import type { JSX } from 'preact';

export function permissionsInProse(permissions: readonly string[]): string {
  return `${new Intl.ListFormat('en').format(permissions)} ${permissions.length === 1 ? 'permission' : 'permissions'}`;
}

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
