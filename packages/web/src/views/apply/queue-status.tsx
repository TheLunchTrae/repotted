import type { JSX } from 'preact';

import type { ApplyQueue, QueuedApply } from '../../app/apply/apply-queue.js';
import { repositoryAddress } from '../../app/navigation/addressed-repository.js';
import type { Router } from '../../app/navigation/router.js';
import { Link } from '../layout/link.js';
import { Spinner } from '../layout/loading.js';
import { usePhone } from '../layout/phone.js';
import { run } from '../layout/run.js';
import { useDismissibleMenu } from '../layout/shell.js';

function count(amount: number, one: string, many: string): string {
  return amount === 1 ? `1 ${one}` : `${amount} ${many}`;
}

function changesOf(amount: number): string {
  return count(amount, 'change', 'changes');
}

const waitingStatus: Readonly<Record<'waiting' | 'writing' | 'held', string>> = {
  waiting: 'Waiting',
  writing: 'Writing',
  held: 'Waiting for you to continue',
};

function QueuedRow({
  apply,
  queue,
  router,
  onAct,
}: {
  readonly apply: QueuedApply;
  readonly queue: ApplyQueue;
  readonly router: Router;
  /** Before a button that goes away with what it does. */
  readonly onAct: () => void;
}): JSX.Element {
  const hasProblem = apply.status === 'stale' || apply.status === 'failed';
  return (
    <li class="queue-row">
      <strong>{apply.repository}</strong>
      <span class="muted small">
        {apply.profileName === '' ? '' : `${apply.profileName}: `}
        {changesOf(apply.changes)}
      </span>
      {apply.status === 'stale' || apply.status === 'failed' ? (
        <span class="queue-problem small">{apply.message}</span>
      ) : (
        <span class="muted small">{waitingStatus[apply.status]}</span>
      )}
      {hasProblem && (
        <span class="queue-row-actions">
          {apply.status === 'failed' && (
            <button
              class="button button-small"
              type="button"
              aria-label={`Try again: ${apply.repository}`}
              onClick={() => {
                onAct();
                run(queue.tryAgain(apply.id));
              }}
            >
              Try again
            </button>
          )}
          <Link class="button button-quiet button-small" router={router} to={repositoryAddress(apply.repository)}>
            Open repository
          </Link>
          <button
            class="button button-quiet button-small"
            type="button"
            aria-label={`Dismiss: ${apply.repository}`}
            onClick={() => {
              onAct();
              run(queue.dismiss(apply.id));
            }}
          >
            Dismiss
          </button>
        </span>
      )}
    </li>
  );
}

interface QueueStatusProps {
  readonly queue: ApplyQueue;
  readonly router: Router;
}

/**
 * The header's card for the applies that are queued: how far the queue is
 * while it writes, the button that continues a queue too old to carry on by
 * itself, and the applies that didn't finish.
 */
