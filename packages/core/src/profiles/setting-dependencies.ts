import { isDeepEqual } from '../shared/equal.js';
import type { Profile } from './schema.js';

export interface SettingCondition {
  readonly otherSettingKeyInSameSection: string;
  readonly values: readonly unknown[];
  readonly hiddenRatherThanGreyedOut: boolean;
}

interface Dependency extends SettingCondition {
  readonly section: string;
  readonly keys: readonly string[];
  /** Set when the reason says more than that the other setting has one of its values. */
  readonly reason?: string | undefined;
}

function dependency(
  section: string,
  keys: readonly string[],
  other: string,
  values: readonly unknown[],
  hidden = true,
  reason?: string,
): Dependency {
  return { section, keys, otherSettingKeyInSameSection: other, values, hiddenRatherThanGreyedOut: hidden, reason };
}

const dependencies: readonly Dependency[] = [
  dependency('repository', ['pull_request_creation_policy', 'pull_request_creation_cap'], 'has_pull_requests', [false]),
  dependency(
    'repository',
    ['pull_request_creation_cap.max_open_pull_requests', 'pull_request_creation_cap.include_drafts'],
    'pull_request_creation_cap.enabled',
    [false],
  ),
  dependency('merge', ['merge_commit_title', 'merge_commit_message'], 'allow_merge_commit', [false]),
  dependency('merge', ['squash_merge_commit_title', 'squash_merge_commit_message'], 'allow_squash_merge', [false]),
  dependency(
    'actions',
    ['allowed_actions', 'sha_pinning_required'],
    'enabled',
    [false],
    true,
    'it only applies while Actions is enabled',
  ),
  dependency(
    'actions',
    ['selected_actions'],
    'allowed_actions',
    ['all', 'local_only'],
    true,
    'it only applies while Actions is enabled and allows only selected actions',
  ),
  dependency(
    'actions',
    [
      'fork_pr_workflows_private_repos.send_write_tokens_to_workflows',
      'fork_pr_workflows_private_repos.send_secrets_and_variables',
      'fork_pr_workflows_private_repos.require_approval_for_fork_pr_workflows',
    ],
    'fork_pr_workflows_private_repos.run_workflows_from_fork_pull_requests',
    [false],
    false,
  ),
  dependency(
    'actions',
    ['oidc_customization_sub.include_claim_keys'],
    'oidc_customization_sub.use_default',
    [true],
    true,
    'GitHub ignores the claim keys while the subject claim uses its default',
  ),
  dependency(
    'security',
    ['automated_security_fixes'],
    'vulnerability_alerts',
    [false],
    false,
    'it needs Dependabot alerts, which are off',
  ),
  ...['code_scanning_default_setup', 'code_quality_setup'].flatMap((setup) => [
    dependency(
      'security',
      (setup === 'code_scanning_default_setup'
        ? ['query_suite', 'threat_model', 'languages', 'runner_type']
        : ['ai_findings_option', 'languages', 'runner_type']
      ).map((key) => `${setup}.${key}`),
      `${setup}.state`,
      ['not-configured'],
      true,
      'GitHub keeps no setup options while the setup is not configured',
    ),
    dependency(
      'security',
      [`${setup}.runner_label`],
      `${setup}.runner_type`,
      ['standard'],
      false,
      'GitHub keeps none with standard runners',
    ),
  ]),
  dependency(
    'security',
    ['dependabot_runner_settings.runner_labels', 'dependabot_runner_settings.runner_group'],
    'dependabot_runner_settings.runner_type',
    ['standard'],
    false,
    'GitHub keeps none with standard runners',
  ),
  dependency(
    'security',
    [
      'secret_scanning_push_protection',
      'secret_scanning_ai_detection',
      'secret_scanning_non_provider_patterns',
      'secret_scanning_validity_checks',
      'secret_scanning_delegated_alert_dismissal',
      'secret_scanning_delegated_bypass',
    ].map((key) => `security_and_analysis.${key}`),
    'security_and_analysis.secret_scanning',
    [{ status: 'disabled' }],
    false,
  ),
  dependency(
    'security',
    ['security_and_analysis.secret_scanning_delegated_bypass_options'],
    'security_and_analysis.secret_scanning_delegated_bypass',
    [{ status: 'disabled' }],
    false,
  ),
  dependency('pages', ['source'], 'build_type', ['workflow']),
];

function dependencyFor(section: string, key: string): Dependency | undefined {
  const exact = dependencies.find((rule) => rule.section === section && rule.keys.includes(key));
  const parent = key.lastIndexOf('.');
  return exact ?? (parent === -1 ? undefined : dependencyFor(section, key.slice(0, parent)));
}

export function settingCondition(section: string, key: string): SettingCondition | undefined {
  return dependencyFor(section, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function get(settings: object, key: string): unknown {
  return key.split('.').reduce<unknown>((value, part) => (isRecord(value) ? value[part] : undefined), settings);
}

export interface InactiveSetting {
  readonly key: string;
  readonly reason: string;
  /** The setting in the same section whose value turns this one off, when the reason names nothing else. */
  readonly inactive_while?: { readonly key: string; readonly values: readonly unknown[] };
}

/** Dependencies use the desired value first, then live state for settings the profile leaves unmanaged. */
export function activeSettings<T extends object>(
  section: string,
  desired: T,
  live: object = {},
): { settings: T; inactive: readonly InactiveSetting[] } {
  const inactive: InactiveSetting[] = [];
  const blockedBy = (key: string): Dependency | undefined => {
    const rule = dependencyFor(section, key);
    if (rule === undefined) {
      return undefined;
    }
    const other = rule.otherSettingKeyInSameSection;
    const parent = blockedBy(other);
    if (parent !== undefined) {
      return parent;
    }
    const value = get(desired, other) ?? get(live, other);
    return rule.values.some((blocked) => isDeepEqual(blocked, value)) ? rule : undefined;
  };
  const keep = <Settings extends object>(settings: Settings, prefix: string): Settings => {
    const kept = { ...settings };
    for (const key of Object.keys(settings)) {
      const value: unknown = Reflect.get(settings, key);
      const path = prefix === '' ? key : `${prefix}.${key}`;
      const rule = blockedBy(path);
      if (rule !== undefined) {
        inactive.push(
          rule.reason === undefined
            ? {
                key: path,
                reason: `it does not apply while ${rule.otherSettingKeyInSameSection} is ${rule.values.map((blocked) => JSON.stringify(blocked)).join(' or ')}`,
                inactive_while: { key: rule.otherSettingKeyInSameSection, values: rule.values },
              }
            : { key: path, reason: rule.reason },
        );
        Reflect.deleteProperty(kept, key);
      } else if (isRecord(value)) {
        const child = keep(value, path);
        if (Object.keys(child).length === 0 && Object.keys(value).length > 0) {
          Reflect.deleteProperty(kept, key);
        } else {
          Reflect.set(kept, key, child);
        }
      }
    }
    return kept;
  };
  return { settings: keep(desired, ''), inactive };
}

export function activeProfileSettings(profile: Profile): Profile {
  const kept = { ...profile };
  for (const section of ['repository', 'merge', 'actions', 'security', 'pages'] as const) {
    const settings = profile[section];
    if (settings !== undefined) {
      Object.assign(kept, { [section]: activeSettings(section, settings).settings });
    }
  }
  return kept;
}
