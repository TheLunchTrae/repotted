import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

import { GitHubError, parseRepo } from '../src/github.js';
import { ApplyError, applyPlan, captureProfile, createPlan, describeFailure } from '../src/plan.js';
import { editProfile, parseProfile, resolveProfile, stringifyProfile } from '../src/profile.js';
import { profile as profileSchema, type Profile } from '../src/schema.js';
import { actionsEndpoints } from '../src/sections/actions.js';
import { repositoryEndpoints } from '../src/sections/repository.js';
import { securityEndpoints } from '../src/sections/security.js';
import { answered, FakeGitHub, type FakeState } from './fake-github.js';

const repo = parseRepo('lunch/app');

/** A repository on a plan and owner that offer every setting, all at GitHub's defaults. */
function offered(): Partial<FakeState> {
  return {
    settings: {
      '/immutable-releases': { enabled: false, enforced_by_owner: false },
      '/interaction-limits/pulls/creation-cap': { enabled: false, max_open_pull_requests: 10, include_drafts: true },
      '/vulnerability-alerts': false,
      '/automated-security-fixes': { enabled: false, paused: false },
      '/private-vulnerability-reporting': { enabled: false },
      '/code-scanning/default-setup': { state: 'not-configured', query_suite: 'default', languages: [] },
      '/code-scanning/ai-scan': { pr_scan: 'disabled' },
      '/code-quality/setup': { state: 'not-configured' },
      '/dependabot/runner-settings': { runner_type: 'standard', runner_labels: [], runner_group: '' },
      '/actions/permissions/access': { access_level: 'none' },
      '/actions/permissions/fork-pr-contributor-approval': { approval_policy: 'first_time_contributors' },
      '/actions/permissions/fork-pr-workflows-private-repos': {
        run_workflows_from_fork_pull_requests: false,
        send_write_tokens_to_workflows: false,
        send_secrets_and_variables: false,
        require_approval_for_fork_pr_workflows: false,
      },
      '/actions/permissions/artifact-and-log-retention': { days: 90, maximum_allowed_days: 400 },
      '/actions/cache/retention-limit': { max_cache_retention_days: 7 },
      '/actions/cache/storage-limit': { max_cache_size_gb: 10 },
      '/actions/oidc/customization/sub': { use_default: true },
      '/properties/values': [{ property_name: 'team', value: null }],
      '/pages': null,
    },
  };
}

const everything: Profile = {
  repository: {
    topics: ['tools', 'github'],
    immutable_releases: true,
    pull_request_creation_cap: { enabled: true, max_open_pull_requests: 3 },
  },
  security: {
    vulnerability_alerts: true,
    automated_security_fixes: true,
    private_vulnerability_reporting: true,
    code_scanning_default_setup: { state: 'configured', query_suite: 'extended' },
    code_scanning_ai_scan: { pr_scan: 'enabled' },
    dependabot_runner_settings: { runner_type: 'labeled', runner_labels: ['dependabot'] },
  },
  actions: {
    access_level: 'user',
    approval_policy: 'all_external_contributors',
    fork_pr_workflows_private_repos: {
      run_workflows_from_fork_pull_requests: true,
      require_approval_for_fork_pr_workflows: true,
    },
    artifact_and_log_retention: { days: 30 },
    max_cache_retention_days: 3,
    max_cache_size_gb: 5,
    oidc_customization_sub: { use_default: false, include_claim_keys: ['repo', 'context'] },
  },
  custom_properties: { team: 'platform' },
  pages: { build_type: 'workflow', cname: 'docs.example.com', https_enforced: true },
  autolinks: [{ key_prefix: 'JIRA-', url_template: 'https://jira.example.com/browse/<num>' }],
};

