import type { JSX } from 'preact';
import { useId, useRef, useState } from 'preact/hooks';

import type { ProfileEditor, SaveProblem } from '../../app/profile-editor/profile-editor.js';
import { run } from '../layout/run.js';
import { describeValue } from './describe-value.js';

interface SaveProblemsProps {
  readonly editor: ProfileEditor;
  readonly onGoTo: (problem: SaveProblem) => void;
}

function resetOne(editor: ProfileEditor, problem: SaveProblem): Promise<void> {
  const { place } = problem;
  if (place.kind === 'setting') {
    return editor.reset(place.field);
  }
  return place.kind === 'entry' ? editor.resetEntry(place.row) : Promise.resolve();
}

function where(problem: SaveProblem): string {
  const { place } = problem;
  return place.kind === 'setting' && place.hiddenWhile !== undefined
    ? `${problem.where} · hidden while ${place.hiddenWhile.field.label} is ${describeValue(place.hiddenWhile.field, place.hiddenWhile.value)}`
    : problem.where;
}

/**
 * The save bar's count of what holds Save back, which opens a list of each
 * thing with a way to go to it or reset it. A hidden setting can't be gone
 * to, so it is only reset; the engine's refusal of the changes together has
 * neither, since no one change is to blame.
 */
export function SaveProblems({ editor, onGoTo }: SaveProblemsProps): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const id = useId();
  const problems = editor.problemsBlockingSave.value;
  const count = problems.length;
  if (count === 0) {
    return null;
  }
  const close = (): void => {
    setOpen(false);
    toggle.current?.focus();
  };
  const resettable = problems.filter((problem) => problem.place.kind !== 'profile').length;
  return (
    <>
      {open && (
        <section
          id={`${id}-list`}
          class="fix-summary bar-summary"
          aria-labelledby={`${id}-heading`}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              close();
            }
          }}
        >
          <div class="fix-summary-head">
            <h2 id={`${id}-heading`}>
              {count === 1 ? '1 thing to fix before you save' : `${count} things to fix before you save`}
            </h2>
            {resettable > 1 && (
              <button
                class="button button-quiet button-small"
                type="button"
                onClick={() => {
                  run(editor.resetEverythingBlockingSave());
                }}
              >
                Reset all
              </button>
            )}
          </div>
          {editor.canSaveAsDraft.value && <p class="muted small">Or keep your changes as a draft.</p>}
          <ul class="fix-list">
            {problems.map((problem) => {
              const hidden = problem.place.kind === 'setting' && problem.place.hiddenWhile !== undefined;
              return (
                <li key={problem.key} class="fix-item">
                  <div class="fix-text">
                    <strong>{problem.name}</strong>
                    <span>{problem.message}</span>
                    <span class="fix-where">{where(problem)}</span>
                  </div>
                  {problem.place.kind !== 'profile' && (
                    <div class="fix-actions">
                      {!hidden && (
                        <button
                          class="button button-small"
                          type="button"
                          onClick={() => {
                            setOpen(false);
                            onGoTo(problem);
                          }}
                        >
                          Go to it
                        </button>
                      )}
                      <button
                        class={hidden ? 'button button-small' : 'button button-quiet button-small'}
                        type="button"
                        aria-label={`Reset ${problem.name}`}
                        onClick={() => {
                          run(resetOne(editor, problem));
                        }}
                      >
                        Reset
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <button
        class="button button-quiet bar-problems"
        type="button"
        ref={toggle}
        aria-expanded={open}
        aria-controls={`${id}-list`}
        onClick={() => {
          setOpen(!open);
        }}
      >
        {count === 1 ? '1 thing to fix' : `${count} things to fix`}
        <span aria-hidden="true">{open ? '▾' : '▴'}</span>
      </button>
    </>
  );
}
