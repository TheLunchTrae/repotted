import type { JSX } from 'preact';
import { PendingButton } from '../layout/pending-button.js';

import type { ProfileEditor } from '../../app/profile-editor/profile-editor.js';
import { BarActions } from '../layout/action-bar.js';
import { run } from '../layout/run.js';

export function RepairProfile({
  editor,
  save,
}: {
  readonly editor: ProfileEditor;
  readonly save: () => Promise<void>;
}): JSX.Element | null {
  const repair = editor.repair.value;
  if (repair === undefined) {
    return null;
  }
  return (
    <section class="groups" aria-labelledby="repair-heading">
      <div class="form-field">
        <h2 id="repair-heading">Fix the profile</h2>
        <p class="muted">
          Correct the YAML syntax below. Configuration errors can be fixed in the settings after saving. Your
          corrections stay here when you visit another page in this tab.
        </p>
        <label for="repair-yaml">Profile YAML</label>
        <textarea
          id="repair-yaml"
          class="field field-lines mono"
          rows={18}
          spellcheck={false}
          value={repair.text.value}
          aria-invalid={repair.problem.value !== undefined}
          aria-describedby="repair-problem"
          onInput={(event) => {
            run(repair.type(event.currentTarget.value));
          }}
        />
        <p id="repair-problem" class="problem small" role="status">
          {repair.checking.value ? 'Checking…' : repair.problem.value}
        </p>
        <p class="muted small">Reload discards your unsaved changes and reads the saved file again.</p>
      </div>
      <div class="save-bar">
        {repair.saveError.value !== undefined && (
          <p class="problem" role="alert">
            {repair.saveError.value}
          </p>
        )}
        <span class="muted small" role="status">
          {repair.saving.value
            ? 'Saving…'
            : editor.dirty.value
              ? 'You have changes that are not saved.'
              : 'Correct the profile before saving.'}
        </span>
        <BarActions
          mainAction={
            <PendingButton
              pending={repair.saving.value}
              class="button button-primary"
              type="button"
              disabled={!repair.canSave.value}
              onClick={() => {
                run(save());
              }}
            >
              Save
            </PendingButton>
          }
          otherActions={
            <button
              class="button button-quiet"
              type="button"
              disabled={repair.saving.value}
              onClick={() => {
                run(editor.resetAll());
              }}
            >
              Reload
            </button>
          }
        />
      </div>
    </section>
  );
}
