import type { DefinitionKind } from '@repotted/core';

export const definitionTypes: readonly {
  readonly kind: DefinitionKind;
  readonly section: string;
  readonly label: string;
  readonly multiple?: boolean;
}[] = [
  { kind: 'actions-policy', section: 'actions', label: 'Actions policy' },
  { kind: 'ruleset', section: 'rulesets', label: 'Ruleset', multiple: true },
  { kind: 'environment', section: 'environments', label: 'Environment', multiple: true },
];
