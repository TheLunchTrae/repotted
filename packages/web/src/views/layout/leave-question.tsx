import type { JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';

import type { LeaveQuestion, Router } from '../../app/navigation/router.js';

/** While the page is drawn, leaving it asks `ask`'s question first, whenever it has one. */
export function useLeaveQuestion(router: Router, ask: () => LeaveQuestion | undefined): void {
  const latest = useRef(ask);
  latest.current = ask;
  useEffect(() => router.holdWhileLeaving(() => latest.current()), [router]);
}

function repositoriesNamed(repositories: readonly string[]): JSX.Element {
  const [first] = repositories;
  return repositories.length === 0 ? (
    <>these repositories</>
  ) : repositories.length === 1 && first !== undefined ? (
    <span class="mono">{first}</span>
  ) : (
    <>{repositories.length} repositories</>
  );
}

function Wording({ question }: { readonly question: LeaveQuestion }): JSX.Element {
  switch (question.kind) {
    case 'one-off-edits':
      return (
        <>
          <h2 id="leave-question-heading">Discard your one-off edits?</h2>
          <p>
            Your one-off edits to {repositoriesNamed(question.repositories)} aren't saved to a profile. Leaving this
            page discards them with the apply.
          </p>
        </>
      );
    case 'capture':
      return (
        <>
          <h2 id="leave-question-heading">Stop the capture?</h2>
          <p>
            Repotted is still reading <span class="mono">{question.repository}</span> from GitHub. Leaving stops the
            capture, and no profile is made.
          </p>
        </>
      );
    case 'new-profile':
      return (
        <>
          <h2 id="leave-question-heading">Discard this new profile?</h2>
          <p>
            {question.name === '' ? 'The new profile' : <strong>{question.name}</strong>} isn't created yet. Leaving
            discards what you entered.
          </p>
        </>
      );
  }
}

/** Asks about work that leaving the page shown would lose, while the router holds a leave for an answer. */
export function LeaveQuestionDialog({ router }: { readonly router: Router }): JSX.Element | null {
  const leaving = router.leaving.value;
  const dialog = useRef<HTMLDialogElement>(null);
  const open = leaving !== undefined;
  useEffect(() => {
    if (open) {
      dialog.current?.showModal();
    }
  }, [open]);
  if (leaving === undefined) {
    return null;
  }
  return (
    <dialog
      class="dialog"
      ref={dialog}
      aria-labelledby="leave-question-heading"
      onClose={() => {
        // Escape is an answer to stay; Leave has already moved on by the time the dialog closes.
        router.stay();
      }}
    >
      <form
        method="dialog"
        onSubmit={(event) => {
          if (event.submitter instanceof HTMLButtonElement && event.submitter.value === 'leave') {
            router.leave();
          }
        }}
      >
        <Wording question={leaving.question} />
        {leaving.question.kind === 'one-off-edits' && leaving.question.savable && (
          <p class="muted small">
            Choose <strong>Save edits to profile</strong> first to keep them.
          </p>
        )}
        <div class="form-actions">
          <button class="button" type="submit" value="leave">
            Leave
          </button>
          {/* The dialog opens with the keyboard on Stay, so Enter never discards work by itself. */}
          <button class="button button-primary" type="submit" value="stay" autofocus>
            Stay
          </button>
        </div>
      </form>
    </dialog>
  );
}
