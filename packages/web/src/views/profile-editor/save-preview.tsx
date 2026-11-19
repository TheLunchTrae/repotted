import { Fragment, type JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import type { DiffFold, DiffLine } from '../../app/profile-editor/line-diff.js';
import type { ProfileEditor, SavePreview } from '../../app/profile-editor/profile-editor.js';
import { run } from '../layout/run.js';
import type { EditorSaving } from './profile-editor.js';

function count(amount: number, noun: string): string {
  return amount === 1 ? `1 ${noun}` : `${amount} ${noun}s`;
}

function message({ draftChangeCount: drafted, unsavedChangeCount: unsaved }: SavePreview): string {
  if (drafted === 0) {
    return 'What applies now against what applies once you save. Save as draft keeps these changes without applying them.';
  }
  if (unsaved === 0) {
    return 'What applies now against what applies once you save the draft.';
  }
  return `What applies now against what applies once you save: the draft, and ${count(unsaved, 'change')} not saved yet. Save as draft keeps them all without applying them.`;
}

function Line({ line }: { readonly line: DiffLine }): JSX.Element {
  if (line.kind === 'added') {
    return (
      <ins class="diff-line diff-added">
        <span>+ </span>
        {line.text}
      </ins>
    );
  }
  if (line.kind === 'removed') {
    return (
      <del class="diff-line diff-removed">
        <span>- </span>
        {line.text}
      </del>
    );
  }
  return (
    <span class="diff-line">
      <span aria-hidden="true">{'  '}</span>
      {line.text}
    </span>
  );
}

export function Diff({
  lines,
  label = 'Changes to what applies',
}: {
  readonly lines: readonly (DiffLine | DiffFold)[];
  readonly label?: string;
}): JSX.Element {
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const region = useRef<HTMLDivElement>(null);
  return (
    <div class="code diff" role="region" tabIndex={0} aria-label={label} ref={region}>
      {lines.map((line, index) =>
        line.kind !== 'fold' ? (
          // A diff's lines are made once for a preview and never move, so each is known by its place.
          <Line key={index} line={line} />
        ) : open.has(index) ? (
          <Fragment key={index}>
            {line.lines.map((text, at) => (
              <Line key={at} line={{ kind: 'same', text }} />
            ))}
          </Fragment>
        ) : (
          <button
            key={index}
            class="diff-fold"
            type="button"
            onClick={() => {
              setOpen(new Set([...open, index]));
              // The button goes with its fold, so the keyboard moves to the lines it opened.
              region.current?.focus();
            }}
          >
            Show {count(line.lines.length, 'unchanged line')}
          </button>
        ),
      )}
    </div>
  );
}

interface SavePreviewProps {
  readonly name: string;
  readonly editor: ProfileEditor;
  readonly saving: EditorSaving;
  readonly preview: SavePreview;
}

export function SavePreviewDialog({ name, editor, saving, preview }: SavePreviewProps): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    // A dialog taken away with its page, as by the browser's Back, closes its preview too.
    return () => {
      editor.closePreview();
    };
  }, [editor]);
  return (
    <dialog
      class="dialog dialog-wide"
      ref={dialog}
      aria-labelledby="preview-heading"
      onClose={() => {
        editor.closePreview();
      }}
    >
      <form
        method="dialog"
        onSubmit={(event) => {
          const pressed = event.submitter instanceof HTMLButtonElement ? event.submitter.value : '';
          if (pressed === 'applies' || pressed === 'draft') {
            run(saving.save(pressed));
          }
        }}
      >
        <h2 id="preview-heading">Preview changes to {name}</h2>
        <p class="muted small">{message(preview)}</p>
        {(preview.reusableDefinitions?.length ?? 0) > 0 && (
          <p class="muted small">
            Saving creates and links reusable definitions:{' '}
            {preview.reusableDefinitions?.map((definition) => definition.name).join(', ')}.
          </p>
        )}
        {preview.changedLineCount === 0 ? (
          <p class="notice">Saving applies nothing new: what the profile applies stays as it is.</p>
        ) : (
          <Diff lines={preview.lines} />
        )}
        {(preview.removedUnknownFields?.length ?? 0) > 0 && (
          <p class="muted small">Saving removes unrecognized keys: {preview.removedUnknownFields?.join(', ')}.</p>
        )}
        {(preview.rulesetsWithSettledBypassActorIds?.length ?? 0) > 0 && (
          <p class="muted small">
            Saving sets bypass actor IDs that GitHub ignores to the ones it keeps, in:{' '}
            {preview.rulesetsWithSettledBypassActorIds?.join(', ')}.
          </p>
        )}
        <div class="form-actions">
          <button class="button button-primary" type="submit" value="applies" disabled={!editor.canSave.value}>
            Save
          </button>
          <button class="button" type="submit" value="draft" disabled={!editor.canSaveAsDraft.value}>
            Save as draft
          </button>
          <button class="button button-quiet" type="submit" value="close" autofocus>
            Close
          </button>
        </div>
      </form>
    </dialog>
  );
}
