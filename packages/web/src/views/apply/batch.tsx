import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Spinner } from '../layout/loading.js';
import { PendingButton, usePendingAction } from '../layout/pending-button.js';
import { ImportedNotice } from './imported-notice.js';

import type { BatchApply, BatchMemberView } from '../../app/apply/batch-apply.js';
import {
  type CompareRow,
  exclusionLabel,
  type LinkedReviewNote,
  reviewSections,
  sectionTitles,
} from '../../app/apply/comparison.js';
import type { Router } from '../../app/navigation/router.js';
import { BarActions } from '../layout/action-bar.js';
import { useLeaveQuestion } from '../layout/leave-question.js';
import { Link } from '../layout/link.js';
import { run } from '../layout/run.js';
import { ProfileSettings } from '../profile-editor/profile-editor.js';
import { waitingForEarlier } from './apply.js';
import { ReviewNotes, SkippedSetting } from './review-notes.js';

const kinds: Readonly<Record<CompareRow['kind'], string>> = { changes: 'Changes', adds: 'Adds', removes: 'Removes' };

function count(amount: number, noun: string): string {
  return amount === 1 ? `1 ${noun}` : `${amount} ${noun}s`;
}

function statusOf(member: BatchMemberView): { readonly text: string; readonly tone: string } {
  switch (member.status) {
    case 'changes':
      return { text: count(member.changes, 'change'), tone: 'pill pill-drift' };
    case 'in-line':
      return { text: 'Already in line', tone: 'pill' };
    case 'needs-access':
      return { text: 'Needs access', tone: 'pill pill-remove' };
    case 'failed':
      return { text: "Couldn't compare", tone: 'pill pill-remove' };
    case 'left-out':
      return { text: 'Left out', tone: 'pill' };
  }
}

type About = NonNullable<LinkedReviewNote['about']>;

interface MemberProps {
  readonly member: BatchMemberView;
  readonly batch: BatchApply;
  readonly reviewingOrApplying: boolean;
  /** Undefined for a batch with no edits to go back to. */
  readonly onEdit: ((about: About) => void) | undefined;
  readonly editDisabled: boolean;
}

function Member({ member, batch, reviewingOrApplying: working, onEdit, editDisabled }: MemberProps): JSX.Element {
  const status = statusOf(member);
  const out = member.status === 'left-out';
  return (
    <section class="settings-group" aria-label={member.repository}>
      <div class="entry-bar">
        <h2>
          <span class="mono">{member.repository}</span> <span class={status.tone}>{status.text}</span>
        </h2>
        {(out || member.status === 'failed') && (
          <button
            class="button button-quiet button-small"
            type="button"
            disabled={working}
            aria-label={`Remove ${member.repository} from the batch`}
            onClick={() => {
              run(batch.remove(member.repository));
            }}
          >
            Remove from batch
          </button>
        )}
        <label class="check">
          <input
            type="checkbox"
            checked={!out}
            disabled={working}
            aria-label={`Apply to ${member.repository} in this batch`}
            onChange={(event) => {
              run(batch.leaveOutRepository(member.repository, !event.currentTarget.checked));
            }}
          />
          <span>In this batch</span>
        </label>
      </div>
      {member.comparisonFailureMessage !== undefined && (
        <p class="notice notice-problem" role="alert">
          {member.comparisonFailureMessage}
        </p>
      )}
      {member.profiles.length > 0 && <p class="muted small">Profiles, in order: {member.profiles.join(', ')}</p>}
      {member.authoritative.length > 0 && (
        <p class="muted small">
          Full section ownership: {member.authoritative.map((section) => sectionTitles[section]).join(', ')}.
        </p>
      )}
      {member.warnings.length > 0 && (
        <ReviewNotes class="muted small" notes={member.warnings} onEdit={onEdit} editDisabled={editDisabled} />
      )}
      {member.skippedDrafts.length > 0 && (
        <ul class="muted small">
          {member.skippedDrafts.map((skipped) => (
            <li key={skipped}>{skipped}</li>
          ))}
        </ul>
      )}
      {(member.sections.length > 0 || member.skippedSettings.length > 0) && (
        <ul class="rows" role="list">
          {reviewSections(member.sections, member.skippedSettings).flatMap((section) =>
            section.rows.map((row) =>
              row.kind === 'skipped' ? (
                <SkippedSetting
                  key={`${section.section} skipped ${row.key}`}
                  row={row}
                  onEdit={onEdit}
                  editDisabled={editDisabled}
                  forWhom={member.repository}
                />
              ) : (
                <li key={`${section.section} ${row.label} ${row.key}`} class="compare-row">
                  <span class="compare-what">
                    <strong>{row.label}</strong>
                    <span class="mono small muted">{row.key}</span>
                  </span>
                  <span class="compare-values">
                    <span class="visually-hidden">{kinds[row.kind]}: on GitHub now, </span>
                    <span class={row.kind === 'adds' ? 'muted' : 'compare-now'}>{row.now}</span>
                    <span aria-hidden="true">→</span>
                    <span class="visually-hidden">; after the apply, </span>
                    <span class={row.kind === 'removes' ? 'compare-removed' : 'compare-wanted'}>{row.wanted}</span>
                  </span>
                  {row.lockReason !== undefined && <span class="pill pill-remove">{row.lockReason}</span>}
                  {row.oneOff === true && <span class="pill pill-drift">One-off edit</span>}
                  {row.leaveOut !== undefined && (
                    <button
                      class="button button-quiet button-small"
                      type="button"
                      disabled={working}
                      aria-label={`Leave out ${row.label}, ${row.key}, for ${member.repository}`}
                      onClick={() => {
                        run(batch.leaveOut(member.repository, row.leaveOut ?? '', true));
                      }}
                    >
                      Leave out
                    </button>
                  )}
                </li>
              ),
            ),
          )}
        </ul>
      )}
      {member.leftOut.length > 0 && (
        <p class="muted small">
          Left out here:{' '}
          {member.leftOut.map((key) => (
            <span key={key} class="left-out-key">
              <span>{exclusionLabel(key)}</span>{' '}
              <button
                class="link"
                type="button"
                disabled={working}
                aria-label={`Put back ${exclusionLabel(key)} for ${member.repository}`}
                onClick={() => {
                  run(batch.leaveOut(member.repository, key, false));
                }}
              >
                Put back
              </button>
            </span>
          ))}
        </p>
      )}
    </section>
  );
}

