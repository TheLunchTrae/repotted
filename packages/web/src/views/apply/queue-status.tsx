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
}: {
  readonly apply: QueuedApply;
  readonly queue: ApplyQueue;
  readonly router: Router;
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
  const heldLabel =
    held === undefined
      ? undefined
      : `Continue with ${held.changes > 0 ? changesOf(held.changes) : count(held.repositories, 'repository', 'repositories')}`;
  const notFinished = count(problems, 'apply not finished', 'applies not finished');
  const step = progress === undefined ? '' : `${Math.min(progress.finished + 1, progress.total)} of ${progress.total}`;
  const summary = progress !== undefined ? `Applying ${step}` : (heldLabel ?? notFinished);
  const shortSummary =
    progress !== undefined ? step : heldLabel === undefined ? `${problems} not finished` : 'Continue';
  // Said once for each turn the queue takes, not for each repository it finishes.
  const announcement =
    progress !== undefined
      ? 'Applying changes to GitHub.'
      : held !== undefined
        ? `${changesOf(held.changes)} queued earlier. Nothing is written until you continue.`
        : problems > 0
          ? `${notFinished}.`
          : '';
  return (
    <>
      <p class="visually-hidden" role="status">
        {announcement}
      </p>
      {applies.length > 0 && (
        <details class="menu queue-menu" ref={menu}>
          <summary
            class={`button button-small${progress === undefined && held !== undefined ? ' button-primary' : ''}`}
            aria-label={narrow ? summary : undefined}
          >
            {progress !== undefined && <Spinner />}
            {narrow ? shortSummary : summary}
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
            {progress !== undefined && (
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
                  Queued {new Date(held.since).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}, and not
                  finished. Nothing is written until you continue. Each repository is checked first, and gets only the
                  changes you reviewed.
                </p>
                <p class="queue-row-actions">
                  <button
                    class="button button-primary button-small"
                    type="button"
                    onClick={() => {
                      queue.continueHeld();
                    }}
                  >
                    Continue
                  </button>
                  <button
                    class="button button-quiet button-small"
                    type="button"
                    onClick={() => {
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
                <QueuedRow key={apply.id} apply={apply} queue={queue} router={router} />
              ))}
            </ul>
          </div>
        </details>
      )}
    </>
  );
}
