import { describe, expect, test } from 'vitest';

import { bypassActorIdGitHubKeeps, rulesetsWithBypassActorIdsSettledBySave } from '../../src/profiles/bypass-actors.js';

describe('bypassActorIdGitHubKeeps', () => {
  test('reads an organization or enterprise owner as 1 and a deploy key as no ID', () => {
    expect(bypassActorIdGitHubKeeps('OrganizationAdmin', 7)).toBe(1);
    expect(bypassActorIdGitHubKeeps('OrganizationAdmin', null)).toBe(1);
    expect(bypassActorIdGitHubKeeps('EnterpriseOwner', 0)).toBe(1);
    expect(bypassActorIdGitHubKeeps('DeployKey', 4)).toBeNull();
  });

  test('keeps the ID of every other actor', () => {
    expect(bypassActorIdGitHubKeeps('Team', 42)).toBe(42);
    expect(bypassActorIdGitHubKeeps('Integration', 15368)).toBe(15368);
    expect(bypassActorIdGitHubKeeps('RepositoryRole', 5)).toBe(5);
  });
});

describe('rulesetsWithBypassActorIdsSettledBySave', () => {
  test('names only the rulesets whose ignored IDs the save sets', () => {
    const owner = { actor_type: 'OrganizationAdmin', bypass_mode: 'always' } as const;
    expect(
      rulesetsWithBypassActorIdsSettledBySave(
        {
          rulesets: [
            { name: 'Main', bypass_actors: [{ ...owner, actor_id: 7 }] },
            { name: 'Kept', bypass_actors: [{ ...owner, actor_id: 1 }] },
            { name: 'From a base', bypass_actors: [{ ...owner, actor_id: 3 }] },
          ],
        },
        {
          rulesets: [
            { name: 'Main', bypass_actors: [{ ...owner, actor_id: 1 }] },
            { name: 'Kept', bypass_actors: [{ ...owner, actor_id: 1 }] },
            { name: 'From a base', bypass_actors: [{ ...owner, actor_id: 3 }] },
          ],
        },
      ),
    ).toEqual(['Main']);
  });
});
