import { settingCondition, type SettingCondition } from '@repotted/core';

export interface SettingOption {
  readonly label: string;
  readonly value: unknown;
}

interface FieldDetails {
  readonly section: string;
  readonly key: string;
  readonly label: string;
  readonly kind: 'choice' | 'number' | 'text' | 'list';
  readonly options: readonly SettingOption[];
  readonly indentedUnderPreviousSetting: boolean;
  readonly note: string | undefined;
  readonly allowsEmpty: boolean;
  readonly emptyIsNull: boolean;
  readonly dependsOn: SettingCondition | undefined;
  readonly excludesOtherSettingsInSection: boolean;
}

export class SettingField implements FieldDetails {
  readonly section: string;
  readonly key: string;
  readonly label: string;
  readonly kind: FieldDetails['kind'];
  readonly options: readonly SettingOption[];
  readonly indentedUnderPreviousSetting: boolean;
  readonly note: string | undefined;
  readonly allowsEmpty: boolean;
  readonly emptyIsNull: boolean;
  readonly dependsOn: SettingCondition | undefined;
  readonly excludesOtherSettingsInSection: boolean;

  constructor(details: FieldDetails) {
    this.section = details.section;
    this.key = details.key;
    this.label = details.label;
    this.kind = details.kind;
    this.options = details.options;
    this.indentedUnderPreviousSetting = details.indentedUnderPreviousSetting;
    this.note = details.note;
    this.allowsEmpty = details.allowsEmpty;
    this.emptyIsNull = details.emptyIsNull;
    this.dependsOn = details.dependsOn;
    this.excludesOtherSettingsInSection = details.excludesOtherSettingsInSection;
  }

  get path(): readonly string[] {
    return [this.section, ...this.key.split('.')];
  }

