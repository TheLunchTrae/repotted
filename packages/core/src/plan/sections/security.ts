import { repoPath, type RepoRef } from '../../github/client.js';
import { securityAndAnalysis, securityFields, type SecuritySettings } from '../../profiles/schema.js';
import type { Change, SectionPlan, Warning } from '../change.js';
import {
  activeSettingsForPlan,
  type Endpoint,
  type EndpointValue,
  planEndpoint,
  warningForUnavailable,
} from '../endpoints.js';
import { fieldChanges } from '../match.js';

/**
 * GitHub reports JavaScript and TypeScript apart for code scanning but takes
 * them as one language, so a profile names them the way a write sends them.
 */
function combineScriptLanguages(value: Record<string, unknown>): Record<string, unknown> {
  const languages = value['languages'];
  if (!Array.isArray(languages)) {
    return value;
  }
  const combined = languages.map((language: unknown) =>
    language === 'javascript' || language === 'typescript' ? 'javascript-typescript' : language,
  );
  return { ...value, languages: [...new Set(combined)] };
}

interface Adjusted {
  readonly desired: Record<string, unknown>;
  readonly dropped?: { readonly fields: string[]; readonly reason: string };
}

function without(desired: Record<string, unknown>, fields: string[], reason: string): Adjusted {
  return fields.length > 0
    ? {
        desired: Object.fromEntries(Object.entries(desired).filter(([field]) => !fields.includes(field))),
        dropped: { fields, reason },
      }
    : { desired };
}

/**
 * GitHub reports no runner while a setup is not configured, runs a configured
 * one on standard runners unless told otherwise, reports no runner label with
 * standard runners, and refuses labeled runners without one. GitHub's docs
 * don't say so; this is how it reports these settings, and what the fake
 * GitHub models.
 */
function keepRunnerLabel(desired: Record<string, unknown>, live: Record<string, unknown>): Adjusted {
  const named = (field: string) => desired[field] !== undefined;
  const type = desired['runner_type'] ?? live['runner_type'] ?? 'standard';
  const label = named('runner_label') ? desired['runner_label'] : live['runner_label'];
  if (type === 'standard' && typeof label === 'string' && named('runner_label')) {
    return without(desired, ['runner_label'], 'GitHub keeps none with standard runners');
  }
  if (type === 'labeled' && typeof label !== 'string') {
    // The runner type only goes when it would change what GitHub has.
    const fields = [
      ...(named('runner_type') && desired['runner_type'] !== live['runner_type'] ? ['runner_type'] : []),
      ...(named('runner_label') ? ['runner_label'] : []),
    ];
    return without(desired, fields, 'labeled runners need a runner label');
  }
  return { desired };
}

/**
 * In the order they apply: Dependabot alerts before the security updates that
 * answer them, and code scanning after the repository settings that turn on
 * the Advanced Security it may need.
 */
export const securityEndpoints: readonly Endpoint[] = [
  {
    kind: 'toggle',
    key: 'vulnerability_alerts',
    path: '/vulnerability-alerts',
    target: 'Dependabot alerts',
    reads: 'presence',
  },
  {
    kind: 'toggle',
    key: 'automated_security_fixes',
    path: '/automated-security-fixes',
    target: 'Dependabot security updates',
    reads: 'enabled',
    // GitHub answers 404 while Dependabot alerts are off.
    missingIsOff: true,
  },
  {
    kind: 'toggle',
    key: 'private_vulnerability_reporting',
    path: '/private-vulnerability-reporting',
    target: 'private vulnerability reporting',
    reads: 'enabled',
  },
  {
    kind: 'object',
    key: 'code_scanning_default_setup',
    path: '/code-scanning/default-setup',
    target: 'code scanning default setup',
    method: 'PATCH',
    schema: securityFields.code_scanning_default_setup,
    repositorySpecificFields: ['languages'],
    fromGitHub: combineScriptLanguages,
    adjust: keepRunnerLabel,
  },
  {
    kind: 'object',
    key: 'code_scanning_ai_scan',
    path: '/code-scanning/ai-scan',
    target: 'code scanning AI Scan',
    method: 'PATCH',
    schema: securityFields.code_scanning_ai_scan,
  },
  {
    kind: 'object',
    key: 'code_quality_setup',
    path: '/code-quality/setup',
    target: 'code quality setup',
    method: 'PATCH',
    schema: securityFields.code_quality_setup,
    repositorySpecificFields: ['languages'],
    adjust: keepRunnerLabel,
  },
  {
    kind: 'object',
    key: 'dependabot_runner_settings',
    path: '/dependabot/runner-settings',
    target: 'Dependabot runners',
    method: 'PUT',
    schema: securityFields.dependabot_runner_settings,
    // No group reads as an empty one, the way GitHub reports it.
    fromGitHub: (value) => (value['runner_group'] === null ? { ...value, runner_group: '' } : value),
    // GitHub keeps no runner labels or group with standard runners, and
    // refuses them in the write; labeled runners take exactly one label.
    adjust: (desired, live) => {
      const { runner_labels: labels } = desired;
      const type = desired['runner_type'] ?? live['runner_type'];
      const inEffect = labels ?? live['runner_labels'];
      if (type === 'labeled' && !(Array.isArray(inEffect) && inEffect.length === 1)) {
        return {
          desired: {},
          dropped: { fields: Object.keys(desired), reason: 'labeled runners need exactly one runner label' },
        };
      }
      return { desired };
    },
    adjustWriteBody: (body) => {
      if (body['runner_type'] === 'standard') {
        return { runner_type: 'standard' };
      }
      // GitHub reports no group as an empty one, which it doesn't take back.
      const { runner_group: group, ...rest } = body;
      return group === '' ? rest : body;
    },
  },
];

