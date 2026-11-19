import { type GitHub, repoPath, type RepoRef } from '../github/client.js';
import { describeOwnerType, type OwnerType } from '../profiles/owner.js';
import type { Drafts } from '../profiles/profile.js';
import { labelKey, type Profile } from '../profiles/schema.js';
import { type Change, type Section, sections, type Warning } from './change.js';
import { planEndpoint, readEndpoints } from './endpoints.js';
import {
  authoritativeSchema,
  type Ownership,
  excludedEntry,
  ownedActions,
  owns,
  ownershipWarnings,
  pruneEntries,
} from './ownership.js';
import { planActionPolicies, readActionPolicies } from './sections/action-policies.js';
import { actionsEndpoints, planActions, readActions, readActionsEnabled } from './sections/actions.js';
import { planAutolinks, readAutolinks } from './sections/autolinks.js';
import { planEnvironments, readEnvironments } from './sections/environments.js';
import { planLabels, readLabels } from './sections/labels.js';
import { planPages, readPages } from './sections/pages.js';
import { planCustomProperties, readCustomProperties } from './sections/properties.js';
import { planRepository, readRepository, repositoryOwnerType } from './sections/repository.js';
import { planRulesets, readRulesets } from './sections/rulesets.js';
import { liveSecurityAndAnalysis, planSecurity, securityEndpoints } from './sections/security.js';
import { orderSettingChanges } from './setting-order.js';

export interface Skipped {
  readonly section: Section;
  readonly target: string;
  /** From `drafts.unset`: the draft stops managing the target rather than changing it. */
  readonly unset?: true | undefined;
}

export interface Plan extends Ownership {
  readonly source?:
    | { readonly profile: string }
    | { readonly text: string; readonly directory: string }
    | { readonly staged: string }
    | undefined;
  readonly repository: string;
  readonly desired: Profile;
  readonly changes: readonly Change[];
  /** The profile's drafts, which the plan leaves out. */
  readonly skipped: readonly Skipped[];
  readonly warnings: readonly Warning[];
}

function draftTargets(drafts: Drafts, section: Section): string[] {
  if (section === 'autolinks') {
    return (drafts.autolinks ?? []).map((entry) => entry.key_prefix);
  }
  if (section === 'actions_policies' || section === 'rulesets' || section === 'environments' || section === 'labels') {
    return (drafts[section] ?? []).map((entry) => entry.name);
  }
  return Object.keys(drafts[section] ?? {});
}

/** A key of `drafts.unset` reads as `repository.has_wiki` or `rulesets/Legacy`. */
function unsetTarget(key: string): { section: Section; target: string } | undefined {
  const at = key.includes('/') ? key.indexOf('/') : key.indexOf('.');
  const section = sections.find((name) => name === key.slice(0, at));
  return section === undefined ? undefined : { section, target: key.slice(at + 1) };
}

export function skippedDrafts(drafts: Drafts): Skipped[] {
  const unset = (drafts.unset ?? []).flatMap((key) => {
    const target = unsetTarget(key);
    return target === undefined ? [] : [{ ...target, unset: true as const }];
  });
  return sections.flatMap((section) => [
    ...draftTargets(drafts, section).map((target) => ({ section, target })),
    ...unset.filter((item) => item.section === section),
  ]);
}

export class OwnerMismatchError extends Error {
  readonly profile: OwnerType;
  readonly repository: OwnerType;

  constructor(repo: RepoRef, profile: OwnerType, repository: OwnerType) {
    super(
      `This profile is for ${describeOwnerType(profile)}, and ${repo.owner}/${repo.name} belongs to ${repository === 'user' ? 'a personal account' : 'an organization'}. To use its settings there, make a copy of the profile and change the copy's type to ${describeOwnerType(repository)}.`,
    );
    this.name = 'OwnerMismatchError';
    this.profile = profile;
    this.repository = repository;
  }
}