describe('settings at their own endpoints', () => {
  test('offers every endpoint setting in the repository the tests of every setting use', () => {
    const paths = [...repositoryEndpoints, ...securityEndpoints, ...actionsEndpoints].map((endpoint) => endpoint.path);

    expect(Object.keys(offered().settings ?? {})).toEqual(expect.arrayContaining(paths));
  });

  test('brings every setting in line, after which the plan is empty', async () => {
    const github = new FakeGitHub(offered());

    const plan = await createPlan(github, repo, everything);
    expect(plan.warnings).toEqual([]);
    expect(plan.changes.map((change) => `${change.request.method} ${change.request.path}`)).toEqual([
      'PUT /repos/lunch/app/topics',
      'PUT /repos/lunch/app/immutable-releases',
      'PATCH /repos/lunch/app/interaction-limits/pulls/creation-cap',
      'PUT /repos/lunch/app/vulnerability-alerts',
      'PUT /repos/lunch/app/automated-security-fixes',
      'PUT /repos/lunch/app/private-vulnerability-reporting',
      'PATCH /repos/lunch/app/code-scanning/default-setup',
      'PATCH /repos/lunch/app/code-scanning/ai-scan',
      'PUT /repos/lunch/app/dependabot/runner-settings',
      'PUT /repos/lunch/app/actions/permissions/access',
      'PUT /repos/lunch/app/actions/permissions/fork-pr-contributor-approval',
      'PUT /repos/lunch/app/actions/permissions/fork-pr-workflows-private-repos',
      'PUT /repos/lunch/app/actions/permissions/artifact-and-log-retention',
      'PUT /repos/lunch/app/actions/cache/retention-limit',
      'PUT /repos/lunch/app/actions/cache/storage-limit',
      'PUT /repos/lunch/app/actions/oidc/customization/sub',
      'PATCH /repos/lunch/app/properties/values',
      'POST /repos/lunch/app/pages',
      'PUT /repos/lunch/app/pages',
      'POST /repos/lunch/app/autolinks',
    ]);
    // The creation cap keeps its live setting for drafts, which the profile leaves out.
    expect(plan.changes[2]?.request.body).toEqual({ enabled: true, max_open_pull_requests: 3 });
    // A PUT replaces the fork settings, so it carries the live ones the profile leaves out.
    const fork = plan.changes.find((change) => change.request.path.endsWith('/fork-pr-workflows-private-repos'));
    expect(fork?.request.body).toEqual({
      run_workflows_from_fork_pull_requests: true,
      send_write_tokens_to_workflows: false,
      send_secrets_and_variables: false,
      require_approval_for_fork_pr_workflows: true,
    });

    await applyPlan(github, plan);
    expect((await createPlan(github, repo, everything)).changes).toEqual([]);
  });

  test('turns Dependabot security updates off before the alerts they answer', async () => {
    const state = offered();
    const github = new FakeGitHub({
      ...state,
      settings: {
        ...state.settings,
        '/vulnerability-alerts': true,
        '/automated-security-fixes': { enabled: true, paused: false },
      },
    });
    const desired: Profile = { security: { vulnerability_alerts: false, automated_security_fixes: false } };

    const plan = await createPlan(github, repo, desired);
    expect(plan.changes.map((change) => `${change.request.method} ${change.target}`)).toEqual([
      'DELETE Dependabot security updates',
      'DELETE Dependabot alerts',
    ]);
    await applyPlan(github, plan);
    expect((await createPlan(github, repo, desired)).changes).toEqual([]);
  });

  test('skips security updates the profile turns on while it turns alerts off', async () => {
    const plan = await createPlan(new FakeGitHub(offered()), repo, {
      security: { vulnerability_alerts: false, automated_security_fixes: true },
    });

    expect(plan.changes).toEqual([]);
    expect(plan.warnings).toEqual([
      {
        section: 'security',
        key: 'automated_security_fixes',
        cause: 'not_applicable',
        message: 'it needs Dependabot alerts, which are off',
      },
    ]);
  });

  test('sends only the runner type for standard Dependabot runners', async () => {
    const state = offered();
    const github = new FakeGitHub({
      ...state,
      settings: {
        ...state.settings,
        '/dependabot/runner-settings': { runner_type: 'labeled', runner_labels: ['big'], runner_group: null },
      },
    });
    const desired: Profile = { security: { dependabot_runner_settings: { runner_type: 'standard' } } };

    const plan = await createPlan(github, repo, desired);
    expect(plan.changes[0]?.request.body).toEqual({ runner_type: 'standard' });
    await applyPlan(github, plan);
    expect((await createPlan(github, repo, desired)).changes).toEqual([]);
  });

  test('writes security and analysis to the repository when GitHub reports it', async () => {
    const github = new FakeGitHub();
    github.state.repository['security_and_analysis'] = {
      secret_scanning: { status: 'disabled' },
      secret_scanning_push_protection: { status: 'disabled' },
    };
    const desired: Profile = { security: { security_and_analysis: { secret_scanning: { status: 'enabled' } } } };

    const plan = await createPlan(github, repo, desired);
    expect(plan.changes).toEqual([
      expect.objectContaining({
        fields: [
          { field: 'security_and_analysis.secret_scanning', from: { status: 'disabled' }, to: { status: 'enabled' } },
        ],
        request: {
          method: 'PATCH',
          path: '/repos/lunch/app',
          body: { security_and_analysis: { secret_scanning: { status: 'enabled' } } },
        },
      }),
    ]);
    await applyPlan(github, plan);
    expect((await createPlan(github, repo, desired)).changes).toEqual([]);
    expect(github.state.repository['security_and_analysis']).toEqual({
      secret_scanning: { status: 'enabled' },
      secret_scanning_push_protection: { status: 'disabled' },
    });
  });

  test('skips security and analysis that GitHub does not report', async () => {
    const plan = await createPlan(new FakeGitHub(), repo, {
      security: { security_and_analysis: { secret_scanning: { status: 'enabled' } } },
    });

    expect(plan.changes).toEqual([]);
    expect(plan.warnings).toEqual([
      {
        section: 'security',
        key: 'security_and_analysis',
        cause: 'refused',
        message: 'GitHub did not report it; it reports it only to repository admins',
      },
    ]);
  });

  test('warns about changing visibility', async () => {
    const plan = await createPlan(new FakeGitHub(), repo, { repository: { visibility: 'private' } });

    expect(plan.changes).toHaveLength(1);
    expect(plan.warnings).toEqual([
      {
        section: 'repository',
        key: 'visibility',
        message:
          'Changing visibility to private detaches public forks and drops stars and watchers from people without access',
      },
    ]);
  });
});

