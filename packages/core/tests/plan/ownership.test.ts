import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';

import { type GitHub, parseRepo } from '../../src/github/client.js';
import { applyPlan, createPlan, parsePlan, StalePlanError } from '../../src/plan/plan.js';
import { createStagedApply, editStagedApply, planStagedApply, resolveStagedApply } from '../../src/staging/staged.js';
import { answered, FakeGitHub } from '../support/fake-github.js';

const repo = parseRepo('lunch/app');
const ruleset = (id: number, name: string) => ({
  id,
  name,
  target: 'branch',
  enforcement: 'active',
  bypass_actors: [],
  rules: [{ type: 'deletion' }],
});

test('prunes once after merging the entire combination and never prunes an excluded entry', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'repotted-ownership-'));
  try {
    const first = path.join(directory, 'base.yaml');
    const second = path.join(directory, 'service.yaml');
    const staged = path.join(directory, 'apply.yaml');
    await writeFile(first, 'rulesets: [{name: Main}]\n');
    await writeFile(second, 'rulesets: [{name: Release}]\n');
    const github = new FakeGitHub({ rulesets: [ruleset(1, 'Main'), ruleset(2, 'Release'), ruleset(3, 'Legacy')] });
    await createStagedApply(staged, 'lunch/app', [first, second], ['rulesets']);
    const reviewed = await planStagedApply(github, staged);
    expect(reviewed.plan.changes.map((change) => [change.action, change.target])).toEqual([['delete', 'Legacy']]);
    await editStagedApply(staged, [
      { exclude: 'rulesets/Legacy', excluded: true },
      { exclude: 'rulesets/Main', excluded: true },
    ]);
    expect((await planStagedApply(github, staged)).plan.changes).toEqual([]);
    expect((await resolveStagedApply(staged)).authoritative).toEqual(['rulesets']);
    expect(github.writes).toEqual([]);
    await writeFile(second, 'extends: missing.yaml\n');
    await expect(planStagedApply(github, staged)).rejects.toThrow();
    expect(github.writes).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('an explicitly owned empty section prunes all pages and stale plans cannot delete newly added entries', async () => {
  const github = new FakeGitHub({
    rulesets: Array.from({ length: 101 }, (_, index) => ruleset(index + 1, `Rule ${index}`)),
  });
  expect((await createPlan(github, repo, {})).changes).toEqual([]);
  const reviewed = parsePlan(
    JSON.parse(JSON.stringify(await createPlan(github, repo, {}, [], { authoritative: ['rulesets'] }))),
  );
  expect(reviewed.changes).toHaveLength(101);
  github.state.rulesets.push(ruleset(102, 'New'));
  await expect(applyPlan(github, reviewed)).rejects.toBeInstanceOf(StalePlanError);
  expect(github.writes).toEqual([]);
  const fresh = await createPlan(github, repo, {}, [], { authoritative: ['rulesets'] });
  await applyPlan(github, fresh);
  expect(github.state.rulesets).toEqual([]);
});

test('matches environment and label names without case and preserves retained fields and label rename sources', async () => {
  const github = new FakeGitHub({
    environments: [
      {
        name: 'Production',
        wait_timer: 30,
        prevent_self_review: true,
        reviewers: [{ type: 'User', id: 7 }],
        deployment_branch_policy: null,
        branch_policies: [],
      },
      {
        name: 'Old',
        wait_timer: 0,
        prevent_self_review: false,
        reviewers: [],
        deployment_branch_policy: null,
        branch_policies: [],
      },
    ],
    labels: [{ id: 1, name: 'bug', color: 'ffffff', description: 'Keep this', default: false }],
    autolinks: [{ id: 1, key_prefix: 'OLD-', url_template: 'https://example.com/<num>', is_alphanumeric: true }],
  });
  const plan = await createPlan(
    github,
    repo,
    { environments: [{ name: 'production' }], labels: [{ name: 'Defect', renamed_from: ['BUG'] }] },
    [],
    { authoritative: ['environments', 'labels', 'autolinks'] },
  );
  expect(plan.changes.map((change) => [change.action, change.target])).toEqual([
    ['delete', 'OLD-'],
    ['delete', 'Old'],
    ['update', 'Defect'],
  ]);
  expect(plan.warnings.some((warning) => warning.message.includes('secrets and variables'))).toBe(true);
  await applyPlan(github, plan);
  expect(github.state.environments[0]).toMatchObject({ wait_timer: 30, reviewers: [{ type: 'User', id: 7 }] });
  expect(github.state.labels[0]).toMatchObject({ name: 'Defect', description: 'Keep this' });
});

test('refused and truncated reads block ownership instead of implying empty state', async () => {
  const github = new FakeGitHub().fail('GET /repos/lunch/app/environments', answered(403, 'Forbidden'));
  await expect(createPlan(github, repo, {}, [], { authoritative: ['environments'] })).rejects.toThrow(
    'Cannot fully own environments',
  );
  const incomplete: GitHub = { request: () => Promise.resolve({ total_count: 2, environments: [] }) };
  await expect(createPlan(incomplete, repo, {}, [], { authoritative: ['environments'] })).rejects.toThrow(
    'Incomplete enumeration',
  );
  expect(github.writes).toEqual([]);
});

test('Actions ownership shows and applies its explicit baseline while exclusions preserve live settings', async () => {
  const github = new FakeGitHub({
    settings: {
      '/actions/permissions/access': { access_level: 'organization' },
      '/actions/permissions/fork-pr-contributor-approval': { approval_policy: 'first_time_contributors' },
      '/actions/permissions/fork-pr-workflows-private-repos': {
        run_workflows_from_fork_pull_requests: true,
        send_write_tokens_to_workflows: true,
        send_secrets_and_variables: true,
        require_approval_for_fork_pr_workflows: false,
      },
      '/actions/permissions/artifact-and-log-retention': { days: 30 },
      '/actions/cache/retention-limit': { max_cache_retention_days: 30 },
      '/actions/cache/storage-limit': { max_cache_size_gb: 20 },
      '/actions/oidc/customization/sub': {
        use_default: false,
        use_immutable_subject: true,
        include_claim_keys: ['repo'],
      },
    },
  });
  const plan = await createPlan(github, repo, {}, [], {
    authoritative: ['actions'],
    exclude: ['actions.artifact_and_log_retention'],
  });
  expect(
    plan.changes.some((change) =>
      change.fields.some((field) => field.field === 'default_workflow_permissions' && field.to === 'read'),
    ),
  ).toBe(true);
  await applyPlan(github, parsePlan(JSON.parse(JSON.stringify(plan))));
  expect(github.state.actions).toMatchObject({ allowed_actions: 'selected', sha_pinning_required: true });
  expect(github.state.selected).toEqual({ github_owned_allowed: false, verified_allowed: false, patterns_allowed: [] });
  expect(github.state.settings['/actions/permissions/artifact-and-log-retention']).toEqual({ days: 30 });
  expect(github.state.workflow['default_workflow_permissions']).toBe('read');
  const inaccessible = new FakeGitHub();
  await expect(createPlan(inaccessible, repo, {}, [], { authoritative: ['actions'] })).rejects.toThrow(
    'Cannot fully own actions',
  );
});

test('ambiguous live targets cannot be pruned by name', async () => {
  const github = new FakeGitHub({ rulesets: [ruleset(1, 'Same'), ruleset(2, 'Same')] });
  await expect(createPlan(github, repo, {}, [], { authoritative: ['rulesets'] })).rejects.toThrow('duplicate names');
  expect(github.writes).toEqual([]);
});
