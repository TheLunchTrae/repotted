import type { AuthoritativeSection } from '@repotted/core';
import type { JSX } from 'preact';

import { type OwnableSection, ownableSections } from '../../app/repositories/saved-assignments.js';

const choices: Record<OwnableSection, { readonly name: string; readonly removes: string }> = {
  actions_policies: { name: 'Actions policies', removes: 'Deletes Actions policies the profiles don’t list.' },
  rulesets: {
    name: 'Rulesets',
    removes: 'Deletes repository rulesets the profiles don’t list. Organization rulesets stay.',
  },
  environments: {
    name: 'Environments',
    removes: 'Deletes environments the profiles don’t list, with their secrets and variables.',
  },
  labels: {
    name: 'Labels',
    removes: 'Deletes labels the profiles don’t list and removes them from issues and pull requests.',
  },
};

export function OwnershipChoices({
  value,
  onChange,
}: {
  readonly value: readonly AuthoritativeSection[];
  readonly onChange: (sections: readonly AuthoritativeSection[]) => void;
}): JSX.Element {
  return (
    <fieldset class="settings-group">
      <legend>Full section ownership</legend>
      <p class="muted small">
        Make the profiles the complete list for a section. Listed entries keep any fields the profiles leave out.
      </p>
      {ownableSections.map((section) => (
        <label class="check check-row" key={section}>
          <input
            type="checkbox"
            checked={value.includes(section)}
            onChange={(event) => {
              onChange(
                event.currentTarget.checked ? [...value, section] : value.filter((current) => current !== section),
              );
            }}
          />
          <span>
            {choices[section].name}
            <span class="muted small check-note">{choices[section].removes}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
