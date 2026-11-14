import { type SettingField, settingSections } from './setting-fields.js';

// Finds settings by what a person types. A setting is found by its label,
// its key in a profile, its note, the labels of its choices, its other
// names below, its group's title and description, its tab, and the setting
// it sits under, so searching for that one finds its options too.

/** Other words people know a setting by, by its path in a profile. */
export const otherNames: Readonly<Record<string, readonly string[]>> = {
  'repository.default_branch': ['main', 'master', 'trunk'],
  'repository.visibility': ['private', 'public', 'internal'],
  'repository.is_template': ['generate from template'],
  'repository.allow_forking': ['forks'],
  'repository.has_issues': ['bug tracker', 'tickets'],
  'repository.has_projects': ['boards', 'kanban'],
  'repository.has_discussions': ['forum', 'questions'],
  'repository.pull_request_creation_cap.enabled': ['spam', 'cap'],
  'repository.allow_auto_merge': ['automerge'],
  'repository.allow_update_branch': ['out of date', 'behind base', 'update branch'],
  'repository.delete_branch_on_merge': ['auto-delete', 'cleanup', 'remove branches'],
  'repository.web_commit_signoff_required': ['dco', 'signoff', 'developer certificate of origin'],
  'repository.immutable_releases': ['lock releases', 'tag protection'],
  'merge.allow_merge_commit': ['merge button', 'no fast-forward'],
  'merge.allow_squash_merge': ['squash and merge', 'single commit'],
  'merge.allow_rebase_merge': ['rebase and merge', 'linear history', 'fast-forward'],
  'actions.enabled': ['workflows', 'ci', 'github actions'],
  'actions.allowed_actions': ['allowlist', 'third-party', 'marketplace'],
  'actions.selected_actions.patterns_allowed': ['allowlist', 'blocklist', 'patterns', 'wildcard'],
  'actions.sha_pinning_required': ['pin', 'pinned', 'supply chain'],
  'actions.default_workflow_permissions': ['github_token', 'token permissions', 'contents write'],
  'actions.can_approve_pull_request_reviews': ['github_token', 'bot approvals'],
  'actions.access_level': ['reusable workflows', 'share actions'],
  'actions.approval_policy': ['forks', 'first-time contributor', 'outside collaborator'],
  'actions.artifact_and_log_retention.days': ['logs', 'storage', 'expire'],
  'actions.max_cache_retention_days': ['storage', 'expire'],
  'actions.max_cache_size_gb': ['storage', 'quota'],
  'actions.oidc_customization_sub.use_default': ['oidc', 'openid', 'sub claim', 'cloud deploy'],
  'actions.oidc_customization_sub.use_immutable_subject': ['oidc', 'openid', 'sub claim'],
  'security.security_and_analysis.advanced_security': ['ghas'],
  'security.private_vulnerability_reporting': ['security advisories', 'report a vulnerability'],
  'security.vulnerability_alerts': ['vulnerable dependencies', 'cve', 'security alerts'],
  'security.automated_security_fixes': ['dependabot pull requests', 'automatic fixes'],
  'security.dependabot_runner_settings.runner_type': ['self-hosted'],
  'security.dependabot_runner_settings.runner_group': ['self-hosted', 'runner'],
  'security.code_scanning_default_setup.state': ['codeql', 'sast', 'static analysis'],
  'security.code_scanning_default_setup.threat_model': ['codeql'],
  'security.code_scanning_default_setup.runner_type': ['self-hosted'],
  'security.code_quality_setup.runner_type': ['self-hosted'],
  'security.security_and_analysis.secret_scanning': ['secret scanning', 'leaked secrets', 'credentials', 'tokens'],
  'security.security_and_analysis.secret_scanning_push_protection': ['block secrets'],
  'pages.absent': ['unpublish', 'delete site'],
  'pages.build_type': ['jekyll', 'static site', 'website'],
  'pages.cname': ['cname', 'dns', 'website'],
  'pages.https_enforced': ['ssl', 'tls', 'certificate'],
  'security.code_scanning_default_setup.runner_label': ['self-hosted', 'runner'],
  'security.code_quality_setup.runner_label': ['self-hosted', 'runner'],
};

/** Text as the search compares it: lowercase, with punctuation such as the underscores and dots of a key as spaces. */
function normalize(text: string): string {
  return ` ${text.toLowerCase().replaceAll(/[^\p{L}\p{N}]+/gu, ' ')} `;
}

/** What a setting says about itself. On and Off are left out, since every switch has them. */
function own(field: SettingField): string {
  return [
    field.label,
    field.key,
    field.note ?? '',
    ...field.options.map((option) => option.label).filter((label) => label !== 'On' && label !== 'Off'),
    ...(otherNames[field.path.join('.')] ?? []),
  ].join(' ');
}

interface Indexed {
  readonly terms: string;
  /** The setting a sub-option sits under. */
  readonly parent: SettingField | undefined;
}

function build(): Map<SettingField, Indexed> {
  const index = new Map<SettingField, Indexed>();
  for (const section of settingSections) {
    for (const group of section.groups) {
      let parent: SettingField | undefined;
      for (const field of group.fields) {
        const owner = field.nested ? parent : undefined;
        index.set(field, {
          terms: normalize(
            [section.name, group.title, group.description, own(field), owner === undefined ? '' : own(owner)].join(' '),
          ),
          parent: owner,
        });
        if (!field.nested) {
          parent = field;
        }
      }
    }
  }
  return index;
}

const index = build();

/** The words of a search as they are compared, each with the space that starts a word in front; none for a blank search. */
export function searchWords(query: string): string[] {
  return normalize(query)
    .split(' ')
    .filter((word) => word !== '')
    .map((word) => ` ${word}`);
}

/**
 * Whether every word starts a word of the setting's text, so `allow_squash`,
 * "squash allow", and "squ" all find `allow_squash_merge`, while "on"
 * doesn't find every "configuration".
 */
export function matchesSearch(field: SettingField, words: readonly string[]): boolean {
  const terms = index.get(field)?.terms ?? '';
  return words.every((word) => terms.includes(word));
}

/** The setting a sub-option sits under, which shows with it when it is found. */
export function parentOf(field: SettingField): SettingField | undefined {
  return index.get(field)?.parent;
}
