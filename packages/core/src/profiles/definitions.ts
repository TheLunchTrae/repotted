import { stringify } from 'yaml';

import { type GitHub, repoPath, type RepoRef } from '../github/client.js';
import type { Warning } from '../plan/change.js';
import { captureEndpoints, loadable, readEndpoints } from '../plan/endpoints.js';
import { actionsEndpoints, readActions } from '../plan/sections/actions.js';
import { repositoryOwnerType } from '../plan/sections/repository.js';
import { withoutOwnerConflicts } from './owner.js';
import { actionsSettings, type DefinitionKind, type ProfileFile } from './schema.js';
import { activeProfileSettings } from './setting-dependencies.js';

export async function captureDefinition(
  github: GitHub,
  repo: RepoRef,
  kind: DefinitionKind,
): Promise<{ definition: ProfileFile; warnings: Warning[] }> {
  const owner = repositoryOwnerType(await github.request('GET', repoPath(repo)));
  const endpoints = captureEndpoints('actions', actionsEndpoints, await readEndpoints(github, repo, actionsEndpoints));
  const warnings = [...endpoints.warnings];
  const actions = loadable(
    { section: 'actions' },
    actionsSettings,
    { ...(await readActions(github, repo)), ...endpoints.settings },
    warnings,
  );
  const { value, dropped } = withoutOwnerConflicts(activeProfileSettings({ actions }), owner);
  warnings.push(...dropped.map((conflict) => ({ section: 'actions' as const, message: conflict.message })));
  return { definition: { kind, ...(owner === undefined ? {} : { owner_type: owner }), ...value }, warnings };
}

export function stringifyDefinition(definition: ProfileFile): string {
  return stringify(definition, { lineWidth: 0 });
}
