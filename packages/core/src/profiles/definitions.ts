import { stringify } from 'yaml';

import { type GitHub, repoPath, type RepoRef } from '../github/client.js';
import type { Warning } from '../plan/change.js';
import { describeActionPolicy, readActionPolicies } from '../plan/sections/action-policies.js';
import { describeEnvironment, readEnvironments } from '../plan/sections/environments.js';
import { repositoryOwnerType } from '../plan/sections/repository.js';
import { readRulesets } from '../plan/sections/rulesets.js';
import { withoutOwnerConflicts } from './owner.js';
import { actionPolicy, type DefinitionKind, environmentKey, profile, type ProfileFile, ruleset } from './schema.js';

export async function captureDefinition(
  github: GitHub,
  repo: RepoRef,
  kind: DefinitionKind,
  targetName?: string,
): Promise<{ definition: ProfileFile; warnings: Warning[] }> {
  if (targetName === undefined || targetName.trim() === '') {
    throw new Error(`Give the name of the ${kind} to capture.`);
  }
  const owner = repositoryOwnerType(await github.request('GET', repoPath(repo)));
  if (kind === 'environment') {
    const live = await readEnvironments(github, repo);
    if (!live.available) {
      throw new Error(`Cannot capture environment ${targetName}: ${live.reason}`);
    }
    const matches = live.environments.filter((entry) => environmentKey(entry.name) === environmentKey(targetName));
    const [matched] = matches;
    if (matches.length !== 1 || matched === undefined) {
      throw new Error(`Expected one environment named ${targetName}, found ${matches.length}.`);
    }
    const captured = profile.parse({
      ...(owner === undefined ? {} : { owner_type: owner }),
      environments: [describeEnvironment(matched)],
    });
    return { definition: { kind, ...captured }, warnings: [] };
  }
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
  const live = await readActionPolicies(github, repo);
  if (!live.available) {
    throw new Error(`Cannot capture Actions policy ${targetName}: ${live.reason}`);
  }
  const matches = live.policies.filter((entry) => entry.policy.name === targetName);
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new Error(`Expected one repository Actions policy named ${targetName}, found ${matches.length}.`);
  }
  const captured = actionPolicy.parse(describeActionPolicy(matches[0].policy));
  return {
    definition: { kind, ...(owner === undefined ? {} : { owner_type: owner }), actions_policies: [captured] },
    warnings: [],
  };
}

export function stringifyDefinition(definition: ProfileFile): string {
  return stringify(definition, { lineWidth: 0 });
}
