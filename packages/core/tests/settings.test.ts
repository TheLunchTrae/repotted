import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { GitHubError, parseRepo } from '../src/github.js';
import { ApplyError, applyPlan, captureProfile, createPlan, describeFailure } from '../src/plan.js';
import { editProfile, resolveProfile } from '../src/profile.js';
import { profile as profileSchema, type Profile } from '../src/schema.js';
import { FakeGitHub, type FakeState } from './fake-github.js';

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
      'Skipped security.automated_security_fixes: it needs Dependabot alerts, which are off',
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
      'Skipped security.security_and_analysis: GitHub did not report it; it reports it only to repository admins',
    ]);
  });

  test('warns about changing visibility', async () => {
    const plan = await createPlan(new FakeGitHub(), repo, { repository: { visibility: 'private' } });

    expect(plan.changes).toHaveLength(1);
    expect(plan.warnings).toEqual([
      'Changing visibility to private detaches public forks and drops stars and watchers from people without access',
    ]);
  });
});

describe('settings GitHub does not offer or refuses', () => {
  test('skips a setting the repository does not have, naming why', async () => {
    const plan = await createPlan(new FakeGitHub(), repo, { security: { private_vulnerability_reporting: true } });

    expect(plan.changes).toEqual([]);
    expect(plan.warnings).toEqual([
      'Skipped security.private_vulnerability_reporting: GitHub does not offer private vulnerability reporting on this repository (Not Found: GET /private-vulnerability-reporting)',
    ]);
  });

  test('names the permission a refused read needs', async () => {
    const github = new FakeGitHub({ ...offered(), refused: ['GET /pages', 'GET /actions/oidc/customization/sub'] });

    const plan = await createPlan(github, repo, {
      pages: { build_type: 'workflow' },
      actions: { oidc_customization_sub: { use_default: true } },
    });
    expect(plan.changes).toEqual([]);
    expect(plan.warnings).toEqual([
      'Skipped actions.oidc_customization_sub: GitHub refused to read OIDC subject claim (Resource not accessible by integration); that needs the Actions read permission',
      'Skipped pages: GitHub refused to read GitHub Pages (Resource not accessible by integration); that needs the Pages read permission',
    ]);

    const { warnings } = await captureProfile(github, repo);
    expect(warnings).toEqual([...plan.warnings]);
  });

  test('names the permission a refused write needs', async () => {
    const github = new FakeGitHub({ ...offered(), refused: ['PATCH /properties/values'] });

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
      expect(editProfile(own, [{ path: bad, value: true }])).rejects.toThrow(
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
    const warning =
      'Skipped security.dependabot_runner_settings.runner_labels: GitHub keeps none with standard runners';

    const plan = await createPlan(github, repo, profile);
    expect(plan.warnings).toEqual([warning]);
    expect(plan.changes.map((change) => change.request.body)).toEqual([{ runner_type: 'standard' }]);
    await applyPlan(github, plan);
    const next = await createPlan(github, repo, profile);
    expect(next.changes).toEqual([]);
    expect(next.warnings).toEqual([warning]);
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
      'Skipped security.dependabot_runner_settings.runner_type: labeled runners need exactly one runner label',
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
      'Skipped actions.oidc_customization_sub.include_claim_keys: GitHub ignores claim keys while use_default is true',
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
      'Skipped pages: a new site built from a branch needs source.branch, or build_type: workflow',
    ]);
  });
});
