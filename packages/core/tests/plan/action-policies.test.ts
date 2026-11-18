import { expect, test } from 'vitest';

import { parseRepo } from '../../src/github/client.js';
import { applyPlan, captureProfile, createPlan, parsePlan, StalePlanError } from '../../src/plan/plan.js';
import { captureDefinition } from '../../src/profiles/definitions.js';
import { parseProfile } from '../../src/profiles/profile.js';
import { answered, FakeGitHub } from '../support/fake-github.js';

const repo = parseRepo('lunch/app');
const policy = (id: number, name: string) => ({
  id,
  name,
  target: 'actions',
  enforcement: 'active',
  conditions: { workflow_path: { include: ['.github/workflows/release.yml'], exclude: [] } },
  rules: [{ type: 'restrict_action_events', parameters: { allowed_events: ['release'], future_option: true } }],
});

test('policy updates preserve omitted fields and create replacements before explicit deletions', async () => {
  const github = new FakeGitHub({ policies: [policy(1, 'Release'), policy(2, 'Legacy'), policy(3, 'Keep')] });
  const desired = (
    await parseProfile(
      `actions_policies:
  - name: Release
    enforcement: evaluate
  - name: Publish
    rules:
      - type: restrict_actions_actors
        parameters:
          allowed_actors: [{ id: 5, type: User }]
  - name: Legacy
    absent: true
`,
      '.',
    )
  ).profile;
  const plan = parsePlan(JSON.parse(JSON.stringify(await createPlan(github, repo, desired))));
  expect(plan.changes.map((change) => [change.action, change.target])).toEqual([
    ['create', 'Publish'],
    ['update', 'Release'],
    ['delete', 'Legacy'],
  ]);
  expect(plan.changes[1]?.request).toEqual({
    method: 'PUT',
    path: '/repos/lunch/app/actions/policies/1',
    body: {
      name: 'Release',
      enforcement: 'evaluate',
      conditions: { workflow_path: { include: ['.github/workflows/release.yml'], exclude: [] } },
      rules: [{ type: 'restrict_action_events', parameters: { allowed_events: ['release'], future_option: true } }],
    },
  });
  await applyPlan(github, plan);
  expect(github.state.policies.map((item) => item.name).sort()).toEqual(['Keep', 'Publish', 'Release']);
  expect((await createPlan(github, repo, desired)).changes).toEqual([]);
});

test('policy rule edits preserve omitted live parameters and workflow targeting', async () => {
  const github = new FakeGitHub({ policies: [policy(1, 'Release')] });
  const plan = await createPlan(github, repo, {
    actions_policies: [
      {
        name: 'Release',
        rules: [{ type: 'restrict_action_events', parameters: { allowed_events: ['workflow_dispatch'] } }],
      },
    ],
  });
  await applyPlan(github, plan);
  expect(github.state.policies[0]).toEqual({
    ...policy(1, 'Release'),
    rules: [
      { type: 'restrict_action_events', parameters: { allowed_events: ['workflow_dispatch'], future_option: true } },
    ],
  });
});

test('full policy ownership preserves inherited and excluded policies, and refuses incomplete reads', async () => {
  const github = new FakeGitHub({
    policies: [
      policy(1, 'Remove'),
      policy(2, 'Keep'),
      { ...policy(3, 'Organization policy'), source_type: 'Organization' },
    ],
  });
  const ownership = { authoritative: ['actions_policies'] as const, exclude: ['actions_policies/Keep'] };
  const plan = await createPlan(github, repo, {}, [], ownership);
  expect(plan.changes.map((change) => change.target)).toEqual(['Remove']);
  await applyPlan(github, plan);
  expect(github.state.policies.map((item) => item.name)).toEqual(['Keep', 'Organization policy']);
  github.fail(/GET .*actions\/policies/u, answered(403, 'Resource not accessible by integration'));
  await expect(createPlan(github, repo, {}, [], ownership)).rejects.toThrow('Cannot fully own actions_policies');
});

test('policy reads include every page and ignore inherited entries even if GitHub lists them', async () => {
  const github = new FakeGitHub({ policies: Array.from({ length: 101 }, (_, i) => policy(i + 1, `Policy ${i + 1}`)) });
  const plan = await createPlan(github, repo, { actions_policies: [{ name: 'Policy 101', enforcement: 'disabled' }] });
  expect(plan.changes.map((change) => change.request.path)).toEqual(['/repos/lunch/app/actions/policies/101']);
  expect(github.calls.some((call) => call.path.endsWith('page=2'))).toBe(true);
});

test('changed live policies invalidate saved plans before writes', async () => {
  const github = new FakeGitHub({ policies: [policy(1, 'Release')] });
  const plan = await createPlan(github, repo, { actions_policies: [{ name: 'Release', enforcement: 'disabled' }] });
  github.state.policies[0]!.rules = [];
  await expect(applyPlan(github, plan)).rejects.toBeInstanceOf(StalePlanError);
  expect(github.writes).toEqual([]);
});

test('profile capture includes named policies separately from general Actions settings', async () => {
  const github = new FakeGitHub({ policies: [policy(1, 'Release')] });
  const captured = await captureProfile(github, repo);
  expect(captured.profile.actions_policies).toEqual([
    {
      name: 'Release',
      enforcement: 'active',
      conditions: policy(1, 'Release').conditions,
      rules: policy(1, 'Release').rules,
    },
  ]);
  expect(captured.profile.actions?.enabled).toBe(true);
  expect(github.writes).toEqual([]);
});

test('a desired rule without parameters retains its existing allowlist', async () => {
  const github = new FakeGitHub({ policies: [policy(1, 'Release')] });
  const plan = await createPlan(github, repo, {
    actions_policies: [{ name: 'Release', enforcement: 'evaluate', rules: [{ type: 'restrict_action_events' }] }],
  });
  await applyPlan(github, plan);
  expect(github.state.policies[0]?.rules).toEqual(policy(1, 'Release').rules);
});

test('capturing stored empty workflow targets produces an applicable all-workflows policy', async () => {
  const github = new FakeGitHub({
    policies: [{ ...policy(1, 'Release'), conditions: { workflow_path: { include: [], exclude: [] } } }],
  });
  const expected = { workflow_path: { include: ['~ALL'], exclude: [] } };
  const captured = await captureDefinition(github, repo, 'actions-policy', 'Release');
  expect(captured.definition.actions_policies?.[0]).toMatchObject({ conditions: expected });
  expect((await captureProfile(github, repo)).profile.actions_policies?.[0]).toMatchObject({ conditions: expected });
});

test('partial policy updates normalize stored empty workflow targets in the reviewed request', async () => {
  const github = new FakeGitHub({
    policies: [{ ...policy(1, 'Release'), conditions: { workflow_path: { include: [], exclude: [] } } }],
  });
  const plan = await createPlan(github, repo, {
    actions_policies: [{ name: 'Release', enforcement: 'disabled' }],
  });
  expect(plan.changes[0]?.request.body).toMatchObject({
    conditions: { workflow_path: { include: ['~ALL'], exclude: [] } },
  });
  expect(plan.changes[0]?.fields).toContainEqual({
    field: 'conditions',
    from: { workflow_path: { include: [], exclude: [] } },
    to: { workflow_path: { include: ['~ALL'], exclude: [] } },
  });
  await applyPlan(github, plan);
  expect((await createPlan(github, repo, plan.desired)).changes).toEqual([]);
});