function Confirm({ batch, onClose }: { readonly batch: BatchApply; readonly onClose: () => void }): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const ready = batch.ready.value;
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog class="dialog" ref={dialog} aria-labelledby="batch-confirm" onClose={onClose}>
      <form
        method="dialog"
        onSubmit={(event) => {
          if (event.submitter instanceof HTMLButtonElement && event.submitter.value === 'apply') {
            run(batch.apply());
          }
        }}
      >
        <h2 id="batch-confirm">Apply to {ready.length === 1 ? '1 repository' : `${ready.length} repositories`}?</h2>
        <p>
          This writes the changes you reviewed, one repository at a time. Repotted checks each on GitHub first, and
          writes nothing to one that changed since the review.
        </p>
        <ul class="batch-repositories" aria-label="Repositories to change">
          {ready.map((member) => (
            <li key={member.repository} class="mono">
              {member.repository}
            </li>
          ))}
        </ul>
        <div class="form-actions">
          {/* The dialog opens with the keyboard on Cancel, so Enter never applies by itself. */}
          <button
            class="button button-quiet"
            type="button"
            onClick={() => {
              dialog.current?.close('cancel');
            }}
            autofocus
          >
            Cancel
          </button>
          <button class="button button-primary" type="submit" value="apply">
            Apply now
          </button>
        </div>
      </form>
    </dialog>
  );
}

interface BatchProps {
  readonly batch: BatchApply;
  readonly router: Router;
  /** How many queued applies are written before this page's. */
  readonly earlierApplies: number;
}

