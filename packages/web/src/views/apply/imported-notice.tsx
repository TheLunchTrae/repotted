import type { JSX } from 'preact';

import type { ImportedEdits } from '../../app/apply/apply.js';

/** Over a one-time apply's edits when they came from a file. */
export function ImportedNotice({ imported }: { readonly imported: ImportedEdits | undefined }): JSX.Element | null {
  if (imported === undefined) {
    return null;
  }
  return (
    <p class="notice">
      <strong>Imported from {imported.file}.</strong> These settings apply this once and aren't saved to your profiles.
      {imported.leftOutDrafts && ' The drafts in the file are left out, as every apply leaves drafts out.'}
    </p>
  );
}
