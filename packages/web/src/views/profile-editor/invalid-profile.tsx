import type { JSX } from 'preact';

import { type EditorPlace, nameOfPlace, type ProfileEditor } from '../../app/profile-editor/profile-editor.js';

interface InvalidProfileProps {
  readonly editor: ProfileEditor;
  readonly onGoTo: (place: EditorPlace) => void;
}

/** What makes the profile file invalid, each problem with a link to the setting or entry it is in. */
export function InvalidProfile({ editor, onGoTo }: InvalidProfileProps): JSX.Element {
  return (
    <div class="notice notice-problem" role="alert">
      <p>This profile isn't valid:</p>
      <ul>
        {editor.configurationProblems.value.map((problem) => {
          const place = editor.placeOfConfigurationProblem(problem);
          return (
            <li key={`${problem.file} ${problem.path.map(String).join('.')} ${problem.message}`}>
              <button
                class="link"
                type="button"
                onClick={() => {
                  onGoTo(place);
                }}
              >
                {nameOfPlace(place)}
              </button>
              : {problem.message}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
