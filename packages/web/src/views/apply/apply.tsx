import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Spinner } from '../layout/loading.js';
import { PendingButton, usePendingAction } from '../layout/pending-button.js';

import { repottedAppInstallUrl } from '../../app/account/github-app.js';
import type { Apply } from '../../app/apply/apply.js';
import { type CompareRow, sectionTitles } from '../../app/apply/comparison.js';
import { repositoryAddress } from '../../app/navigation/addressed-repository.js';
import type { Router } from '../../app/navigation/router.js';
import { BarActions } from '../layout/action-bar.js';
import { useLeaveQuestion } from '../layout/leave-question.js';
import { Link } from '../layout/link.js';
import { run } from '../layout/run.js';
import { ProfileSettings } from '../profile-editor/profile-editor.js';
import { OwnershipChoices } from './ownership.js';

const kinds: Readonly<Record<CompareRow['kind'], string>> = { changes: 'Changes', adds: 'Adds', removes: 'Removes' };

function Row({ row, apply }: { readonly row: CompareRow; readonly apply: Apply }): JSX.Element {
  return (
    <li class="compare-row">
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
          aria-label={`Leave out ${row.label}, ${row.key}`}
          onClick={() => {
            run(apply.leaveOut(row.leaveOut ?? '', true));
          }}
        >
          Leave out
        </button>
      )}
    </li>
  );
}

function Confirm({ apply, onClose }: { readonly apply: Apply; readonly onClose: () => void }): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const state = apply.state.value;
  const changes = apply.counts.value.changes;
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog class="dialog" ref={dialog} aria-labelledby="apply-heading" onClose={onClose}>
      <form
        method="dialog"
        onSubmit={(event) => {
          if (event.submitter instanceof HTMLButtonElement && event.submitter.value === 'apply') {
            run(apply.apply());
          }
        }}
      >
        <h2 id="apply-heading">Apply to {state.kind === 'idle' ? '' : state.repository}?</h2>
        <p>
          This writes {changes === 1 ? 'the 1 change' : `the ${changes} changes`} you reviewed to the repository on
          GitHub. Repotted checks the repository first, and writes nothing if it changed since the review.
        </p>
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

interface ApplyProps {
  readonly apply: Apply;
  readonly router: Router;
}