describe('settings GitHub does not offer or refuses', () => {
  test('skips a setting the repository does not have, naming why', async () => {
    const plan = await createPlan(new FakeGitHub(), repo, { security: { private_vulnerability_reporting: true } });

    expect(plan.changes).toEqual([]);
    expect(plan.warnings).toEqual([
      {
        section: 'security',
        key: 'private_vulnerability_reporting',
        cause: 'unavailable',
        message:
          'GitHub does not offer private vulnerability reporting on this repository (Not Found: GET /private-vulnerability-reporting)',
      },
    ]);
  });

  test('names the permission a refused read needs', async () => {
    const github = new FakeGitHub(offered())
      .fail('GET /repos/lunch/app/pages', answered(403, 'Resource not accessible by integration'))
      .fail(
        'GET /repos/lunch/app/actions/oidc/customization/sub',
        answered(403, 'Resource not accessible by integration'),
      );

    const plan = await createPlan(github, repo, {
      pages: { build_type: 'workflow' },
      actions: { oidc_customization_sub: { use_default: true } },
    });
    expect(plan.changes).toEqual([]);
    expect(plan.warnings).toEqual([
      {
        section: 'actions',
        key: 'oidc_customization_sub',
        cause: 'refused',
        message:
          'GitHub refused to read OIDC subject claim (Resource not accessible by integration); that needs the Actions read permission',
      },
      {
        section: 'pages',
        cause: 'refused',
        message:
          'GitHub refused to read GitHub Pages (Resource not accessible by integration); that needs the Pages read permission',
      },
    ]);

    const { warnings } = await captureProfile(github, repo);
    expect(warnings).toEqual([...plan.warnings]);
  });

  test('names the permission a refused write needs', async () => {
    const github = new FakeGitHub(offered()).fail(
      'PATCH /repos/lunch/app/properties/values',
      answered(403, 'Resource not accessible by integration'),
    );

    const error = await createPlan(github, repo, { custom_properties: { team: 'web' } }).then((plan) =>
      applyPlan(github, plan).then(
        () => undefined,
        (failure: unknown) => failure,
      ),
    );
    expect(error).toBeInstanceOf(ApplyError);
    if (!(error instanceof ApplyError)) {
      return;
    }
    expect(error.cause).toBeInstanceOf(GitHubError);
    expect(describeFailure(error)).toContain('That change needs the Custom properties write permission.');
  });
});

describe('autolinks and Pages', () => {
  test('makes a differing autolink again and deletes one marked absent', async () => {
    const github = new FakeGitHub({
      autolinks: [
        { id: 1, key_prefix: 'JIRA-', url_template: 'https://old.example.com/<num>', is_alphanumeric: true },
        { id: 2, key_prefix: 'GONE-', url_template: 'https://gone.example.com/<num>', is_alphanumeric: false },
        { id: 3, key_prefix: 'KEEP-', url_template: 'https://keep.example.com/<num>', is_alphanumeric: true },
      ],
    });
    const desired: Profile = {
      autolinks: [
        { key_prefix: 'JIRA-', url_template: 'https://jira.example.com/browse/<num>' },
        { key_prefix: 'GONE-', absent: true },
      ],
    };

    const plan = await createPlan(github, repo, desired);
    expect(plan.changes.map((change) => `${change.request.method} ${change.target}`)).toEqual([
      'DELETE JIRA-',
      'DELETE GONE-',
      'POST JIRA-',
    ]);
    await applyPlan(github, plan);
    expect(github.state.autolinks.map((item) => item.key_prefix)).toEqual(['KEEP-', 'JIRA-']);
    expect((await createPlan(github, repo, desired)).changes).toEqual([]);
  });

  test('deletes the Pages site for absent and captures a workflow site without its domain', async () => {
    const github = new FakeGitHub({
      settings: {
        '/pages': {
          build_type: 'workflow',
          source: { branch: 'main', path: '/' },
          cname: 'docs.example.com',
          https_enforced: true,
          public: true,
        },
      },
    });

    const { profile } = await captureProfile(github, repo);
    expect(profile.pages).toEqual({ build_type: 'workflow', https_enforced: true });

    const plan = await createPlan(github, repo, { pages: { absent: true } });
    expect(plan.changes.map((change) => change.request.method)).toEqual(['DELETE']);
    await applyPlan(github, plan);
    expect((await createPlan(github, repo, { pages: { absent: true } })).changes).toEqual([]);
  });
});

