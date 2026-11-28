import type { JSX } from 'preact';
import { useRef, useState } from 'preact/hooks';

import { PendingButton, usePendingAction } from '../layout/pending-button.js';
import { run } from '../layout/run.js';
import { ImportProblem } from '../profiles/import.js';

/**
 * Starts a one-time apply that saves nothing: **Edit** opens on no edits,
 * and **Import** on what a chosen profile or definition file sets.
 * `onImport` says why when the file can't be applied.
 */
export function ChangeOnce({
  onEdit,
  onImport,
}: {
  readonly onEdit: () => void;
  readonly onImport: (fileName: string, text: string) => Promise<string | undefined>;
}): JSX.Element {
  const input = useRef<HTMLInputElement>(null);
  const [reading, read] = usePendingAction();
  const [problem, setProblem] = useState<string | undefined>(undefined);
  return (
    <div class="panel-form">
      <strong>Change settings once</strong>
      <p class="muted small">
        Edit them here, or import a profile, ruleset, environment, or Actions policy. Nothing is saved to your profiles.
      </p>
      <div class="panel-actions">
        <button class="button" type="button" onClick={onEdit}>
          Edit
        </button>
        <PendingButton
          pending={reading}
          class="button"
          type="button"
          onClick={() => {
            input.current?.click();
          }}
        >
          Import
        </PendingButton>
      </div>
      <input
        ref={input}
        class="visually-hidden"
        type="file"
        accept=".yaml,.yml,.json"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const chosen = event.currentTarget;
          const file = chosen.files?.[0];
          // The same file can be chosen again after a problem or a cancel.
          chosen.value = '';
          if (file === undefined) {
            return;
          }
          setProblem(undefined);
          run(
            read(async () => {
              setProblem(await onImport(file.name, await file.text()));
            }),
          );
        }}
      />
      {problem !== undefined && (
        <ImportProblem
          problem={problem}
          onClose={() => {
            setProblem(undefined);
          }}
        />
      )}
    </div>
  );
}
