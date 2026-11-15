import type { JSX } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';

import type { BatchDone, BatchScope, ProfileEditor } from '../../app/profile-editor/profile-editor.js';
import { run } from '../layout/run.js';

interface BatchAction {
  readonly label: string;
  readonly count: number;
  /** What the count counts, for a screen reader: "settings", or "rulesets". */
  readonly counted: string;
  readonly act: () => Promise<void>;
}

interface BatchActionsProps {
  readonly editor: ProfileEditor;
  readonly scope: BatchScope;
  /** The group, as its heading names it, where the actions sit among other groups. */
  readonly name?: string;
  readonly actions: readonly BatchAction[];
  readonly describeDone: (done: BatchDone) => string;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function describeSettingsDone(done: BatchDone): string {
  if (done.action === 'reset') {
    return `${plural(done.count, 'change is', 'changes are')} back to what is saved.`;
  }
  const hidden = done.hiddenByGitHub > 0 ? `, ${done.hiddenByGitHub} of them hidden by GitHub` : '';
  return `${plural(done.count, 'setting is', 'settings are')} no longer set in this profile${hidden}.`;
}

export function describeEntriesDone(one: string, many: string): (done: BatchDone) => string {
  return (done) =>
    done.action === 'reset'
      ? `${plural(done.count, `${one} is`, `${many} are`)} back to what is saved.`
      : `${plural(done.count, `${one} is`, `${many} are`)} out of the profile.`;
}

/**
 * Sits in a heading row that wraps: the actions, which show only when they
 * would change something, and once one is pressed, what it did with Undo
 * on a line of its own.
 */
export function BatchActions({ editor, scope, name, actions, describeDone }: BatchActionsProps): JSX.Element {
  const done = editor.batchDone.value;
  const doneHere = done?.scope === scope ? done : undefined;
  const shown = actions.filter((action) => action.count > 0);
  const undo = useRef<HTMLButtonElement>(null);
  const doneId = useId();
  const actionsHolder = useRef<HTMLDivElement>(null);
  const [focusUndoOnceDone, setFocusUndoOnceDone] = useState(false);
  const [focusActionsAfterUndo, setFocusActionsAfterUndo] = useState(false);
  // The pressed action goes once it has nothing left to change, so the keyboard moves to Undo, which reads out what
  // was done, and back to the actions after it.
  useEffect(() => {
    if (focusUndoOnceDone && doneHere !== undefined) {
      undo.current?.focus();
      setFocusUndoOnceDone(false);
    }
  }, [focusUndoOnceDone, doneHere]);
  useEffect(() => {
    if (focusActionsAfterUndo && doneHere === undefined) {
      actionsHolder.current?.querySelector<HTMLButtonElement>('button')?.focus();
      setFocusActionsAfterUndo(false);
    }
  }, [focusActionsAfterUndo, doneHere]);
  return (
    <>
      {shown.length > 0 && (
        <div class="batch-actions" ref={actionsHolder}>
          {shown.map((action) => (
            <button
              key={action.label}
              class="button button-quiet button-small"
              type="button"
              disabled={editor.saving.value}
              aria-label={`${action.label}: ${action.count} ${action.counted}${name === undefined ? '' : ` in ${name}`}`}
              onClick={() => {
                setFocusUndoOnceDone(true);
                run(action.act());
              }}
            >
              {action.label} <span class="count">({action.count})</span>
            </button>
          ))}
        </div>
      )}
      {doneHere !== undefined && (
        <div class="notice batch-done">
          <p class="small" id={doneId}>
            {describeDone(doneHere)} Nothing changes until you save.
          </p>
          <button
            class="button button-small"
            type="button"
            ref={undo}
            aria-describedby={doneId}
            disabled={editor.saving.value}
            onClick={() => {
              setFocusActionsAfterUndo(true);
              run(editor.undoBatch());
            }}
          >
            Undo
          </button>
        </div>
      )}
    </>
  );
}
