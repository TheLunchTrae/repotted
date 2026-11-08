import { copyFile, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';

import { parsePlan } from '@repotted/core';

import { type GitHub, GitHubError, responseError } from '../../core/src/github.js';
import { FakeGitRepository } from '../../core/tests/fake-git.js';
import { FakeGitHub } from '../../core/tests/fake-github.js';

type Method = Parameters<FakeGitHub['request']>[0];
import { installUrl, NotSignedInError } from '../src/auth.js';
import { type Io, run } from '../src/commands.js';

const examples = path.join(import.meta.dirname, '../../../examples');
const directory = await mkdtemp(path.join(tmpdir(), 'repotted-cli-'));

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

interface Result {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/** A fake that refuses its nth write, as GitHub might partway through an apply. */
class FailingGitHub extends FakeGitHub {
  private remaining: number;

  constructor(failOnWrite: number) {
    super();
    this.remaining = failOnWrite;
  }

  override request(method: Method, path: string, body?: unknown): Promise<unknown> {
    if (method !== 'GET') {
      this.remaining -= 1;
      if (this.remaining === 0) {
        return Promise.reject(new GitHubError(500, 'Server Error'));
      }
    }
    return super.request(method, path, body);
  }
}

async function cliWith(github: GitHub, overrides: Partial<Io>, ...argv: string[]): Promise<Result> {
  let out = '';
  let err = '';
  const io: Io = {
    version: '0.0.0',
    env: {},
    github: () => Promise.resolve(github),
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
    interactive: false,
    confirm: () => Promise.resolve(false),
    signIn: () => Promise.reject(new Error('no sign-in in this test')),
    signOut: () => Promise.reject(new Error('no sign-out in this test')),
    ...overrides,
  };
  const code = await run(argv, io);
  return { code, out, err };
}

function cli(github: FakeGitHub, ...argv: string[]): Promise<Result> {
  return cliWith(github, {}, ...argv);
}

/** stdout as one JSON document, which fails the test when it is anything else. */
function document(result: Result): unknown {
  const parsed: unknown = JSON.parse(result.out);
  return parsed;
}

async function savePlan(github: FakeGitHub, name: string): Promise<string> {
  const file = path.join(directory, name);
  const planned = await cli(github, 'plan', 'lunch/app', '--profile', path.join(examples, 'base.yaml'), '--out', file);
  expect(planned.code).toBe(0);
  return file;
}

describe('apply', () => {
  test('refuses to write without a terminal or --yes', async () => {
    const github = new FakeGitHub();
    const file = await savePlan(github, 'no-terminal.json');

    const result = await cli(github, 'apply', file);

    expect(result.code).toBe(2);
    expect(result.err).toContain('apply asks before it writes');
    expect(github.writes).toEqual([]);
  });

  test('writes nothing when the prompt is declined', async () => {
    const github = new FakeGitHub();
    const file = await savePlan(github, 'declined.json');

    const result = await cliWith(github, { interactive: true, confirm: () => Promise.resolve(false) }, 'apply', file);

    expect(result.code).toBe(1);
    expect(result.err).toBe('Nothing applied.\n');
    expect(github.writes).toEqual([]);
  });
});

describe('--json', () => {
  test('plans, saves and applies with nothing but JSON on stdout', async () => {
    const github = new FakeGitHub();
    const file = path.join(directory, 'plan.json');

    const planned = await cli(
      github,
      'plan',
      'lunch/app',
      '--profile',
      path.join(examples, 'base.yaml'),
      '--out',
      file,
      '--json',
    );
    expect(planned).toMatchObject({ code: 0, err: '' });
    expect(document(planned)).toEqual(JSON.parse(await readFile(file, 'utf8')));
    expect(document(planned)).toMatchObject({ repository: 'lunch/app', warnings: [] });
    expect(github.writes).toEqual([]);

    const applied = await cli(github, 'apply', file, '--yes', '--json');
    expect(applied).toMatchObject({ code: 0, err: '' });
    expect(document(applied)).toEqual({
      repository: 'lunch/app',
      applied: parsePlan(document(planned)).changes,
    });
  });

  test('captures a repository as its profile and warnings', async () => {
    const result = await cli(new FakeGitHub({ rulesetsUnavailable: true }), 'capture', 'lunch/app', '--json');

    expect(result).toMatchObject({ code: 0, err: '' });
    expect(document(result)).toMatchObject({
      repository: 'lunch/app',
      profile: { repository: { has_wiki: true } },
      warnings: ['Skipped rulesets: this repository’s plan does not support rulesets'],
    });
  });

  test('captures into a file and prints the same profile', async () => {
    const file = path.join(directory, 'captured.yaml');

    const result = await cli(new FakeGitHub(), 'capture', 'lunch/app', '--output', file, '--json');

    expect(result).toMatchObject({ code: 0, err: '' });
    expect(document(result)).toMatchObject({ repository: 'lunch/app', profile: { repository: { has_wiki: true } } });
    expect(await readFile(file, 'utf8')).toBe((await cli(new FakeGitHub(), 'capture', 'lunch/app')).out);
  });

  test('reports a stale plan with what the repository needs now, and writes nothing', async () => {
    const github = new FakeGitHub();
    const file = path.join(directory, 'stale.json');
    await cli(github, 'plan', 'lunch/app', '--profile', path.join(examples, 'base.yaml'), '--out', file, '--json');
    github.state.repository = { ...github.state.repository, has_projects: false };

    const result = await cli(github, 'apply', file, '--yes', '--json');

    expect(result.code).toBe(1);
    expect(document(result)).toMatchObject({ error: { kind: 'stale_plan', current: { repository: 'lunch/app' } } });
    expect(github.writes).toEqual([]);
  });

  test('reports a write that fails partway with the changes made and the one that failed', async () => {
    const planner = new FakeGitHub();
    const file = await savePlan(planner, 'partial.json');
    const changes = parsePlan(JSON.parse(await readFile(file, 'utf8'))).changes;
    expect(changes.length).toBeGreaterThan(2);

    const result = await cli(new FailingGitHub(2), 'apply', file, '--yes', '--json');

    expect(result).toMatchObject({ code: 1, err: '' });
    expect(document(result)).toMatchObject({
      error: { kind: 'apply_failed', applied: changes.slice(0, 1), failed: changes[1] },
    });
  });

  test('marks the changes the App may not make, in the plan and its text', async () => {
    const github = new FakeGitHub({
      account: {
        login: 'lunch',
        name: null,
        repositories: [],
        installations: [
          {
            id: 4,
            permissions: { administration: 'read' },
            repositories: [{ full_name: 'lunch/app', private: false, permissions: { admin: true } }],
          },
        ],
      },
    });
    const profile = path.join(directory, 'wiki.yaml');
    await writeFile(profile, 'repository: { has_wiki: false }\n');

    const planned = await cli(github, 'plan', 'lunch/app', '--profile', profile, '--json');
    expect(document(planned)).toMatchObject({
      access: {
        role: 'admin',
        app: { status: 'installed', settings_url: 'https://github.com/settings/installations/4' },
      },
      locks: [{ change: 0, reason: 'Needs Administration write' }],
    });
    expect((await cli(github, 'plan', 'lunch/app', '--profile', profile)).out).toContain(
      '~ update repository settings (locked: Needs Administration write)',
    );
  });

  test("gives GitHub's reason for a write it refuses for good", async () => {
    const file = await savePlan(new FakeGitHub(), 'refused.json');
    const refusing = new FakeGitHub();
    refusing.request = (method, requestPath, body) =>
      method === 'GET'
        ? FakeGitHub.prototype.request.call(refusing, method, requestPath, body)
        : Promise.reject(
            responseError(403, {
              message: 'Resource not accessible by integration',
              documentation_url: 'https://docs.github.com/rest/repos/repos#update-a-repository',
            }),
          );

    const result = await cli(refusing, 'apply', file, '--yes', '--json');

    expect(document(result)).toMatchObject({
      error: { kind: 'apply_failed', applied: [], reason: 'Needs Administration write' },
    });
    // Only text output links GitHub's docs, after the failure.
    expect(JSON.stringify(document(result))).not.toContain('docs.github.com');
    expect((await cli(refusing, 'apply', file, '--yes')).err).toMatch(
      /^Failed to update repository settings after 0 of the plan's changes: Resource not accessible by integration\n.*\nSee https:\/\/docs\.github\.com\/rest\/repos\/repos#update-a-repository\n$/su,
    );
  });

  test("links GitHub's docs after a failure in text, and leaves them out of JSON", async () => {
    const github = new FakeGitHub();
    github.request = () =>
      Promise.reject(
        responseError(404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest/repos/repos' }),
      );

    expect(await cli(github, 'capture', 'lunch/app')).toMatchObject({
      code: 1,
      err: 'repotted: Not Found\nSee https://docs.github.com/rest/repos/repos\n',
    });
    expect(document(await cli(github, 'capture', 'lunch/app', '--json'))).toEqual({
      error: { kind: 'error', message: 'Not Found' },
    });
  });

  test('reports failures and misuse as JSON errors with their exit codes', async () => {
    const github = new FakeGitHub();
    const file = await savePlan(github, 'unconfirmed.json');

    const unconfirmed = await cli(github, 'apply', file, '--json');
    expect(unconfirmed.code).toBe(2);
    expect(document(unconfirmed)).toEqual({ error: { kind: 'usage', message: 'apply --json needs --yes.' } });
    expect(github.writes).toEqual([]);

    const malformed = await cli(github, 'plan', 'lunch/app', '--json=true');
    expect(malformed).toMatchObject({ code: 2, err: '' });
    expect(document(malformed)).toMatchObject({ error: { kind: 'usage' } });

    const missing = await cli(github, 'plan', 'lunch/app', '--profile', path.join(directory, 'none.yaml'), '--json');
    expect(missing.code).toBe(1);
    expect(document(missing)).toMatchObject({ error: { kind: 'error' } });
    expect(missing.err).toBe('');
  });
});

describe('account commands', () => {
  const account = {
    login: 'lunch',
    name: 'Lunch',
    installations: [{ id: 1, repositories: [{ full_name: 'lunch/app', private: true, permissions: { admin: true } }] }],
    repositories: [],
  };
  const signedOut = {
    github: () => Promise.reject(new NotSignedInError('Not signed in to GitHub. Run repotted login.')),
  };

  test('repos lists what the App reaches, as JSON or as lines', async () => {
    const github = new FakeGitHub({ account });

    const listed = await cli(github, 'repos', '--json');
    expect(listed).toMatchObject({ code: 0, err: '' });
    expect(document(listed)).toEqual({
      source: 'installations',
      repositories: [{ full_name: 'lunch/app', private: true, archived: false }],
    });

    expect(await cli(github, 'repos')).toMatchObject({ code: 0, out: 'lunch/app (private)\n' });
  });

  test('repos says why a list is empty', async () => {
    const none = await cli(new FakeGitHub({ account: { ...account, installations: [] } }), 'repos');
    expect(none).toMatchObject({ code: 0, out: '' });
    expect(none.err).toContain('not installed on any repositories');

    const admin = await cli(new FakeGitHub({ account: { login: 'lunch', name: null, repositories: [] } }), 'repos');
    expect(admin.err).toBe('This token administers no repositories.\n');
  });

  test('a missing or rejected sign-in fails with its own kind', async () => {
    const missing = await cliWith(new FakeGitHub(), signedOut, 'repos', '--json');
    expect(missing).toMatchObject({ code: 1, err: '' });
    expect(document(missing)).toEqual({
      error: { kind: 'signed_out', message: 'Not signed in to GitHub. Run repotted login.' },
    });

    const github = new FakeGitHub({ account });
    github.request = () => Promise.reject(new GitHubError(401, 'Bad credentials'));
    const rejected = await cli(github, 'repos', '--json');
    expect(rejected.code).toBe(1);
    expect(document(rejected)).toEqual({ error: { kind: 'signed_out', message: 'Bad credentials' } });

    // A passing problem, such as a refresh that could not reach GitHub, may clear on the next try.
    const passing = await cliWith(
      new FakeGitHub(),
      {
        github: () =>
          Promise.reject(new NotSignedInError('Could not refresh. Not signed in.', ['Could not refresh.'], false)),
      },
      'repos',
      '--json',
    );
    expect(document(passing)).toMatchObject({ error: { kind: 'error' } });

    // Other refusals from GitHub say nothing about the sign-in.
    github.request = () => Promise.reject(new GitHubError(403, 'Resource not accessible by integration'));
    expect(document(await cli(github, 'repos', '--json'))).toMatchObject({ error: { kind: 'error' } });
  });

  test('logout removes the sign-in and says whether there was one', async () => {
    const removed = await cliWith(new FakeGitHub(), { signOut: () => Promise.resolve(true) }, 'logout', '--json');
    expect(removed).toMatchObject({ code: 0, err: '' });
    expect(document(removed)).toEqual({ removed: true });

    const none = await cliWith(new FakeGitHub(), { signOut: () => Promise.resolve(false) }, 'logout', '--json');
    expect(document(none)).toEqual({ removed: false });

    expect(await cliWith(new FakeGitHub(), { signOut: () => Promise.resolve(true) }, 'logout')).toMatchObject({
      code: 0,
      out: 'Signed out.\n',
    });
  });

  test('status treats a token GitHub rejects as signed out', async () => {
    const github = new FakeGitHub({ account });
    github.request = (_method, path) =>
      path === '/user' ? Promise.reject(new GitHubError(401, 'Bad credentials')) : Promise.resolve(undefined);

    const result = await cli(github, 'status', '--json');

    expect(result).toMatchObject({ code: 1, err: '' });
    expect(document(result)).toEqual({
      signed_in: false,
      reason: 'rejected',
      message: 'GitHub rejected the sign-in. Run repotted login again.',
      problems: [],
      token_variable: null,
      install_url: installUrl,
    });

    const fromVariable = await cliWith(github, { env: { GH_TOKEN: 'token' } }, 'status', '--json');
    expect(document(fromVariable)).toEqual({
      signed_in: false,
      reason: 'rejected',
      message: 'GitHub rejected the token in GH_TOKEN.',
      problems: [],
      token_variable: 'GH_TOKEN',
      install_url: installUrl,
    });
  });

  test('status names the account, or says it is signed out with exit 1', async () => {
    const signedIn = await cli(new FakeGitHub({ account }), 'status', '--json');
    expect(signedIn).toMatchObject({ code: 0, err: '' });
    expect(document(signedIn)).toEqual({
      signed_in: true,
      login: 'lunch',
      name: 'Lunch',
      token_variable: null,
      install_url: installUrl,
    });

    // Another App's install page is not one Repotted knows.
    const otherApp = await cliWith(
      new FakeGitHub({ account }),
      { env: { REPOTTED_GITHUB_CLIENT_ID: 'Iv1.other' } },
      'status',
      '--json',
    );
    expect(document(otherApp)).toMatchObject({ signed_in: true, install_url: null });

    const out = await cliWith(new FakeGitHub(), signedOut, 'status', '--json');
    expect(out).toMatchObject({ code: 1, err: '' });
    expect(document(out)).toEqual({
      signed_in: false,
      reason: 'not_signed_in',
      message: 'Not signed in to GitHub. Run repotted login.',
      problems: [],
      token_variable: null,
      install_url: installUrl,
    });
  });

  test('status passes on why a sign-in could not be read', async () => {
    const problem = 'Could not read the OS keychain: locked.';
    const result = await cliWith(
      new FakeGitHub(),
      { github: () => Promise.reject(new NotSignedInError(`${problem} Not signed in to GitHub.`, [problem])) },
      'status',
      '--json',
    );

    expect(document(result)).toMatchObject({ signed_in: false, reason: 'not_signed_in', problems: [problem] });
  });

  test('login --json prints the code, then the outcome, one JSON document per line', async () => {
    let enter = (): void => undefined;
    const finished = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const code = {
      deviceCode: 'device',
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
      interval: 5,
      expiresAt: Date.UTC(2026, 0, 1),
    };
    let printed = '';
    const running = run(['login', '--json'], {
      version: '0.0.0',
      env: {},
      github: () => Promise.reject(new Error('not used')),
      out: (text) => {
        printed += text;
        // The code is out before the user has entered it.
        enter();
      },
      err: (text) => {
        throw new Error(`stderr: ${text}`);
      },
      interactive: false,
      confirm: () => Promise.resolve(false),
      signIn: () => Promise.resolve({ code, finished }),
      signOut: () => Promise.reject(new Error('not used')),
    });

    expect(await running).toBe(0);
    const lines = printed
      .trimEnd()
      .split('\n')
      .map((line): unknown => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({
      event: 'code',
      verification_uri: 'https://github.com/login/device',
      user_code: 'ABCD-1234',
      expires_at: '2026-01-01T00:00:00.000Z',
    });
    expect(lines[1]).toMatchObject({ event: 'signed_in' });
  });

  const code = {
    deviceCode: 'device',
    userCode: 'ABCD-1234',
    verificationUri: 'https://github.com/login/device',
    interval: 5,
    expiresAt: Date.UTC(2026, 0, 1),
  };

  test('login --json ends with an error line when the sign-in fails after the code', async () => {
    const result = await cliWith(
      new FakeGitHub(),
      { signIn: () => Promise.resolve({ code, finished: Promise.reject(new Error('The code expired.')) }) },
      'login',
      '--json',
    );

    expect(result).toMatchObject({ code: 1, err: '' });
    const lines = result.out
      .trimEnd()
      .split('\n')
      .map((line): unknown => JSON.parse(line));
    expect(lines[0]).toMatchObject({ event: 'code' });
    expect(lines[1]).toEqual({ event: 'error', error: { kind: 'error', message: 'The code expired.' } });
  });

  test('login prints the code on stderr and where to install the App once signed in', async () => {
    const result = await cliWith(
      new FakeGitHub(),
      { signIn: () => Promise.resolve({ code, finished: Promise.resolve() }) },
      'login',
    );

    expect(result.code).toBe(0);
    expect(result.err).toContain('open https://github.com/login/device and enter the code ABCD-1234');
    expect(result.out).toContain('Signed in.');
  });
});

describe('profile commands', () => {
  test('profile resolves a profile as JSON and saves edits to its file', async () => {
    const base = path.join(directory, 'base.yaml');
    const file = path.join(directory, 'repotted.yaml');
    await copyFile(path.join(examples, 'base.yaml'), base);
    await copyFile(path.join(examples, 'repotted.yaml'), file);

    const shown = await cli(new FakeGitHub(), 'profile', file, '--json');
    expect(shown).toMatchObject({ code: 0, err: '' });
    expect(document(shown)).toMatchObject({ chain: [file, base], sources: { repository: { has_projects: base } } });

    const edited = await cli(
      new FakeGitHub(),
      'profile',
      file,
      '--set',
      'repository.has_wiki=true',
      '--set',
      'merge.squash_merge_commit_title=PR_TITLE',
      '--set',
      'merge.squash_merge_commit_message=PR_BODY',
      '--json',
    );
    expect(edited).toMatchObject({ code: 0, err: '' });
    expect(document(edited)).toMatchObject({
      profile: { repository: { has_wiki: true }, merge: { squash_merge_commit_title: 'PR_TITLE' } },
      sources: { repository: { has_wiki: file } },
    });
    expect(await readFile(file, 'utf8')).toContain('has_wiki: true');

    const removed = await cli(new FakeGitHub(), 'profile', file, '--unset', 'repository.has_wiki', '--json');
    expect(document(removed)).not.toHaveProperty('profile.repository.has_wiki');
    expect(await readFile(file, 'utf8')).not.toContain('has_wiki');
  });

  test('profile renames a ruleset in place when its write follows its drop, and drops an environment', async () => {
    const file = path.join(directory, 'entries.yaml');
    await writeFile(
      file,
      'rulesets:\n  - name: Old # the main one\n    enforcement: active\n  - name: Tags\nenvironments: [{ name: -legacy }]\n',
    );

    const edited = await cli(
      new FakeGitHub(),
      'profile',
      file,
      '--drop-ruleset',
      'Old',
      '--ruleset',
      '{"name":"New","enforcement":"evaluate"}',
      '--drop-environment=-legacy',
      '--json',
    );

    expect(edited).toMatchObject({ code: 0, err: '' });
    expect(document(edited)).toMatchObject({ profile: { rulesets: [{ name: 'New' }, { name: 'Tags' }] } });
    expect(await readFile(file, 'utf8')).toBe(
      'rulesets:\n  - name: New # the main one\n    enforcement: evaluate\n  - name: Tags\n',
    );
  });

  test('profile saves a draft, finishes it when its write follows its drop, and plan skips drafts', async () => {
    const file = path.join(directory, 'drafts.yaml');
    await writeFile(file, 'repository: { has_wiki: false }\n');

    const drafted = await cli(
      new FakeGitHub(),
      'profile',
      file,
      '--ruleset',
      '{"name":"Main","draft":true,"enforcement":"maybe"}',
      '--set',
      'drafts.repository.has_issues=false',
    );
    expect(drafted.code).toBe(0);
    expect(drafted.err).toContain('Drafts, left out of plans: repository.has_issues, ruleset "Main"');
    expect(drafted.err).toContain('warning: Draft ruleset "Main":');

    const planned = await cli(new FakeGitHub(), 'plan', 'lunch/app', '--profile', file, '--json');
    expect(document(planned)).toMatchObject({
      skipped: [
        { section: 'repository', target: 'has_issues' },
        { section: 'rulesets', target: 'Main' },
      ],
    });

    const finished = await cli(
      new FakeGitHub(),
      'profile',
      file,
      '--drop-draft-ruleset',
      'Main',
      '--ruleset',
      '{"name":"Main","enforcement":"evaluate"}',
      '--json',
    );
    expect(finished).toMatchObject({ code: 0, err: '' });
    expect(document(finished)).toMatchObject({
      profile: { rulesets: [{ name: 'Main', enforcement: 'evaluate' }] },
      drafts: { repository: { has_issues: false } },
      warnings: [],
    });
  });

  test('profile drops a draft environment and keeps the environment of the same name', async () => {
    const file = path.join(directory, 'draft-environments.yaml');
    await writeFile(file, 'environments: [{ name: npm, wait_timer: 1 }, { name: NPM, draft: true, wait_timer: 2 }]\n');

    const dropped = await cli(new FakeGitHub(), 'profile', file, '--drop-draft-environment', 'npm', '--json');
    expect(dropped.code).toBe(0);
    expect(document(dropped)).toMatchObject({ profile: { environments: [{ name: 'npm', wait_timer: 1 }] } });
    expect(document(dropped)).not.toHaveProperty('drafts.environments');
  });

  test('profile refuses a ruleset that is not an object with a name, as misuse', async () => {
    for (const text of ['[]', '{"enforcement":"active"}', 'Main']) {
      const result = await cli(
        new FakeGitHub(),
        'profile',
        path.join(examples, 'base.yaml'),
        '--ruleset',
        text,
        '--json',
      );

      expect(result.code).toBe(2);
      expect(document(result)).toMatchObject({ error: { kind: 'usage' } });
    }
  });

  test('profile refuses an edit without a value, as misuse', async () => {
    const result = await cli(
      new FakeGitHub(),
      'profile',
      path.join(examples, 'base.yaml'),
      '--set',
      'repository.has_wiki',
      '--json',
    );

    expect(result.code).toBe(2);
    expect(document(result)).toMatchObject({ error: { kind: 'usage' } });
  });

  test('profiles lists a folder as JSON', async () => {
    const result = await cli(new FakeGitHub(), 'profiles', examples, '--json');

    expect(result).toMatchObject({ code: 0, err: '' });
    expect(document(result)).toEqual({
      profiles: [
        { name: 'base', file: path.join(examples, 'base.yaml'), extends: null, problem: null },
        {
          name: 'repotted',
          file: path.join(examples, 'repotted.yaml'),
          extends: path.join(examples, 'base.yaml'),
          problem: null,
        },
      ],
    });
  });
});

describe('sync', () => {
  test('prints the sync as JSON and exits 1 while a file is in conflict', async () => {
    const github = new FakeGitRepository();
    github.write({ 'base.yaml': '# base\n' });
    const folder = await mkdtemp(path.join(directory, 'sync-'));
    await writeFile(path.join(folder, 'base.yaml'), '# mine\n');

    const conflicted = await cliWith(github, {}, 'sync', folder, '--repository', 'lunch/config', '--json');
    const settled = await cliWith(github, {}, 'sync', folder, '--prefer', 'local', '--only', 'base.yaml', '--json');

    expect(conflicted).toMatchObject({ code: 1, err: '' });
    expect(document(conflicted)).toMatchObject({
      repository: 'lunch/config',
      branch: 'main',
      conflicts: ['base.yaml'],
    });
    expect(settled.code).toBe(0);
    expect(document(settled)).toMatchObject({ pushed: ['base.yaml'], conflicts: [] });
    expect(github.files()).toEqual({ 'base.yaml': '# mine\n' });
  });

  test("links GitHub's docs after a sync GitHub refused", async () => {
    const github = new FakeGitRepository();
    github.write({ 'base.yaml': '# base\n' });
    const folder = await mkdtemp(path.join(directory, 'sync-'));
    await cliWith(github, {}, 'sync', folder, '--repository', 'lunch/config', '--json');
    await writeFile(path.join(folder, 'base.yaml'), '# mine\n');
    github.refuseWrites = responseError(403, {
      message: 'Resource not accessible by integration',
      documentation_url: 'https://docs.github.com/rest/git/refs',
    });

    const result = await cliWith(github, {}, 'sync', folder);

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/^repotted: Repotted cannot reach the profiles in lunch\/config: .*\n/u);
    expect(result.err).toMatch(/\nSee https:\/\/docs\.github\.com\/rest\/git\/refs\n$/u);
  });

  test('refuses a side other than local or remote, as misuse', async () => {
    const result = await cliWith(new FakeGitRepository(), {}, 'sync', directory, '--prefer', 'mine', '--json');

    expect(result.code).toBe(2);
    expect(document(result)).toMatchObject({ error: { kind: 'usage' } });
    const alone = await cliWith(new FakeGitRepository(), {}, 'sync', directory, '--only', 'a.yaml', '--json');
    expect(alone.code).toBe(2);
  });
});

describe('stage', () => {
  test('starts a staged apply, edits and exclusions over its profile, and applies the reviewed plan', async () => {
    const profile = path.join(directory, 'staged-base.yaml');
    await writeFile(profile, 'repository: { has_wiki: false, has_issues: false }\n');
    const file = path.join(directory, 'staged.yaml');
    const github = new FakeGitHub();

    const started = await cli(github, 'stage', file, '--new', 'lunch/app', '--profile', profile, '--json');
    expect(started).toMatchObject({ code: 0, err: '' });
    expect(document(started)).toMatchObject({ repository: 'lunch/app', exclude: [] });

    const edited = await cli(
      github,
      'stage',
      file,
      '--set',
      'repository.has_projects=false',
      '--exclude',
      'repository.has_issues',
      '--json',
    );
    expect(document(edited)).toMatchObject({
      profile: { repository: { has_wiki: false, has_projects: false } },
      exclude: ['repository.has_issues'],
    });

    const planFile = path.join(directory, 'staged-plan.json');
    const planned = await cli(github, 'plan', 'lunch/app', '--staged', file, '--out', planFile, '--json');
    expect(planned.code).toBe(0);
    // The document says what the plan applies and what leaves each change out; the plan file is the plan alone.
    expect(document(planned)).toMatchObject({
      staged: { repository: 'lunch/app', base: await realpath(profile), exclude: ['repository.has_issues'] },
      exclusions: [
        { change: 0, field: 'has_projects', key: 'repository.has_projects', edited: true },
        { change: 0, field: 'has_wiki', key: 'repository.has_wiki', edited: false },
      ],
    });
    // A staged plan says what it can't make, as any plan does.
    expect(document(planned)).toHaveProperty('locks');
    expect(document(planned)).toHaveProperty('access');
    expect(await readFile(planFile, 'utf8')).not.toContain('exclusions');
    const applied = await cli(github, 'apply', planFile, '--yes', '--json');
    expect(applied.code).toBe(0);
    expect(github.writes).toEqual([
      { method: 'PATCH', path: '/repos/lunch/app', body: { has_wiki: false, has_projects: false } },
    ]);
    expect(await readFile(profile, 'utf8')).toBe('repository: { has_wiki: false, has_issues: false }\n');

    const discarded = await cli(github, 'stage', file, '--discard', '--json');
    expect(discarded.code).toBe(0);
    expect(await readFile(file, 'utf8').catch(() => 'gone')).toBe('gone');
  });

  test('refuses a plan for another repository than the staged apply names', async () => {
    const file = path.join(directory, 'staged-other.yaml');
    await cli(new FakeGitHub(), 'stage', file, '--new', 'lunch/app');

    const result = await cli(new FakeGitHub(), 'plan', 'lunch/other', '--staged', file);
    expect(result.code).toBe(2);
    expect(result.err).toContain('applies to lunch/app');
  });

  test('plans a staged apply for its repository named in any case', async () => {
    const file = path.join(directory, 'staged-case.yaml');
    await cli(new FakeGitHub(), 'stage', file, '--new', 'lunch/app');

    const result = await cli(new FakeGitHub(), 'plan', 'Lunch/App', '--staged', file, '--json');
    expect(result.code).toBe(0);
    expect(document(result)).toMatchObject({ repository: 'lunch/app' });
  });

  test('leaves no file behind when the edits of a start fail, so it can start again', async () => {
    const file = path.join(directory, 'staged-failed-start.yaml');

    const failed = await cli(new FakeGitHub(), 'stage', file, '--new', 'lunch/app', '--set', 'repository.no_such=1');
    expect(failed.code).not.toBe(0);
    expect(
      await readFile(file).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    const started = await cli(new FakeGitHub(), 'stage', file, '--new', 'lunch/app');
    expect(started.code).toBe(0);
  });

  test('names the drafts of its profile, which its plan leaves out', async () => {
    const profile = path.join(directory, 'staged-drafts-base.yaml');
    await writeFile(profile, 'repository: { has_wiki: false }\ndrafts:\n  repository: { has_projects: false }\n');
    const file = path.join(directory, 'staged-drafts.yaml');

    const started = await cli(new FakeGitHub(), 'stage', file, '--new', 'lunch/app', '--profile', profile);
    expect(started.err).toContain('Drafts of its profile, left out: repository.has_projects');
    const planned = await cli(new FakeGitHub(), 'plan', '--staged', file, '--json');
    expect(JSON.parse(planned.out)).toMatchObject({ skipped: [{ section: 'repository', target: 'has_projects' }] });
  });
});
