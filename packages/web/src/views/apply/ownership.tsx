import { authoritativeSections, type AuthoritativeSection } from '@repotted/core';
import type { JSX } from 'preact';

const names: Record<AuthoritativeSection, string> = {
  actions: 'Actions settings',
  actions_policies: 'Actions policies',
  autolinks: 'Autolinks',
  rulesets: 'Rulesets',
  environments: 'Environments',
  labels: 'Labels',
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
        Remove unlisted entries in selected sections. Retained entries keep omitted fields. Actions uses the documented
        baseline for omitted settings.
      </p>
      {authoritativeSections.map((section) => (
        <label class="check" key={section}>
          <input
            type="checkbox"
            checked={value.includes(section)}
            onChange={(event) => {
              onChange(
                event.currentTarget.checked ? [...value, section] : value.filter((current) => current !== section),
              );
            }}
          />
          <span>{names[section]}</span>
        </label>
      ))}
      <p class="muted small">
        Deleting environments also deletes their secrets and variables. Deleting labels removes them from issues and
        pull requests.
      </p>
    </fieldset>
  );
}
