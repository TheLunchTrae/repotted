import path from 'node:path';
import { describe, expect, test } from 'vitest';

import { parseRepo, repoPath } from '../src/github.js';
import { matches } from '../src/match.js';
import {
  ApplyError,
  applyPlan,
  captureProfile,
  createPlan,
  formatPlan,
  parsePlan,
  StalePlanError,
} from '../src/plan.js';
import { loadProfile } from '../src/profile.js';
import type { Profile } from '../src/schema.js';
import { EnvironmentSettingsError } from '../src/sections/environments.js';
import { MergeSettingsError } from '../src/sections/repository.js';
import { FakeGitHub } from './fake-github.js';

const repo = parseRepo('lunch/app');
const examples = path.join(import.meta.dirname, '../../../examples');
const mainBranch = { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } };

function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('matches', () => {
  test('pairs array items even when a greedy pass would pair them wrongly', () => {
    expect(matches([{ type: 'a' }, { type: 'a', strict: true }], [{ type: 'a', strict: true }, { type: 'a' }])).toBe(
      true,
    );
  });

  test('ignores live keys the profile does not set but not missing items', () => {
    expect(matches({ rules: [{ type: 'a' }] }, { rules: [{ type: 'a', extra: 1 }], id: 3 })).toBe(true);
    expect(matches({ rules: [{ type: 'a' }] }, { rules: [{ type: 'a' }, { type: 'b' }] })).toBe(false);
  });
});

describe('parseRepo', () => {
  test('rejects names that would leave the repository path', () => {
    expect(() => parseRepo('../user')).toThrow();
    expect(() => parseRepo('octo/..')).toThrow();
    expect(repoPath(parseRepo('octo.org/app.js'))).toBe('/repos/octo.org/app.js');
  });
});

