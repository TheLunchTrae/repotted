import { isDeepStrictEqual } from 'node:util';

import { z } from 'zod';

import { type Change, type Section, sections } from './change.js';
import { captureEndpoints, loadable, planEndpoint, readEndpoints, unloadable } from './endpoints.js';
import { type GitHub, GitHubError, parseRepo, repoPattern, type RepoRef } from './github.js';
import { type Lock, requiredPermission } from './permissions.js';
import type { Drafts } from './profile.js';
import {
  actionsSettings,
  commitPairs,
  environment,
  identifyingRepositoryFields,
  mergeSettings,
  profile,
  type Profile,
  repositorySettings,
  ruleset,
  securityAndAnalysis,
  securitySettings,
} from './schema.js';
import { actionsEndpoints, planActions, readActions } from './sections/actions.js';
import { describeAutolink, planAutolinks, readAutolinks } from './sections/autolinks.js';
import { describeEnvironment, planEnvironments, readEnvironments } from './sections/environments.js';
import { describePages, planPages, readPages } from './sections/pages.js';
import { captureCustomProperties, planCustomProperties, readCustomProperties } from './sections/properties.js';
import { planRepository, readRepository, repositoryEndpoints } from './sections/repository.js';
import { planRulesets, readRulesets } from './sections/rulesets.js';
import { liveSecurityAndAnalysis, planSecurity, securityEndpoints } from './sections/security.js';

/** A draft that a plan leaves out: a setting by its key, or an entry by its prefix or name. */
export interface Skipped {
  readonly section: Section;
  readonly target: string;
}

/** The changes a profile needs on one repository, in the order they apply. */
export interface Plan {
  readonly repository: string;
  readonly desired: Profile;
  readonly changes: readonly Change[];
  /** The profile's drafts, which the plan leaves out. */
  readonly skipped: readonly Skipped[];
  readonly warnings: readonly string[];
}

/** The drafts of one section: settings by key, autolinks by prefix, and other entries by name. */
function draftTargets(drafts: Drafts, section: Section): string[] {
  if (section === 'autolinks') {
    return (drafts.autolinks ?? []).map((entry) => entry.key_prefix);
  }
  if (section === 'rulesets' || section === 'environments') {
    return (drafts[section] ?? []).map((entry) => entry.name);
  }
  return Object.keys(drafts[section] ?? {});
}

/** What a plan skips for these drafts, in the order their sections apply. */
export function skippedDrafts(drafts: Drafts): Skipped[] {
  return sections.flatMap((section) => draftTargets(drafts, section).map((target) => ({ section, target })));
}

/**
 * Reads only the sections the profile mentions and plans the writes that
 * bring them in line. Settings and rulesets the profile does not name are
 * left alone. `skipped` lists the profile's drafts, which `desired` never
 * holds, so the plan can say what it left out.
 */
export async function createPlan(
  github: GitHub,
  repo: RepoRef,
  desired: Profile,
  skipped: readonly Skipped[] = [],
): Promise<Plan> {
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

  return { repository: `${repo.owner}/${repo.name}`, desired, changes, skipped, warnings };
}

/**
 * The captured rulesets or environments that a profile can hold. One that
 * fails its schema is left out whole, with a warning: a ruleset without one
 * of its rules would have that rule removed on apply, while a profile leaves
 * a ruleset it does not name alone.
 */
