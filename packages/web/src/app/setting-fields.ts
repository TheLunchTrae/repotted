// The settings the profile editor offers, in the order of its tabs: what each
// is called, the choices it takes, and what it depends on. A setting's path
// is its section and its key in a profile, as `merge.allow_squash_merge`, with
// dots inside the key for a setting in a group.

/** A value a setting can take, with what the editor calls it. */
export interface SettingOption {
  readonly label: string;
  readonly value: unknown;
}

/** When a setting follows another: GitHub hides it, or greys it out, while the other has one of these values. */
export interface SettingCondition {
  /** The other setting's key, in the same section. */
  readonly key: string;
  readonly values: readonly unknown[];
  /** Whether GitHub hides the setting, rather than leaving it in place and off. */
  readonly hides: boolean;
}

interface FieldDetails {
  readonly section: string;
  readonly key: string;
  readonly label: string;
  readonly kind: 'choice' | 'number' | 'text' | 'list';
  readonly options: readonly SettingOption[];
  /** Whether it sits indented under the setting before it, as one of that setting's own options. */
  readonly nested: boolean;
  /** What to know about it, such as an option beside it that has no API. */
  readonly note: string | undefined;
  /** Whether a text setting may be empty. */
  readonly allowsEmpty: boolean;
  /** Whether an empty text setting is saved as null, which clears it on GitHub. */
  readonly emptyIsNull: boolean;
  readonly dependsOn: SettingCondition | undefined;
  /** Whether setting it takes out every other setting in its section, and setting any of them takes it out. */
  readonly alone: boolean;
  /** Other words a search finds it by. */
  readonly synonyms: readonly string[];
  /** Whether its lines are allowed action patterns, which the editor checks against GitHub. */
  readonly actionPatterns: boolean;
}

export class SettingField implements FieldDetails {
  readonly section: string;
  readonly key: string;
  readonly label: string;
  readonly kind: FieldDetails['kind'];
  readonly options: readonly SettingOption[];
  readonly nested: boolean;
  readonly note: string | undefined;
  readonly allowsEmpty: boolean;
  readonly emptyIsNull: boolean;
  readonly dependsOn: SettingCondition | undefined;
  readonly alone: boolean;
  readonly synonyms: readonly string[];
  readonly actionPatterns: boolean;

  constructor(details: FieldDetails) {
    this.section = details.section;
    this.key = details.key;
    this.label = details.label;
    this.kind = details.kind;
    this.options = details.options;
    this.nested = details.nested;
    this.note = details.note;
    this.allowsEmpty = details.allowsEmpty;
    this.emptyIsNull = details.emptyIsNull;
    this.dependsOn = details.dependsOn;
    this.alone = details.alone;
    this.synonyms = details.synonyms;
    this.actionPatterns = details.actionPatterns;
  }

  /** The setting's place in a profile: its section, then each key down to it. */
  get path(): readonly string[] {
    return [this.section, ...this.key.split('.')];
  }

