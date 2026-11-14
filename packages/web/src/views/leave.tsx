import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import type { Profiles } from '../app/profiles.js';
import { run } from './run.js';

interface LeaveProps {
  readonly profiles: Profiles;
  /** Goes on with what the question held back, once no profile has unsaved changes. */
  readonly onLeave: () => void;
  readonly onClose: () => void;
}

/** Asks what to do with unsaved changes before signing out, which would drop them. */
export function SignOutQuestion({ profiles, onLeave, onClose }: LeaveProps): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  /** Whether every change is saved in this browser while the sync that takes them elsewhere didn't finish. */
  const [unsynced, setUnsynced] = useState(false);
  const names = profiles.unsavedNames.value;
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const signOut = (): void => {
    dialog.current?.close();
    onLeave();
  };
  const leave = async (save: boolean): Promise<void> => {
    setWorking(true);
    setProblem(undefined);
    try {
      if (save) {
        const saved = await profiles.saveAll();
        if (saved === 'unsaved') {
          setProblem(
            "Some changes weren't saved. A profile with a draft, or with a value that isn't valid, is saved from its own page: stay signed in to do that, or discard the changes.",
          );
          return;
        }
        if (saved === 'unsynced') {
          setUnsynced(true);
          return;
        }
      } else {
        await profiles.discardAll();
      }
      // A question put away while this ran, as a second Escape can, is an answer to stay.
      if (dialog.current?.open === true) {
        signOut();
      }
    } finally {
      setWorking(false);
    }
  };
  const [first = '', second = ''] = names;
  return (
    <dialog
      class="dialog"
      ref={dialog}
      aria-labelledby="leave-heading"
      onClose={onClose}
      onCancel={(event) => {
        // Escape while a save runs would put the question away and still sign out when the save ends.
        if (working) {
          event.preventDefault();
        }
      }}
    >
      {unsynced ? (
        <>
          <h2 id="leave-heading">Sign out before your changes are synced?</h2>
          <p>
            Your changes are saved in this browser, but the last sync didn't finish or left a profile changed in both
            places, so where your profiles are kept doesn't have them all. Stay signed in to sort that out on the
            Profiles page.
          </p>
        </>
      ) : (
        <>
          <h2 id="leave-heading">Save your changes before you sign out?</h2>
          <p>
            {names.length === 1
              ? `${first} has unsaved changes.`
              : names.length === 2
                ? `${first} and ${second} have unsaved changes.`
                : `${names.length} profiles have unsaved changes.`}{' '}
            Signing out discards changes that aren't saved.
          </p>
        </>
      )}
      {problem !== undefined && (
        <p class="problem" role="alert">
          {problem}
        </p>
      )}
      <div class="form-actions">
        {unsynced ? (
          <button class="button" type="button" autofocus onClick={signOut}>
            Sign out anyway
          </button>
        ) : (
          <>
            <button
              class="button button-primary"
              type="button"
              disabled={working}
              autofocus
              onClick={() => {
                run(leave(true));
              }}
            >
              Save and sign out
            </button>
            <button
              class="button"
              type="button"
              disabled={working}
              onClick={() => {
                run(leave(false));
              }}
            >
              Discard and sign out
            </button>
          </>
        )}
        <button
          class="button button-quiet"
          type="button"
          disabled={working}
          onClick={() => {
            dialog.current?.close();
          }}
        >
          Stay signed in
        </button>
      </div>
    </dialog>
  );
}