describe('capture of every section', () => {
  test('captures a profile the repository matches, leaving out what names it', async () => {
    const github = new FakeGitHub(offered());
    await applyPlan(github, await createPlan(github, repo, everything));

    const { profile, warnings } = await captureProfile(github, repo);
    expect(warnings).toEqual([]);
    expect(profile.repository).not.toHaveProperty('topics');
    expect(profile.repository).not.toHaveProperty('visibility');
    expect(profile.pages).toEqual({ build_type: 'workflow', https_enforced: true });
    expect(profile.custom_properties).toEqual({ team: 'platform' });
    expect(profile.security).toMatchObject({ vulnerability_alerts: true, automated_security_fixes: true });
    expect((await createPlan(github, repo, profile)).changes).toEqual([]);
  });

  test('leaves out, with a warning, a value GitHub reports that a profile cannot hold', async () => {
    const state = offered();
    const github = new FakeGitHub({
      ...state,
      settings: {
        ...state.settings,
        '/code-scanning/default-setup': { state: 'configured', query_suite: 'security-and-quality' },
        '/actions/permissions/fork-pr-contributor-approval': { approval_policy: 'everyone_new' },
      },
    });
    github.state.repository['pull_request_creation_policy'] = 'maintainers_only';
    github.state.repository['merge_commit_title'] = 'COMMIT_TITLE';
    github.state.repository['merge_commit_message'] = 'PR_BODY';
    github.state.repository['security_and_analysis'] = {
      secret_scanning: { status: 'enabled' },
      secret_scanning_push_protection: { status: 'paused' },
    };

    const { profile, warnings } = await captureProfile(github, repo);
    expect(warnings).toEqual([
      {
        section: 'repository',
        key: 'pull_request_creation_policy',
        cause: 'unloadable',
        message:
          'a profile cannot hold "maintainers_only" (Invalid option: expected one of "all"|"collaborators_only")',
      },
      {
        section: 'merge',
        key: 'merge_commit_title',
        cause: 'unloadable',
        message: 'a profile cannot hold "COMMIT_TITLE" (Invalid option: expected one of "PR_TITLE"|"MERGE_MESSAGE")',
      },
      {
        section: 'merge',
        key: 'merge_commit_message',
        cause: 'unloadable',
        message: 'GitHub takes it only with merge_commit_title, which is left out',
      },
      {
        section: 'security',
        key: 'code_scanning_default_setup',
        field: 'query_suite',
        cause: 'unloadable',
        message: 'a profile cannot hold "security-and-quality" (Invalid option: expected one of "default"|"extended")',
      },
      {
        section: 'security',
        key: 'security_and_analysis',
        field: 'secret_scanning_push_protection',
        cause: 'unloadable',
        message: 'a profile cannot hold "paused" at status (Invalid option: expected one of "enabled"|"disabled")',
      },
      {
        section: 'actions',
        key: 'approval_policy',
        cause: 'unloadable',
        message:
          'a profile cannot hold "everyone_new" (Invalid option: expected one of "first_time_contributors_new_to_github"|"first_time_contributors"|"all_external_contributors")',
      },
    ]);
    expect(profile.repository).not.toHaveProperty('pull_request_creation_policy');
    expect(profile.merge).not.toHaveProperty('merge_commit_title');
    expect(profile.merge).not.toHaveProperty('merge_commit_message');
    expect(profile.security?.code_scanning_default_setup).toEqual({ state: 'configured' });
    expect(profile.security?.security_and_analysis).toEqual({ secret_scanning: { status: 'enabled' } });
    expect(profile.actions).not.toHaveProperty('approval_policy');
    const loaded = await parseProfile(stringifyProfile(profile), tmpdir());
    // Half of a commit message pair would not pass on a repository with the other half's default.
    await expect(createPlan(new FakeGitHub(offered()), repo, loaded.profile)).resolves.toBeDefined();
    // The repository it came from plans too, though its own pair is one a profile cannot hold.
    expect((await createPlan(github, repo, loaded.profile)).changes).toEqual([]);
  });

  test('leaves out, with a warning, a whole ruleset or environment a profile cannot hold', async () => {
    const github = new FakeGitHub({
      rulesets: [
        {
          id: 1,
          name: 'Queue',
          target: 'branch',
          enforcement: 'active',
          bypass_actors: [],
          rules: [{ type: 'deletion' }, { type: 'merge_queue', parameters: { merge_method: 'FAST_FORWARD' } }],
        },
        {
          id: 2,
          name: 'Keep',
          target: 'branch',
          enforcement: 'active',
          bypass_actors: [],
          rules: [{ type: 'deletion' }],
        },
      ],
      environments: [
        {
          name: 'slow',
          wait_timer: 50_000,
          prevent_self_review: false,
          reviewers: [],
          deployment_branch_policy: null,
          branch_policies: [],
        },
      ],
    });

    const { profile, warnings } = await captureProfile(github, repo);
    expect(warnings).toEqual([
      {
        section: 'rulesets',
        key: 'Queue',
        cause: 'unloadable',
        message:
          'a profile cannot hold "FAST_FORWARD" at rules[1].parameters.merge_method (Invalid option: expected one of "MERGE"|"SQUASH"|"REBASE")',
      },
      {
        section: 'environments',
        key: 'slow',
        cause: 'unloadable',
        message: 'a profile cannot hold 50000 at wait_timer (Too big: expected number to be <=43200)',
      },
    ]);
    expect(profile.rulesets?.map((entry) => entry.name)).toEqual(['Keep']);
    expect(profile.environments).toEqual([]);
    await expect(parseProfile(stringifyProfile(profile), tmpdir())).resolves.toBeDefined();
  });

  test("reads GitHub's nulls for unset fields as unset, and writes no empty security_and_analysis", async () => {
    const state = offered();
    const github = new FakeGitHub({
      ...state,
      settings: {
        ...state.settings,
        // As GitHub documents them while neither is configured.
        '/code-scanning/default-setup': {
          state: 'not-configured',
          languages: [],
          runner_type: null,
          runner_label: null,
          query_suite: 'default',
          threat_model: 'remote',
          updated_at: null,
          schedule: null,
        },
        '/code-quality/setup': {
          state: 'not-configured',
          languages: [],
          runner_type: null,
          runner_label: null,
          ai_findings_option: null,
          updated_at: null,
          schedule: null,
        },
      },
    });
    github.state.repository['security_and_analysis'] = { secret_scanning: { status: 'paused' } };

    const { profile, warnings } = await captureProfile(github, repo);
    expect(warnings).toEqual([
      {
        section: 'security',
        key: 'security_and_analysis',
        field: 'secret_scanning',
        cause: 'unloadable',
        message: 'a profile cannot hold "paused" at status (Invalid option: expected one of "enabled"|"disabled")',
      },
    ]);
    expect(profile.security).not.toHaveProperty('security_and_analysis');
    expect(profile.security?.code_scanning_default_setup).toEqual({
      state: 'not-configured',
      runner_label: null,
      query_suite: 'default',
      threat_model: 'remote',
    });
    expect(profile.security?.code_quality_setup).toEqual({ state: 'not-configured', runner_label: null });
    expect((await createPlan(github, repo, profile)).changes).toEqual([]);
  });
});

