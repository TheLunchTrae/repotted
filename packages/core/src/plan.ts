import { isDeepStrictEqual } from 'node:util';

import { z } from 'zod';

import type { Change } from './change.js';
import { type GitHub, parseRepo, repoPattern, type RepoRef } from './github.js';
import { profile, type Profile } from './schema.js';
import { planActions, readActions } from './sections/actions.js';
import { describeEnvironment, planEnvironments, readEnvironments } from './sections/environments.js';
import { planRepository, readRepository } from './sections/repository.js';
import { planRulesets, readRulesets } from './sections/rulesets.js';

/** The changes a profile needs on one repository, in the order they apply. */
export interface Plan {
  readonly repository: string;
  readonly desired: Profile;
  readonly changes: readonly Change[];
  readonly warnings: readonly string[];
}

/**
 * Reads only the sections the profile mentions and plans the writes that
 * bring them in line. Settings and rulesets the profile does not name are
 * left alone.
 */
export async function createPlan(github: GitHub, repo: RepoRef, desired: Profile): Promise<Plan> {
  const changes: Change[] = [];
  const warnings: string[] = [];

  if (desired.repository !== undefined || desired.merge !== undefined) {
    changes.push(...planRepository(desired, await readRepository(github, repo), repo));
  }
  if (desired.actions !== undefined) {
    const actions = planActions(desired.actions, await readActions(github, repo), repo);
    changes.push(...actions.changes);
    warnings.push(...actions.warnings);
  }
  if (desired.rulesets !== undefined) {
    const rulesets = planRulesets(desired.rulesets, await readRulesets(github, repo), repo);
    changes.push(...rulesets.changes);
    warnings.push(...rulesets.warnings);
  }
  if (desired.environments !== undefined) {
    const environments = planEnvironments(desired.environments, await readEnvironments(github, repo), repo);
    changes.push(...environments.changes);
    warnings.push(...environments.warnings);
  }

  return { repository: `${repo.owner}/${repo.name}`, desired, changes, warnings };
}

/** Reads every section into a profile that describes the repository as it is. */
export async function captureProfile(github: GitHub, repo: RepoRef): Promise<{ profile: Profile; warnings: string[] }> {
  const { repository, merge } = await readRepository(github, repo);
  const actions = await readActions(github, repo);
  const rulesets = await readRulesets(github, repo);
  const environments = await readEnvironments(github, repo);
  const warnings: string[] = [];
  if (!rulesets.available) {
    warnings.push(`Skipped rulesets: ${rulesets.reason}`);
  }
  if (!environments.available) {
    warnings.push(`Skipped environments: ${environments.reason}`);
  }
  return {
    profile: {
      repository,
      merge,
      actions,
      ...(rulesets.available ? { rulesets: rulesets.rulesets.map((entry) => entry.ruleset) } : {}),
      ...(environments.available ? { environments: environments.environments.map(describeEnvironment) } : {}),
    },
    warnings,
  };
}

// A saved plan's changes are never executed: apply re-plans from `desired`
// and only compares, so a hand-edited file cannot smuggle in other requests.
const savedChange = z.object({
  section: z.enum(['repository', 'merge', 'actions', 'rulesets', 'environments']),
  action: z.enum(['create', 'update', 'delete']),
  target: z.string(),
  fields: z.array(z.object({ field: z.string(), from: z.unknown().optional(), to: z.unknown().optional() })),
  request: z.object({
    method: z.enum(['GET', 'PATCH', 'POST', 'PUT', 'DELETE']),
    path: z.string(),
    body: z.unknown().optional(),
  }),
});

const savedPlan = z.object({
  repository: z.string().regex(repoPattern),
  desired: profile,
  changes: z.array(savedChange),
  warnings: z.array(z.string()),
});

export function parsePlan(data: unknown): Plan {
  return savedPlan.parse(data);
}

export class StalePlanError extends Error {
  readonly current: Plan;

  constructor(current: Plan) {
    super(`${current.repository} changed since this plan was made. Run plan again and review the new changes.`);
    this.name = 'StalePlanError';
    this.current = current;
  }
}

export class ApplyError extends Error {
  readonly applied: readonly Change[];
  readonly failed: Change;

  constructor(applied: readonly Change[], failed: Change, cause: unknown) {
    super(`Failed to ${failed.action} ${failed.target} after ${applied.length} of the plan's changes`, { cause });
    this.name = 'ApplyError';
    this.applied = applied;
    this.failed = failed;
  }
}

function jsonValue(value: unknown): unknown {
  const copy: unknown = JSON.parse(JSON.stringify(value));
  return copy;
}

/**
 * Applies a reviewed plan. The repository is planned again first, and the
 * plan only runs when that yields exactly the reviewed changes.
 */
export async function applyPlan(github: GitHub, reviewed: Plan): Promise<readonly Change[]> {
  const current = await createPlan(github, parseRepo(reviewed.repository), reviewed.desired);
  if (!isDeepStrictEqual(jsonValue(current.changes), jsonValue(reviewed.changes))) {
    throw new StalePlanError(current);
  }
  const applied: Change[] = [];
  for (const change of current.changes) {
    try {
      await github.request(change.request.method, change.request.path, change.request.body);
    } catch (error) {
      throw new ApplyError(applied, change, error);
    }
    applied.push(change);
  }
  return applied;
}

function show(value: unknown): string {
  return value === undefined ? 'unset' : JSON.stringify(value);
}

const symbols = { create: '+', update: '~', delete: '-' } as const;

export function formatPlan(plan: Plan): string {
  const lines = [
    plan.changes.length === 0
      ? `${plan.repository} matches the profile.`
      : `${plan.repository}: ${plan.changes.length} ${plan.changes.length === 1 ? 'change' : 'changes'}`,
  ];
  for (const change of plan.changes) {
    const kind =
      change.section === 'rulesets'
        ? `ruleset "${change.target}"`
        : change.section === 'environments'
          ? `environment ${change.target}`
          : change.target;
    lines.push(`  ${symbols[change.action]} ${change.action} ${kind}`);
    for (const field of change.fields) {
      lines.push(`      ${field.field}: ${show(field.from)} -> ${show(field.to)}`);
    }
  }
  for (const warning of plan.warnings) {
    lines.push(`  ! ${warning}`);
  }
  return lines.join('\n');
}

/** What an ApplyError means for the repository: what was written and what failed. */
export function describeFailure(error: ApplyError): string {
  const cause = error.cause instanceof Error ? error.cause.message : String(error.cause);
  const lines = [`${error.message}: ${cause}`];
  if (error.applied.length > 0) {
    lines.push(
      'Already applied:',
      ...error.applied.map((change) => `  ${symbols[change.action]} ${change.action} ${change.target}`),
    );
  }
  lines.push('Nothing after the failed change was written. Plan again to see where the repository stands.');
  return lines.join('\n');
}
