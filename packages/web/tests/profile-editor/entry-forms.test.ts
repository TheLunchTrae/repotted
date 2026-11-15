import { expect, test } from 'vitest';

import {
  branchPolicies,
  labelProblem,
  refPatternProblem,
  refPatterns,
  uniqueTrimmedNonBlankLines,
  rulesetProblem,
  withBranchPolicies,
  withDeploymentBranches,
  withNamedRefTarget,
  withRefNames,
  withRefPatterns,
  withRule,
  withRuleParameter,
  withStatusChecks,
} from '../../src/app/profile-editor/entry-forms.js';

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

test('named targets are selected and deselected in the ref names, and the names as saved in any order are as saved', () => {
  const mixed = {
    name: 'Release',
    target: 'branch',
    conditions: { ref_name: { include: ['refs/heads/release/*', '~DEFAULT_BRANCH', 'refs/heads/hotfix/*'] } },
  };
  const all = withNamedRefTarget(mixed, 'include', '~ALL', true, mixed);
  expect(all['conditions']).toEqual({
    ref_name: {
      include: ['refs/heads/release/*', '~DEFAULT_BRANCH', 'refs/heads/hotfix/*', '~ALL'],
      exclude: [],
    },
  });
  expect(withNamedRefTarget(all, 'include', '~ALL', false, mixed)).toEqual(mixed);

  const added = withRefPatterns(mixed, 'include', ['refs/heads/release/*', 'refs/heads/hotfix/*', 'refs/heads/next']);
  expect(added['conditions']).toEqual({
    ref_name: {
      include: ['refs/heads/release/*', '~DEFAULT_BRANCH', 'refs/heads/hotfix/*', 'refs/heads/next'],
      exclude: [],
    },
  });

  const retyped = withRefPatterns(mixed, 'include', ['refs/heads/next'], mixed);
  expect(retyped['conditions']).toEqual({ ref_name: { include: ['~DEFAULT_BRANCH', 'refs/heads/next'], exclude: [] } });
  expect(withRefPatterns(retyped, 'include', ['refs/heads/release/*', 'refs/heads/hotfix/*'], mixed)).toEqual(mixed);

  const typedNamed = withRefPatterns(mixed, 'include', ['~ALL', 'refs/heads/release/*'], mixed);
  expect(refPatterns(typedNamed, 'include')).toEqual(['refs/heads/release/*']);
  expect(withNamedRefTarget(typedNamed, 'include', '~ALL', false, mixed)['conditions']).toEqual({
    ref_name: { include: ['refs/heads/release/*', '~DEFAULT_BRANCH'], exclude: [] },
  });

  const deselected = withRefPatterns(mixed, 'include', [], mixed);
  expect(deselected['conditions']).toEqual({ ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } });
});

test('names as saved come back only when each is there as many times as saved', () => {
  const twice = {
    name: 'Twice',
    conditions: { ref_name: { include: ['refs/heads/a', 'refs/heads/a', 'refs/heads/b'] } },
  };
  const other = withRefNames(twice, 'include', ['refs/heads/a', 'refs/heads/b', 'refs/heads/b'], twice);
  expect(other['conditions']).toEqual({
    ref_name: { include: ['refs/heads/a', 'refs/heads/b', 'refs/heads/b'], exclude: [] },
  });
  expect(withRefNames(other, 'include', ['refs/heads/b', 'refs/heads/a', 'refs/heads/a'], twice)).toEqual(twice);
});