describe('profiles of every section', () => {
  async function folder(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'repotted-settings-'));
    for (const [name, text] of Object.entries(files)) {
      await writeFile(path.join(dir, name), text);
    }
    return dir;
  }

  test('merges groups key by key, autolinks by prefix and an absent Pages site whole', async () => {
    const dir = await folder({
      'base.yaml': [
        'security:',
        '  code_scanning_default_setup: { state: configured, query_suite: extended }',
        'pages: { build_type: legacy, source: { branch: main } }',
        'autolinks:',
        '  - { key_prefix: A-, url_template: "https://a.example.com/<num>" }',
        '  - { key_prefix: B-, url_template: "https://b.example.com/<num>" }',
        '',
      ].join('\n'),
      'own.yaml': [
        'extends: base.yaml',
        'security:',
        '  code_scanning_default_setup: { query_suite: default }',
        'pages: { absent: true }',
        'autolinks:',
        '  - { key_prefix: B-, absent: true }',
        '',
      ].join('\n'),
    });
    const own = path.join(dir, 'own.yaml');
    const base = path.join(dir, 'base.yaml');

    const resolved = await resolveProfile(own);
    expect(resolved.profile.security).toEqual({
      code_scanning_default_setup: { state: 'configured', query_suite: 'default' },
    });
    expect(resolved.profile.pages).toEqual({ absent: true });
    expect(resolved.profile.autolinks).toEqual([
      { key_prefix: 'A-', url_template: 'https://a.example.com/<num>' },
      { key_prefix: 'B-', absent: true },
    ]);
    const realOwn = resolved.chain[0] ?? own;
    const realBase = resolved.chain[1] ?? base;
    expect(resolved.sources.security).toEqual({
      'code_scanning_default_setup.state': realBase,
      'code_scanning_default_setup.query_suite': realOwn,
    });
    expect(resolved.sources.autolinks).toEqual({ 'A-': realBase, 'B-': realOwn });
  });

  test('edits a setting inside a group and a custom property, and refuses a path that is not a setting', async () => {
    const dir = await folder({ 'own.yaml': 'repository:\n  has_wiki: false\n' });
    const own = path.join(dir, 'own.yaml');

    await editProfile(own, [
      { path: ['security', 'code_scanning_default_setup', 'state'], value: 'configured' },
      { path: ['custom_properties', 'team'], value: 'web' },
      { path: ['repository', 'topics'], value: ['tools'] },
    ]);
    expect(await readFile(own, 'utf8')).toBe(
      [
        'repository:',
        '  has_wiki: false',
        '  topics:',
        '    - tools',
        'security:',
        '  code_scanning_default_setup:',
        '    state: configured',
        'custom_properties:',
        '  team: web',
        '',
      ].join('\n'),
    );

    for (const bad of [
      ['security', 'code_scanning_default_setup', 'nope'],
      ['security', 'vulnerability_alerts', 'inner'],
      ['custom_properties', 'team', 'inner'],
      ['rulesets', 'name'],
    ]) {
      await expect(editProfile(own, [{ path: bad, value: true }])).rejects.toThrow(
        'it is not one setting of a profile section',
      );
    }
  });
});