  under(): SettingField {
    return new SettingField({ ...this.#details(), indentedUnderPreviousSetting: true });
  }

  noted(note: string): SettingField {
    return new SettingField({ ...this.#details(), note });
  }

  standsAlone(): SettingField {
    return new SettingField({ ...this.#details(), excludesOtherSettingsInSection: true });
  }

  #details(): FieldDetails {
    return {
      section: this.section,
      key: this.key,
      label: this.label,
      kind: this.kind,
      options: this.options,
      indentedUnderPreviousSetting: this.indentedUnderPreviousSetting,
      note: this.note,
      allowsEmpty: this.allowsEmpty,
      emptyIsNull: this.emptyIsNull,
      dependsOn: this.dependsOn,
      excludesOtherSettingsInSection: this.excludesOtherSettingsInSection,
    };
  }
}

export interface SettingGroup {
  readonly title: string;
  readonly description: string;
  readonly fields: readonly SettingField[];
}

export interface SettingSection {
  readonly name: string;
  readonly section: string;
  readonly groups: readonly SettingGroup[];
}

function field(
  section: string,
  key: string,
  label: string,
  kind: FieldDetails['kind'],
  options: readonly SettingOption[] = [],
  text: { readonly allowsEmpty?: boolean; readonly emptyIsNull?: boolean } = {},
): SettingField {
  return new SettingField({
    section,
    key,
    label,
    kind,
    options,
    indentedUnderPreviousSetting: false,
    note: undefined,
    allowsEmpty: text.allowsEmpty ?? false,
    emptyIsNull: text.emptyIsNull ?? false,
    dependsOn: settingCondition(section, key),
    excludesOtherSettingsInSection: false,
  });
}

function custom(
  section: string,
  key: string,
  label: string,
  options: readonly (readonly [string, unknown])[],
): SettingField {
  return field(
    section,
    key,
    label,
    'choice',
    options.map(([name, value]) => ({ label: name, value })),
  );
}

const disabled = { status: 'disabled' };

function onOff(section: string, key: string, label: string): SettingField {
  return custom(section, key, label, [
    ['On', true],
    ['Off', false],
  ]);
}

/** GitHub turns a feature under `security_and_analysis` on and off by a status. */
function feature(key: string, label: string): SettingField {
  return custom('security', `security_and_analysis.${key}`, label, [
    ['On', { status: 'enabled' }],
    ['Off', disabled],
  ]);
}

function choice(section: string, key: string, label: string, ...options: (readonly [string, string])[]): SettingField {
  return custom(section, key, label, options);
}

function list(section: string, key: string, label: string): SettingField {
  return field(section, key, label, 'list');
}

function number(section: string, key: string, label: string): SettingField {
  return field(section, key, label, 'number');
}

function text(
  section: string,
  key: string,
  label: string,
  options: { readonly allowsEmpty?: boolean; readonly emptyIsNull?: boolean } = {},
): SettingField {
  return field(section, key, label, 'text', [], options);
}

function runnerLabel(setup: string): SettingField {
  return text('security', `${setup}.runner_label`, 'Runner label', { emptyIsNull: true })
    .under()
    .noted('Used only with labeled runners. Leave it empty for no label.');
}

function group(title: string, description: string, fields: readonly SettingField[]): SettingGroup {
  return { title, description, fields };
}

function section(name: string, key: string, groups: readonly SettingGroup[]): SettingSection {
  return { name, section: key, groups };
}

export const settingSections: readonly SettingSection[] = [
  section('Repository', 'repository', [
    group(
      'About',
      'The description, website, and visibility describe one repository, so a captured profile leaves them out. Topics, custom properties, and autolinks are set in the profile file, not here.',
      [
        text('repository', 'description', 'Description', { allowsEmpty: true }),
        text('repository', 'homepage', 'Website', { allowsEmpty: true }),
        text('repository', 'default_branch', 'Default branch'),
        choice('repository', 'visibility', 'Visibility', ['Public', 'public'], ['Private', 'private']).noted(
          'A plan says what a change of visibility does before it applies.',
        ),
        onOff('repository', 'is_template', 'Template repository'),
        onOff('repository', 'allow_forking', 'Allow forking'),
      ],
    ),
    group('Features', 'What the repository shows on GitHub.', [
      onOff('repository', 'has_issues', 'Issues').noted(
        'Limiting issues to collaborators and closing issues when a linked pull request merges have no API, so they are set on GitHub only.',
      ),
      onOff('repository', 'has_projects', 'Projects'),
      onOff('repository', 'has_wiki', 'Wiki').noted(
        'Restricting editing to collaborators has no API, so it is set on GitHub only.',
      ),
      onOff('repository', 'has_discussions', 'Discussions'),
      onOff('repository', 'has_pull_requests', 'Pull requests'),
      choice(
        'repository',
        'pull_request_creation_policy',
        'Who can create pull requests',
        ['Everyone', 'all'],
        ['Collaborators only', 'collaborators_only'],
      ).under(),
      onOff('repository', 'pull_request_creation_cap.enabled', 'Limit open pull requests per user')
        .under()
        .noted('Exemptions by account age or merged pull requests have no API, so they are set on GitHub only.'),
      number('repository', 'pull_request_creation_cap.max_open_pull_requests', 'Open pull requests allowed').under(),
      onOff('repository', 'pull_request_creation_cap.include_drafts', 'Count draft pull requests').under(),
    ]),
    group('Pull requests', 'How branches update and clean up after a merge.', [
      onOff('repository', 'allow_auto_merge', 'Allow auto-merge'),
      onOff('repository', 'allow_update_branch', 'Suggest updating branches'),
      onOff('repository', 'delete_branch_on_merge', 'Delete head branches after merge'),
      onOff('repository', 'web_commit_signoff_required', 'Require sign-off on web commits'),
    ]),
    group('Releases', "Whether a published release's tag and assets are locked.", [
      onOff('repository', 'immutable_releases', 'Immutable releases'),
    ]),
  ]),
  section('Merge', 'merge', [
    group(
      'Merge methods',
      'How pull requests can merge, and what each kind of commit says. GitHub needs at least one method, and takes only the commit title and message pairs its settings page offers.',
      [
        onOff('merge', 'allow_merge_commit', 'Allow merge commits'),
        choice(
          'merge',
          'merge_commit_title',
          'Merge commit title',
          ['Pull request title', 'PR_TITLE'],
          ['Default message', 'MERGE_MESSAGE'],
        ).under(),
        choice(
          'merge',
          'merge_commit_message',
          'Merge commit message',
          ['Pull request body', 'PR_BODY'],
          ['Pull request title', 'PR_TITLE'],
          ['Blank', 'BLANK'],
        ).under(),
        onOff('merge', 'allow_squash_merge', 'Allow squash merging'),
        choice(
          'merge',
          'squash_merge_commit_title',
          'Squash commit title',
          ['Pull request title', 'PR_TITLE'],
          ['Commit or pull request title', 'COMMIT_OR_PR_TITLE'],
        ).under(),
        choice(
          'merge',
          'squash_merge_commit_message',
          'Squash commit message',
          ['Pull request body', 'PR_BODY'],
          ['Commit messages', 'COMMIT_MESSAGES'],
          ['Blank', 'BLANK'],
        ).under(),
        onOff('merge', 'allow_rebase_merge', 'Allow rebase merging'),
      ],
    ),
  ]),
  section('Actions', 'actions', [
    group('Policy', 'Whether workflows run, and which actions they may use.', [
      onOff('actions', 'enabled', 'Actions'),
      choice(
        'actions',
        'allowed_actions',
        'Allowed actions',
        ['All', 'all'],
        ["This owner's", 'local_only'],
        ['Selected', 'selected'],
      ).under(),
      onOff('actions', 'selected_actions.github_owned_allowed', 'Actions by GitHub').under(),
      onOff('actions', 'selected_actions.verified_allowed', 'Actions by verified creators').under(),
      list('actions', 'selected_actions.patterns_allowed', 'Allowed action patterns')
        .under()
        .noted('One pattern a line, such as octo-org/*. Start one with ! to block it.'),
      onOff('actions', 'sha_pinning_required', 'Require pinning to a full commit SHA').under(),
    ]),
    group('Workflow permissions', 'What the GITHUB_TOKEN may do.', [
      choice(
        'actions',
        'default_workflow_permissions',
        'Default permissions',
        ['Read', 'read'],
        ['Read and write', 'write'],
      ),
      onOff('actions', 'can_approve_pull_request_reviews', 'Allow approving pull requests'),
    ]),
    group(
      'Access',
      "Whether workflows in other private repositories can use this one's actions and reusable workflows. Private repositories only.",
      [
        choice(
          'actions',
          'access_level',
          'Accessible from',
          ['Nowhere else', 'none'],
          ["This user's repositories", 'user'],
          ["This organization's repositories", 'organization'],
        ),
      ],
    ),
    group('Fork pull requests', 'When workflows from forks run, and what they get.', [
      choice(
        'actions',
        'approval_policy',
        'Require approval for',
        ['New GitHub users', 'first_time_contributors_new_to_github'],
        ['First-time contributors', 'first_time_contributors'],
        ['All outside contributors', 'all_external_contributors'],
      ),
      onOff(
        'actions',
        'fork_pr_workflows_private_repos.run_workflows_from_fork_pull_requests',
        'Run workflows from fork pull requests',
      ).noted('Private repositories only.'),
      onOff(
        'actions',
        'fork_pr_workflows_private_repos.send_write_tokens_to_workflows',
        'Send write tokens to workflows',
      ).under(),
      onOff(
        'actions',
        'fork_pr_workflows_private_repos.send_secrets_and_variables',
        'Send secrets and variables',
      ).under(),
      onOff(
        'actions',
        'fork_pr_workflows_private_repos.require_approval_for_fork_pr_workflows',
        'Require approval for each run',
      ).under(),
    ]),
    group('Artifacts and caches', 'How long workflow output stays, and how much the cache holds.', [
      number('actions', 'artifact_and_log_retention.days', 'Artifact and log retention, in days'),
      number('actions', 'max_cache_retention_days', 'Cache retention, in days'),
      number('actions', 'max_cache_size_gb', 'Cache size limit, in GB'),
    ]),
    group(
      'OpenID Connect',
      'The subject claim in the tokens workflows get from GitHub. Claim keys are set in the profile file, not here.',
      [
        onOff('actions', 'oidc_customization_sub.use_default', 'Use the default subject claim'),
        onOff('actions', 'oidc_customization_sub.use_immutable_subject', 'Use immutable IDs in the subject'),
      ],
    ),
  ]),
  section('Security', 'security', [
    group('Advanced Security', 'GitHub shows and changes these for repository admins only.', [
      feature('advanced_security', 'GitHub Advanced Security'),
      feature('code_security', 'GitHub Code Security'),
      onOff('security', 'private_vulnerability_reporting', 'Private vulnerability reporting'),
    ]),
    group('Dependabot', 'Alerts and pull requests for vulnerable dependencies.', [
      onOff('security', 'vulnerability_alerts', 'Dependabot alerts').noted(
        'Malware alerts, Dependabot rules, and preventing direct dismissals have no API here, so they are set on GitHub or in a security configuration.',
      ),
      onOff('security', 'automated_security_fixes', 'Dependabot security updates')
        .under()
        .noted('Grouping security updates has no API; groups in dependabot.yml do it instead.'),
      choice(
        'security',
        'dependabot_runner_settings.runner_type',
        'Dependabot runners',
        ['Standard', 'standard'],
        ['Labeled', 'labeled'],
      ).noted('Runner labels are set in the profile file, not here.'),
      text('security', 'dependabot_runner_settings.runner_group', 'Runner group', { allowsEmpty: true })
        .under()
        .noted('Used only with labeled runners. Leave it empty for no group.'),
    ]),
    group('Code scanning', 'Finds problems in the code with CodeQL. Languages are set in the profile file, not here.', [
      choice(
        'security',
        'code_scanning_default_setup.state',
        'Default setup',
        ['Configured', 'configured'],
        ['Not configured', 'not-configured'],
      ).noted(
        'Copilot Autofix, Agentic Autofix, and preventing direct dismissals have no API here, so they are set on GitHub or in a security configuration.',
      ),
      choice(
        'security',
        'code_scanning_default_setup.query_suite',
        'Query suite',
        ['Default', 'default'],
        ['Extended', 'extended'],
      ).under(),
      choice(
        'security',
        'code_scanning_default_setup.threat_model',
        'Threat model',
        ['Remote', 'remote'],
        ['Remote and local', 'remote_and_local'],
      ).under(),
      choice(
        'security',
        'code_scanning_default_setup.runner_type',
        'Runner type',
        ['Standard', 'standard'],
        ['Labeled', 'labeled'],
      ).under(),
      runnerLabel('code_scanning_default_setup'),
      choice(
        'security',
        'code_scanning_ai_scan.pr_scan',
        'AI Scan on pull requests',
        ['On', 'enabled'],
        ['Off', 'disabled'],
      ),
    ]),
    group(
      'Code quality',
      'Finds maintainability and reliability problems. Languages are set in the profile file, not here.',
      [
        choice(
          'security',
          'code_quality_setup.state',
          'Code quality',
          ['Configured', 'configured'],
          ['Not configured', 'not-configured'],
        ),
        choice(
          'security',
          'code_quality_setup.ai_findings_option',
          'AI findings',
          ['Off', 'disabled'],
          ['On push', 'on_push'],
        ).under(),
        choice(
          'security',
          'code_quality_setup.runner_type',
          'Runner type',
          ['Standard', 'standard'],
          ['Labeled', 'labeled'],
        ).under(),
        runnerLabel('code_quality_setup'),
      ],
    ),
    group('Secret scanning', 'Finds secrets pushed to the repository.', [
      feature('secret_scanning', 'Secret Protection'),
      feature('secret_scanning_push_protection', 'Push protection')
        .under()
        .noted('Push protection for AI-detected secrets is set only in a security configuration.'),
      feature('secret_scanning_ai_detection', 'AI detection').under(),
      feature('secret_scanning_non_provider_patterns', 'Non-provider patterns').under(),
      feature('secret_scanning_validity_checks', 'Validity checks')
        .under()
        .noted('GitHub Enterprise Cloud only. Extended metadata is set only in a security configuration.'),
      feature('secret_scanning_delegated_alert_dismissal', 'Delegated alert dismissal').under(),
      feature('secret_scanning_delegated_bypass', 'Delegated bypass')
        .under()
        .noted('Who can approve a bypass is set in the profile file, not here.'),
    ]),
  ]),
  section('Pages', 'pages', [
    group('GitHub Pages', 'The site GitHub publishes from the repository.', [
      custom('pages', 'absent', 'Take the site down', [['Yes', true]])
        .standsAlone()
        .noted('It deletes the site on each repository. Remove it to describe a site instead.'),
      choice('pages', 'build_type', 'Build from', ['A branch', 'legacy'], ['GitHub Actions', 'workflow']),
      text('pages', 'source.branch', 'Branch').under(),
      choice('pages', 'source.path', 'Folder', ['/ (root)', '/'], ['/docs', '/docs']).under(),
      text('pages', 'cname', 'Custom domain').noted('To clear a domain, set cname to null in the profile file.'),
      onOff('pages', 'https_enforced', 'Enforce HTTPS'),
      custom('pages', 'public', 'Who can see the site', [
        ['Everyone', true],
        ['People with access', false],
      ]).noted('GitHub Enterprise Cloud only.'),
    ]),
  ]),
];
