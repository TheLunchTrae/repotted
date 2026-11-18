import type { JSX } from 'preact';
import { useId } from 'preact/hooks';

import type { ProfileEditor } from '../../app/profile-editor/profile-editor.js';
import { definitionTypes } from '../../app/profiles/definition-types.js';
import type { ReusableSection } from '../../app/profiles/save-reusable-definitions.js';

interface ReusableDefinitionOptionProps {
  readonly editor: ProfileEditor;
  readonly section: ReusableSection;
  readonly entryKey: string;
  readonly defaultName: string;
}

export function ReusableDefinitionOption({
  editor,
  section,
  entryKey,
  defaultName,
}: ReusableDefinitionOptionProps): JSX.Element | null {
  const id = useId();
  if (!editor.canReuse.value) {
    return null;
  }
  const library = definitionTypes.find((item) => item.section === section);
  if (library === undefined) {
    return null;
  }
  const noun = section === 'actions_policies' ? library.label : library.label.toLowerCase();
  const key = entryKey;
  const name = editor.reusableName(key);
  const problem = editor.reusableProblem.value;
  return (
    <fieldset class="reusable-definition-option" disabled={editor.saving.value}>
      <label class="check check-row">
        <input
          type="checkbox"
          checked={name !== undefined}
          onChange={(event) => editor.setReusable(section, key, event.currentTarget.checked ? defaultName : undefined)}
        />
        <span>
          Also save as a reusable {noun}
          <span class="muted small check-note">
            Create a shared definition and link it to this profile when you save.
          </span>
        </span>
      </label>
      {name !== undefined && (
        <label class="form-field">
          <span>Reusable definition name</span>
          <input
            class="field"
            value={name}
            aria-invalid={problem?.key === key}
            aria-describedby={problem?.key === key ? id : undefined}
            onInput={(event) => editor.setReusable(section, key, event.currentTarget.value)}
          />
          {problem?.key === key && (
            <span id={id} class="problem small" role="alert">
              {problem.message}
            </span>
          )}
        </label>
      )}
    </fieldset>
  );
}
