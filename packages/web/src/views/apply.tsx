import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import type { Apply } from '../app/apply.js';
import type { CompareRow } from '../app/comparison.js';
import { installUrl } from '../app/github-app.js';
import type { Router } from '../app/router.js';
import { Link } from './link.js';
import { ProfileSettings } from './profile-editor.js';
import { run } from './run.js';

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
      {row.lock !== undefined && <span class="pill pill-remove">{row.lock}</span>}
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

/** Asks once more before anything is written, with what will be. */
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
          <button class="button button-primary" type="submit" value="apply">
            Apply now
          </button>
          {/* The dialog opens with the keyboard on Cancel, so Enter never applies by itself. */}
          <button class="button button-quiet" type="submit" value="cancel" autofocus>
            Cancel
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

/** One apply of a profile to a repository: what it would change, what is left out of it, and the step that writes it. */
export function ApplyPage({ apply, router }: ApplyProps): JSX.Element {
  const state = apply.state.value;
  const [confirming, setConfirming] = useState(false);
  const back = (
    <Link router={router} to="/">
      Back to repositories
    </Link>
  );
  if (state.kind === 'idle') {
    return (
      <div class="page">
        <div class="page-body">
          <h1>Apply a profile to a repository</h1>
          <p>Select a repository on the Repositories page, pick a profile, and choose Apply.</p>
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
          apply.discard().then(() => {
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
              Apply {state.profile === '' ? '' : `${state.profile} `}to <span class="mono">{state.repository}</span>
            </h1>
            <p class="muted" role="status">
              {state.kind === 'editing'
                ? state.fromProfile
                  ? 'Step 1 of 2: one-off edits. They apply on top of the profile for this apply only.'
                  : 'Step 1 of 2: the settings to change, this once. Nothing else on the repository is touched.'
                : state.kind === 'reviewing'
                  ? 'One moment…'
                  : state.kind === 'applying'
                    ? 'Writing to GitHub…'
                    : state.kind === 'unfinished'
                      ? 'An apply here is not finished.'
                      : state.kind === 'failed'
                        ? "The apply couldn't be reviewed. Review again once that is put right, or discard the apply."
                        : state.kind === 'applied'
                          ? `${state.changes === 1 ? '1 change was' : `${state.changes} changes were`} written to GitHub.`
                          : counts.changes === 0
                            ? 'Step 2 of 2: nothing to apply. The repository already has what this apply sets.'
                            : `Step 2 of 2: ${counts.changes === 1 ? '1 change' : `${counts.changes} changes`}${
                                counts.locked === 0 ? '' : `, ${counts.locked} that GitHub would refuse`
                              }. Nothing is written until you apply.`}
            </p>
          </div>
        </div>
        {state.kind === 'unfinished' && (
          <div class="form-actions">
            <button
              class="button button-primary"
              type="button"
              onClick={() => {
                run(apply.resume());
              }}
            >
              Pick it up
            </button>
            <button
              class="button"
              type="button"
              onClick={() => {
                run(apply.startOver());
              }}
            >
              Start over with {state.profile}
            </button>
          </div>
        )}
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
            <ProfileSettings
              key={editor.file}
              name={state.profile}
              editor={editor}
              pushes={editor.ownerType.value !== 'user'}
              saving={{
                save: () => editor.save((work) => work()),
                discardDraft: () => Promise.resolve(),
                onGitHub: false,
                saveLabel: 'Save edits',
                more: (
                  <>
                    {discard}
                    {state.fromProfile && (
                      <button
                        class="button"
                        type="button"
                        disabled={editor.saving.value}
                        onClick={() => {
                          run(apply.saveToProfile());
                        }}
                      >
                        Save edits to profile
                      </button>
                    )}
                    <button
                      class="button button-primary"
                      type="button"
                      disabled={editor.saving.value || (editor.dirty.value && !editor.canSave.value)}
                      onClick={() => {
                        run(apply.review());
                      }}
                    >
                      Review changes
                    </button>
                  </>
                ),
              }}
            />
          </>
        )}
        {state.kind === 'reviewed' && (
          <>
            {state.notice !== undefined && (
              <p class="notice notice-problem" role="alert">
                {state.notice}
              </p>
            )}
            {state.warnings.length > 0 && (
              <div class="notice notice-drift">
                <p>The review left some things out:</p>
                <ul>
                  {state.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            )}
            {state.skipped.length > 0 && (
              <div class="notice">
                <p>The profile's draft is left out. It holds:</p>
                <ul>
                  {state.skipped.map((skipped) => (
                    <li key={skipped} class="mono small">
                      {skipped}
                    </li>
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
                      href={state.appAccess === 'install' ? installUrl : state.appAccess.settings}
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
        {state.kind !== 'applied' && state.kind !== 'unfinished' && state.kind !== 'editing' && (
          <div class="save-bar">
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
            <button
              class="button"
              type="button"
              disabled={working}
              onClick={() => {
                run(apply.reviewAgain());
              }}
            >
              Review again
            </button>
            <button
              class="button button-primary"
              type="button"
              disabled={!apply.canApply.value}
              onClick={() => {
                setConfirming(true);
              }}
            >
              Apply
            </button>
          </div>
        )}
        {confirming && (
          <Confirm
            apply={apply}
            onClose={() => {
              setConfirming(false);
            }}
          />
        )}
      </article>
    </div>
  );
}
