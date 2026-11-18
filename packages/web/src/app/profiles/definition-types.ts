import type { DefinitionKind, ProfileReferences } from '@repotted/core';

export const definitionTypes: readonly {
  readonly kind: DefinitionKind;
  readonly section: keyof ProfileReferences;
  readonly label: string;
  readonly title: string;
  readonly path: string;
}[] = [
  {
    kind: 'actions-policy',
    section: 'actions_policies',
    label: 'Actions policy',
    title: 'Actions policies',
    path: '/actions-policies',
  },
  { kind: 'ruleset', section: 'rulesets', label: 'Ruleset', title: 'Rulesets', path: '/rulesets' },
  {
    kind: 'environment',
    section: 'environments',
    label: 'Environment',
    title: 'Environments',
    path: '/environments',
  },
];
