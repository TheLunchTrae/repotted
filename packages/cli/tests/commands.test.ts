import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parsePlan } from '@repotted/core';

import { GitHubError } from '../../core/src/github.js';
import { FakeGitHub } from '../../core/tests/fake-github.js';

type Method = Parameters<FakeGitHub['request']>[0];
import { type Io, run } from '../src/commands.js';

const examples = path.join(import.meta.dir, '../../../examples');
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

async function cliWith(github: FakeGitHub, overrides: Partial<Io>, ...argv: string[]): Promise<Result> {
  let out = '';
  let err = '';
  const io: Io = {
    version: '0.0.0',
    github: () => Promise.resolve(github),
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
    interactive: false,
    confirm: () => Promise.resolve(false),
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
