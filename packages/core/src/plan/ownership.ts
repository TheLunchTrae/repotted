import { z } from 'zod';

import { actionsSettings, environmentKey, labelKey, type Profile } from '../profiles/schema.js';
import type { Change, Section, Warning } from './change.js';

export const authoritativeSections = [
  'actions',
  'autolinks',
  'actions_policies',
  'rulesets',
  'environments',
  'labels',
] as const;
export type AuthoritativeSection = (typeof authoritativeSections)[number];
export const authoritativeSchema = z
  .array(z.enum(authoritativeSections))
  .refine(
    (sections) => new Set(sections).size === sections.length,
    'Each authoritative section can be named only once',
  );

export interface Ownership {
  readonly authoritative?: readonly AuthoritativeSection[];
  readonly exclude?: readonly string[];
}

export function owns(ownership: Ownership, section: Section): boolean {
  return (
    ownership.authoritative?.some((name) => name === section) === true && ownership.exclude?.includes(section) !== true
  );
}

function key(section: Section, name: string): string {
  return section === 'environments' ? environmentKey(name) : section === 'labels' ? labelKey(name) : name;
}

export function excludedEntry(ownership: Ownership, section: Section, name: string): boolean {
  return (
    ownership.exclude?.some((excluded) => {
      const prefix = `${section}/`;
      return excluded.startsWith(prefix) && key(section, excluded.slice(prefix.length)) === key(section, name);
    }) === true
  );
}

export function pruneEntries<Entry>(
  desired: readonly Entry[],
  liveNames: readonly string[],
  nameOf: (entry: Entry) => string,
  absent: (name: string) => Entry,
  section: Section,
  ownership: Ownership,
  aliases: readonly string[] = [],
): readonly Entry[] {
  if (!owns(ownership, section)) {
    return desired;
  }
  if (new Set(liveNames.map((name) => key(section, name))).size !== liveNames.length) {
    throw new Error(`Cannot fully own ${section}: live entries have duplicate names, so their targets are ambiguous`);
  }
  const wanted = new Set([...desired.map(nameOf), ...aliases].map((name) => key(section, name)));
  return [
    ...desired,
    ...liveNames
      .filter((name) => !wanted.has(key(section, name)) && !excludedEntry(ownership, section, name))
      .map(absent),
  ].filter((entry) => !excludedEntry(ownership, section, nameOf(entry)));
}

function withoutSetting(value: unknown, parts: readonly string[]): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value;
  }
  const [first, ...rest] = parts;
  return Object.fromEntries(
    Object.entries(value).flatMap(([name, item]): [string, unknown][] =>
      name !== first ? [[name, item]] : rest.length === 0 ? [] : [[name, withoutSetting(item, rest)]],
    ),
  );
}

/** Baselines are Repotted's explicit policy, not an assertion about GitHub's defaults. */
export function ownedActions(desired: Profile['actions'], ownership: Ownership): Profile['actions'] {
  if (!owns(ownership, 'actions')) {
    return desired;
  }
  const result: NonNullable<Profile['actions']> = {
    enabled: true,
    allowed_actions: 'selected',
    sha_pinning_required: true,
    default_workflow_permissions: 'read',
    can_approve_pull_request_reviews: false,
    access_level: 'none',
    approval_policy: 'all_external_contributors',
    max_cache_retention_days: 7,
    max_cache_size_gb: 10,
    ...desired,
    selected_actions: {
      github_owned_allowed: false,
      verified_allowed: false,
      patterns_allowed: [],
      ...desired?.selected_actions,
    },
    artifact_and_log_retention: { days: 90, ...desired?.artifact_and_log_retention },
    fork_pr_workflows_private_repos: {
      run_workflows_from_fork_pull_requests: false,
      send_write_tokens_to_workflows: false,
      send_secrets_and_variables: false,
      require_approval_for_fork_pr_workflows: true,
      ...desired?.fork_pr_workflows_private_repos,
    },
    oidc_customization_sub: {
      use_default: desired?.oidc_customization_sub?.include_claim_keys === undefined,
      use_immutable_subject: false,
      ...desired?.oidc_customization_sub,
    },
  };
  // An excluded setting keeps its live value, including when ownership supplied the baseline.
  const excluded = (ownership.exclude ?? []).reduce<unknown>((current, path) => {
    const [section, ...parts] = path.split('.');
    return section === 'actions' ? withoutSetting(current, parts) : current;
  }, result);
  return actionsSettings.parse(excluded);
}

export function ownershipWarnings(changes: readonly Change[], warnings: Warning[], ownership: Ownership): void {
  const blocked = warnings.find(
    (warning) =>
      warning.section !== undefined &&
      owns(ownership, warning.section) &&
      (warning.cause === 'refused' || warning.cause === 'unavailable' || warning.cause === 'unloadable'),
  );
  if (blocked !== undefined) {
    throw new Error(
      `Cannot fully own ${blocked.section}: ${blocked.message}. Nothing was planned. Restore complete read access or turn ownership off.`,
    );
  }
  if (owns(ownership, 'rulesets')) {
    warnings.push({
      section: 'rulesets',
      message:
        'Full ownership controls repository rulesets only. Inherited organization rulesets remain outside repository control.',
    });
  }
  for (const change of changes) {
    if (change.action !== 'delete' || !owns(ownership, change.section)) {
      continue;
    }
    if (change.section === 'environments' && change.entry.branch_policy === undefined) {
      warnings.push({
        section: 'environments',
        key: change.entry.name,
        message: `Deleting environment "${change.entry.name}" also deletes its secrets and variables.`,
      });
    }
    if (change.section === 'labels') {
      warnings.push({
        section: 'labels',
        key: change.entry.name,
        message: `Deleting label "${change.entry.name}" removes it from issues and pull requests.`,
      });
    }
  }
}
