import { expect, test } from 'vitest';

import {
  branchPolicies,
  labelProblem,
  linesOf,
  rulesetProblem,
  withBranchPolicies,
  withDeploymentBranches,
  withRefNames,
  withRule,
  withRuleParameter,
  withStatusChecks,
} from '../src/app/entry-forms.js';

const saved = {
  name: 'Main',
  target: 'branch',
  bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }],
  conditions: { ref_name: { include: ['~DEFAULT_BRANCH'] }, repository_name: { include: ['api'] } },
  rules: [
    { type: 'deletion' },
    { type: 'pull_request', parameters: { required_approving_review_count: 2, allowed_merge_methods: ['squash'] } },
    {
      type: 'required_status_checks',
      parameters: { required_status_checks: [{ context: 'quality', integration_id: 15_368 }] },
    },
    { type: 'code_scanning', parameters: { code_scanning_tools: [] } },
  ],
};

test('ref names are written as a pair, keep the other conditions, and typed then deleted are as saved', () => {
  const added = withRefNames(saved, 'exclude', ['refs/heads/tmp/*'], saved);
  expect(added['conditions']).toEqual({
    repository_name: { include: ['api'] },
    ref_name: { include: ['~DEFAULT_BRANCH'], exclude: ['refs/heads/tmp/*'] },
  });
  expect(added['bypass_actors']).toBe(saved.bypass_actors);

  expect(withRefNames(added, 'exclude', [], saved)).toEqual(saved);

  const none = withRefNames(withRefNames({ name: 'New' }, 'include', ['~ALL']), 'include', []);
  expect(none).toEqual({ name: 'New' });
});

test('a rule turned off and on again comes back as saved, and rules the form has no box for stay', () => {
  const off = withRule(saved, 'pull_request', false, saved);
  expect(off['rules']).toEqual([saved.rules[0], saved.rules[2], saved.rules[3]]);

  const on = withRule(off, 'pull_request', true, saved);
  expect(on['rules']).toContainEqual(saved.rules[1]);
  expect(withRule(on, 'pull_request', true, saved)).toBe(on);
});

test('the last rule turned off leaves rules unset when the file set none, and empty when it set some', () => {
  const fresh = { name: 'New' };
  const checked = withRule(fresh, 'deletion', true, undefined);
  expect(checked['rules']).toEqual([{ type: 'deletion' }]);
  // Unset rules leave each repository's alone. An empty list would remove them all.
  expect(withRule(checked, 'deletion', false, undefined)).toEqual(fresh);

  const one = { name: 'One', rules: [{ type: 'deletion' }] };
  expect(withRule(one, 'deletion', false, one)).toEqual({ name: 'One', rules: [] });
});

test('a rule parameter is set or left to each repository, beside the ones the form does not show', () => {
  const set = withRuleParameter(saved, 'pull_request', 'require_code_owner_review', true);
  expect(set['rules']).toContainEqual({
    type: 'pull_request',
    parameters: {
      required_approving_review_count: 2,
      allowed_merge_methods: ['squash'],
      require_code_owner_review: true,
    },
  });

  const bare = withRuleParameter(
    { rules: [{ type: 'pull_request', parameters: { dismiss_stale_reviews_on_push: true } }] },
    'pull_request',
    'dismiss_stale_reviews_on_push',
    undefined,
  );
  expect(bare['rules']).toEqual([{ type: 'pull_request' }]);
});

test('status checks keep what the file says of a check, once each, and none named is a problem', () => {
  const next = withStatusChecks(saved, linesOf('quality\n build \nquality\n'));
  expect(next['rules']).toContainEqual({
    type: 'required_status_checks',
    parameters: { required_status_checks: [{ context: 'quality', integration_id: 15_368 }, { context: 'build' }] },
  });
  expect(rulesetProblem(next)).toBeUndefined();
  expect(rulesetProblem(withStatusChecks(saved, []))).toBe('Name at least one status check that must pass.');
  expect(rulesetProblem(withRule(saved, 'required_status_checks', false, saved))).toBeUndefined();
});

test("deployment branches drop their patterns with another choice and get the file's back with chosen", () => {
  const environment = {
    name: 'production',
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    branch_policies: [
      { name: 'main', type: 'branch' },
      { name: 'v*', type: 'tag' },
    ],
  };

  const any = withDeploymentBranches(environment, 'any', environment);
  expect(any).toEqual({ name: 'production', deployment_branch_policy: null });
  expect(withDeploymentBranches(any, 'chosen', environment)).toEqual(environment);
  expect(withDeploymentBranches(environment, undefined, environment)).toEqual({ name: 'production' });
  expect(withDeploymentBranches({ name: 'new' }, 'protected')).toEqual({
    name: 'new',
    deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
  });
});

test('branch and tag patterns are set apart, and a pattern kept stays as the file writes it', () => {
  const environment = {
    branch_policies: [{ name: 'main', type: 'branch' }, { name: 'tag:odd' }, { name: 'v*', type: 'tag' }],
  };
  expect(branchPolicies(environment, 'branch')).toEqual(['main', 'tag:odd']);
  expect(branchPolicies(environment, 'tag')).toEqual(['v*']);

  const next = withBranchPolicies(environment, 'branch', ['main', 'release/*']);
  expect(next['branch_policies']).toEqual([
    { name: 'main', type: 'branch' },
    { name: 'release/*' },
    { name: 'v*', type: 'tag' },
  ]);
  expect(withBranchPolicies(next, 'tag', ['v*', 'rc*'])['branch_policies']).toEqual([
    { name: 'main', type: 'branch' },
    { name: 'release/*' },
    { name: 'v*', type: 'tag' },
    { name: 'rc*', type: 'tag' },
  ]);
});

test("a label's old names are checked as apply would", () => {
  expect(labelProblem({ name: 'bug', renamed_from: ['defect'] }, ['docs'])).toBeUndefined();
  expect(labelProblem({ name: 'Bug', renamed_from: ['bug'] }, [])).toBe("Renamed from lists the label's own name.");
  expect(labelProblem({ name: 'bug', renamed_from: ['Old', 'old'] }, [])).toBe('Each old name can be listed once.');
  expect(labelProblem({ name: 'bug', renamed_from: ['x'.repeat(51)] }, [])).toBe(
    'An old name can be at most 50 characters.',
  );
  expect(labelProblem({ name: 'bug', renamed_from: ['Docs'] }, ['docs'])).toBe(
    "The profile has a label named Docs, so it can't be an old name.",
  );
});
