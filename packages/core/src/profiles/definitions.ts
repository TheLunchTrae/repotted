import { stringify } from 'yaml';

import { type GitHub, repoPath, type RepoRef } from '../github/client.js';
import type { Warning } from '../plan/change.js';
import { captureEndpoints, loadable, readEndpoints } from '../plan/endpoints.js';
import { actionsEndpoints, readActions } from '../plan/sections/actions.js';
import { repositoryOwnerType } from '../plan/sections/repository.js';
import { readRulesets } from '../plan/sections/rulesets.js';
import { withoutOwnerConflicts } from './owner.js';
import { actionsSettings, type DefinitionKind, type ProfileFile, ruleset } from './schema.js';
import { activeProfileSettings } from './setting-dependencies.js';

export async function captureDefinition(
  github: GitHub,
  repo: RepoRef,
  kind: DefinitionKind,
  targetName?: string,
): Promise<{ definition: ProfileFile; warnings: Warning[] }> {
  if (kind === 'ruleset' && (targetName === undefined || targetName.trim() === '')) {
    throw new Error('Give the name of the ruleset to capture.');
  }
  if (kind === 'actions-policy' && targetName !== undefined) {
    throw new Error('An Actions policy has no target name.');
  }
  const owner = repositoryOwnerType(await github.request('GET', repoPath(repo)));
  if (kind === 'ruleset') {
    const live = await readRulesets(github, repo);
    if (!live.available) {
      throw new Error(`Cannot capture ruleset ${targetName}: ${live.reason}`);
    }
    const matches = live.rulesets.filter((entry) => entry.ruleset.name === targetName);
    if (matches.length !== 1 || matches[0] === undefined) {
      throw new Error(`Expected one repository ruleset named ${targetName}, found ${matches.length}.`);
    }
    const { value, dropped } = withoutOwnerConflicts({ rulesets: [ruleset.parse(matches[0].ruleset)] }, owner);
    if (value.rulesets.length !== 1) {
      throw new Error(`Ruleset ${targetName} is not supported for this repository's owner type.`);
    }
    return {
      definition: { kind, ...(owner === undefined ? {} : { owner_type: owner }), ...value },
      warnings: dropped.map((conflict) => ({ section: 'rulesets', message: conflict.message })),
    };
  }
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
