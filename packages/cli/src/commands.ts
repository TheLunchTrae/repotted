import { readFile, writeFile } from 'node:fs/promises';
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

import {
  enterCode,
  installUrl,
  keychain,
  startSignIn,
  tokenOrSignIn,
  tokenVariables,
  usesRepottedApp,
} from './auth.js';
import { createServer } from './mcp.js';

/** What the CLI reaches outside itself: GitHub, the terminal, and its own version. */
export interface Io {
  readonly version: string;
  github(): Promise<GitHub>;
  out(text: string): void;
  err(text: string): void;
  /** Whether a person can answer a prompt. */
  readonly interactive: boolean;
  confirm(question: string): Promise<boolean>;
}

const usage = `Usage: repotted <command> [options]

Commands:
  capture <owner/repo> [--output file]          Write the repository's setup as a YAML profile
  plan <owner/repo> --profile file [--out file]  Show the changes a profile needs; --out saves the plan
  apply <plan.json> [--yes]                      Apply a saved plan if the repository has not changed
  mcp [--read-only]                              Run the MCP server over stdio
  login                                          Sign in with the Repotted GitHub App
  logout                                         Remove the sign-in from the OS keychain

The GitHub token comes from GITHUB_TOKEN or GH_TOKEN, then repotted login, then
the GitHub CLI (gh auth token).

Options:
  --json         With capture, plan or apply, print one JSON document for programs
  -h, --help     Show this help
  -v, --version  Show the version`;

class UsageError extends Error {}

function only(positionals: string[], label: string): string {
  const [value, ...rest] = positionals;
  if (value === undefined || rest.length > 0) {
    throw new UsageError(`Expected one ${label}.`);
  }
  return value;
}

function json(io: Io, value: unknown): void {
  io.out(`${JSON.stringify(value)}\n`);
}

function warn(io: Io, lines: readonly string[]): void {
  for (const line of lines) {
    io.err(`warning: ${line}\n`);
  }
}

async function capture(io: Io, args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { output: { type: 'string', short: 'o' }, json: { type: 'boolean' } },
  });
  const repo = parseRepo(only(positionals, 'repository'));
  if (values.json === true && values.output !== undefined) {
    throw new UsageError('capture takes --json or --output, not both.');
  }
  const result = await captureProfile(await io.github(), repo);
  if (values.json === true) {
    json(io, { repository: `${repo.owner}/${repo.name}`, profile: result.profile, warnings: result.warnings });
    return 0;
  }
  const yaml = stringifyProfile(result.profile);
  if (values.output === undefined) {
    io.out(yaml);
  } else {
    await writeFile(values.output, yaml);
    io.err(`Wrote ${values.output}\n`);
  }
  warn(io, result.warnings);
  return 0;
}

async function plan(io: Io, args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { profile: { type: 'string', short: 'p' }, out: { type: 'string' }, json: { type: 'boolean' } },
  });
  const repo = parseRepo(only(positionals, 'repository'));
  if (values.profile === undefined) {
    throw new UsageError('plan needs --profile.');
  }
  const desired = await loadProfile(values.profile);
  const result = await createPlan(await io.github(), repo, desired);
  if (values.out !== undefined) {
    await writeFile(values.out, `${JSON.stringify(result, null, 2)}\n`);
  }
  if (values.json === true) {
    json(io, result);
    return 0;
  }
  io.out(`${formatPlan(result)}\n`);
  if (values.out !== undefined) {
    io.err(`Saved the plan to ${values.out}. Apply it with: repotted apply ${values.out}\n`);
  }
  return 0;
}