export function QueueStatus({ queue, router }: QueueStatusProps): JSX.Element | null {
  const menu = useDismissibleMenu();
  // A small phone's bar has room for a word or two beside the wordmark and the account.
  const narrow = usePhone('(max-width: 480px)');
  const applies = queue.applies.value;
  const progress = queue.progress.value;
  const held = queue.held.value;
  const problems = applies.filter((apply) => apply.status === 'stale' || apply.status === 'failed').length;
  const heldAmount =
    held === undefined
      ? ''
      : held.changes > 0
        ? changesOf(held.changes)
        : count(held.repositories, 'repository', 'repositories');
  // Each part with whether a small phone hides it, where it is still read aloud.
  const summary: readonly (readonly [text: string, hiddenWhenNarrow: boolean])[] =
    progress !== undefined
      ? [
          ['Applying ', true],
          [`${Math.min(progress.finished + 1, progress.total)} of ${progress.total}`, false],
        ]
      : held !== undefined
        ? narrow
          ? // Not the word on the panel's button, since this one only opens the panel.
            [
              [heldAmount.split(' ')[0] ?? '', false],
              [` ${heldAmount.split(' ')[1] ?? ''}`, true],
              [' waiting', false],
            ]
          : [[`Continue with ${heldAmount}`, false]]
        : problems > 0
          ? [
              [String(problems), false],
              [problems === 1 ? ' apply' : ' applies', true],
              [' not finished', false],
            ]
          : // Queued a moment ago, before its turn comes.
            [['Starting', false]];
  // Said once for each turn the queue takes, not for each repository it finishes.
  const announcement =
    progress !== undefined
      ? 'Applying changes to GitHub.'
      : held !== undefined
        ? `${heldAmount} queued earlier. Nothing is written until you continue.`
        : problems > 0
          ? `${count(problems, 'apply', 'applies')} not finished.`
          : '';
  // A button that goes away with what it does would take the keyboard's place with it, so the card's own button takes it first.
  const closePanel = (): void => {
    if (menu.current !== null) {
      menu.current.open = false;
      menu.current.querySelector('summary')?.focus();
    }
  };
  return (
    <>
      <p class="visually-hidden" role="status">
        {announcement}
      </p>
      {applies.length > 0 && (
        <details class="menu queue-menu" ref={menu}>
          <summary
            class={`button button-small${
              progress !== undefined
                ? ''
                : held !== undefined
                  ? ' button-primary'
                  : problems > 0
                    ? ' queue-summary-problem'
                    : ''
            }`}
          >
            {progress !== undefined && <Spinner />}
            <span>
              {summary.map(([text, hiddenWhenNarrow]) => (
                <span key={text} class={narrow && hiddenWhenNarrow ? 'visually-hidden' : undefined}>
                  {text}
                </span>
              ))}
            </span>
            {problems > 0 && (progress !== undefined || held !== undefined) && (
              <span class="queue-problem-mark">
                <span class="visually-hidden">, {count(problems, 'apply', 'applies')} not finished</span>
              </span>
            )}
          </summary>
          <div
            class="menu-panel menu-panel-end queue-panel"
            onClick={(event) => {
              if (event.target instanceof HTMLAnchorElement && menu.current !== null) {
                menu.current.open = false;
              }
            }}
          >
            <p class="menu-heading">
              <strong>Applies to GitHub</strong>
              {progress !== undefined && (
                <span class="muted">
                  {progress.repository === undefined ? 'Starting' : `Writing to ${progress.repository}`}. You can keep
                  working, and a reload carries on from here.
                </span>
              )}
            </p>
            {progress !== undefined && progress.total > 1 && (
              <progress
                class="queue-progress"
                max={progress.total}
                value={progress.finished}
                aria-label="Repositories applied"
              />
            )}
            {held !== undefined && (
              <div class="queue-held">
                <p class="small">
                  Queued {new Date(held.since).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })},{' '}
                  {held.signInLost
                    ? 'and stopped when GitHub no longer accepted your sign-in.'
                    : 'and not finished within an hour.'}{' '}
                  Nothing is written until you continue. Each repository is checked first, and gets only the changes you
                  reviewed.
                </p>
                <p class="queue-row-actions">
                  <button
                    class="button button-primary button-small"
                    type="button"
                    onClick={() => {
                      closePanel();
                      run(queue.continueHeld());
                    }}
                  >
                    Continue
                  </button>
                  <button
                    class="button button-quiet button-small"
                    type="button"
                    onClick={() => {
                      closePanel();
                      run(queue.discardHeld());
                    }}
                  >
                    Discard
                  </button>
                </p>
              </div>
            )}
            <ul class="queue-list">
              {applies.map((apply) => (
                <QueuedRow key={apply.id} apply={apply} queue={queue} router={router} onAct={closePanel} />
              ))}
            </ul>
          </div>
        </details>
      )}
    </>
  );
}
