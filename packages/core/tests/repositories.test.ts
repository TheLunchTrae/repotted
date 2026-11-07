import { describe, expect, test } from 'bun:test';

import { currentUser, listRepositories } from '../src/repositories.js';
import { FakeGitHub, type FakeRepository } from './fake-github.js';

function repositories(prefix: string, count: number, extra: Partial<FakeRepository> = {}): FakeRepository[] {
  return Array.from({ length: count }, (_, index) => ({
    full_name: `${prefix}/repo-${String(index).padStart(3, '0')}`,
    private: false,
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
          { id: 2, repositories: [{ full_name: 'acme/site', private: true, archived: true }] },
        ],
        repositories: [],
      },
    });

    const list = await listRepositories(github);

    expect(list.source).toBe('installations');
    expect(list.repositories).toHaveLength(102);
    expect(list.repositories[0]).toEqual({ full_name: 'acme/site', private: true, archived: true });
    expect(list.repositories.at(-1)?.full_name).toBe('lunch/repo-100');
  });

  test('falls back to the repositories a token administers when GitHub refuses the installation list', async () => {
    const github = new FakeGitHub({
      account: {
        login: 'lunch',
        name: null,
        repositories: [
          { full_name: 'lunch/b', private: false, permissions: { admin: true } },
          { full_name: 'lunch/a', private: true, permissions: { admin: true } },
          { full_name: 'other/c', private: false, permissions: { admin: false } },
        ],
      },
    });

    expect(await listRepositories(github)).toEqual({
      source: 'admin',
      repositories: [
        { full_name: 'lunch/a', private: true, archived: false },
        { full_name: 'lunch/b', private: false, archived: false },
      ],
    });
  });
});

test('currentUser reads the signed-in account', async () => {
  const github = new FakeGitHub({ account: { login: 'lunch', name: 'Lunch', repositories: [] } });

  expect(await currentUser(github)).toEqual({ login: 'lunch', name: 'Lunch' });
});