describe('settings GitHub ties together', () => {
  test('turns on immutable releases and security updates that GitHub reports as missing while off', async () => {
    const github = new FakeGitHub(offered());
    const profile: Profile = {
      repository: { immutable_releases: true },
      security: { vulnerability_alerts: true, automated_security_fixes: true },
    };

    const plan = await createPlan(github, repo, profile);
    expect(plan.warnings).toEqual([]);
    expect(plan.changes.map((change) => `${change.request.method} ${change.request.path}`)).toEqual([
      'PUT /repos/lunch/app/immutable-releases',
      'PUT /repos/lunch/app/vulnerability-alerts',
      'PUT /repos/lunch/app/automated-security-fixes',
    ]);
    await applyPlan(github, plan);
    expect((await createPlan(github, repo, profile)).changes).toEqual([]);
  });

  test('leaves out runner labels with standard Dependabot runners, so the plan settles', async () => {
    const github = new FakeGitHub(offered());
    github.state.settings['/dependabot/runner-settings'] = { runner_type: 'labeled', runner_labels: ['dependabot'] };
    const profile: Profile = {
      security: { dependabot_runner_settings: { runner_type: 'standard', runner_labels: ['x'] } },
    };
    const warning = {
      section: 'security',
      key: 'dependabot_runner_settings',
      field: 'runner_labels',
      cause: 'not_applicable',
      message: 'GitHub keeps none with standard runners',
    };

    const plan = await createPlan(github, repo, profile);
    expect(plan.warnings).toEqual([warning]);
    expect(plan.changes.map((change) => change.request.body)).toEqual([{ runner_type: 'standard' }]);
    await applyPlan(github, plan);
    const next = await createPlan(github, repo, profile);
    expect(next.changes).toEqual([]);
    expect(next.warnings).toEqual([warning]);
  });

  test('leaves out a runner label with standard code scanning and code quality runners, so the plan settles', async () => {
    const github = new FakeGitHub(offered());
    github.state.settings['/code-scanning/default-setup'] = {
      state: 'configured',
      query_suite: 'default',
      languages: ['python'],
      runner_type: 'labeled',
      runner_label: 'code-scanning',
    };
    github.state.settings['/code-quality/setup'] = { state: 'configured', runner_type: 'standard', runner_label: null };
    const profile: Profile = {
      security: {
        code_scanning_default_setup: { runner_type: 'standard', runner_label: 'x' },
        code_quality_setup: { runner_label: 'x' },
      },
    };
    const warnings = [
      {
        section: 'security',
        key: 'code_scanning_default_setup',
        field: 'runner_label',
        cause: 'not_applicable',
        message: 'GitHub keeps none with standard runners',
      },
      {
        section: 'security',
        key: 'code_quality_setup',
        field: 'runner_label',
        cause: 'not_applicable',
        message: 'GitHub keeps none with standard runners',
      },
    ];

    const plan = await createPlan(github, repo, profile);
    expect(plan.warnings).toEqual(warnings);
    expect(plan.changes.map((change) => change.request.body)).toEqual([{ runner_type: 'standard' }]);
    await applyPlan(github, plan);
    const next = await createPlan(github, repo, profile);
    expect(next.changes).toEqual([]);
    expect(next.warnings).toEqual(warnings);
  });

  test('skips labeled code scanning and code quality runners without a runner label', async () => {
    const github = new FakeGitHub(offered());
    github.state.settings['/code-quality/setup'] = { state: 'configured', runner_type: 'labeled', runner_label: 'big' };

    const profile: Profile = {
      security: {
        code_scanning_default_setup: { state: 'configured', runner_type: 'labeled' },
        code_quality_setup: { runner_label: null },
      },
    };

    const plan = await createPlan(github, repo, profile);
    expect(plan.warnings).toEqual([
      {
        section: 'security',
        key: 'code_scanning_default_setup',
        field: 'runner_type',
        cause: 'not_applicable',
        message: 'labeled runners need a runner label',
      },
      {
        section: 'security',
        key: 'code_quality_setup',
        field: 'runner_label',
        cause: 'not_applicable',
        message: 'labeled runners need a runner label',
      },
    ]);
    expect(plan.changes.map((change) => change.request.body)).toEqual([{ state: 'configured' }]);
    await applyPlan(github, plan);
    const next = await createPlan(github, repo, profile);
    expect(next.changes).toEqual([]);
    expect(next.warnings).toEqual(plan.warnings);
  });

  test('clears a runner label by moving to standard runners with a null label', async () => {
    const github = new FakeGitHub(offered());
    github.state.settings['/code-quality/setup'] = { state: 'configured', runner_type: 'labeled', runner_label: 'big' };
    const profile: Profile = { security: { code_quality_setup: { runner_type: 'standard', runner_label: null } } };

    const plan = await createPlan(github, repo, profile);
    expect(plan.warnings).toEqual([]);
    expect(plan.changes.map((change) => change.request.body)).toEqual([
      { runner_type: 'standard', runner_label: null },
    ]);
    await applyPlan(github, plan);
    expect((await createPlan(github, repo, profile)).changes).toEqual([]);
  });

  test('skips a runner label on a setup that runs on standard runners by default', async () => {
    const github = new FakeGitHub(offered());
    const profile: Profile = {
      security: { code_scanning_default_setup: { state: 'configured', runner_label: 'big' } },
    };
    const warning = {
      section: 'security',
      key: 'code_scanning_default_setup',
      field: 'runner_label',
      cause: 'not_applicable',
      message: 'GitHub keeps none with standard runners',
    };

    const plan = await createPlan(github, repo, profile);
    expect(plan.warnings).toEqual([warning]);
    expect(plan.changes.map((change) => change.request.body)).toEqual([{ state: 'configured' }]);
    await applyPlan(github, plan);
    const next = await createPlan(github, repo, profile);
    expect(next.changes).toEqual([]);
    expect(next.warnings).toEqual([warning]);
  });

  test('turns off a setup on labeled runners from a capture of one that is not configured', async () => {
    const source = new FakeGitHub(offered());
    // As GitHub reports it while not configured.
    source.state.settings['/code-scanning/default-setup'] = {
      state: 'not-configured',
      query_suite: 'default',
      languages: [],
      runner_type: null,
      runner_label: null,
    };
    const { profile } = await captureProfile(source, repo);
    expect(profile.security?.code_scanning_default_setup).toHaveProperty('runner_label', null);
    const github = new FakeGitHub(offered());
    github.state.settings['/code-scanning/default-setup'] = {
      state: 'configured',
      query_suite: 'default',
      languages: ['python'],
      runner_type: 'labeled',
      runner_label: 'big',
    };

    const plan = await createPlan(github, repo, profile);
    expect(plan.warnings).toEqual([]);
    expect(plan.changes.map((change) => change.request.path)).toEqual(['/repos/lunch/app/code-scanning/default-setup']);
    await applyPlan(github, plan);
    const next = await createPlan(github, repo, profile);
    expect(next.changes).toEqual([]);
    expect(next.warnings).toEqual([]);
  });

  test('plans no runner for a setup that is not configured, even one a base profile names', async () => {
    const github = new FakeGitHub(offered());
    // As GitHub reports it while not configured.
    github.state.settings['/code-quality/setup'] = { state: 'not-configured', runner_type: null, runner_label: null };
    const dir = await mkdtemp(path.join(tmpdir(), 'repotted-settings-'));
    await writeFile(
      path.join(dir, 'base.yaml'),
      'security:\n  code_quality_setup: { state: configured, runner_type: standard }\n',
    );
    await writeFile(
      path.join(dir, 'own.yaml'),
      'extends: base.yaml\nsecurity:\n  code_quality_setup: { state: not-configured }\n',
    );
    const { profile } = await resolveProfile(path.join(dir, 'own.yaml'));
    expect(profile.security?.code_quality_setup).toEqual({ state: 'not-configured', runner_type: 'standard' });

    const plan = await createPlan(github, repo, profile);
    expect(plan.changes).toEqual([]);
    expect(plan.warnings).toEqual([]);
  });

  test('skips runner settings with a warning while the repository leaves the setup not configured', async () => {
    const github = new FakeGitHub(offered());
    const plan = await createPlan(github, repo, {
      security: { code_scanning_default_setup: { runner_type: 'labeled', runner_label: 'big' } },
    });
    const reason = 'GitHub keeps no runner while the setup is not configured';
    expect(plan.changes).toEqual([]);
    // GitHub's reason, though the setting is the profile's to fix.
    expect(plan.warnings).toEqual([
      {
        section: 'security',
        key: 'code_scanning_default_setup',
        field: 'runner_type',
        cause: 'not_applicable',
        message: reason,
      },
      {
        section: 'security',
        key: 'code_scanning_default_setup',
        field: 'runner_label',
        cause: 'not_applicable',
        message: reason,
      },
    ]);
  });

  test('warns only about the label when labeled runners would lose theirs', async () => {
    const github = new FakeGitHub(offered());
    github.state.settings['/code-quality/setup'] = { state: 'configured', runner_type: 'labeled', runner_label: 'big' };

    const plan = await createPlan(github, repo, {
      security: { code_quality_setup: { runner_type: 'labeled', runner_label: null } },
    });
    expect(plan.changes).toEqual([]);
    expect(plan.warnings).toEqual([
      {
        section: 'security',
        key: 'code_quality_setup',
        field: 'runner_label',
        cause: 'not_applicable',
        message: 'labeled runners need a runner label',
      },
    ]);
  });

  test('plans nothing for a captured repository on standard Dependabot runners', async () => {
    const github = new FakeGitHub(offered());

    const { profile: captured } = await captureProfile(github, repo);
    expect(captured.security?.dependabot_runner_settings).toEqual({
      runner_type: 'standard',
      runner_labels: [],
      runner_group: '',
    });
    const plan = await createPlan(github, repo, captured);
    expect(plan.changes).toEqual([]);
    expect(plan.warnings).toEqual([]);
  });

  test('writes no Dependabot runner group as an empty one, as GitHub reports it', async () => {
    const github = new FakeGitHub(offered());
    github.state.settings['/dependabot/runner-settings'] = { runner_type: 'standard', runner_group: null };

    const { profile: captured } = await captureProfile(github, repo);
    expect(captured.security?.dependabot_runner_settings).toEqual({ runner_type: 'standard', runner_group: '' });
    expect(profileSchema.safeParse(captured).success).toBe(true);
    expect(profileSchema.safeParse({ security: { dependabot_runner_settings: { runner_group: null } } }).success).toBe(
      false,
    );
  });

  test('skips labeled Dependabot runners without exactly one label', async () => {
    const plan = await createPlan(new FakeGitHub(offered()), repo, {
      security: { dependabot_runner_settings: { runner_type: 'labeled' } },
    });

    expect(plan.changes).toEqual([]);
    expect(plan.warnings).toEqual([
      {
        section: 'security',
        key: 'dependabot_runner_settings',
        field: 'runner_type',
        cause: 'not_applicable',
        message: 'labeled runners need exactly one runner label',
      },
    ]);
  });

  test('sends no null a live setting holds', async () => {
    const github = new FakeGitHub(offered());
    github.state.settings['/dependabot/runner-settings'] = { runner_type: 'standard', runner_group: null };

    const plan = await createPlan(github, repo, {
      security: { dependabot_runner_settings: { runner_type: 'labeled', runner_labels: ['dependabot'] } },
    });
    expect(plan.changes.map((change) => change.request.body)).toEqual([
      { runner_type: 'labeled', runner_labels: ['dependabot'] },
    ]);
  });

  test('stops using the default OIDC subject when a profile names claim keys, so the plan settles', async () => {
    const github = new FakeGitHub(offered());
    const profile: Profile = { actions: { oidc_customization_sub: { include_claim_keys: ['repo'] } } };

    const plan = await createPlan(github, repo, profile);
    expect(plan.changes.map((change) => change.request.body)).toEqual([
      { use_default: false, include_claim_keys: ['repo'] },
    ]);
    await applyPlan(github, plan);
    expect((await createPlan(github, repo, profile)).changes).toEqual([]);

    const ignored = await createPlan(github, repo, {
      actions: { oidc_customization_sub: { use_default: true, include_claim_keys: ['repo'] } },
    });
    expect(ignored.warnings).toEqual([
      {
        section: 'actions',
        key: 'oidc_customization_sub',
        field: 'include_claim_keys',
        cause: 'not_applicable',
        message: 'GitHub ignores claim keys while use_default is true',
      },
    ]);
    expect(ignored.changes.map((change) => change.request.body)).toEqual([
      { use_default: true, include_claim_keys: ['repo'] },
    ]);
  });

  test('sets a limit GitHub reports as unset', async () => {
    const github = new FakeGitHub(offered());
    github.state.settings['/actions/cache/storage-limit'] = {};
    const profile: Profile = { actions: { max_cache_size_gb: 5 } };

    const plan = await createPlan(github, repo, profile);
    expect(plan.changes.map((change) => change.request.body)).toEqual([{ max_cache_size_gb: 5 }]);
    await applyPlan(github, plan);
    expect((await createPlan(github, repo, profile)).changes).toEqual([]);

    github.state.settings['/actions/cache/storage-limit'] = {};
    const { profile: captured } = await captureProfile(github, repo);
    expect(captured.actions).not.toHaveProperty('max_cache_size_gb');
  });

  test('reads JavaScript and TypeScript as the one language code scanning takes, and leaves languages out of capture', async () => {
    const github = new FakeGitHub(offered());
    github.state.settings['/code-scanning/default-setup'] = {
      state: 'configured',
      query_suite: 'default',
      languages: ['javascript', 'typescript', 'python'],
    };

    const plan = await createPlan(github, repo, {
      security: { code_scanning_default_setup: { languages: ['javascript-typescript', 'python'] } },
    });
    expect(plan.changes).toEqual([]);

    const { profile: captured } = await captureProfile(github, repo);
    expect(captured.security?.code_scanning_default_setup).toEqual({ state: 'configured', query_suite: 'default' });
  });

  test('skips a new Pages site built from a branch it does not name', async () => {
    const plan = await createPlan(new FakeGitHub(offered()), repo, { pages: { source: { path: '/docs' } } });

    expect(plan.changes).toEqual([]);
    expect(plan.warnings).toEqual([
      {
        section: 'pages',
        cause: 'not_applicable',
        message: 'a new site built from a branch needs source.branch, or build_type: workflow',
      },
    ]);
  });
});
