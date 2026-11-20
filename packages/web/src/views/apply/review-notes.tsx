import type { JSX } from 'preact';
import { useId } from 'preact/hooks';

import type { LinkedReviewNote, SkippedSettingRow } from '../../app/apply/comparison.js';

interface ReviewNotesProps {
  readonly notes: readonly LinkedReviewNote[];
  /** Goes back to the edits at what the note names; undefined where there are no edits to go back to. */
  readonly onEdit: ((about: NonNullable<LinkedReviewNote['about']>) => void) | undefined;
  /** While the review can't go back to its edits, as while it is under way. */
  readonly editDisabled: boolean;
  readonly class?: string;
}

/** The review's notes, each that names a setting or entry with **Edit**, which goes back to the edits at it. */
export function ReviewNotes({ notes, onEdit, editDisabled, class: className }: ReviewNotesProps): JSX.Element {
  const id = useId();
  return (
    <ul class={className}>
      {notes.map((note, index) => (
        <li key={note.text} class="review-note">
          <span id={`${id}-${String(index)}`}>{note.text}</span>
          {note.about !== undefined && onEdit !== undefined && (
            <button
              class="button button-small"
              type="button"
              aria-describedby={`${id}-${String(index)}`}
              disabled={editDisabled}
              onClick={() => {
                if (note.about !== undefined) {
                  onEdit(note.about);
                }
              }}
            >
              Edit
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

interface SkippedSettingProps {
  readonly row: SkippedSettingRow;
  readonly onEdit: ((about: SkippedSettingRow['about']) => void) | undefined;
  readonly editDisabled: boolean;
  /** Said after the setting in its **Edit** button's accessible name, as for a batch's repository. */
  readonly forWhom?: string;
}

/** A setting the apply skips, greyed out in place, with **Edit**, which goes back to the edits at it. */
export function SkippedSetting({ row, onEdit, editDisabled, forWhom }: SkippedSettingProps): JSX.Element {
  return (
    <li class="compare-row compare-row-skipped">
      <span class="compare-what">
        <strong>{row.label}</strong>
        <span class="mono small muted">{row.key}</span>
      </span>
      <span class="compare-values">
        <span class="visually-hidden">Skipped: the profile sets </span>
        <span class="struck">{row.value}</span>
      </span>
      <span class="small muted compare-skip-reason">{row.reason}</span>
      {onEdit !== undefined && (
        <button
          class="button button-quiet button-small"
          type="button"
          aria-label={`Edit ${row.label}${forWhom === undefined ? '' : `, for ${forWhom}`}`}
          disabled={editDisabled}
          onClick={() => {
            onEdit(row.about);
          }}
        >
          Edit
        </button>
      )}
    </li>
  );
}
