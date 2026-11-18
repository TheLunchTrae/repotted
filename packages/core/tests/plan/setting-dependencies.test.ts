import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

import { GitHubError, parseRepo } from '../../src/github/client.js';
import { ApplyError, applyPlan, captureProfile, createPlan, parsePlan, StalePlanError } from '../../src/plan/plan.js';
import { orderSettingChanges } from '../../src/plan/setting-order.js';
import { editProfile, parseProfile, stringifyProfile } from '../../src/profiles/profile.js';
import type { Profile } from '../../src/profiles/schema.js';
import { FakeGitHub } from '../support/fake-github.js';

const repo = parseRepo('lunch/app');

describe.each([
  ['code_scanning_default_setup', '/code-scanning/default-setup', 'code scanning default setup'],
  ['code_quality_setup', '/code-quality/setup', 'code quality setup'],
] as const)('%s Actions prerequisites', (key, endpoint, target) => {
  test.each(['all', 'selected'] as const)(
    'enables Actions before setup and selected actions when the disabled policy is %s',
    async (allowed) => {
      const github = new FakeGitHub({
        actions: { enabled: false, allowed_actions: allowed },
        settings: { [endpoint]: { state: 'not-configured' } },
      });
      const desired: Profile = {
        actions: {
          enabled: true,
          allowed_actions: 'selected',
          selected_actions: { github_owned_allowed: true, patterns_allowed: ['octo/*'] },
          default_workflow_permissions: 'read',
        },
        security: { [key]: { state: 'configured' } },
      };
      const plan = await createPlan(github, repo, desired);
      expect(github.writes).toEqual([]);
      expect(plan.warnings).toEqual([]);
      expect(plan.changes.map((change) => change.target)).toEqual([
        'Actions permissions',
        target,
        'selected actions',
        'workflow permissions',
      ]);
      await applyPlan(github, parsePlan(JSON.parse(JSON.stringify(plan))));
      expect(github.writes.map((call) => call.path)).toEqual([
        '/repos/lunch/app/actions/permissions',
        `/repos/lunch/app${endpoint}`,
        '/repos/lunch/app/actions/permissions/selected-actions',
        '/repos/lunch/app/actions/permissions/workflow',
      ]);
      expect((await createPlan(github, repo, desired)).changes).toEqual([]);
    },
  );

  test('skips setup configuration when Actions is disabled and unmanaged', async () => {
    const github = new FakeGitHub({
      actions: { enabled: false },
      settings: { [endpoint]: { state: 'not-configured' } },
    });
    const plan = await createPlan(github, repo, {
      security: { [key]: { state: 'configured' } },
    });
    expect(plan.changes).toEqual([]);
    expect(plan.warnings).toEqual([
      {
        section: 'security',
        key,
        cause: 'not_applicable',
        message:
          'it needs Actions to be enabled; set actions.enabled: true in the profile or enable Actions on the repository',
      },
    ]);
    await applyPlan(github, plan);
    expect(github.writes).toEqual([]);
  });

  test('turns setup off before disabling Actions', async () => {
    const github = new FakeGitHub({
      settings: { [endpoint]: { state: 'configured' } },
    });
    const desired: Profile = {
      actions: { enabled: false },
      security: { [key]: { state: 'not-configured' } },
    };
    const plan = await createPlan(github, repo, desired);
    expect(plan.changes.map((change) => change.target)).toEqual([target, 'Actions permissions']);
    await applyPlan(github, plan);
    expect((await createPlan(github, repo, desired)).changes).toEqual([]);
  });

  test('turns setup off before an independent Actions enablement that fails', async () => {
    const github = new FakeGitHub({
      actions: { enabled: false },
      settings: { [endpoint]: { state: 'configured' } },
    }).fail(
      'PUT /repos/lunch/app/actions/permissions',
      new GitHubError(403, 'Actions is disabled by the organization'),
    );
    const plan = await createPlan(github, repo, {
      actions: { enabled: true },
      security: { [key]: { state: 'not-configured' } },
    });
    expect(plan.changes.map((change) => change.target)).toEqual([target, 'Actions permissions']);
    await expect(applyPlan(github, plan)).rejects.toMatchObject({
      name: ApplyError.name,
      applied: [{ target }],
      failed: { target: 'Actions permissions' },
    });
    expect(github.state.settings[endpoint]).toMatchObject({ state: 'not-configured' });
  });

  test('refuses an apply when Actions must be enabled by a change that was not reviewed', async () => {
    const github = new FakeGitHub({ settings: { [endpoint]: { state: 'not-configured' } } });
    const plan = await createPlan(github, repo, {
      actions: { enabled: true },
      security: { [key]: { state: 'configured' } },
    });
    github.state.actions.enabled = false;
    await expect(applyPlan(github, plan)).rejects.toBeInstanceOf(StalePlanError);
    expect(github.writes).toEqual([]);
  });

  test('does not configure setup after its Actions prerequisite fails', async () => {
    const github = new FakeGitHub({
      actions: { enabled: false },
      settings: { [endpoint]: { state: 'not-configured' } },
    }).fail(
      'PUT /repos/lunch/app/actions/permissions',
      new GitHubError(403, 'Actions is disabled by the organization'),
    );
    const plan = await createPlan(github, repo, {
      actions: { enabled: true },
      security: { [key]: { state: 'configured' } },
    });
    await expect(applyPlan(github, plan)).rejects.toMatchObject({
      name: ApplyError.name,
      applied: [],
      failed: { target: 'Actions permissions' },
    });
    expect(github.writes.map((call) => call.path)).toEqual(['/repos/lunch/app/actions/permissions']);
  });

  test('reports an unreadable Actions prerequisite instead of attempting setup configuration', async () => {
    const github = new FakeGitHub({
      settings: { [endpoint]: { state: 'not-configured' } },
    }).fail('GET /repos/lunch/app/actions/permissions', new GitHubError(403, 'Resource not accessible by integration'));
    const plan = await createPlan(github, repo, {
      security: { [key]: { state: 'configured' } },
    });
    expect(plan.changes).toEqual([]);
    expect(plan.warnings).toEqual([
      expect.objectContaining({
        section: 'security',
        key,
        cause: 'refused',
        remedy: { kind: 'permission', permission: 'Administration read' },
      }),
    ]);
    expect(github.writes).toEqual([]);
  });
});

