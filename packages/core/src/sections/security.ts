import type { Change, SectionPlan } from '../change.js';
import { type Endpoint, type EndpointValue, planEndpoint } from '../endpoints.js';
import { repoPath, type RepoRef } from '../github.js';
import { fieldChanges } from '../match.js';
import { securityAndAnalysis, type SecuritySettings } from '../schema.js';

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

/**
 * Security and code quality settings at endpoints of their own, in the
 * order they apply: Dependabot alerts before the security updates that
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
    fields: ['state', 'runner_type', 'runner_label', 'query_suite', 'threat_model', 'languages'],
    carries: [],
    identifying: ['languages'],
    fromGitHub: combineScriptLanguages,
  },
  {
    kind: 'object',
    key: 'code_scanning_ai_scan',
    path: '/code-scanning/ai-scan',
    target: 'code scanning AI Scan',
    method: 'PATCH',
    fields: ['pr_scan'],
    carries: [],
  },
  {
    kind: 'object',
    key: 'code_quality_setup',
    path: '/code-quality/setup',
    target: 'code quality setup',
    method: 'PATCH',
    fields: ['state', 'runner_type', 'runner_label', 'languages', 'ai_findings_option'],
    carries: [],
    identifying: ['languages'],
  },
  {
    kind: 'object',
    key: 'dependabot_runner_settings',
    path: '/dependabot/runner-settings',
    target: 'Dependabot runners',
    method: 'PUT',
    fields: ['runner_type', 'runner_labels', 'runner_group'],
    carries: ['runner_type', 'runner_labels', 'runner_group'],
    // GitHub keeps no runner labels or group with standard runners, and
    // refuses them in the write.
    adjust: (desired, live) => {
      const { runner_labels: labels, runner_group: group, ...rest } = desired;
      const standard = (desired['runner_type'] ?? live['runner_type']) === 'standard';
      const dropped = [
        ...(labels === undefined ? [] : ['runner_labels']),
        ...(group === undefined ? [] : ['runner_group']),
      ];
      return standard && dropped.length > 0
        ? { desired: rest, dropped: { fields: dropped, reason: 'GitHub keeps none with standard runners' } }
        : { desired };
    },
    body: (body) => (body['runner_type'] === 'standard' ? { runner_type: 'standard' } : body),
  },
];

const securityAndAnalysisKeys = Object.keys(securityAndAnalysis.shape);

/** The parts of `security_and_analysis` a profile can set, as the repository reports them. */
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
 * Plans the security section. `security_and_analysis` is written to the
 * repository, so it needs the admin view of the repository, which reports
 * it. Turning Dependabot alerts off turns security updates off first.
 */
export function planSecurity(
  desired: SecuritySettings,
  securityAndAnalysisLive: Record<string, unknown> | undefined,
  endpoints: ReadonlyMap<string, EndpointValue>,
  repo: RepoRef,
): SectionPlan {
  const changes: Change[] = [];
  const warnings: string[] = [];
  if (desired.security_and_analysis !== undefined) {
    if (securityAndAnalysisLive === undefined) {
      warnings.push(
        'Skipped security.security_and_analysis: GitHub did not report it; it reports it only to repository admins',
      );
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
  const alerts = endpoints.get('vulnerability_alerts');
  const alertsOn = desired.vulnerability_alerts ?? (alerts?.available === true ? alerts.value : undefined);
  const planned: Change[] = [];
  for (const endpoint of securityEndpoints) {
    const value: unknown = Reflect.get(desired, endpoint.key);
    const live = endpoints.get(endpoint.key);
    if (value === undefined || live === undefined) {
      continue;
    }
    if (endpoint.key === 'automated_security_fixes' && value === true && alertsOn === false) {
      warnings.push('Skipped security.automated_security_fixes: it needs Dependabot alerts, which are off');
      continue;
    }
    const plan = planEndpoint('security', endpoint, value, live, repo);
    planned.push(...plan.changes);
    warnings.push(...plan.warnings);
  }
  // Security updates go off before the alerts they answer.
  const fixesOff = planned.filter(
    (change) => change.target === 'Dependabot security updates' && change.request.method === 'DELETE',
  );
  changes.push(...fixesOff, ...planned.filter((change) => !fixesOff.includes(change)));
  return { changes, warnings };
}
