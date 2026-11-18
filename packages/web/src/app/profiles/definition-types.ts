import type { DefinitionKind } from '@repotted/core';

export const definitionTypes: readonly {
  readonly kind: DefinitionKind;
  readonly section: string;
  readonly label: string;
  readonly title: string;
  readonly path: string;
  readonly multiple?: boolean;
}[] = [
  {
    kind: 'actions-policy',
    section: 'actions',
    label: 'Actions policy',
    title: 'Actions policies',
    path: '/actions-policies',
  },
  { kind: 'ruleset', section: 'rulesets', label: 'Ruleset', title: 'Rulesets', path: '/rulesets', multiple: true },
  {
    kind: 'environment',
    section: 'environments',
    label: 'Environment',
    title: 'Environments',
    path: '/environments',
    multiple: true,
  },
];