test('allows Dependabot security updates with Actions disabled', async () => {
  const { profile } = await parseProfile(
    'actions: { enabled: false }\nsecurity: { vulnerability_alerts: true, automated_security_fixes: true }',
    '.',
  );
  const github = new FakeGitHub({
    actions: { enabled: false },
    settings: { '/vulnerability-alerts': false, '/automated-security-fixes': { enabled: false } },
  });
  await applyPlan(github, await createPlan(github, repo, profile));
  expect(github.state.settings['/automated-security-fixes']).toMatchObject({ enabled: true });
  expect(github.state.actions.enabled).toBe(false);
});

test('keeps unmanaged selected-actions settings when enabling Actions with a partial list', async () => {
  const github = new FakeGitHub({
    actions: { enabled: false, allowed_actions: 'selected' },
    selected: { github_owned_allowed: true, verified_allowed: false, patterns_allowed: ['octo/*'] },
  });
  const desired: Profile = { actions: { enabled: true, selected_actions: { verified_allowed: true } } };
  const plan = await createPlan(github, repo, desired);
  expect(plan.warnings).toEqual([]);
  await applyPlan(github, plan);
  expect(github.state.selected).toEqual({
    github_owned_allowed: true,
    verified_allowed: true,
    patterns_allowed: ['octo/*'],
  });
  expect((await createPlan(github, repo, desired)).changes).toEqual([]);
});

