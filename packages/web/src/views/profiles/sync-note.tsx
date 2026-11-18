import type { JSX } from 'preact';
import { Spinner } from '../layout/loading.js';

import type { Profiles } from '../../app/profiles/profiles.js';
import { run } from '../layout/run.js';

export function SyncNote({ profiles }: { readonly profiles: Profiles }): JSX.Element | null {
  const sync = profiles.sync.value;
  const syncDestination = profiles.source.value.kind === 'folder' ? 'the folder' : 'GitHub';
  if (sync.status === 'failed') {
    return (
      <p class="problem small" role="alert">
        Not synced. {/[.!?]$/u.test(sync.message) ? sync.message : `${sync.message}.`} Profiles stay in this browser
        until a sync works.{' '}
        {profiles.needsFolderAccess.value && (
          <button
            class="link"
            type="button"
            onClick={() => {
              run(profiles.allowFolder());
            }}
          >
            Allow access
          </button>
        )}
      </p>
    );
  }
  if (sync.status === 'syncing') {
    return (
      <p class="muted small" role="status">
        <Spinner /> Syncing with {syncDestination}…
      </p>
    );
  }
  if (sync.status === 'synced') {
    const conflicts = profiles.conflicts.value.length;
    const moved = [
      sync.pulled > 0 ? `${sync.pulled} from ${syncDestination}` : undefined,
      sync.pushed > 0 ? `${sync.pushed} to ${syncDestination}` : undefined,
    ].filter((part) => part !== undefined);
    return (
      <p class="muted small" role="status">
        {conflicts > 0
          ? `Synced, with ${conflicts} ${conflicts === 1 ? 'profile' : 'profiles'} changed in both places.`
          : moved.length > 0
            ? `Synced: ${moved.join(', ')}.`
            : `In sync with ${syncDestination}.`}
      </p>
    );
  }
  return null;
}
