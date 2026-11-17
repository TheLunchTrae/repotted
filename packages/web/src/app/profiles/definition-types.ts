import type { DefinitionKind } from '@repotted/core';

export const definitionTypes: readonly {
  readonly kind: DefinitionKind;
  readonly section: string;
  readonly label: string;
}[] = [{ kind: 'actions-policy', section: 'actions', label: 'Actions policy' }];