test('orders same-section prerequisites and nested dependency chains without changing unrelated order', async () => {
  const github = new FakeGitHub({
    repository: { has_pull_requests: false },
    actions: { enabled: false },
    settings: {
      '/interaction-limits/pulls/creation-cap': { enabled: false },
      '/vulnerability-alerts': false,
      '/automated-security-fixes': { enabled: false },
    },
  });
  const plan = await createPlan(github, repo, {
    repository: { has_pull_requests: true, pull_request_creation_cap: { enabled: true, max_open_pull_requests: 3 } },
    actions: { enabled: true, allowed_actions: 'selected', selected_actions: { verified_allowed: true } },
    security: { vulnerability_alerts: true, automated_security_fixes: true },
  });
  expect(orderSettingChanges(plan.changes.toReversed()).map((change) => change.target)).toEqual([
    'Actions permissions',
    'selected actions',
    'Dependabot alerts',
    'Dependabot security updates',
    'repository settings',
    'pull request creation cap',
  ]);
});

test('ignores disabled settings in YAML, including nested dependencies, and applies only active settings', async () => {
  const { profile } = await parseProfile(
    `
repository:
  has_pull_requests: false
  pull_request_creation_policy: collaborators_only
  pull_request_creation_cap: { enabled: true, max_open_pull_requests: 3, include_drafts: true }
merge:
  allow_merge_commit: false
  merge_commit_title: MERGE_MESSAGE
  merge_commit_message: PR_BODY
security:
  vulnerability_alerts: false
  automated_security_fixes: true
  security_and_analysis:
    secret_scanning: { status: disabled }
    secret_scanning_push_protection: { status: enabled }
  code_scanning_default_setup: { state: not-configured, query_suite: extended, runner_type: labeled, runner_label: big }
actions:
  fork_pr_workflows_private_repos:
    run_workflows_from_fork_pull_requests: false
    send_secrets_and_variables: true
pages:
  build_type: workflow
  source: { branch: main, path: /docs }
`,
    '.',
  );
  const github = new FakeGitHub({
    repository: {
      has_pull_requests: true,
      allow_merge_commit: true,
      allow_squash_merge: true,
      security_and_analysis: {
        secret_scanning: { status: 'enabled' },
        secret_scanning_push_protection: { status: 'disabled' },
      },
    },
    settings: {
      '/interaction-limits/pulls/creation-cap': { enabled: false },
      '/vulnerability-alerts': true,
      '/automated-security-fixes': { enabled: false },
      '/code-scanning/default-setup': { state: 'configured', query_suite: 'default' },
      '/actions/permissions/fork-pr-workflows-private-repos': {
        run_workflows_from_fork_pull_requests: true,
        send_write_tokens_to_workflows: true,
        send_secrets_and_variables: false,
        require_approval_for_fork_pr_workflows: true,
      },
      '/pages': { build_type: 'legacy', source: { branch: 'old', path: '/' } },
    },
  });
  const plan = await createPlan(github, repo, profile);
  expect(plan.changes.map((change) => change.request.body)).toEqual([
    { has_pull_requests: false },
    { allow_merge_commit: false },
    { security_and_analysis: { secret_scanning: { status: 'disabled' } } },
    undefined,
    { state: 'not-configured' },
    { run_workflows_from_fork_pull_requests: false },
    { build_type: 'workflow' },
  ]);
  expect(plan.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ cause: 'not_applicable' })]));
  expect(plan.warnings.filter((warning) => warning.key === 'fork_pr_workflows_private_repos')).toHaveLength(1);
  await applyPlan(github, plan);
  expect((await createPlan(github, repo, profile)).changes).toEqual([]);
});