describe('plan and apply', () => {
  test("brings a fresh repository to Trae's profile, after which the plan is empty", async () => {
    const github = new FakeGitHub();
    const desired = await loadProfile(path.join(examples, 'repotted.yaml'));

    const plan = await createPlan(github, repo, desired);
    expect(plan.changes.map((change) => `${change.action} ${change.target}`)).toEqual([
      'update repository settings',
      'update merge methods',
      'update workflow permissions',
      'create Main: Block Creation and Deletion',
      'create Main: Block Force Pushes',
      'create Main: Require PR',
      'create Main: Require Approval',
      'create Main: Require Code Owner Review',
      'create Main: Require Status Checks',
      'create npm',
      'create npm: tag v*',
    ]);

    await applyPlan(github, plan);
    // GitHub fills in default rule parameters; they must not read as drift.
    expect((await createPlan(github, repo, desired)).changes).toEqual([]);
  });

  test('writes only the settings the profile names and leaves other rulesets alone', async () => {
    const github = new FakeGitHub({
      rulesets: [{ id: 7, name: 'Tags: Protect', target: 'tag', enforcement: 'active', bypass_actors: [], rules: [] }],
    });
    const plan = await createPlan(github, repo, { repository: { delete_branch_on_merge: true }, rulesets: [] });
    await applyPlan(github, plan);

    expect(github.writes).toEqual([
      { method: 'PATCH', path: '/repos/lunch/app', body: { delete_branch_on_merge: true } },
    ]);
    expect(github.state.rulesets.map((item) => item.name)).toEqual(['Tags: Protect']);
  });

  test('creates a replacement ruleset before deleting the ones it replaces', async () => {
    const github = new FakeGitHub({
      rulesets: [
        {
          id: 1,
          name: 'Main: Block Creation',
          target: 'branch',
          enforcement: 'active',
          bypass_actors: [],
          conditions: mainBranch,
          rules: [{ type: 'creation' }],
        },
        {
          id: 2,
          name: 'Main: Block Deletion',
          target: 'branch',
          enforcement: 'active',
          bypass_actors: [],
          conditions: mainBranch,
          rules: [{ type: 'deletion' }],
        },
      ],
    });
    const desired: Profile = {
      rulesets: [
        { name: 'Main: Block Deletion', absent: true },
        { name: 'Main: Block Creation', absent: true },
        {
          name: 'Main: Block Creation and Deletion',
          target: 'branch',
          enforcement: 'active',
          bypass_actors: [],
          conditions: mainBranch,
          rules: [{ type: 'creation' }, { type: 'deletion' }],
        },
      ],
    };

    await applyPlan(github, await createPlan(github, repo, desired));

    expect(github.writes.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /repos/lunch/app/rulesets',
      'DELETE /repos/lunch/app/rulesets/2',
      'DELETE /repos/lunch/app/rulesets/1',
    ]);
  });

  test('updates a ruleset whose rules differ, keeping its id', async () => {
    const github = new FakeGitHub({
      rulesets: [
        {
          id: 4,
          name: 'Main: Require PR',
          target: 'branch',
          enforcement: 'active',
          bypass_actors: [],
          conditions: mainBranch,
          rules: [{ type: 'pull_request', parameters: { allowed_merge_methods: ['squash'] } }],
        },
      ],
    });
    const desired = await loadProfile(path.join(examples, 'base.yaml'));
    const plan = await createPlan(github, repo, {
      rulesets: (desired.rulesets ?? []).filter((item) => item.name === 'Main: Require PR'),
    });

    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]?.request).toMatchObject({ method: 'PUT', path: '/repos/lunch/app/rulesets/4' });
    expect(plan.changes[0]?.fields.map((field) => field.field)).toEqual(['rules']);
  });

  test('keeps what a named ruleset leaves out when it updates the ruleset', async () => {
    const github = new FakeGitHub({
      rulesets: [
        {
          id: 4,
          name: 'Main: Require Approval',
          target: 'branch',
          enforcement: 'active',
          bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'exempt' }],
          conditions: mainBranch,
          rules: [
            {
              type: 'pull_request',
              parameters: {
                allowed_merge_methods: ['rebase'],
                dismiss_stale_reviews_on_push: true,
                require_code_owner_review: false,
                require_last_push_approval: true,
                required_approving_review_count: 1,
                required_review_thread_resolution: false,
              },
            },
          ],
        },
      ],
    });
    const desired: Profile = {
      rulesets: [
        {
          name: 'Main: Require Approval',
          enforcement: 'evaluate',
          rules: [{ type: 'pull_request', parameters: { required_approving_review_count: 2 } }],
        },
      ],
    };

    const plan = await createPlan(github, repo, desired);
    expect(plan.changes[0]?.fields.map((field) => field.field)).toEqual(['enforcement', 'rules']);
    await applyPlan(github, plan);

    const [stored] = github.state.rulesets;
    expect(stored?.enforcement).toBe('evaluate');
    expect(stored?.bypass_actors).toHaveLength(1);
    expect(stored?.rules[0]?.parameters).toMatchObject({
      dismiss_stale_reviews_on_push: true,
      require_last_push_approval: true,
      required_approving_review_count: 2,
      allowed_merge_methods: ['rebase'],
    });
  });

  test('keeps live keys inside listed items, such as a status check app id', async () => {
    const github = new FakeGitHub({
      rulesets: [
        {
          id: 6,
          name: 'Checks',
          target: 'branch',
          enforcement: 'active',
          bypass_actors: [],
          rules: [
            {
              type: 'required_status_checks',
              parameters: {
                strict_required_status_checks_policy: false,
                required_status_checks: [{ context: 'quality', integration_id: 15368 }],
              },
            },
          ],
        },
      ],
    });
    const desired: Profile = {
      rulesets: [
        {
          name: 'Checks',
          rules: [
            {
              type: 'required_status_checks',
              parameters: {
                strict_required_status_checks_policy: true,
                required_status_checks: [{ context: 'quality' }],
              },
            },
          ],
        },
      ],
    };

    await applyPlan(github, await createPlan(github, repo, desired));
    expect(github.state.rulesets[0]?.rules[0]?.parameters).toEqual({
      strict_required_status_checks_policy: true,
      required_status_checks: [{ context: 'quality', integration_id: 15368 }],
    });
  });

  test('shows every value a new ruleset gets, the API defaults included', async () => {
    const plan = await createPlan(new FakeGitHub(), repo, {
      rulesets: [{ name: 'Main', rules: [{ type: 'pull_request' }] }],
    });

    expect(plan.changes[0]?.fields.map((field) => field.field)).toEqual([
      'name',
      'target',
      'enforcement',
      'bypass_actors',
      'rules',
    ]);
    expect(formatPlan(plan)).toContain('"required_approving_review_count":0');
  });

  test('sends a commit message setting with its title setting', async () => {
    const github = new FakeGitHub();
    github.state.repository['squash_merge_commit_title'] = 'PR_TITLE';
    await applyPlan(github, await createPlan(github, repo, { merge: { squash_merge_commit_message: 'PR_BODY' } }));

    expect(github.writes[0]?.body).toEqual({
      squash_merge_commit_message: 'PR_BODY',
      squash_merge_commit_title: 'PR_TITLE',
    });
  });

  test('refuses a commit message that the live title does not allow, at plan time', async () => {
    const github = new FakeGitHub();
    const error = await rejection(createPlan(github, repo, { merge: { squash_merge_commit_message: 'PR_BODY' } }));

    expect(error).toBeInstanceOf(MergeSettingsError);
    expect(String(error)).toContain(
      'squash_merge_commit_title: COMMIT_OR_PR_TITLE with squash_merge_commit_message: PR_BODY',
    );
  });

  test('refuses to turn off the last merge method left on the repository', async () => {
    const github = new FakeGitHub();
    github.state.repository['allow_merge_commit'] = false;
    github.state.repository['allow_rebase_merge'] = false;
    const error = await rejection(createPlan(github, repo, { merge: { allow_squash_merge: false } }));

    expect(error).toBeInstanceOf(MergeSettingsError);
    expect(String(error)).toContain('Every merge method is off');
  });

  test('keeps SHA pinning when it changes the Actions policy', async () => {
    const github = new FakeGitHub({ actions: { enabled: true, allowed_actions: 'all', sha_pinning_required: true } });
    await applyPlan(github, await createPlan(github, repo, { actions: { allowed_actions: 'local_only' } }));

    expect(github.state.actions).toEqual({ enabled: true, allowed_actions: 'local_only', sha_pinning_required: true });
  });

  test('refuses a plan the repository has drifted from, without writing', async () => {
    const github = new FakeGitHub();
    const plan = await createPlan(github, repo, { repository: { has_wiki: false, has_issues: true } });
    github.state.repository['has_wiki'] = false;

    expect(await rejection(applyPlan(github, plan))).toBeInstanceOf(StalePlanError);
    expect(github.writes).toEqual([]);
  });

  test('never runs requests edited into a saved plan', async () => {
    const github = new FakeGitHub();
    const plan = await createPlan(github, repo, { repository: { has_wiki: false } });
    const tampered = {
      ...plan,
      changes: plan.changes.map((change) => ({ ...change, request: { method: 'DELETE', path: '/repos/lunch/app' } })),
    };
    const saved = parsePlan(JSON.parse(JSON.stringify(tampered)));

    expect(await rejection(applyPlan(github, saved))).toBeInstanceOf(StalePlanError);
    expect(github.writes).toEqual([]);
  });

  test('reports which changes were applied when a write fails', async () => {
    const github = new FakeGitHub();
    const plan = await createPlan(github, repo, {
      repository: { has_wiki: false },
      rulesets: [{ name: 'Broken', target: 'branch', enforcement: 'active', bypass_actors: [], rules: [] }],
    });
    const request = github.request.bind(github);
    github.request = (method, requestPath, body) =>
      method === 'POST' ? Promise.reject(new Error('boom')) : request(method, requestPath, body);

    const failure = await rejection(applyPlan(github, plan));
    expect(failure).toBeInstanceOf(ApplyError);
    expect(failure instanceof ApplyError ? failure.applied.map((change) => change.target) : []).toEqual([
      'repository settings',
    ]);
  });

  test('skips rulesets on a plan that does not support them and still plans the rest', async () => {
    const github = new FakeGitHub({ rulesetsUnavailable: true });
    const plan = await createPlan(github, repo, await loadProfile(path.join(examples, 'base.yaml')));

    expect(plan.changes.some((change) => change.section === 'rulesets')).toBe(false);
    expect(plan.changes.length).toBeGreaterThan(0);
    expect(plan.warnings).toEqual(['Skipped rulesets: this repository’s plan does not support rulesets']);
  });

  test('sets the Actions policy before its selected-actions list', async () => {
    const github = new FakeGitHub();
    const desired: Profile = {
      actions: {
        allowed_actions: 'selected',
        selected_actions: { github_owned_allowed: true, patterns_allowed: ['oven-sh/*'] },
      },
    };
    const plan = await createPlan(github, repo, desired);
    expect(plan.changes.map((change) => change.target)).toEqual(['Actions policy', 'selected actions']);

    await applyPlan(github, plan);
    expect((await createPlan(github, repo, desired)).changes).toEqual([]);
  });

  test('keeps the environment settings a profile leaves out', async () => {
    const github = new FakeGitHub({
      environments: [
        {
          name: 'npm',
          wait_timer: 0,
          prevent_self_review: true,
          reviewers: [{ type: 'User', id: 42 }],
          deployment_branch_policy: null,
          branch_policies: [],
        },
      ],
    });
    const desired: Profile = { environments: [{ name: 'npm', wait_timer: 5 }] };

    await applyPlan(github, await createPlan(github, repo, desired));

    expect(github.state.environments[0]).toMatchObject({
      wait_timer: 5,
      reviewers: [{ type: 'User', id: 42 }],
      prevent_self_review: true,
    });
    expect((await createPlan(github, repo, desired)).changes).toEqual([]);
  });

  test('drops old deployment patterns before adding new ones, and only in named environments', async () => {
    const custom = { protected_branches: false, custom_branch_policies: true };
    const github = new FakeGitHub({
      environments: [
        {
          name: 'npm',
          wait_timer: 0,
          prevent_self_review: false,
          reviewers: [],
          deployment_branch_policy: custom,
          branch_policies: [
            { id: 1, name: 'main', type: 'branch' },
            { id: 2, name: 'v*', type: 'tag' },
          ],
        },
        {
          name: 'github-pages',
          wait_timer: 0,
          prevent_self_review: false,
          reviewers: [],
          deployment_branch_policy: null,
          branch_policies: [],
        },
        {
          name: 'old',
          wait_timer: 0,
          prevent_self_review: false,
          reviewers: [],
          deployment_branch_policy: null,
          branch_policies: [],
        },
      ],
    });
    const desired: Profile = {
      environments: [
        {
          name: 'npm',
          deployment_branch_policy: custom,
          branch_policies: [{ name: 'v*', type: 'tag' }, { name: 'release/*' }],
        },
        { name: 'old', absent: true },
      ],
    };

    const plan = await createPlan(github, repo, desired);
    expect(plan.changes.map((change) => `${change.action} ${change.target}`)).toEqual([
      'delete npm: branch main',
      'create npm: branch release/*',
      'delete old',
    ]);

    await applyPlan(github, plan);
    expect(github.state.environments.map((environment) => environment.name).sort()).toEqual(['github-pages', 'npm']);
    expect((await createPlan(github, repo, desired)).changes).toEqual([]);
  });

  test('skips environments it cannot read and still plans the rest', async () => {
    const github = new FakeGitHub({ environmentsUnreadable: true });
    const plan = await createPlan(github, repo, {
      repository: { has_wiki: false },
      environments: [{ name: 'npm', wait_timer: 5 }],
    });

    expect(plan.changes.map((change) => change.section)).toEqual(['repository']);
    expect(plan.warnings).toEqual([expect.stringContaining('Skipped environments')]);
  });

  test('skips environments when it cannot read their deployment patterns', async () => {
    const github = new FakeGitHub({
      branchPoliciesUnreadable: true,
      environments: [
        {
          name: 'npm',
          wait_timer: 0,
          prevent_self_review: false,
          reviewers: [],
          deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
          branch_policies: [],
        },
      ],
    });
    const plan = await createPlan(github, repo, { environments: [{ name: 'npm', wait_timer: 5 }] });

    expect(plan.changes).toEqual([]);
    expect(plan.warnings).toEqual([expect.stringContaining('Skipped environments')]);
  });

  test('updates an environment named in another case, keeping what the profile leaves out', async () => {
    const github = new FakeGitHub({
      environments: [
        {
          name: 'npm',
          wait_timer: 0,
          prevent_self_review: true,
          reviewers: [{ type: 'User', id: 42 }],
          deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
          branch_policies: [],
        },
      ],
    });
    const desired: Profile = { environments: [{ name: 'NPM', wait_timer: 5 }] };

    const plan = await createPlan(github, repo, desired);
    expect(plan.changes.map((change) => `${change.action} ${change.target}`)).toEqual(['update npm']);
    expect(plan.changes[0]?.request.path).toBe(`${repoPath(repo)}/environments/npm`);

    await applyPlan(github, plan);
    expect(github.state.environments).toHaveLength(1);
    expect(github.state.environments[0]).toMatchObject({
      name: 'npm',
      wait_timer: 5,
      reviewers: [{ type: 'User', id: 42 }],
    });
    expect((await createPlan(github, repo, desired)).changes).toEqual([]);
  });

  test('turns off prevent_self_review when the profile removes every reviewer', async () => {
    const github = new FakeGitHub({
      environments: [
        {
          name: 'npm',
          wait_timer: 0,
          prevent_self_review: true,
          reviewers: [{ type: 'User', id: 42 }],
          deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
          branch_policies: [],
        },
      ],
    });
    const plan = await createPlan(github, repo, { environments: [{ name: 'npm', reviewers: [] }] });

    expect(plan.changes[0]?.request.body).toMatchObject({ prevent_self_review: false, reviewers: [] });
  });

  test('refuses prevent_self_review on an environment that would have no reviewers, at plan time', async () => {
    const github = new FakeGitHub({});
    const error = await rejection(
      createPlan(github, repo, { environments: [{ name: 'npm', prevent_self_review: true }] }),
    );

    expect(error).toBeInstanceOf(EnvironmentSettingsError);
  });

  test('reads environments past the first page, so it never recreates one', async () => {
    const environments = Array.from({ length: 101 }, (_, index) => ({
      ...{
        name: 'npm',
        wait_timer: 0,
        prevent_self_review: true,
        reviewers: [{ type: 'User', id: 42 }],
        deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
        branch_policies: [],
      },
      name: `env-${String(index).padStart(3, '0')}`,
    }));
    const github = new FakeGitHub({ environments });

    expect((await createPlan(github, repo, { environments: [{ name: 'env-100', wait_timer: 0 }] })).changes).toEqual(
      [],
    );
  });

  test('warns instead of writing a selected-actions list the policy would ignore', async () => {
    const plan = await createPlan(new FakeGitHub(), repo, {
      actions: { selected_actions: { verified_allowed: true } },
    });

    expect(plan.changes).toEqual([]);
    expect(plan.warnings).toHaveLength(1);
  });
});