const securityAndAnalysisKeys = Object.keys(securityAndAnalysis.shape);

export function liveSecurityAndAnalysis(
  reported: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return reported === undefined
    ? undefined
    : Object.fromEntries(
        securityAndAnalysisKeys.filter((key) => reported[key] !== undefined).map((key) => [key, reported[key]]),
      );
}

/**
 * `security_and_analysis` is written to the repository, so it needs the admin
 * view of the repository, which reports it.
 */
export function planSecurity(
  input: SecuritySettings,
  securityAndAnalysisLive: Record<string, unknown> | undefined,
  endpoints: ReadonlyMap<string, EndpointValue>,
  repo: RepoRef,
  actionsEnabled: EndpointValue | undefined,
): SectionPlan {
  const changes: Change[] = [];
  const warnings: Warning[] = [];
  const liveSettings = {
    security_and_analysis: securityAndAnalysisLive,
    ...Object.fromEntries([...endpoints].flatMap(([key, value]) => (value.available ? [[key, value.value]] : []))),
  };
  const desired = activeSettingsForPlan('security', input, liveSettings, warnings);
  if (desired.security_and_analysis !== undefined) {
    if (securityAndAnalysisLive === undefined) {
      warnings.push({
        section: 'security',
        key: 'security_and_analysis',
        cause: 'refused',
        remedy: { kind: 'admin_role' },
        message: 'GitHub did not report it; it reports it only to repository admins',
      });
    } else {
      const fields = fieldChanges(desired.security_and_analysis, securityAndAnalysisLive);
      if (fields.length > 0) {
        changes.push({
          section: 'security',
          action: 'update',
          target: 'security and analysis',
          fields: fields.map((field) => ({ ...field, field: `security_and_analysis.${field.field}` })),
          request: {
            method: 'PATCH',
            path: repoPath(repo),
            body: { security_and_analysis: Object.fromEntries(fields.map((field) => [field.field, field.to])) },
          },
        });
      }
    }
  }
  for (const endpoint of securityEndpoints) {
    const value: unknown = Reflect.get(desired, endpoint.key);
    const live = endpoints.get(endpoint.key);
    if (value === undefined || live === undefined) {
      continue;
    }
    if (
      (endpoint.key === 'code_scanning_default_setup' || endpoint.key === 'code_quality_setup') &&
      desired[endpoint.key]?.state !== 'not-configured' &&
      actionsEnabled !== undefined &&
      (!actionsEnabled.available || actionsEnabled.value !== true)
    ) {
      warnings.push({
        section: 'security',
        key: endpoint.key,
        ...(actionsEnabled.available
          ? {
              cause: 'not_applicable' as const,
              message: 'it needs Actions to be enabled; turn Actions on in the profile or on the repository',
            }
          : warningForUnavailable(actionsEnabled)),
      });
      continue;
    }
    const plan = planEndpoint('security', endpoint, value, live, repo);
    changes.push(...plan.changes);
    warnings.push(...plan.warnings);
  }
  return { changes, warnings };
}
