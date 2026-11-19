import { GitHubError } from '../github/client.js';
import { type Lock, requiredPermission } from '../github/permissions.js';
import type { ApplyError } from './apply.js';
import { isListSection, type Section, type Warning } from './change.js';
import type { Plan, Skipped } from './plan.js';

function show(value: unknown): string {
  return value === undefined ? 'unset' : JSON.stringify(value);
}

const symbols = { create: '+', update: '~', delete: '-' } as const;

function describeTarget(section: Section, target: string): string {
  switch (section) {
    case 'actions_policies':
      return `Actions policy "${target}"`;
    case 'rulesets':
      return `ruleset "${target}"`;
    case 'environments':
      return `environment ${target}`;
    case 'autolinks':
      return `autolink ${target}`;
    case 'labels':
      return `label "${target}"`;
    case 'repository':
    case 'merge':
    case 'actions':
    case 'security':
    case 'custom_properties':
    case 'pages':
      return target;
  }
}

export function describeSkipped({ section, target, unset }: Skipped): string {
  const named = isListSection(section) ? describeTarget(section, target) : `${section}.${target}`;
  if (unset === true) {
    return `${named} (stops managing it)`;
  }
  return section === 'pages' && target === 'absent' ? 'pages.absent (turns the Pages site off)' : named;
}

const entryNouns: Partial<Record<Section, string>> = {
  autolinks: 'autolink',
  actions_policies: 'Actions policy',
  rulesets: 'ruleset',
  environments: 'environment',
  labels: 'label',
};

export function describeWarning({ section, key, field, cause, message }: Warning): string {
  if (cause === undefined || section === undefined) {
    return message;
  }
  const noun = entryNouns[section];
  const where =
    noun !== undefined && key !== undefined
      ? `${noun} "${key}"`
      : [section, key, field].filter((part) => part !== undefined).join('.');
  return `Skipped ${where}: ${message}`;
}

export function formatPlan(plan: Plan, locks: readonly Lock[] = []): string {
  const lines = [
    ...((plan.authoritative?.length ?? 0) > 0
      ? [`Full ownership: ${plan.authoritative?.join(', ')}. Unlisted entries are removed.`]
      : []),
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
    lines.push(`  ! ${describeWarning(warning)}`);
  }
  return lines.join('\n');
}

/**
 * Only a `402`, `403` or `422` says something lasting about the repository, the
 * token or the App. A refusal for want of a permission names the permission;
 * any other gives GitHub's reason. Null for anything else, a rate limit
 * included.
 */
export function failureReason(error: ApplyError): string | null {
  const cause = error.cause;
  if (!(cause instanceof GitHubError) || ![402, 403, 422].includes(cause.status) || cause.rateLimited) {
    return null;
  }
  if (cause.status === 403 && /not accessible by/iu.test(cause.message)) {
    const { method, path } = error.failed.request;
    return `Needs ${requiredPermission(method, path)}`;
  }
  return cause.message;
}

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
