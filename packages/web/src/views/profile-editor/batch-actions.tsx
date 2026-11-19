import type { JSX } from 'preact';
import { useCallback, useEffect, useId, useRef, useState } from 'preact/hooks';

import type { BatchDone, BatchScope, ProfileEditor } from '../../app/profile-editor/profile-editor.js';
import { run } from '../layout/run.js';

export interface BatchAction {
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
  return (done) => {
    const counted = plural(done.count, `${one} is`, `${many} are`);
    if (done.action === 'reset') {
      return `${counted} back to what is saved.`;
    }
    return done.action === 'put-back' ? `${counted} back in the profile.` : `${counted} out of the profile.`;
  };
}

export function describePatternsDone(done: BatchDone): string {
  return `${plural(done.count, 'pattern is', 'patterns are')} off the list.`;
}

export function describeProfileResetDone(done: BatchDone): string {
  return `${plural(done.count, 'unsaved change was', 'unsaved changes were')} discarded.`;
}

interface BatchUndoNoticeProps {
  readonly editor: ProfileEditor;
  readonly scope: BatchScope;
  readonly describeDone: (done: BatchDone) => string;
  /** False where the action left nothing to save, as the save bar's Reset does. */
  readonly changesWaitForSave?: boolean;
  /** Set once the action was pressed here, so the keyboard moves to Undo, which reads out what was done. */
  readonly focusUndo: boolean;
  readonly onUndoFocused: () => void;
  readonly onUndo: () => void;
}

/** What the last batch action pressed in this place did, with Undo, while nothing else has changed since. */
export function BatchUndoNotice({
  editor,
  scope,
  describeDone,
  changesWaitForSave = true,
  focusUndo,
  onUndoFocused,
  onUndo,
}: BatchUndoNoticeProps): JSX.Element | null {
  const done = editor.batchDone.value;
  const doneHere = done?.scope === scope ? done : undefined;
  const undo = useRef<HTMLButtonElement>(null);
  const doneId = useId();
  useEffect(() => {
    if (focusUndo && doneHere !== undefined) {
      undo.current?.focus();
      onUndoFocused();
    }
  }, [focusUndo, doneHere, onUndoFocused]);
  if (doneHere === undefined) {
    return null;
  }
  return (
    <div class="notice batch-done">
      <p class="small" id={doneId}>
        {describeDone(doneHere)}
        {changesWaitForSave && ' Nothing changes until you save.'}
      </p>
      <button
        class="button button-small"
        type="button"
        ref={undo}
        aria-describedby={doneId}
        disabled={editor.saving.value}
        onClick={() => {
          onUndo();
          run(editor.undoBatch());
        }}
      >
        Undo
      </button>
    </div>
  );
}

/**
 * Sits in a row that wraps: the actions, which show only when they would
 * change something, and once one is pressed, what it did with Undo on a
 * line of its own.
 */
export function BatchActions({ editor, scope, name, actions, describeDone }: BatchActionsProps): JSX.Element {
  const doneHere = editor.batchDone.value?.scope === scope;
  const shown = actions.filter((action) => action.count > 0);
  const actionsHolder = useRef<HTMLDivElement>(null);
  const [focusUndoOnceDone, setFocusUndoOnceDone] = useState(false);
  const [focusActionsAfterUndo, setFocusActionsAfterUndo] = useState(false);
  const undoFocused = useCallback(() => {
    setFocusUndoOnceDone(false);
  }, []);
  const undone = useCallback(() => {
    setFocusActionsAfterUndo(true);
  }, []);
  // The pressed action goes once it has nothing left to change, so the keyboard comes back to the actions after Undo.
  useEffect(() => {
    if (focusActionsAfterUndo && !doneHere) {
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
      <BatchUndoNotice
        editor={editor}
        scope={scope}
        describeDone={describeDone}
        focusUndo={focusUndoOnceDone}
        onUndoFocused={undoFocused}
        onUndo={undone}
      />
    </>
  );
}
