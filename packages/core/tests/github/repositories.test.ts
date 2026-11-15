import { describe, expect, test } from 'vitest';

import { type GitHub, GitHubError, responseError } from '../../src/github/client.js';
import { currentUser, listRepositories, readInstallationSettingsUrl } from '../../src/github/repositories.js';
import { FakeGitHub, type FakeRepository } from '../support/fake-github.js';

function repositories(prefix: string, count: number, extra: Partial<FakeRepository> = {}): FakeRepository[] {
  return Array.from({ length: count }, (_, index) => ({
    full_name: `${prefix}/repo-${String(index).padStart(3, '0')}`,
    private: false,
    permissions: { admin: true },
    ...extra,
  }));
}

describe('listRepositories', () => {
  test('lists every repository the App is installed on, across installations and pages', async () => {
    const github = new FakeGitHub({
      account: {
        login: 'lunch',
        name: null,
        installations: [
          { id: 1, repositories: repositories('lunch', 101) },
          {
            id: 2,
            repositories: [
              {
                full_name: 'acme/site',
                private: true,
                archived: true,
                topics: ['repotted-config'],
                pushed_at: '2026-11-15T12:00:00Z',
                permissions: { admin: true },
              },
              { full_name: 'acme/read-only', private: false, permissions: { admin: false } },
            ],
          },
        ],
        repositories: [],
      },
    });

    const list = await listRepositories(github);

    expect(list.source).toBe('installations');
    expect(list.repositories).toHaveLength(102);
    expect(list.repositories[0]).toEqual({
      full_name: 'acme/site',
      private: true,
      archived: true,
      topics: ['repotted-config'],
      pushed_at: '2026-11-15T12:00:00Z',
    });
    expect(list.repositories.at(-1)?.full_name).toBe('lunch/repo-100');
  });

  test('falls back, past the first page, when GitHub refuses the installation list', async () => {
    const github = new FakeGitHub({
      account: { login: 'lunch', name: null, repositories: repositories('lunch', 150) },
    });

    const list = await listRepositories(github);

    expect(list.source).toBe('admin');
    expect(list.repositories).toHaveLength(150);
  });

  test('fails rather than switch source on any other error, a rate limit included', async () => {
    for (const error of [
      new GitHubError(401, 'Bad credentials'),
      responseError(403, { message: 'API rate limit exceeded for user ID 7.' }, { 'x-ratelimit-remaining': '0' }),
      responseError(403, { message: 'You have exceeded a secondary rate limit.' }, { 'retry-after': '60' }),
      new GitHubError(500, 'Server Error'),
    ]) {
      const github = new FakeGitHub().fail('GET /user/installations', error);

      const caught = await listRepositories(github).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      expect(caught).toBe(error);
      expect(github.calls.some((call) => call.path.startsWith('/user/repos'))).toBe(false);
    }
  });

  test('falls back to the repositories a token administers when GitHub refuses the installation list', async () => {
    const github = new FakeGitHub({
      account: {
        login: 'lunch',
        name: null,
        repositories: [
          { full_name: 'lunch/b', private: false, pushed_at: '2026-11-14T09:30:00Z', permissions: { admin: true } },
          { full_name: 'lunch/a', private: true, permissions: { admin: true } },
          { full_name: 'other/c', private: false, permissions: { admin: false } },
        ],
      },
    });

    expect(await listRepositories(github)).toEqual({
      source: 'admin',
      repositories: [
        { full_name: 'lunch/a', private: true, archived: false, topics: [], pushed_at: null },
        { full_name: 'lunch/b', private: false, archived: false, topics: [], pushed_at: '2026-11-14T09:30:00Z' },
      ],
      missing_permissions: [],
    });
  });
});

describe('the permissions an installation has not accepted', () => {
  const everyPermission = {
    administration: 'write',
    contents: 'write',
    actions: 'write',
    pages: 'write',
    repository_custom_properties: 'write',
    issues: 'write',
    security_events: 'read',
    metadata: 'read',
  };

  test('are named for each owner whose listed repositories they hold back', async () => {
    const { pages: _pages, ...withoutPages } = everyPermission;
    const github = new FakeGitHub({
      account: {
        login: 'lunch',
        name: null,
        installations: [
          { id: 1, permissions: withoutPages, repositories: repositories('lunch', 1) },
          {
            id: 2,
            permissions: { ...everyPermission, actions: 'read', issues: 'read' },
            repositories: repositories('acme', 1),
          },
          { id: 3, permissions: everyPermission, repositories: repositories('done', 1) },
          // Nothing it holds is listed, so nothing it lacks keeps a listed setting off.
          { id: 4, permissions: {}, repositories: repositories('quiet', 1, { permissions: { admin: false } }) },
        ],
        repositories: [],
      },
    });

    expect((await listRepositories(github)).missing_permissions).toEqual([
      {
        owner: 'acme',
        permissions: ['Actions', 'Issues'],
        settings_url: 'https://github.com/settings/installations/2',
      },
      { owner: 'lunch', permissions: ['Pages'], settings_url: 'https://github.com/settings/installations/1' },
    ]);
    expect(await readInstallationSettingsUrl(github, 'ACME')).toBe('https://github.com/settings/installations/2');
    expect(await readInstallationSettingsUrl(github, 'nobody')).toBeNull();
  });

  test('are none for an installation GitHub answers without its permissions', async () => {
    const fake = new FakeGitHub({
      account: {
        login: 'lunch',
        name: null,
        installations: [{ id: 1, repositories: repositories('lunch', 1) }],
        repositories: [],
      },
    });
    const github: GitHub = {
      request: (method, path, body) =>
        path.startsWith('/user/installations?')
          ? Promise.resolve({
              total_count: 1,
              installations: [{ id: 1, account: { login: 'lunch' }, repository_selection: 'selected' }],
            })
          : fake.request(method, path, body),
    };

    expect((await listRepositories(github)).missing_permissions).toEqual([]);
  });
});

test('currentUser reads the signed-in account', async () => {
  const github = new FakeGitHub({ account: { login: 'lunch', name: 'Lunch', repositories: [] } });

  expect(await currentUser(github)).toEqual({ login: 'lunch', name: 'Lunch' });
});
