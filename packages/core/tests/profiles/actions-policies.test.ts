import { expect, test } from 'vitest';

import { parseProfile } from '../../src/profiles/profile.js';

test('a standalone Actions policy resolves a named workflow policy', async () => {
  const resolved = await parseProfile(
    `kind: actions-policy
actions_policies:
  - name: Release
    enforcement: active
    conditions:
      workflow_path:
        include: ['.github/workflows/release.yml']
        exclude: []
    rules:
      - type: restrict_action_events
        parameters:
          allowed_events: [release, workflow_dispatch]
`,
    '.',
  );
  expect(resolved.profile).toEqual({
    actions_policies: [
      {
        name: 'Release',
        enforcement: 'active',
        conditions: { workflow_path: { include: ['.github/workflows/release.yml'], exclude: [] } },
        rules: [{ type: 'restrict_action_events', parameters: { allowed_events: ['release', 'workflow_dispatch'] } }],
      },
    ],
  });
});

test('known event rules reject mistyped events before a plan can write them', async () => {
  await expect(
    parseProfile(
      'actions_policies: [{ name: Release, rules: [{ type: restrict_action_events, parameters: { allowed_events: [pull_requests] } }] }]',
      '.',
    ),
  ).rejects.toThrow('allowed_events');
});