export function ApplyPage({ apply, router }: ApplyProps): JSX.Element {
  const [reviewingAgain, reviewAgain] = usePendingAction();
  const [savingProfile, saveProfile] = usePendingAction();
  const [reviewing, review] = usePendingAction();
  const state = apply.state.value;
  const [confirming, setConfirming] = useState(false);
  useLeaveQuestion(router, () => {
    const current = apply.state.peek();
    if (current.kind === 'idle' || !apply.holdsOneOffEdits.peek()) {
      return undefined;
    }
    return {
      kind: 'one-off-edits',
      repositories: [current.repository],
      savable: current.kind === 'editing' && current.fromProfile && !current.builtIn,
    };
  });
  const back = (
    <Link router={router} to={state.kind === 'idle' ? '/' : repositoryAddress(state.repository)}>
      Back to repositories
    </Link>
  );
  if (state.kind === 'idle') {
    return (
      <div class="page">
        <div class="page-body">
          <h1>Apply a profile to a repository</h1>
          <p>Open a repository on the Repositories page, pick a profile, and choose Apply.</p>
          <p>{back}</p>
        </div>
      </div>
    );
  }
  const counts = apply.counts.value;
  const working = state.kind === 'reviewing' || state.kind === 'applying';
  const editor = apply.editor.value;
  const discard = (
    <button
      class="button button-quiet"
      type="button"
      disabled={working}
      onClick={() => {
        run(
          apply.close().then(() => {
            router.go('/');
          }),
        );
      }}
    >
      Discard apply
    </button>
  );
  return (
    <div class="page">
      <article class="page-body" aria-labelledby="apply-title">
        <p>{back}</p>
        <div class="page-heading">
          <div>
            <h1 id="apply-title">
              Apply {state.profileName === '' ? '' : `${state.profileName} `}to{' '}
              <span class="mono">{state.repository}</span>
            </h1>
            <p class="muted" role="status">
              {(state.kind === 'reviewing' || state.kind === 'applying') && <Spinner />}
              {state.kind === 'editing'
                ? state.fromProfile
                  ? 'Step 1 of 2: one-off edits. They apply on top of the profile for this apply only.'
                  : 'Step 1 of 2: the settings to change, this once. Nothing else on the repository is touched.'
                : state.kind === 'reviewing'
                  ? 'Reviewing changes…'
                  : state.kind === 'applying'
                    ? 'Writing to GitHub…'
                    : state.kind === 'failed'
                      ? "The apply couldn't be reviewed. Review again once that is put right, or discard the apply."
                      : state.kind === 'applied'
                        ? state.changes === 0
                          ? 'Nothing needed writing to GitHub. Its profiles are recorded as applied.'
                          : `${state.changes === 1 ? '1 change was' : `${state.changes} changes were`} written to GitHub.`
                        : counts.changes === 0
                          ? 'Step 2 of 2: nothing to apply. The repository already has what this apply sets.'
                          : `Step 2 of 2: ${counts.changes === 1 ? '1 change' : `${counts.changes} changes`}${
                              counts.locked === 0 ? '' : `, ${counts.locked} that GitHub would refuse`
                            }. Nothing is written until you apply.`}
            </p>
          </div>
        </div>
        {state.kind === 'failed' && (
          <p class="notice notice-problem" role="alert">
            {state.message}
          </p>
        )}
        {state.kind === 'editing' && editor !== undefined && (
          <>
            {apply.editError.value !== undefined && (
              <p class="notice notice-problem" role="alert">
                {apply.editError.value}
              </p>
            )}
            {state.leftOut.length > 0 && (
              <div class="notice">
                <p>This apply leaves these out, so they can't be edited here until they are put back:</p>
                <ul class="left-out">
                  {state.leftOut.map((key) => (
                    <li key={key}>
                      <span class="mono small">{key}</span>{' '}
                      <button
                        class="link"
                        type="button"
                        aria-label={`Put back ${key}`}
                        onClick={() => {
                          run(apply.leaveOut(key, false));
                        }}
                      >
                        Put back
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <OwnershipChoices
              value={state.authoritative}
              onChange={(sections) => {
                run(apply.setAuthoritative(sections));
              }}
            />
            <ProfileSettings
              key={editor.file}
              name={state.profileName}
              editor={editor}
              ownerTypeHasPushRulesets={editor.ownerType.value !== 'user'}
              saving={{
                save: () => editor.save((work) => work()),
                discardDraft: () => Promise.resolve(),
                onGitHub: false,
                saveLabel: 'Save edits',
                extraBarActions: (
                  <>
                    {discard}
                    {state.fromProfile && !state.builtIn && (
                      <PendingButton
                        pending={savingProfile}
                        class="button"
                        type="button"
                        disabled={
                          savingProfile ||
                          reviewing ||
                          editor.saving.value ||
                          (editor.dirty.value && !editor.canSave.value)
                        }
                        onClick={() => {
                          run(saveProfile(() => apply.saveToProfile()));
                        }}
                      >
                        Save edits to profile
                      </PendingButton>
                    )}
                  </>
                ),
                primaryActionInsteadOfSave: (
                  <PendingButton
                    pending={reviewing}
                    class="button button-primary"
                    type="button"
                    disabled={
                      savingProfile || reviewing || editor.saving.value || (editor.dirty.value && !editor.canSave.value)
                    }
                    onClick={() => {
                      run(review(() => apply.review()));
                    }}
                  >
                    Review changes
                  </PendingButton>
                ),
              }}
            />
          </>
        )}
        {state.kind === 'reviewed' && (
          <>
            {(state.plan.authoritative?.length ?? 0) > 0 && (
              <p class="notice notice-drift">
                Full ownership: {state.plan.authoritative?.map((section) => sectionTitles[section]).join(', ')}. Every
                removal is included below.
              </p>
            )}
            {state.notice !== undefined && (
              <p class="notice notice-problem" role="alert">
                {state.notice}
              </p>
            )}
            {state.assignment.kind === 'add' && (
              <div class="assign-choice">
                <label class="check">
                  <input
                    type="checkbox"
                    checked={apply.addToRepositoryProfiles.value}
                    onChange={(event) => {
                      apply.addToRepositoryProfiles.value = event.currentTarget.checked;
                    }}
                  />
                  <span>
                    Add <span class="mono">{state.assignment.profileName}</span> to this repository's profiles when it
                    applies
                  </span>
                </label>
                <p class="muted small">
                  {state.assignment.recordsVersions
                    ? 'Deselect it for a one-time apply. The repository keeps no record of the profile.'
                    : 'Deselect it for a one-time apply. Since this apply leaves some of the profile out, edits it, or skips a setting GitHub refused to show, the profile is added as not applied yet.'}
                </p>
              </div>
            )}
            {state.assignment.kind === 'own' && (
              <p class="muted small">
                {state.assignment.recordsVersions
                  ? "Applying records this version of the repository's profiles as applied."
                  : "This apply leaves some of the repository's profiles out, edits them, or skips a setting GitHub refused to show, so it doesn't record them as applied."}
              </p>
            )}
            {state.warnings.length > 0 && (
              <div class="notice notice-drift">
                <p>Review notes:</p>
                <ul>
                  {state.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            )}
            {state.skippedDrafts.length > 0 && (
              <div class="notice">
                <p>The profile's draft is left out. It holds:</p>
                <ul>
                  {state.skippedDrafts.map((skipped) => (
                    <li key={skipped}>{skipped}</li>
                  ))}
                </ul>
              </div>
            )}
            {counts.locked > 0 && (
              <div class="notice notice-drift">
                <p>
                  Apply waits while GitHub would refuse a change: it would stop there and leave the changes after it
                  unwritten. Leave each such change out, or grant what it needs and review again.
                </p>
                {state.appAccess !== undefined && (
                  <p class="notice-actions">
                    <a
                      class="button button-small"
                      href={state.appAccess === 'install' ? repottedAppInstallUrl : state.appAccess.settings}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {state.appAccess === 'install' ? 'Install the App' : 'Review App access'}
                    </a>
                  </p>
                )}
              </div>
            )}
            <div class="groups">
              {state.sections.map((section) => (
                <section key={section.section} class="settings-group" aria-label={section.title}>
                  <h2>{section.title}</h2>
                  <ul class="rows" role="list">
                    {section.rows.map((row) => (
                      <Row key={`${row.label} ${row.key}`} row={row} apply={apply} />
                    ))}
                  </ul>
                </section>
              ))}
              {state.leftOut.length > 0 && (
                <section class="settings-group" aria-label="Left out of this apply">
                  <div>
                    <h2>Left out of this apply</h2>
                    <p class="muted small">The profile keeps these. Only this apply leaves them as they are.</p>
                  </div>
                  <ul class="rows" role="list">
                    {state.leftOut.map((key) => (
                      <li key={key} class="compare-row">
                        <span class="compare-what mono">{key}</span>
                        <button
                          class="button button-quiet button-small"
                          type="button"
                          aria-label={`Put back ${key}`}
                          onClick={() => {
                            run(apply.leaveOut(key, false));
                          }}
                        >
                          Put back
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          </>
        )}
        {/* Before the action bar, so the bar stays the page's last child. */}
        {confirming && (
          <Confirm
            apply={apply}
            onClose={() => {
              setConfirming(false);
            }}
          />
        )}
        {state.kind !== 'applied' && state.kind !== 'editing' && (
          <div class="save-bar">
            <BarActions
              mainAction={
                apply.canRecordWithoutChanges.value ? (
                  <button
                    class="button button-primary"
                    type="button"
                    onClick={() => {
                      run(apply.recordWithoutChanges());
                    }}
                  >
                    Record as applied
                  </button>
                ) : (
                  <PendingButton
                    pending={state.kind === 'applying'}
                    class="button button-primary"
                    type="button"
                    disabled={!apply.canApply.value}
                    onClick={() => {
                      setConfirming(true);
                    }}
                  >
                    Apply
                  </PendingButton>
                )
              }
              otherActions={
                <>
                  {discard}
                  <button
                    class="button"
                    type="button"
                    disabled={working}
                    onClick={() => {
                      run(apply.backToEdits());
                    }}
                  >
                    Back to edits
                  </button>
                  <PendingButton
                    pending={reviewingAgain}
                    class="button"
                    type="button"
                    disabled={working}
                    onClick={() => {
                      run(reviewAgain(() => apply.reviewAgain()));
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
