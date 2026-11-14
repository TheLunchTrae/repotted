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
  const names = profiles.unsavedNames.value;
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const leave = async (save: boolean): Promise<void> => {
    setWorking(true);
    setProblem(undefined);
    try {
      if (save) {
        if (!(await profiles.saveAll())) {
          setProblem("Some changes couldn't be saved. Open the profile to see why, or discard them.");
          return;
        }
      } else {
        await profiles.discardAll();
      }
      dialog.current?.close();
      onLeave();
    } finally {
      setWorking(false);
    }
  };
  const [first = '', second = ''] = names;
  return (
    <dialog class="dialog" ref={dialog} aria-labelledby="leave-heading" onClose={onClose}>
      <h2 id="leave-heading">Save your changes before you sign out?</h2>
      <p>
        {names.length === 1
          ? `${first} has unsaved changes.`
          : names.length === 2
            ? `${first} and ${second} have unsaved changes.`
            : `${names.length} profiles have unsaved changes.`}{' '}
        Signing out discards changes that aren't saved.
      </p>
      {problem !== undefined && (
        <p class="problem" role="alert">
          {problem}
        </p>
      )}
      <div class="form-actions">
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
