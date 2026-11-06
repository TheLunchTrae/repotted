#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ApplyError,
  applyPlan,
  captureProfile,
  createGitHub,
  createPlan,
  describeFailure,
  formatPlan,
  type GitHub,
  loadProfile,
  parsePlan,
  parseRepo,
  StalePlanError,
  stringifyProfile,
} from '@repotted/core';
import { z } from 'zod';

import { resolveToken } from './auth.js';
import { createServer } from './mcp.js';

// Both src/main.ts and the built dist/repotted.js sit one level below package.json.
const { version } = z
  .object({ version: z.string() })
  .parse(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')));

const usage = `Usage: repotted <command> [options]

Commands:
  capture <owner/repo> [--output file]          Write the repository's setup as a YAML profile
  plan <owner/repo> --profile file [--out file]  Show the changes a profile needs; --out saves the plan
  apply <plan.json> [--yes]                      Apply a saved plan if the repository has not changed
  mcp [--read-only]                              Run the MCP server over stdio

The GitHub token comes from GITHUB_TOKEN, GH_TOKEN or the GitHub CLI (gh auth token).

Options:
  -h, --help     Show this help
  -v, --version  Show the version`;

class UsageError extends Error {}

async function github(): Promise<GitHub> {
  return createGitHub(await resolveToken());
}

function only(positionals: string[], label: string): string {
  const [value, ...rest] = positionals;
  if (value === undefined || rest.length > 0) {
    throw new UsageError(`Expected one ${label}.`);
  }
  return value;
}

function warn(lines: readonly string[]): void {
  for (const line of lines) {
    process.stderr.write(`warning: ${line}\n`);
  }
}

async function confirm(question: string): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(?:es)?$/iu.test((await prompt.question(question)).trim());
  } finally {
    prompt.close();
  }
}

async function capture(args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { output: { type: 'string', short: 'o' } },
  });
  const repo = parseRepo(only(positionals, 'repository'));
  const result = await captureProfile(await github(), repo);
  const yaml = stringifyProfile(result.profile);
  if (values.output === undefined) {
    process.stdout.write(yaml);
  } else {
    await writeFile(values.output, yaml);
    process.stderr.write(`Wrote ${values.output}\n`);
  }
  warn(result.warnings);
  return 0;
}

async function plan(args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { profile: { type: 'string', short: 'p' }, out: { type: 'string' } },
  });
  const repo = parseRepo(only(positionals, 'repository'));
  if (values.profile === undefined) {
    throw new UsageError('plan needs --profile.');
  }
  const result = await createPlan(await github(), repo, await loadProfile(values.profile));
  process.stdout.write(`${formatPlan(result)}\n`);
  if (values.out !== undefined) {
    await writeFile(values.out, `${JSON.stringify(result, null, 2)}\n`);
    process.stderr.write(`Saved the plan to ${values.out}. Apply it with: repotted apply ${values.out}\n`);
  }
  return 0;
}

async function apply(args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { yes: { type: 'boolean', short: 'y' } },
  });
  const file = only(positionals, 'plan file');
  const reviewed = parsePlan(JSON.parse(await readFile(file, 'utf8')));
  process.stdout.write(`${formatPlan(reviewed)}\n`);
  if (reviewed.changes.length === 0) {
    return 0;
  }
  if (values.yes !== true) {
    if (!process.stdin.isTTY) {
      throw new UsageError('apply asks before it writes. Run it in a terminal, or pass --yes.');
    }
    if (!(await confirm(`Apply ${reviewed.changes.length} changes to ${reviewed.repository}? [y/N] `))) {
      process.stderr.write('Nothing applied.\n');
      return 1;
    }
  }
  try {
    const applied = await applyPlan(await github(), reviewed);
    process.stdout.write(`Applied ${applied.length} ${applied.length === 1 ? 'change' : 'changes'}.\n`);
    return 0;
  } catch (error) {
    if (error instanceof StalePlanError) {
      process.stderr.write(`${error.message}\n\nThe repository now needs:\n${formatPlan(error.current)}\n`);
      return 1;
    }
    if (error instanceof ApplyError) {
      process.stderr.write(`${describeFailure(error)}\n`);
      return 1;
    }
    throw error;
  }
}

async function mcp(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { 'read-only': { type: 'boolean' } } });
  const server = createServer({ version, github, cwd: process.cwd(), readOnly: values['read-only'] === true });
  await server.connect(new StdioServerTransport());
  // The transport keeps the process alive until the client disconnects.
  return 0;
}

const commands: Record<string, (args: string[]) => Promise<number>> = { capture, plan, apply, mcp };

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === '-h' || command === '--help' || command === 'help') {
    process.stdout.write(`${usage}\n`);
    return command === undefined ? 1 : 0;
  }
  if (command === '-v' || command === '--version') {
    process.stdout.write(`${version}\n`);
    return 0;
  }
  const run = commands[command];
  if (run === undefined) {
    throw new UsageError(`Unknown command: ${command}`);
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    process.stdout.write(`${usage}\n`);
    return 0;
  }
  return run(rest);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  // parseArgs reports unknown or malformed options with an ERR_PARSE_ARGS_* code.
  const misused =
    error instanceof UsageError ||
    (error instanceof Error && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS'));
  process.stderr.write(`repotted: ${error instanceof Error ? error.message : String(error)}\n`);
  if (misused) {
    process.stderr.write('Run repotted --help for usage.\n');
  }
  process.exitCode = misused ? 2 : 1;
}