export function BatchPage({ batch, router, earlierApplies }: BatchProps): JSX.Element {
  const [reviewingAgain, reviewAgain] = usePendingAction();
  const [reviewing, review] = usePendingAction();
  const state = batch.state.value;
  const [confirming, setConfirming] = useState(false);
  // A review note's Edit goes back to the edits at what it names, as a new object each time, so the same note goes again.
  const [editing, setEditing] = useState<{ readonly about: About } | undefined>(undefined);
  const editor = batch.editor.value;
  const landOn = useMemo(
    () => (editing === undefined ? undefined : editor?.placeOf(editing.about.section, editing.about.key)),
    [editing, editor],
  );
  useLeaveQuestion(router, () => {
    const current = batch.state.peek();
    if (!batch.holdsOneOffEdits.peek()) {
      return undefined;
    }
    const repositories =
      current.kind === 'editing'
        ? current.repositories
        : current.kind === 'reviewing' || current.kind === 'reviewed'
          ? current.members.map((member) => member.repository)
          : [];
    return { kind: 'one-off-edits', repositories, savable: false };
  });
  const back = (
    <Link router={router} to="/">
      Back to repositories
    </Link>
  );
  if (state.kind === 'idle') {
    return (
      <div class="page">
        <div class="page-body">
          <h1>Apply a profile to several repositories</h1>
          <p>
            Select repositories on the Repositories page, then pick a profile and choose Review apply, or choose Change
            settings once.
          </p>
          <p>{back}</p>
        </div>
      </div>
    );
  }
  const ready = batch.ready.value;
  const reviewingOrApplying = state.kind === 'reviewing' || state.kind === 'applying';
  const members = batch.members.value;
  const refused = state.kind === 'reviewed' ? state.refused : [];
  const repositories = (amount: number): string => (amount === 1 ? '1 repository' : `${amount} repositories`);
  const discard = (
    <button
      class="button button-quiet"
      type="button"
      disabled={reviewingOrApplying}
      onClick={() => {
        run(
          batch.close().then(() => {
            if (batch.state.value.kind === 'idle') {
              router.go('/');
            }
          }),
        );
      }}
    >
      Discard batch
    </button>
  );
  return (
    <div class="page">
      <article class="page-body" aria-labelledby="batch-title">
        <p>{back}</p>
        <div class="page-heading">
          <div>
            <h1 id="batch-title">
              Apply{' '}
              {state.profileName === '' ? 'to several repositories' : `${state.profileName} to several repositories`}
            </h1>
            <p class="muted" role="status">
              {(state.kind === 'reviewing' || state.kind === 'applying') && <Spinner />}
              {state.kind === 'editing'
                ? `Step 1 of 2: the settings to change on ${repositories(state.repositories.length)}, this once. Nothing else on them is touched.`
                : state.kind === 'reviewing'
                  ? 'Reading from GitHub…'
                  : state.kind === 'applying'
                    ? earlierApplies > 0
                      ? waitingForEarlier(earlierApplies)
                      : `Writing to GitHub: ${state.results.length} of ${state.total} done…`
                    : state.kind === 'failed'
                      ? "The batch couldn't be reviewed."
                      : state.kind === 'applied'
                        ? state.left === 0
                          ? 'Every repository is finished, and the batch has ended.'
                          : `${repositories(state.left)} didn't finish and ${state.left === 1 ? 'is' : 'are'} still in the batch.`
                        : ready.length === 0
                          ? 'No repository has changes that can be written.'
                          : `${repositories(ready.length)} with changes to write. Nothing is written until you apply.`}
            </p>
            {state.kind === 'editing' && (
              <ul class="batch-repositories muted" aria-label="Repositories to change">
                {state.repositories.map((repository) => (
                  <li key={repository} class="mono">
                    {repository}
                  </li>
                ))}
              </ul>
            )}
            {state.kind === 'applying' && (
              <progress
                class="batch-progress"
                max={state.total}
                value={state.results.length}
                aria-label="Repositories finished"
              />
            )}
            {ready.length > 0 && (
              <ul class="batch-repositories muted" aria-label="Repositories to change">
                {ready.map((member) => (
                  <li key={member.repository} class="mono">
                    {member.repository}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        {state.kind === 'failed' && (
          <p class="notice notice-problem" role="alert">
            {state.message}
          </p>
        )}
        {state.kind === 'editing' && <ImportedNotice imported={batch.imported.value} />}
        {state.kind === 'editing' && editor !== undefined && (
          <ProfileSettings
            key={editor.file}
            name=""
            editor={editor}
            landOn={landOn}
            onLanded={() => {
              setEditing(undefined);
            }}
            ownerTypeHasPushRulesets={editor.ownerType.value !== 'user'}
            saving={{
              save: () => editor.save((work) => work()),
              discardDraft: () => Promise.resolve(),
              onGitHub: false,
              saveLabel: 'Save edits',
              extraBarActions: discard,
              primaryActionInsteadOfSave: (
                <PendingButton
                  pending={reviewing}
                  class="button button-primary"
                  type="button"
                  disabled={reviewing || editor.saving.value || (editor.dirty.value && !editor.canSave.value)}
                  onClick={() => {
                    run(review(() => batch.review()));
                  }}
                >
                  Review changes
                </PendingButton>
              ),
            }}
          />
        )}
        {(state.kind === 'applying' || state.kind === 'applied') && state.results.length > 0 && (
          <ul class="rows" role="list" aria-label="How each repository ended">
            {state.results.map((result) => (
              <li key={result.repository} class="compare-row">
                <strong class="mono compare-what">{result.repository}</strong>
                <span class={result.finished ? 'compare-values' : 'compare-values problem'}>{result.said}</span>
              </li>
            ))}
          </ul>
        )}
        {(state.kind === 'reviewed' || members.length > 0) && (
          <>
            {refused.length > 0 && (
              <div class="notice notice-drift" role="status">
                <p>
                  {editor === undefined
                    ? 'Some repositories kept the change:'
                    : "Some repositories couldn't take the edits, so they are left out:"}
                </p>
                <ul>
                  {refused.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            )}
            {editor === undefined && batch.addOffer.value !== undefined && (
              <div class="assign-choice">
                <label class="check">
                  <input
                    type="checkbox"
                    checked={batch.addToRepositoryProfiles.value}
                    disabled={reviewingOrApplying}
                    onChange={(event) => {
                      batch.addToRepositoryProfiles.value = event.currentTarget.checked;
                    }}
                  />
                  <span>
                    Add <span class="mono">{batch.addOffer.value}</span> to each repository's profiles when it applies
                  </span>
                </label>
                <p class="muted small">
                  Deselect it for a one-time apply. The repositories keep no record of the profile. One whose apply
                  leaves some of the profile out, edits it, skips a setting GitHub refused to show, or differs from its
                  section ownership gets it as not applied yet.
                </p>
              </div>
            )}
            {editor === undefined && (
              <section class="settings-group" aria-label="All repositories">
                <div>
                  <h2>All repositories</h2>
                  <p class="muted small">
                    Each change that can be left out, and the repositories it affects. Repositories that need access
                    wait until access is granted. Leaving a change out everywhere leaves it out of every repository's
                    apply; the profile keeps it.
                  </p>
                </div>
                {batch.changes.value.length > 0 && (
                  <ul class="rows" role="list">
                    {batch.changes.value.map((change) => (
                      <li key={change.key} class="compare-row">
                        <strong class="compare-what">{change.label}</strong>
                        <div class="compare-values muted">
                          <ul class="batch-repositories small" aria-label={`Repositories affected by ${change.label}`}>
                            {change.repositories.map((repository) => (
                              <li key={repository}>
                                <span class="mono">{repository}</span>
                                {members.find((member) => member.repository === repository)?.status ===
                                  'needs-access' && ' (needs access)'}
                              </li>
                            ))}
                          </ul>
                        </div>
                        <button
                          class="button button-quiet button-small"
                          type="button"
                          disabled={reviewingOrApplying}
                          aria-label={`Leave out ${change.label} everywhere`}
                          onClick={() => {
                            run(batch.everywhere(change.key, true));
                          }}
                        >
                          Leave out everywhere
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {batch.leftOut.value.length > 0 && (
                  <ul class="rows" role="list" aria-label="Left out">
                    {batch.leftOut.value.map((key) => (
                      <li key={key} class="compare-row">
                        <strong class="compare-what">{exclusionLabel(key)}</strong>
                        <span class="compare-values muted">Left out</span>
                        <button
                          class="button button-quiet button-small"
                          type="button"
                          disabled={reviewingOrApplying}
                          aria-label={`Put back ${exclusionLabel(key)} everywhere`}
                          onClick={() => {
                            run(batch.everywhere(key, false));
                          }}
                        >
                          Put back everywhere
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
            <div class="groups">
              {members.map((member) => (
                <Member
                  key={member.repository}
                  member={member}
                  batch={batch}
                  reviewingOrApplying={reviewingOrApplying}
                  editDisabled={reviewingOrApplying || !batch.canEdit.value}
                  onEdit={
                    editor === undefined
                      ? undefined
                      : (about) => {
                          setEditing({ about });
                          run(batch.backToEdits());
                        }
                  }
                />
              ))}
            </div>
          </>
        )}
        {/* Before the action bar, so the bar stays the page's last child. */}
        {confirming && (
          <Confirm
            batch={batch}
            onClose={() => {
              setConfirming(false);
            }}
          />
        )}
        {state.kind !== 'editing' && (
          <div class="save-bar">
            <BarActions
              mainAction={
                <PendingButton
                  pending={state.kind === 'applying'}
                  class="button button-primary"
                  type="button"
                  disabled={state.kind !== 'reviewed' || (ready.length === 0 && !batch.canRecordWithoutChanges.value)}
                  onClick={() => {
                    if (batch.canRecordWithoutChanges.value) {
                      run(batch.apply());
                    } else {
                      setConfirming(true);
                    }
                  }}
                >
                  {batch.canRecordWithoutChanges.value
                    ? 'Mark as applied'
                    : ready.length === 0
                      ? 'Apply'
                      : `Apply to ${repositories(ready.length)}`}
                </PendingButton>
              }
              otherActions={
                <>
                  {discard}
                  {editor !== undefined && (
                    <button
                      class="button"
                      type="button"
                      disabled={reviewingOrApplying || !batch.canEdit.value}
                      onClick={() => {
                        setEditing(undefined);
                        run(batch.backToEdits());
                      }}
                    >
                      Back to edits
                    </button>
                  )}
                  <PendingButton
                    pending={reviewingAgain}
                    class="button"
                    type="button"
                    disabled={reviewingOrApplying || !batch.canReviewAgain.value}
                    onClick={() => {
                      run(reviewAgain(() => batch.reviewAgain()));
                    }}
                  >
                    Review again
                  </PendingButton>
                </>
              }
            />
          </div>
        )}
      </article>
    </div>
  );
}
