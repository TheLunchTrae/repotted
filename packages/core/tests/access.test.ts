import { describe, expect, test } from 'vitest';

import type { Change } from '../src/change.js';
import { GitHubError } from '../src/github.js';
import { lockChanges } from '../src/permissions.js';
import { ApplyError, createPlan, failureReason } from '../src/plan.js';
import { readAccess } from '../src/repositories.js';
import { FakeGitHub, type FakeInstallation } from './fake-github.js';

const app = { owner: 'lunch', name: 'app' };
const lunchApp = { full_name: 'lunch/app', private: false, permissions: { admin: true } };

function withInstallations(installations: FakeInstallation[] | undefined): FakeGitHub {
  return new FakeGitHub({
    account: {
      login: 'lunch',
      name: null,
      repositories: [],
      ...(installations === undefined ? {} : { installations }),
    },
  });
}

function change(method: Change['request']['method'], path: string): Change {
  return { section: 'repository', action: 'update', target: path, fields: [], request: { method, path } };
}

describe('readAccess', () => {
  test("reads the role and the permissions of the owner's installation when it covers the repository", async () => {
    const github = withInstallations([
      { id: 1, account: 'acme', permissions: { administration: 'write' }, repositories: [lunchApp] },
      { id: 2, permissions: { administration: 'write', pages: 'read' }, repositories: [lunchApp] },
    ]);
    github.state.viewer = { admin: false, maintain: false, push: true, triage: true, pull: true };

    expect(await readAccess(github, app)).toEqual({
      role: 'write',
      app: {
        status: 'installed',
        permissions: { administration: 'write', pages: 'read' },
        settings_url: 'https://github.com/settings/installations/2',
      },
    });
  });

  test('covers every repository of an installation on all of them without listing them', async () => {
    const github = withInstallations([{ id: 3, account: 'Lunch', selection: 'all', repositories: [] }]);

    expect((await readAccess(github, app)).app.status).toBe('installed');
    expect(github.calls.some((call) => call.path.startsWith('/user/installations/3/'))).toBe(false);
  });

  test('matches the installation by the name GitHub has for the repository now, in any case', async () => {
    const github = withInstallations([
      { id: 4, account: 'Acme', repositories: [{ ...lunchApp, full_name: 'Acme/Renamed' }] },
    ]);
    github.state.repository = { ...github.state.repository, full_name: 'acme/renamed' };

    expect((await readAccess(github, app)).app.status).toBe('installed');
  });

  test('reads as not installed when no installation covers the repository', async () => {
    for (const installations of [
      [{ id: 1, account: 'acme', selection: 'all' as const, repositories: [] }],
      [{ id: 2, repositories: [{ ...lunchApp, full_name: 'lunch/other' }] }],
    ]) {
      expect((await readAccess(withInstallations(installations), app)).app).toEqual({ status: 'not_installed' });
    }
  });

  test('leaves the App unknown for a token GitHub refuses the installation list to, but not on a rate limit', async () => {
    expect((await readAccess(withInstallations(undefined), app)).app).toEqual({ status: 'unknown' });

    const limited = withInstallations([]);
    limited.request = (method, path) =>
      path.startsWith('/user/installations')
        ? Promise.reject(new GitHubError(403, 'API rate limit exceeded for user ID 7.'))
        : FakeGitHub.prototype.request.call(limited, method, path);
    const failure = await readAccess(limited, app).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(GitHubError);
  });
});

describe('lockChanges', () => {
  const pages = change('PUT', '/repos/lunch/app/pages');
  const settings = change('PATCH', '/repos/lunch/app');
  const oidc = change('PUT', '/repos/lunch/app/actions/oidc/customization/sub');
  const installed = (permissions: Record<string, string>) =>
    ({ status: 'installed', permissions, settings_url: null }) as const;

  test('locks each change by the permissions the installation lacks, naming only those', () => {
    const locks = lockChanges({ role: 'admin', app: installed({ administration: 'write', actions: 'read' }) }, [
      settings,
      pages,
      oidc,
    ]);

    expect(locks).toEqual([
      { change: 1, reason: 'Needs Pages write' },
      { change: 2, reason: 'Needs Actions write' },
    ]);
  });

  test('locks every change on a repository without the App, or without admin there', () => {
    const changes = [settings, pages];

    expect(lockChanges({ role: 'admin', app: { status: 'not_installed' } }, changes)).toEqual([
      { change: 0, reason: 'Needs the GitHub App installed on this repository' },
      { change: 1, reason: 'Needs the GitHub App installed on this repository' },
    ]);
    expect(
      lockChanges({ role: 'maintain', app: installed({ administration: 'write', pages: 'write' }) }, changes),
    ).toEqual([
      { change: 0, reason: 'Needs admin on this repository' },
      { change: 1, reason: 'Needs admin on this repository' },
    ]);
  });

  test('checks only the App when GitHub reports no role', () => {
    expect(lockChanges({ role: null, app: installed({ administration: 'write' }) }, [settings, pages])).toEqual([
      { change: 1, reason: 'Needs Pages write' },
    ]);
  });

  test('locks nothing that the access leaves unknown', () => {
    expect(lockChanges({ role: null, app: { status: 'unknown' } }, [settings, pages, oidc])).toEqual([]);
  });

  test('locks the changes of a real plan against what the App was granted', async () => {
    const github = withInstallations([{ id: 1, permissions: { administration: 'read' }, repositories: [lunchApp] }]);
    const plan = await createPlan(github, app, { repository: { has_wiki: false } });

    expect(lockChanges(await readAccess(github, app), plan.changes)).toEqual([
      { change: 0, reason: 'Needs Administration write' },
    ]);
  });
});

describe('failureReason', () => {
  const failed = (cause: unknown) => new ApplyError([], change('PUT', '/repos/lunch/app/pages'), cause);

  test("names the permission for a refusal for want of one, and gives GitHub's reason for another limit", () => {
    expect(failureReason(failed(new GitHubError(403, 'Resource not accessible by integration')))).toBe(
      'Needs Administration write and Pages write',
    );
    expect(
      failureReason(
        failed(
          new GitHubError(
            422,
            'Your current plan does not support GitHub Pages for this repository. - https://docs.github.com/rest/pages/pages',
          ),
        ),
      ),
    ).toBe('Your current plan does not support GitHub Pages for this repository.');
    expect(
      failureReason(
        failed(
          new GitHubError(
            422,
            'Validation Failed: {"resource":"Ruleset","code":"custom","message":"Invalid target patterns"}, {"code":"invalid"}',
          ),
        ),
      ),
    ).toBe('Validation Failed: Invalid target patterns');
    expect(
      failureReason(
        failed(new GitHubError(422, 'Validation Failed: {"resource":"Repository","code":"custom","field":"name"}')),
      ),
    ).toBe('Validation Failed');
    expect(failureReason(failed(new GitHubError(403, 'Organization policy prevents this change')))).toBe(
      'Organization policy prevents this change',
    );
  });

  test('gives no reason for a failure that says nothing lasting', () => {
    for (const cause of [
      new GitHubError(403, 'API rate limit exceeded for user ID 7.'),
      new GitHubError(500, 'Server Error'),
      new Error('socket hang up'),
    ]) {
      expect(failureReason(failed(cause))).toBeNull();
    }
  });
});