/** `skipped` lists the profile's drafts, which `desired` never holds, so the plan can say what it left out. */
export async function createPlan(
  github: GitHub,
  repo: RepoRef,
  input: Profile,
  skipped: readonly Skipped[] = [],
  ownership: Ownership = {},
): Promise<Plan> {
  authoritativeSchema.parse(ownership.authoritative ?? []);
  const original = input;
  const actions = ownedActions(input.actions, ownership);
  const desired = { ...input, ...(actions === undefined ? {} : { actions }) };
  if (desired.owner_type !== undefined) {
    const owner = repositoryOwnerType(await github.request('GET', repoPath(repo)));
    if (owner !== undefined && owner !== desired.owner_type) {
      throw new OwnerMismatchError(repo, desired.owner_type, owner);
    }
  }
  const changes: Change[] = [];
  const warnings: Warning[] = [];
  const add = (plan: { changes: readonly Change[]; warnings: readonly Warning[] }): void => {
    changes.push(...plan.changes);
    warnings.push(...plan.warnings);
  };

  const security = desired.security;
  const liveActions = desired.actions === undefined ? undefined : await readActions(github, repo);
  const enabled = desired.actions?.enabled ?? liveActions?.enabled;
  const needsActions = [security?.code_scanning_default_setup, security?.code_quality_setup].some(
    (setup) => setup !== undefined && setup.state !== 'not-configured',
  );
  const actionsEnabled = !needsActions
    ? undefined
    : enabled === undefined
      ? await readActionsEnabled(github, repo)
      : { available: true as const, value: enabled };
  if (
    desired.repository !== undefined ||
    desired.merge !== undefined ||
    security?.security_and_analysis !== undefined
  ) {
    const live = await readRepository(github, repo, Object.keys(desired.repository ?? {}));
    add(planRepository(desired, live, repo));
    if (security !== undefined) {
      const named = securityEndpoints.filter(
        (endpoint) =>
          Object.hasOwn(security, endpoint.key) ||
          (endpoint.key === 'vulnerability_alerts' && security.automated_security_fixes !== undefined),
      );
      add(
        planSecurity(
          security,
          liveSecurityAndAnalysis(live.securityAndAnalysis),
          await readEndpoints(github, repo, named),
          repo,
          actionsEnabled,
        ),
      );
    }
  } else if (security !== undefined) {
    const named = securityEndpoints.filter(
      (endpoint) =>
        Object.hasOwn(security, endpoint.key) ||
        (endpoint.key === 'vulnerability_alerts' && security.automated_security_fixes !== undefined),
    );
    add(planSecurity(security, undefined, await readEndpoints(github, repo, named), repo, actionsEnabled));
  }
  if (desired.actions !== undefined && liveActions !== undefined) {
    const { actions } = desired;
    add(planActions(actions, liveActions, repo));
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
  if (desired.autolinks !== undefined || owns(ownership, 'autolinks')) {
    const live = await readAutolinks(github, repo);
    const entries = pruneEntries(
      desired.autolinks ?? [],
      live.available ? live.autolinks.map((entry) => entry.key_prefix) : [],
      (entry) => entry.key_prefix,
      (key_prefix) => ({ key_prefix, absent: true as const }),
      'autolinks',
      ownership,
    );
    add(planAutolinks(entries, live, repo));
  }
  if (desired.actions_policies !== undefined || owns(ownership, 'actions_policies')) {
    const live = await readActionPolicies(github, repo);
    const entries = pruneEntries(
      desired.actions_policies ?? [],
      live.available ? live.policies.map((entry) => entry.policy.name) : [],
      (entry) => entry.name,
      (name) => ({ name, absent: true as const }),
      'actions_policies',
      ownership,
    );
    add(planActionPolicies(entries, live, repo));
  }
  if (desired.rulesets !== undefined || owns(ownership, 'rulesets')) {
    const live = await readRulesets(github, repo);
    const entries = pruneEntries(
      desired.rulesets ?? [],
      live.available ? live.rulesets.map((entry) => entry.ruleset.name) : [],
      (entry) => entry.name,
      (name) => ({ name, absent: true as const }),
      'rulesets',
      ownership,
    );
    add(planRulesets(entries, live, repo));
  }
  if (desired.environments !== undefined || owns(ownership, 'environments')) {
    const live = await readEnvironments(github, repo);
    const entries = pruneEntries(
      desired.environments ?? [],
      live.available ? live.environments.map((entry) => entry.name) : [],
      (entry) => entry.name,
      (name) => ({ name, absent: true as const }),
      'environments',
      ownership,
    );
    add(planEnvironments(entries, live, repo));
  }
  if (desired.labels !== undefined || owns(ownership, 'labels')) {
    const live = await readLabels(github, repo);
    const entries = pruneEntries(
      desired.labels ?? [],
      live.available ? live.labels.map((entry) => entry.name) : [],
      (entry) => entry.name,
      (name) => ({ name, absent: true as const }),
      'labels',
      ownership,
      (desired.labels ?? []).flatMap((entry) => (entry.absent === true ? [] : (entry.renamed_from ?? []))),
    );
    const kept = entries.filter(
      (entry) =>
        entry.absent === true || entry.renamed_from?.some((name) => excludedEntry(ownership, 'labels', name)) !== true,
    );
    const labels = planLabels(kept, live, repo);
    add(labels);
    // A rename applies even when a draft names the old label, so say so beside the skipped draft.
    for (const draft of skipped.filter((item) => item.section === 'labels')) {
      const rename = labels.changes.find((change) =>
        change.fields.some(
          (field) => field.field === 'name' && labelKey(String(field.from)) === labelKey(draft.target),
        ),
      );
      if (rename !== undefined) {
        warnings.push({
          section: 'labels',
          key: draft.target,
          message: `Label "${rename.target}" renames "${draft.target}", which the profile skips as a draft`,
        });
      }
    }
  }

  for (const change of changes) {
    if (
      change.action === 'delete' &&
      change.entry !== undefined &&
      owns(ownership, change.section) &&
      skipped.some((draft) => draft.section === change.section && draft.target === change.entry.name)
    ) {
      warnings.push({
        section: change.section,
        key: change.entry.name,
        message: `The draft for ${change.entry.name} is not part of the desired state. Full ownership deletes its live entry; exclude it to keep it.`,
      });
    }
  }
  ownershipWarnings(changes, warnings, ownership);
  return {
    repository: `${repo.owner}/${repo.name}`,
    desired: original,
    changes: orderSettingChanges(changes),
    skipped,
    warnings,
    ...(ownership.authoritative === undefined ? {} : { authoritative: ownership.authoritative }),
    ...(ownership.exclude === undefined ? {} : { exclude: ownership.exclude }),
  };
}