  under(): SettingField {
    return new SettingField({ ...this.#details(), nested: true });
  }

  noted(note: string): SettingField {
    return new SettingField({ ...this.#details(), note });
  }

  also(...synonyms: string[]): SettingField {
    return new SettingField({ ...this.#details(), synonyms });
  }

  hiddenWhile(key: string, ...values: unknown[]): SettingField {
    return new SettingField({ ...this.#details(), dependsOn: { key, values, hides: true } });
  }

  offWhile(key: string, ...values: unknown[]): SettingField {
    return new SettingField({ ...this.#details(), dependsOn: { key, values, hides: false } });
  }

  ofActionPatterns(): SettingField {
    return new SettingField({ ...this.#details(), actionPatterns: true });
  }

  standsAlone(): SettingField {
    return new SettingField({ ...this.#details(), alone: true });
  }

  #details(): FieldDetails {
    return {
      section: this.section,
      key: this.key,
      label: this.label,
      kind: this.kind,
      options: this.options,
      nested: this.nested,
      note: this.note,
      allowsEmpty: this.allowsEmpty,
      emptyIsNull: this.emptyIsNull,
      dependsOn: this.dependsOn,
      alone: this.alone,
      synonyms: this.synonyms,
      actionPatterns: this.actionPatterns,
    };
  }
}

export interface SettingGroup {
  readonly title: string;
  readonly description: string;
  readonly fields: readonly SettingField[];
}

/** One tab of the editor: the settings of one section of a profile. */
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
    nested: false,
    note: undefined,
    allowsEmpty: text.allowsEmpty ?? false,
    emptyIsNull: text.emptyIsNull ?? false,
    dependsOn: undefined,
    alone: false,
    synonyms: [],
    actionPatterns: false,
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

/** A feature under `security_and_analysis`, which GitHub turns on and off by a status. */
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
    .offWhile(`${setup}.runner_type`, 'standard')
    .noted('Used only with labeled runners. Leave it empty for no label.')
    .also('self-hosted', 'runner');
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
      'The description, website, and visibility describe one repository, so a captured profile leaves them out. Topics, custom properties, and autolinks are edited in the YAML.',
      [
        text('repository', 'description', 'Description', { allowsEmpty: true }),
        text('repository', 'homepage', 'Website', { allowsEmpty: true }),
        text('repository', 'default_branch', 'Default branch').also('main', 'master', 'trunk'),
        choice('repository', 'visibility', 'Visibility', ['Public', 'public'], ['Private', 'private'])
          .noted('A plan says what a change of visibility does before it applies.')
          .also('private', 'public', 'internal'),
        onOff('repository', 'is_template', 'Template repository').also('generate from template'),
        onOff('repository', 'allow_forking', 'Allow forking').also('forks'),
      ],
    ),
    group('Features', 'What the repository shows on GitHub.', [
      onOff('repository', 'has_issues', 'Issues')
        .also('bug tracker', 'tickets')
        .noted(
          'Limiting issues to collaborators and closing issues when a linked pull request merges have no API, so they are set on GitHub only.',
        ),
      onOff('repository', 'has_projects', 'Projects').also('boards', 'kanban'),
      onOff('repository', 'has_wiki', 'Wiki').noted(
        'Restricting editing to collaborators has no API, so it is set on GitHub only.',
      ),
      onOff('repository', 'has_discussions', 'Discussions').also('forum', 'questions'),
      onOff('repository', 'has_pull_requests', 'Pull requests'),
      choice(
        'repository',
        'pull_request_creation_policy',
        'Who can create pull requests',
        ['Everyone', 'all'],
        ['Collaborators only', 'collaborators_only'],
      )
        .under()
        .hiddenWhile('has_pull_requests', false),
      onOff('repository', 'pull_request_creation_cap.enabled', 'Limit open pull requests per user')
        .also('spam', 'cap')
        .under()
        .hiddenWhile('has_pull_requests', false)
        .noted('Exemptions by account age or merged pull requests have no API, so they are set on GitHub only.'),
      number('repository', 'pull_request_creation_cap.max_open_pull_requests', 'Open pull requests allowed')
        .under()
        .hiddenWhile('pull_request_creation_cap.enabled', false),
      onOff('repository', 'pull_request_creation_cap.include_drafts', 'Count draft pull requests')
        .under()
        .hiddenWhile('pull_request_creation_cap.enabled', false),
    ]),
    group('Pull requests', 'How branches update and clean up after a merge.', [
      onOff('repository', 'allow_auto_merge', 'Allow auto-merge').also('automerge'),
      onOff('repository', 'allow_update_branch', 'Suggest updating branches').also(
        'out of date',
        'behind base',
        'update branch',
      ),
      onOff('repository', 'delete_branch_on_merge', 'Delete head branches after merge').also(
        'auto-delete',
        'cleanup',
        'remove branches',
      ),
      onOff('repository', 'web_commit_signoff_required', 'Require sign-off on web commits').also(
        'dco',
        'signoff',
        'developer certificate of origin',
      ),
    ]),
    group('Releases', "Whether a published release's tag and assets are locked.", [
      onOff('repository', 'immutable_releases', 'Immutable releases').also('lock releases', 'tag protection'),
    ]),
  ]),
  section('Merge', 'merge', [
    group(
      'Merge methods',
      'How pull requests can merge, and what each kind of commit says. GitHub needs at least one method, and takes only the commit title and message pairs its settings page offers.',
      [
        onOff('merge', 'allow_merge_commit', 'Allow merge commits').also('merge button', 'no fast-forward'),
        choice(
          'merge',
          'merge_commit_title',
          'Merge commit title',
          ['Pull request title', 'PR_TITLE'],
          ['Default message', 'MERGE_MESSAGE'],
        )
          .under()
          .hiddenWhile('allow_merge_commit', false),
        choice(
          'merge',
          'merge_commit_message',
          'Merge commit message',
          ['Pull request body', 'PR_BODY'],
          ['Pull request title', 'PR_TITLE'],
          ['Blank', 'BLANK'],
        )
          .under()
          .hiddenWhile('allow_merge_commit', false),
        onOff('merge', 'allow_squash_merge', 'Allow squash merging').also('squash and merge', 'single commit'),
        choice(
          'merge',
          'squash_merge_commit_title',
          'Squash commit title',
          ['Pull request title', 'PR_TITLE'],
          ['Commit or pull request title', 'COMMIT_OR_PR_TITLE'],
        )
          .under()
          .hiddenWhile('allow_squash_merge', false),
        choice(
          'merge',
          'squash_merge_commit_message',
          'Squash commit message',
          ['Pull request body', 'PR_BODY'],
          ['Commit messages', 'COMMIT_MESSAGES'],
          ['Blank', 'BLANK'],
        )
          .under()
          .hiddenWhile('allow_squash_merge', false),
        onOff('merge', 'allow_rebase_merge', 'Allow rebase merging').also(
          'rebase and merge',
          'linear history',
          'fast-forward',
        ),
      ],
    ),
  ]),
  section('Actions', 'actions', [
    group('Policy', 'Whether workflows run, and which actions they may use.', [
      onOff('actions', 'enabled', 'Actions').also('workflows', 'ci', 'github actions'),
      choice(
        'actions',
        'allowed_actions',
        'Allowed actions',
        ['All', 'all'],
        ["This owner's", 'local_only'],
        ['Selected', 'selected'],
      )
        .under()
        .hiddenWhile('enabled', false)
        .also('allowlist', 'third-party', 'marketplace'),
      onOff('actions', 'selected_actions.github_owned_allowed', 'Actions by GitHub')
        .under()
        .hiddenWhile('allowed_actions', 'all', 'local_only'),
      onOff('actions', 'selected_actions.verified_allowed', 'Actions by verified creators')
        .under()
        .hiddenWhile('allowed_actions', 'all', 'local_only'),
      list('actions', 'selected_actions.patterns_allowed', 'Allowed action patterns')
        .ofActionPatterns()
        .under()
        .hiddenWhile('allowed_actions', 'all', 'local_only')
        .noted('One pattern a line, such as octo-org/*. Start one with ! to block it.')
        .also('allowlist', 'blocklist', 'patterns', 'wildcard'),
      onOff('actions', 'sha_pinning_required', 'Require pinning to a full commit SHA')
        .under()
        .hiddenWhile('enabled', false)
        .also('pin', 'pinned', 'supply chain'),
    ]),
    group('Workflow permissions', 'What the GITHUB_TOKEN may do.', [
      choice(
        'actions',
        'default_workflow_permissions',
        'Default permissions',
        ['Read', 'read'],
        ['Read and write', 'write'],
      ).also('github_token', 'token permissions', 'contents write'),
      onOff('actions', 'can_approve_pull_request_reviews', 'Allow approving pull requests').also(
        'github_token',
        'bot approvals',
      ),
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
        ).also('reusable workflows', 'share actions'),
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
      ).also('forks', 'first-time contributor', 'outside collaborator'),
      onOff(
        'actions',
        'fork_pr_workflows_private_repos.run_workflows_from_fork_pull_requests',
        'Run workflows from fork pull requests',
      ).noted('Private repositories only.'),
      onOff(
        'actions',
        'fork_pr_workflows_private_repos.send_write_tokens_to_workflows',
        'Send write tokens to workflows',
      )
        .under()
        .offWhile('fork_pr_workflows_private_repos.run_workflows_from_fork_pull_requests', false),
      onOff('actions', 'fork_pr_workflows_private_repos.send_secrets_and_variables', 'Send secrets and variables')
        .under()
        .offWhile('fork_pr_workflows_private_repos.run_workflows_from_fork_pull_requests', false),
      onOff(
        'actions',
        'fork_pr_workflows_private_repos.require_approval_for_fork_pr_workflows',
        'Require approval for each run',
      )
        .under()
        .offWhile('fork_pr_workflows_private_repos.run_workflows_from_fork_pull_requests', false),
    ]),
    group('Artifacts and caches', 'How long workflow output stays, and how much the cache holds.', [
      number('actions', 'artifact_and_log_retention.days', 'Artifact and log retention, in days').also(
        'logs',
        'storage',
        'expire',
      ),
      number('actions', 'max_cache_retention_days', 'Cache retention, in days').also('storage', 'expire'),
      number('actions', 'max_cache_size_gb', 'Cache size limit, in GB').also('storage', 'quota'),
    ]),
    group(
      'OpenID Connect',
      'The subject claim in the tokens workflows get from GitHub. Claim keys are edited in the YAML.',
      [
        onOff('actions', 'oidc_customization_sub.use_default', 'Use the default subject claim').also(
          'oidc',
          'openid',
          'sub claim',
          'cloud deploy',
        ),
        onOff('actions', 'oidc_customization_sub.use_immutable_subject', 'Use immutable IDs in the subject').also(
          'oidc',
          'openid',
          'sub claim',
        ),
      ],
    ),
  ]),
  section('Security', 'security', [
    group('Advanced Security', 'GitHub shows and changes these for repository admins only.', [
      feature('advanced_security', 'GitHub Advanced Security').also('ghas'),
      feature('code_security', 'GitHub Code Security'),
      onOff('security', 'private_vulnerability_reporting', 'Private vulnerability reporting').also(
        'security advisories',
        'report a vulnerability',
      ),
    ]),
    group('Dependabot', 'Alerts and pull requests for vulnerable dependencies.', [
      onOff('security', 'vulnerability_alerts', 'Dependabot alerts')
        .also('vulnerable dependencies', 'cve', 'security alerts')
        .noted(
          'Malware alerts, Dependabot rules, and preventing direct dismissals have no API here, so they are set on GitHub or in a security configuration.',
        ),
      onOff('security', 'automated_security_fixes', 'Dependabot security updates')
        .under()
        .offWhile('vulnerability_alerts', false)
        .also('dependabot pull requests', 'automatic fixes')
        .noted('Grouping security updates has no API; groups in dependabot.yml do it instead.'),
      choice(
        'security',
        'dependabot_runner_settings.runner_type',
        'Dependabot runners',
        ['Standard', 'standard'],
        ['Labeled', 'labeled'],
      )
        .noted('Runner labels are edited in the YAML.')
        .also('self-hosted'),
      text('security', 'dependabot_runner_settings.runner_group', 'Runner group', { allowsEmpty: true })
        .under()
        .offWhile('dependabot_runner_settings.runner_type', 'standard')
        .noted('Used only with labeled runners. Leave it empty for no group.')
        .also('self-hosted', 'runner'),
    ]),
    group('Code scanning', 'Finds problems in the code with CodeQL. Languages are edited in the YAML.', [
      choice(
        'security',
        'code_scanning_default_setup.state',
        'Default setup',
        ['Configured', 'configured'],
        ['Not configured', 'not-configured'],
      )
        .noted(
          'Copilot Autofix, Agentic Autofix, and preventing direct dismissals have no API here, so they are set on GitHub or in a security configuration.',
        )
        .also('codeql', 'sast', 'static analysis'),
      choice(
        'security',
        'code_scanning_default_setup.query_suite',
        'Query suite',
        ['Default', 'default'],
        ['Extended', 'extended'],
      )
        .under()
        .hiddenWhile('code_scanning_default_setup.state', 'not-configured'),
      choice(
        'security',
        'code_scanning_default_setup.threat_model',
        'Threat model',
        ['Remote', 'remote'],
        ['Remote and local', 'remote_and_local'],
      )
        .under()
        .hiddenWhile('code_scanning_default_setup.state', 'not-configured')
        .also('codeql'),
      choice(
        'security',
        'code_scanning_default_setup.runner_type',
        'Runner type',
        ['Standard', 'standard'],
        ['Labeled', 'labeled'],
      )
        .under()
        .hiddenWhile('code_scanning_default_setup.state', 'not-configured')
        .also('self-hosted'),
      runnerLabel('code_scanning_default_setup'),
      choice(
        'security',
        'code_scanning_ai_scan.pr_scan',
        'AI Scan on pull requests',
        ['On', 'enabled'],
        ['Off', 'disabled'],
      ),
    ]),
    group('Code quality', 'Finds maintainability and reliability problems. Languages are edited in the YAML.', [
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
      )
        .under()
        .hiddenWhile('code_quality_setup.state', 'not-configured'),
      choice(
        'security',
        'code_quality_setup.runner_type',
        'Runner type',
        ['Standard', 'standard'],
        ['Labeled', 'labeled'],
      )
        .under()
        .hiddenWhile('code_quality_setup.state', 'not-configured')
        .also('self-hosted'),
      runnerLabel('code_quality_setup'),
    ]),
    group('Secret scanning', 'Finds secrets pushed to the repository.', [
      feature('secret_scanning', 'Secret Protection').also(
        'secret scanning',
        'leaked secrets',
        'credentials',
        'tokens',
      ),
      feature('secret_scanning_push_protection', 'Push protection')
        .under()
        .offWhile('security_and_analysis.secret_scanning', disabled)
        .also('block secrets')
        .noted('Push protection for AI-detected secrets is set only in a security configuration.'),
      feature('secret_scanning_ai_detection', 'AI detection')
        .under()
        .offWhile('security_and_analysis.secret_scanning', disabled),
      feature('secret_scanning_non_provider_patterns', 'Non-provider patterns')
        .under()
        .offWhile('security_and_analysis.secret_scanning', disabled),
      feature('secret_scanning_validity_checks', 'Validity checks')
        .under()
        .offWhile('security_and_analysis.secret_scanning', disabled)
        .noted('GitHub Enterprise Cloud only. Extended metadata is set only in a security configuration.'),
      feature('secret_scanning_delegated_alert_dismissal', 'Delegated alert dismissal')
        .under()
        .offWhile('security_and_analysis.secret_scanning', disabled),
      feature('secret_scanning_delegated_bypass', 'Delegated bypass')
        .under()
        .offWhile('security_and_analysis.secret_scanning', disabled)
        .noted('Who can approve a bypass is edited in the YAML.'),
    ]),
  ]),
  section('Pages', 'pages', [
    group('GitHub Pages', 'The site GitHub publishes from the repository.', [
      custom('pages', 'absent', 'Take the site down', [['Yes', true]])
        .standsAlone()
        .also('unpublish', 'delete site')
        .noted('It deletes the site on each repository. Remove it to describe a site instead.'),
      choice('pages', 'build_type', 'Build from', ['A branch', 'legacy'], ['GitHub Actions', 'workflow']).also(
        'jekyll',
        'static site',
        'website',
      ),
      text('pages', 'source.branch', 'Branch').under().hiddenWhile('build_type', 'workflow'),
      choice('pages', 'source.path', 'Folder', ['/ (root)', '/'], ['/docs', '/docs'])
        .under()
        .hiddenWhile('build_type', 'workflow'),
      text('pages', 'cname', 'Custom domain')
        .also('cname', 'dns', 'website')
        .noted('To clear a domain, set cname to null in the YAML.'),
      onOff('pages', 'https_enforced', 'Enforce HTTPS').also('ssl', 'tls', 'certificate'),
      custom('pages', 'public', 'Who can see the site', [
        ['Everyone', true],
        ['People with access', false],
      ]).noted('GitHub Enterprise Cloud only.'),
    ]),
  ]),
];
