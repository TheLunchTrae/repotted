import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import type { OwnerChoice, ProfileEditor } from '../app/profile-editor.js';
import type { Profiles } from '../app/profiles.js';
import { run } from './run.js';

const choices: readonly { readonly type: OwnerChoice; readonly label: string; readonly help: string }[] = [
  { type: 'user', label: 'Personal accounts', help: 'Settings only organizations have stay hidden.' },
  {
    type: 'organization',
    label: 'Organizations',
    help: 'Every setting. The ones only GitHub Enterprise Cloud has are marked.',
  },
  {
    type: 'any',
    label: 'Any owner',
    help: "For a base profile that both kinds extend. GitHub skips what a repository's owner doesn't have.",
  },
];

const changeLabels: Readonly<Record<OwnerChoice, string>> = {
  user: 'Change to personal accounts',
  organization: 'Change to organizations',
  any: 'Change to any owner',
};

interface OwnerTypeProps {
  readonly editor: ProfileEditor;
  readonly profiles: Profiles;
  readonly onClose: () => void;
}

/** Picks the kind of owner a profile is for, and says what the change would leave not managed before it writes. */
export function OwnerTypeDialog({ editor, profiles, onClose }: OwnerTypeProps): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const current: OwnerChoice = editor.ownerType.value ?? 'any';
  const [picked, setPicked] = useState<OwnerChoice>(current);
  useEffect(() => {
    // The dialog shows why its own change failed, not what an earlier save left in the bar behind it.
    editor.saveError.value = undefined;
    dialog.current?.showModal();
  }, [editor]);
  const from = editor.ownerTypeFrom.value;
  const leaving = editor.ownerLeaving(picked);
  const label = choices.find((choice) => choice.type === picked)?.label ?? '';
  const error = editor.saveError.value;
  return (
    <dialog class="dialog" ref={dialog} aria-labelledby="owner-heading" onClose={onClose}>
      <form
        method="dialog"
        onSubmit={(event) => {
          if (event.submitter instanceof HTMLButtonElement && event.submitter.value === 'change') {
            // The dialog stays until the change is written, so a refusal shows here.
            event.preventDefault();
            run(
              profiles.changeOwnerType(picked).then(() => {
                if (editor.saveError.value === undefined) {
                  dialog.current?.close();
                }
              }),
            );
          }
        }}
      >
        <h2 id="owner-heading">Who the profile is for</h2>
        {from !== undefined && (
          <p class="notice">{from} sets the type for every profile that extends it, so it is changed there.</p>
        )}
        <fieldset class="choices" disabled={from !== undefined}>
          <legend class="visually-hidden">Owner type</legend>
          {choices.map(({ type, label: name, help }) => (
            <label key={type} class="choice">
              <input
                type="radio"
                name="owner-type"
                checked={picked === type}
                onChange={() => {
                  setPicked(type);
                }}
              />
              <span>
                <strong>{name}</strong>
                <span class="muted small">{help}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {picked !== current && leaving.length > 0 && (
          <div class="notice notice-drift">
            <p>
              {label} don't have {leaving.length === 1 ? '1 thing' : `${leaving.length} things`} this profile sets.
              Changing the type leaves {leaving.length === 1 ? 'it' : 'them'} not managed:
            </p>
            <ul>
              {leaving.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        )}
        {editor.dirty.value && <p class="muted small">Save or reset your changes to change the type.</p>}
        {error !== undefined && (
          <p class="notice notice-problem" role="alert">
            {error}
          </p>
        )}
        <div class="form-actions">
          <button
            class="button button-primary"
            type="submit"
            value="change"
            disabled={picked === current || from !== undefined || !editor.canChangeOwnerType.value}
          >
            {changeLabels[picked]}
          </button>
          <button class="button button-quiet" type="submit" value="cancel">
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}
