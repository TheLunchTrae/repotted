import { describe, expect, test } from 'vitest';

import { bypassActorIdGitHubKeeps } from '../../src/profiles/bypass-actors.js';

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
