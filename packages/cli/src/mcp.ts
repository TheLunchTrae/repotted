import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ApplyError,
  applyPlan,
  describeFailure,
  captureProfile,
  createPlan,
  formatPlan,
  type GitHub,
  lockChanges,
  parseProfile,
  parseRepo,
  type Plan,
  readAccess,
  resolveProfile,
  skippedDrafts,
  StalePlanError,
  stringifyProfile,
} from '@repotted/core';
import { z } from 'zod';

export interface ServerOptions {
  readonly version: string;
  /**
   * Called on every tool call, so the server starts without a token and
   * picks up a refreshed one: user tokens expire, and refreshing one ends the
   * old token.
   */
  readonly github: () => Promise<GitHub>;
  /** Directory that profile paths and `extends` resolve from. */
  readonly cwd: string;
  /** Leaves out the apply tool. */
  readonly readOnly: boolean;
}

interface ToolResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function text(value: string, isError = false): ToolResult {
  return isError ? { content: [{ type: 'text', text: value }], isError } : { content: [{ type: 'text', text: value }] };
}

async function attempt(work: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await work();
  } catch (error) {
    return text(error instanceof Error ? error.message : String(error), true);
  }
}

const repository = z.string().describe('The repository as owner/name, for example octo-org/app');

const instructions = [
  'Repotted reads and changes GitHub repository settings, merge methods, Actions settings, security settings, custom properties, GitHub Pages, autolinks, rulesets, deployment environments and labels.',
  'capture describes a repository as a profile. plan compares a repository with a profile and lists the changes, without writing anything.',
  'apply makes the changes of one earlier plan, by its plan_id, and only if the repository has not changed since. Show the user the plan and get their agreement before calling apply.',
].join(' ');

/**
 * An MCP server over the core engine. capture and plan only read. apply
 * takes nothing but the id of a plan this server made, so an agent can only
 * apply changes that were shown as a plan first.
 */
export async function createServer(options: ServerOptions): Promise<McpServer> {
  // The published package leaves the SDK to npm, so a static import would
  // load it, and its JSON Schema validator, for every command.
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const server = new McpServer({ name: 'repotted', version: options.version }, { instructions });
  const plans = new Map<string, Plan>();
  const client = (): Promise<GitHub> => options.github();

  server.registerTool(
    'capture',
    {
      title: 'Capture a repository',
      description: 'Reads a repository and returns a YAML profile that describes its current setup.',
      inputSchema: { repository },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ repository: name }) =>
      attempt(async () => {
        const result = await captureProfile(await client(), parseRepo(name));
        return text([stringifyProfile(result.profile), ...result.warnings.map((line) => `# ${line}`)].join('\n'));
      }),
  );

  server.registerTool(
    'plan',
    {
      title: 'Plan changes',
      description:
        'Compares a repository with a profile and lists the changes that would bring it in line. Writes nothing. Give the profile as YAML text or as a file path. Returns a plan_id for apply.',
      inputSchema: {
        repository,
        profile: z.string().optional().describe('Profile YAML. `extends` resolves from the server’s directory.'),
        profile_path: z.string().optional().describe('Path to a profile file, relative to the server’s directory.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ repository: name, profile, profile_path: profilePath }) =>
      attempt(async () => {
        if ((profile === undefined) === (profilePath === undefined)) {
          return text('Give exactly one of profile or profile_path.', true);
        }
        const desired =
          profilePath === undefined
            ? await parseProfile(profile ?? '', options.cwd)
            : await resolveProfile(path.resolve(options.cwd, profilePath));
        const github = await client();
        const repo = parseRepo(name);
        const plan = await createPlan(github, repo, desired.profile, skippedDrafts(desired.drafts));
        if (plan.changes.length === 0) {
          return text(formatPlan(plan));
        }
        const locks = lockChanges(await readAccess(github, repo), plan.changes);
        const id = randomUUID();
        plans.set(id, plan);
        return text(`${formatPlan(plan, locks)}\n\nplan_id: ${id}`);
      }),
  );

  if (!options.readOnly) {
    server.registerTool(
      'apply',
      {
        title: 'Apply a plan',
        description:
          'Makes the changes of a plan from the plan tool, by its plan_id. The repository is checked again first; if it changed since the plan, nothing is written and you must plan again. Get the user’s agreement to the plan before calling this.',
        inputSchema: { plan_id: z.string().describe('The plan_id that the plan tool returned') },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      },
      ({ plan_id: id }) =>
        attempt(async () => {
          if (!plans.has(id)) {
            return text('No plan has that plan_id. Call plan first.', true);
          }
          // The client comes first, so a failed sign-in keeps the plan.
          const github = await client();
          const plan = plans.get(id);
          if (plan === undefined) {
            return text('No plan has that plan_id. Call plan first.', true);
          }
          // Taken before the next await, so two calls with one id cannot both apply it.
          plans.delete(id);
          try {
            const applied = await applyPlan(github, plan);
            return text(
              `Applied ${applied.length} ${applied.length === 1 ? 'change' : 'changes'} to ${plan.repository}.`,
            );
          } catch (error) {
            if (error instanceof StalePlanError) {
              return text(`${error.message}\n\nCurrent plan:\n${formatPlan(error.current)}`, true);
            }
            if (error instanceof ApplyError) {
              return text(describeFailure(error), true);
            }
            throw error;
          }
        }),
    );
  }

  return server;
}
