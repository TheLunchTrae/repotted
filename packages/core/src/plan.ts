import { isDeepStrictEqual } from 'node:util';

import { z } from 'zod';

import { type Change, sections } from './change.js';
import { captureEndpoints, planEndpoint, readEndpoints } from './endpoints.js';
import { type GitHub, GitHubError, parseRepo, repoPattern, type RepoRef } from './github.js';
import { requiredPermission } from './permissions.js';
import { identifyingRepositoryFields, profile, type Profile } from './schema.js';
import { actionsEndpoints, planActions, readActions } from './sections/actions.js';
import { describeAutolink, planAutolinks, readAutolinks } from './sections/autolinks.js';
import { describeEnvironment, planEnvironments, readEnvironments } from './sections/environments.js';
import { describePages, planPages, readPages } from './sections/pages.js';
import { captureCustomProperties, planCustomProperties, readCustomProperties } from './sections/properties.js';
import { planRepository, readRepository, repositoryEndpoints } from './sections/repository.js';
import { planRulesets, readRulesets } from './sections/rulesets.js';
import { liveSecurityAndAnalysis, planSecurity, securityEndpoints } from './sections/security.js';

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
  const add = (plan: { changes: readonly Change[]; warnings: readonly string[] }): void => {
    changes.push(...plan.changes);
    warnings.push(...plan.warnings);
  };

  const security = desired.security;
  if (
    desired.repository !== undefined ||
    desired.merge !== undefined ||
    security?.security_and_analysis !== undefined
  ) {
    const live = await readRepository(github, repo, Object.keys(desired.repository ?? {}));
    add(planRepository(desired, live, repo));
    if (security !== undefined) {
      const named = securityEndpoints.filter((endpoint) => Object.hasOwn(security, endpoint.key));
      add(
        planSecurity(
          security,
          liveSecurityAndAnalysis(live.securityAndAnalysis),
          await readEndpoints(github, repo, named),
          repo,
        ),
      );
    }
  } else if (security !== undefined) {
    const named = securityEndpoints.filter((endpoint) => Object.hasOwn(security, endpoint.key));
    add(planSecurity(security, undefined, await readEndpoints(github, repo, named), repo));
  }
  if (desired.actions !== undefined) {
    const { actions } = desired;
    add(planActions(actions, await readActions(github, repo), repo));
    const named = actionsEndpoints.filter((endpoint) => Object.hasOwn(actions, endpoint.key));
    const live = await readEndpoints(github, repo, named);
    for (const endpoint of named) {
      const value = live.get(endpoint.key);
      if (value !== undefined) {
        add(planEndpoint('actions', endpoint, Reflect.get(actions, endpoint.key), value, repo));
      }
    }
  }
  if (desired.custom_properties !== undefined) {
    add(planCustomProperties(desired.custom_properties, await readCustomProperties(github, repo), repo));
  }
  if (desired.pages !== undefined) {
    add(planPages(desired.pages, await readPages(github, repo), repo));
  }
  if (desired.autolinks !== undefined) {
    add(planAutolinks(desired.autolinks, await readAutolinks(github, repo), repo));
  }
  if (desired.rulesets !== undefined) {
    add(planRulesets(desired.rulesets, await readRulesets(github, repo), repo));
  }
  if (desired.environments !== undefined) {
    add(planEnvironments(desired.environments, await readEnvironments(github, repo), repo));
  }

  return { repository: `${repo.owner}/${repo.name}`, desired, changes, warnings };
}

/**
 * Reads every section into a profile that describes the repository as it
 * is. Settings that name the repository, such as its description, stay out,
 * so the profile can describe other repositories too.
 */
export async function captureProfile(github: GitHub, repo: RepoRef): Promise<{ profile: Profile; warnings: string[] }> {
  const warnings: string[] = [];
  const live = await readRepository(github, repo);
  const repositoryEndpointSettings = captureEndpoints('repository', repositoryEndpoints, live.endpoints);
  warnings.push(...repositoryEndpointSettings.warnings);
  const repository = Object.fromEntries(
    Object.entries({ ...live.repository, ...repositoryEndpointSettings.settings }).filter(
      ([key]) => !identifyingRepositoryFields.has(key),
    ),
  );

  const securityEndpointSettings = captureEndpoints(
    'security',
    securityEndpoints,
    await readEndpoints(github, repo, securityEndpoints),
  );
  warnings.push(...securityEndpointSettings.warnings);
  const securityAndAnalysis = liveSecurityAndAnalysis(live.securityAndAnalysis);
  const security = {
    ...(securityAndAnalysis === undefined ? {} : { security_and_analysis: securityAndAnalysis }),
    ...securityEndpointSettings.settings,
  };

  const actionsEndpointSettings = captureEndpoints(
    'actions',
    actionsEndpoints,
    await readEndpoints(github, repo, actionsEndpoints),
  );
  warnings.push(...actionsEndpointSettings.warnings);
  const actions = { ...(await readActions(github, repo)), ...actionsEndpointSettings.settings };

  const properties = await readCustomProperties(github, repo);
  const pages = await readPages(github, repo);
  const autolinks = await readAutolinks(github, repo);
  const rulesets = await readRulesets(github, repo);
  const environments = await readEnvironments(github, repo);
  for (const [section, read] of [
    ['custom_properties', properties],
    ['pages', pages],
    ['autolinks', autolinks],
  ] as const) {
    if (!read.available && read.refused) {
      warnings.push(`Skipped ${section}: ${read.reason}`);
    }
  }
  if (!rulesets.available) {
    warnings.push(`Skipped rulesets: ${rulesets.reason}`);
  }
  if (!environments.available) {
    warnings.push(`Skipped environments: ${environments.reason}`);
  }
  const customProperties = properties.available ? captureCustomProperties(properties.values) : {};
  return {
    profile: {
      repository,
      merge: live.merge,
      actions,
      ...(Object.keys(security).length > 0 ? { security } : {}),
      ...(Object.keys(customProperties).length > 0 ? { custom_properties: customProperties } : {}),
      ...(pages.available && pages.site !== null ? { pages: describePages(pages.site) } : {}),
      ...(autolinks.available && autolinks.autolinks.length > 0
        ? { autolinks: autolinks.autolinks.map(describeAutolink) }
        : {}),
      ...(rulesets.available ? { rulesets: rulesets.rulesets.map((entry) => entry.ruleset) } : {}),
      ...(environments.available ? { environments: environments.environments.map(describeEnvironment) } : {}),
    },
    warnings,
  };
}

// A saved plan's changes are never executed: apply re-plans from `desired`
// and only compares, so a hand-edited file cannot smuggle in other requests.
const savedChange = z.object({
  section: z.enum(sections),
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
          : change.section === 'autolinks'
            ? `autolink ${change.target}`
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
  const { method, path } = error.failed.request;
  const lines = [
    `${error.message}: ${cause}`,
    ...(error.cause instanceof GitHubError && error.cause.status === 403
      ? [`That change needs the ${requiredPermission(method, path)} permission.`]
      : []),
  ];
  if (error.applied.length > 0) {
    lines.push(
      'Already applied:',
      ...error.applied.map((change) => `  ${symbols[change.action]} ${change.action} ${change.target}`),
    );
  }
  lines.push('Nothing after the failed change was written. Plan again to see where the repository stands.');
  return lines.join('\n');
}