function loadableEntries<Entry extends { readonly name: string }>(
  kind: string,
  schema: z.ZodType,
  entries: readonly Entry[],
  warnings: string[],
): Entry[] {
  const kept: Entry[] = [];
  for (const entry of entries) {
    const problem = unloadable(schema, entry);
    if (problem === undefined) {
      kept.push(entry);
    } else {
      warnings.push(`Skipped ${kind} "${entry.name}": ${problem}`);
    }
  }
  return kept;
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
  const repository = loadable(
    'repository',
    repositorySettings,
    Object.fromEntries(
      Object.entries({ ...live.repository, ...repositoryEndpointSettings.settings }).filter(
        ([key]) => !identifyingRepositoryFields.has(key),
      ),
    ),
    warnings,
  );
  const loadableMerge = loadable('merge', mergeSettings, live.merge, warnings);
  // GitHub takes a commit message setting only with its title setting, so
  // when one of a pair is left out, the other goes too.
  const merge: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(loadableMerge)) {
    const pair = commitPairs.find(({ title, message }) => key === title || key === message);
    const other = pair === undefined ? undefined : key === pair.title ? pair.message : pair.title;
    if (other !== undefined && other in live.merge && !(other in loadableMerge)) {
      warnings.push(`Skipped merge.${key}: GitHub takes it only with ${other}, which is left out`);
    } else {
      merge[key] = value;
    }
  }

  const securityEndpointSettings = captureEndpoints(
    'security',
    securityEndpoints,
    await readEndpoints(github, repo, securityEndpoints),
  );
  warnings.push(...securityEndpointSettings.warnings);
  const reported = liveSecurityAndAnalysis(live.securityAndAnalysis);
  const securityAndAnalysisSettings =
    reported === undefined ? {} : loadable('security.security_and_analysis', securityAndAnalysis, reported, warnings);
  const security = loadable(
    'security',
    securitySettings,
    {
      ...(Object.keys(securityAndAnalysisSettings).length === 0
        ? {}
        : { security_and_analysis: securityAndAnalysisSettings }),
      ...securityEndpointSettings.settings,
    },
    warnings,
  );

  const actionsEndpointSettings = captureEndpoints(
    'actions',
    actionsEndpoints,
    await readEndpoints(github, repo, actionsEndpoints),
  );
  warnings.push(...actionsEndpointSettings.warnings);
  const actions = loadable(
    'actions',
    actionsSettings,
    { ...(await readActions(github, repo)), ...actionsEndpointSettings.settings },
    warnings,
  );

  const properties = await readCustomProperties(github, repo);
  const pages = await readPages(github, repo);
  const autolinks = await readAutolinks(github, repo);
  const rulesets = await readRulesets(github, repo);
  const environments = await readEnvironments(github, repo);
  // A section the repository does not have is no news; one GitHub hides is.
  for (const [section, read] of [
    ['custom_properties', properties],
    ['pages', pages],
    ['autolinks', autolinks],
    ['rulesets', rulesets],
    ['environments', environments],
  ] as const) {
    if (!read.available && read.refused) {
      warnings.push(`Skipped ${section}: ${read.reason}`);
    }
  }
  const customProperties = properties.available ? captureCustomProperties(properties.values) : {};
  const capturedRulesets = rulesets.available
    ? loadableEntries(
        'ruleset',
        ruleset,
        rulesets.rulesets.map((entry) => entry.ruleset),
        warnings,
      )
    : undefined;
  const capturedEnvironments = environments.available
    ? loadableEntries('environment', environment, environments.environments.map(describeEnvironment), warnings)
    : undefined;
  return {
    profile: {
      repository,
      merge,
      actions,
      ...(Object.keys(security).length > 0 ? { security } : {}),
      ...(Object.keys(customProperties).length > 0 ? { custom_properties: customProperties } : {}),
      ...(pages.available && pages.site !== null ? { pages: describePages(pages.site) } : {}),
      ...(autolinks.available && autolinks.autolinks.length > 0
        ? { autolinks: autolinks.autolinks.map(describeAutolink) }
        : {}),
      ...(capturedRulesets === undefined ? {} : { rulesets: capturedRulesets }),
      ...(capturedEnvironments === undefined ? {} : { environments: capturedEnvironments }),
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
  // Plans saved before drafts existed have none.
  skipped: z.array(z.object({ section: z.enum(sections), target: z.string() })).default([]),
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
  const current = await createPlan(github, parseRepo(reviewed.repository), reviewed.desired, reviewed.skipped);
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

function describeTarget(section: Section, target: string): string {
  switch (section) {
    case 'rulesets':
      return `ruleset "${target}"`;
    case 'environments':
      return `environment ${target}`;
    case 'autolinks':
      return `autolink ${target}`;
    case 'repository':
    case 'merge':
    case 'actions':
    case 'security':
    case 'custom_properties':
    case 'pages':
      return target;
  }
}

/** A draft a plan leaves out, as plan output names it. */
export function describeSkipped({ section, target }: Skipped): string {
  if (section === 'autolinks' || section === 'rulesets' || section === 'environments') {
    return describeTarget(section, target);
  }
  return section === 'pages' && target === 'absent'
    ? 'pages.absent (turns the Pages site off)'
    : `${section}.${target}`;
}

/** The plan as text; a change in `locks` says why Repotted cannot make it. */
export function formatPlan(plan: Plan, locks: readonly Lock[] = []): string {
  const lines = [
    plan.changes.length === 0
      ? `${plan.repository} matches the profile.`
      : `${plan.repository}: ${plan.changes.length} ${plan.changes.length === 1 ? 'change' : 'changes'}`,
  ];
  for (const [index, change] of plan.changes.entries()) {
    const lock = locks.find((item) => item.change === index);
    lines.push(
      `  ${symbols[change.action]} ${change.action} ${describeTarget(change.section, change.target)}${lock === undefined ? '' : ` (locked: ${lock.reason})`}`,
    );
    for (const field of change.fields) {
      lines.push(`      ${field.field}: ${show(field.from)} -> ${show(field.to)}`);
    }
  }
  for (const draft of plan.skipped) {
    lines.push(`  · skip draft ${describeSkipped(draft)}`);
  }
  for (const warning of plan.warnings) {
    lines.push(`  ! ${warning}`);
  }
  return lines.join('\n');
}

/**
 * Why GitHub refused the change that failed, when it says something lasting
 * about the repository, the token or the App: a `403` or a `422`. A refusal
 * for want of a permission names the permission; any other, such as a
 * feature the repository's plan lacks or an organization policy, gives
 * GitHub's reason. Null for anything else, a rate limit included.
 */
export function failureReason(error: ApplyError): string | null {
  const cause = error.cause;
  if (!(cause instanceof GitHubError) || ![403, 422].includes(cause.status) || cause.rateLimited) {
    return null;
  }
  if (cause.status === 403 && /not accessible by/iu.test(cause.message)) {
    const { method, path } = error.failed.request;
    return `Needs ${requiredPermission(method, path)}`;
  }
  return cause.message;
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