describe('capture', () => {
  test('reads bypass actors that GitHub returns without an id or mode', async () => {
    const github = new FakeGitHub({
      rulesets: [
        {
          id: 3,
          name: 'Org admins',
          target: 'branch',
          enforcement: 'active',
          bypass_actors: [{ actor_type: 'OrganizationAdmin' }],
          rules: [],
        },
      ],
    });

    const { profile } = await captureProfile(github, repo);
    expect(profile.rulesets).toEqual([
      expect.objectContaining({
        bypass_actors: [{ actor_id: null, actor_type: 'OrganizationAdmin', bypass_mode: 'always' }],
      }),
    ]);
  });

  test('captures a profile that the same repository already matches', async () => {
    const github = new FakeGitHub();
    await applyPlan(github, await createPlan(github, repo, await loadProfile(path.join(examples, 'repotted.yaml'))));
    github.state.actions = { enabled: true, allowed_actions: 'selected' };
    github.state.selected = { github_owned_allowed: true, verified_allowed: false, patterns_allowed: [] };

    const { profile, warnings } = await captureProfile(github, repo);

    expect(warnings).toEqual([]);
    expect(profile.rulesets).toHaveLength(6);
    expect(profile.environments).toEqual([
      expect.objectContaining({ name: 'npm', branch_policies: [{ name: 'v*', type: 'tag' }] }),
    ]);
    expect((await createPlan(github, repo, profile)).changes).toEqual([]);
  });
});