test('uses live dependencies when omitted, and honors a profile that enables them', async () => {
  const github = new FakeGitHub({
    repository: { allow_merge_commit: false, allow_squash_merge: true, has_pull_requests: false },
    settings: {
      '/vulnerability-alerts': false,
      '/automated-security-fixes': { enabled: false },
      '/pages': { build_type: 'workflow' },
      '/interaction-limits/pulls/creation-cap': { enabled: false },
    },
  });
  const desired: Profile = {
    repository: { pull_request_creation_cap: { enabled: true, max_open_pull_requests: 5 } },
    merge: { merge_commit_title: 'PR_TITLE', merge_commit_message: 'BLANK' },
    security: { automated_security_fixes: true },
    pages: { source: { branch: 'main' } },
  };
  expect((await createPlan(github, repo, desired)).changes).toEqual([]);
  const enabled: Profile = {
    ...desired,
    repository: { ...desired.repository, has_pull_requests: true },
    merge: { ...desired.merge, allow_merge_commit: true },
    security: { ...desired.security, vulnerability_alerts: true },
    pages: { build_type: 'legacy', source: { branch: 'main' } },
  };
  expect((await createPlan(github, repo, enabled)).changes).toHaveLength(6);
});

test('saving removes inactive settings from the edited YAML and preserves drafts, comments, and base files', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'repotted-dependencies-'));
  try {
    const base = path.join(directory, 'base.yaml');
    const file = path.join(directory, 'profile.yaml');
    const baseText = 'merge: { allow_merge_commit: false }\n';
    await writeFile(base, baseText);
    await writeFile(
      file,
      `# Team profile
extends: base.yaml
repository: { has_wiki: true } # Keep the wiki
merge: { merge_commit_title: PR_TITLE, merge_commit_message: BLANK }
actions: { enabled: true, allowed_actions: selected, selected_actions: { verified_allowed: true } }
drafts:
  actions: { selected_actions: { patterns_allowed: ['octo-org/*'] } }
`,
    );
    const resolved = await editProfile(file, [{ path: ['actions', 'enabled'], value: false }]);
    expect(resolved.profile.merge).toEqual({ allow_merge_commit: false });
    expect(resolved.profile.actions).toEqual({ enabled: false });
    expect(resolved.drafts.actions).toEqual({ selected_actions: { patterns_allowed: ['octo-org/*'] } });
    const text = await readFile(file, 'utf8');
    expect(text).not.toContain('merge_commit_');
    expect(text).toContain('# Team profile');
    expect(text).toContain('# Keep the wiki');
    expect(await readFile(base, 'utf8')).toBe(baseText);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('capture and YAML serialization omit settings disabled by other settings', async () => {
  const github = new FakeGitHub({
    repository: { allow_merge_commit: false, merge_commit_title: 'PR_TITLE', merge_commit_message: 'BLANK' },
    settings: {
      '/interaction-limits/pulls/creation-cap': { enabled: false, max_open_pull_requests: 10, include_drafts: true },
      '/code-scanning/default-setup': { state: 'not-configured', query_suite: 'default', runner_label: null },
    },
  });
  const { profile } = await captureProfile(github, repo);
  expect(profile.merge).not.toHaveProperty('merge_commit_title');
  expect(profile.repository?.pull_request_creation_cap).toEqual({ enabled: false });
  expect(profile.security?.code_scanning_default_setup).toEqual({ state: 'not-configured' });
  expect(stringifyProfile({ pages: { build_type: 'workflow', source: { branch: 'main' } } })).not.toContain('source');
});

test('capture and YAML serialization omit runner labels with standard runners', async () => {
  const profile: Profile = {
    security: {
      code_scanning_default_setup: { state: 'configured', runner_type: 'standard', runner_label: 'unused' },
      code_quality_setup: { state: 'configured', runner_type: 'standard', runner_label: null },
    },
  };
  const github = new FakeGitHub({
    settings: {
      '/code-scanning/default-setup': profile.security?.code_scanning_default_setup,
      '/code-quality/setup': profile.security?.code_quality_setup,
    },
  });
  const captured = await captureProfile(github, repo);
  expect(captured.profile.security?.code_scanning_default_setup).not.toHaveProperty('runner_label');
  expect(captured.profile.security?.code_quality_setup).not.toHaveProperty('runner_label');
  expect(stringifyProfile(profile)).not.toContain('runner_label');
});
