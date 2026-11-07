import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parsePlan } from '@repotted/core';

import { FakeGitHub } from '../../core/tests/fake-github.js';
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

async function cli(github: FakeGitHub, ...argv: string[]): Promise<Result> {
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
  };
  const code = await run(argv, io);
  return { code, out, err };
}

/** stdout as one JSON document, which fails the test when it is anything else. */
function document(result: Result): unknown {
  const parsed: unknown = JSON.parse(result.out);
  return parsed;
}

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

  test('reports failures and misuse as JSON errors with their exit codes', async () => {
    const github = new FakeGitHub();
    const file = path.join(directory, 'any.json');
    await writeFile(file, '{}');

    const unconfirmed = await cli(github, 'apply', file, '--json');
    expect(unconfirmed.code).toBe(2);
    expect(document(unconfirmed)).toEqual({ error: { kind: 'usage', message: 'apply --json needs --yes.' } });

    const missing = await cli(github, 'plan', 'lunch/app', '--profile', path.join(directory, 'none.yaml'), '--json');
    expect(missing.code).toBe(1);
    expect(document(missing)).toMatchObject({ error: { kind: 'error' } });
    expect(missing.err).toBe('');
  });
});