test.each([
  ['refs/heads/release/*', 'branch', undefined],
  ['refs/heads/**/*', 'branch', undefined],
  ['refs/heads/[0-9]*.x', 'branch', undefined],
  ['refs/tags/v*', 'tag', undefined],
  ['refs/tags/v*', 'unset', undefined],
  ['refs/heads/[^_]*', 'branch', undefined],
  ['release/*', 'branch', 'Start each branch pattern with refs/heads/, as in refs/heads/release/*.'],
  ['refs/heads/v*', 'tag', 'Start each tag pattern with refs/tags/, as in refs/tags/v*.'],
  ['v*', 'unset', 'Start each pattern with refs/heads/ for branches or refs/tags/ for tags.'],
  ['~MAIN', 'branch', "~MAIN isn't a target GitHub knows."],
  ['refs/heads/', 'branch', 'refs/heads/ needs a branch name or pattern after it.'],
  ['refs/heads/my branch', 'branch', "refs/heads/my branch: a branch name can't have spaces."],
  ['refs/heads/a..b', 'branch', "refs/heads/a..b: a branch name can't have ..."],
  ['refs/heads/a:b', 'branch', "refs/heads/a:b: a branch name can't have :."],
  ['refs/tags/v1.lock', 'tag', 'refs/tags/v1.lock: no part of a tag name can end with .lock.'],
  ['refs/heads/release/', 'branch', "refs/heads/release/: a branch name can't end with /."],
  ['refs/heads/.hidden', 'branch', 'refs/heads/.hidden: no part of a branch name can start with a dot.'],
  ['refs/heads/a\tb', 'branch', "refs/heads/a\tb: a branch name can't have spaces."],
  ['refs/heads/a\u0007b', 'branch', "refs/heads/a\u0007b: a branch name can't have control characters."],
  ['refs/heads/a.lock/b', 'branch', 'refs/heads/a.lock/b: no part of a branch name can end with .lock.'],
  ['refs/heads/v1.', 'branch', "refs/heads/v1.: a branch name can't end with a dot."],
  ['refs/heads/a~1', 'branch', "refs/heads/a~1: a branch name can't have ~."],
] as const)('the ref pattern %s with the target %s', (pattern, target, problem) => {
  expect(refPatternProblem(pattern, target === 'unset' ? undefined : target)).toBe(problem);
});

test("a ruleset's targets are refused where GitHub would refuse them or match nothing", () => {
  const branches = { name: 'Main', target: 'branch' };
  const typo = withRefPatterns(branches, 'exclude', ['refs/heads/tmp/*', 'tmp/*']);
  expect(rulesetProblem(typo)).toBe('Start each branch pattern with refs/heads/, as in refs/heads/release/*.');
  expect(rulesetProblem(withRefPatterns(typo, 'exclude', ['refs/heads/tmp/*']))).toBeUndefined();

  const defaultBranch = withNamedRefTarget(branches, 'include', '~DEFAULT_BRANCH', true);
  expect(rulesetProblem(defaultBranch)).toBeUndefined();
  expect(rulesetProblem({ ...defaultBranch, target: 'tag' })).toBe(
    "A tag ruleset can't target the default branch. Deselect it.",
  );
  expect(rulesetProblem({ ...defaultBranch, target: 'push' })).toBe(
    'A push ruleset has no branch or tag targets. Deselect them.',
  );
  expect(rulesetProblem({ name: 'Pushes', target: 'push' })).toBeUndefined();
  expect(rulesetProblem(withRefPatterns({ name: 'Pushes', target: 'push' }, 'include', ['refs/heads/a']))).toBe(
    'A push ruleset has no branch or tag targets. Deselect them.',
  );

  expect(rulesetProblem(withNamedRefTarget(branches, 'exclude', '~ALL', true))).toBe(
    'Excluding all branches leaves the ruleset nothing to cover. Deselect it.',
  );
  expect(rulesetProblem({ ...typo, absent: true })).toBeUndefined();

  const noChecks = {
    ...typo,
    rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [] } }],
  };
  expect(rulesetProblem(noChecks)).not.toBe(rulesetProblem(typo));
  expect(rulesetProblem(noChecks)).toBeDefined();
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
  const next = withStatusChecks(saved, uniqueTrimmedNonBlankLines('quality\n build \nquality\n'));
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