async function apply(io: Io, args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { yes: { type: 'boolean', short: 'y' }, json: { type: 'boolean' } },
  });
  const file = only(positionals, 'plan file');
  // A program has no terminal to confirm in; the reviewed plan is its confirmation.
  if (values.json === true && values.yes !== true) {
    throw new UsageError('apply --json needs --yes.');
  }
  const reviewed = parsePlan(JSON.parse(await readFile(file, 'utf8')));
  if (values.json !== true) {
    io.out(`${formatPlan(reviewed)}\n`);
  }
  if (reviewed.changes.length === 0) {
    if (values.json === true) {
      json(io, { repository: reviewed.repository, applied: [] });
    }
    return 0;
  }
  if (values.yes !== true) {
    if (!io.interactive) {
      throw new UsageError('apply asks before it writes. Run it in a terminal, or pass --yes.');
    }
    if (!(await io.confirm(`Apply ${reviewed.changes.length} changes to ${reviewed.repository}? [y/N] `))) {
      io.err('Nothing applied.\n');
      return 1;
    }
  }
  try {
    const applied = await applyPlan(await io.github(), reviewed);
    if (values.json === true) {
      json(io, { repository: reviewed.repository, applied });
    } else {
      io.out(`Applied ${applied.length} ${applied.length === 1 ? 'change' : 'changes'}.\n`);
    }
    return 0;
  } catch (error) {
    if (error instanceof StalePlanError) {
      if (values.json === true) {
        json(io, { error: { kind: 'stale_plan', message: error.message, current: error.current } });
      } else {
        io.err(`${error.message}\n\nThe repository now needs:\n${formatPlan(error.current)}\n`);
      }
      return 1;
    }
    if (error instanceof ApplyError) {
      if (values.json === true) {
        json(io, {
          error: {
            kind: 'apply_failed',
            message: describeFailure(error),
            applied: error.applied,
            failed: error.failed,
          },
        });
      } else {
        io.err(`${describeFailure(error)}\n`);
      }
      return 1;
    }
    throw error;
  }
}

async function login(io: Io, args: string[]): Promise<number> {
  parseArgs({ args, options: {} });
  const signIn = await startSignIn();
  io.err(`To sign in to GitHub, ${enterCode(signIn.code)}.\n`);
  await signIn.finished;
  io.out(
    usesRepottedApp()
      ? `Signed in. Install the Repotted GitHub App on the repositories it should manage: ${installUrl}\n`
      : 'Signed in. Install your GitHub App on the repositories it should manage.\n',
  );
  const overrides = tokenVariables();
  if (overrides.length > 0) {
    io.err(`${overrides.join(' and ')} ${overrides.length === 1 ? 'is' : 'are'} set and used before this sign-in.\n`);
  }
  return 0;
}

async function logout(io: Io, args: string[]): Promise<number> {
  parseArgs({ args, options: {} });
  io.out((await keychain.clear()) ? 'Signed out.\n' : 'Not signed in.\n');
  return 0;
}

async function mcp(io: Io, args: string[]): Promise<number> {
  const mcpToken = tokenOrSignIn();
  const { values } = parseArgs({ args, options: { 'read-only': { type: 'boolean' } } });
  const server = createServer({
    version: io.version,
    github: async () => createGitHub(await mcpToken()),
    cwd: process.cwd(),
    readOnly: values['read-only'] === true,
  });
  await server.connect(new StdioServerTransport());
  // The transport keeps the process alive until the client disconnects.
  return 0;
}

const commands: Record<string, (io: Io, args: string[]) => Promise<number>> = {
  capture,
  plan,
  apply,
  mcp,
  login,
  logout,
};

async function dispatch(io: Io, argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === '-h' || command === '--help' || command === 'help') {
    io.out(`${usage}\n`);
    return command === undefined ? 1 : 0;
  }
  if (command === '-v' || command === '--version') {
    io.out(`${io.version}\n`);
    return 0;
  }
  const handler = commands[command];
  if (handler === undefined) {
    throw new UsageError(`Unknown command: ${command}`);
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    io.out(`${usage}\n`);
    return 0;
  }
  return handler(io, rest);
}

/**
 * Runs one command and returns its exit code: 1 when it fails, 2 when it was
 * misused. With `--json`, a failure is a JSON document on stdout as well.
 */
export async function run(argv: string[], io: Io): Promise<number> {
  try {
    return await dispatch(io, argv);
  } catch (error) {
    // parseArgs reports unknown or malformed options with an ERR_PARSE_ARGS_* code.
    const misused =
      error instanceof UsageError ||
      (error instanceof Error && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS'));
    const message = error instanceof Error ? error.message : String(error);
    if (argv.includes('--json')) {
      json(io, { error: { kind: misused ? 'usage' : 'error', message } });
    } else {
      io.err(`repotted: ${message}\n`);
      if (misused) {
        io.err('Run repotted --help for usage.\n');
      }
    }
    return misused ? 2 : 1;
  }
}
