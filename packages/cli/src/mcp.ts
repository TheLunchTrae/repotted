import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ApplyError,
  applyPlan,
  describeFailure,
  captureProfile,
  createPlan,
  formatPlan,
  type GitHub,
  loadProfile,
  parseProfile,
  parseRepo,
  type Plan,
  StalePlanError,
  stringifyProfile,
} from '@repotted/core';
import { z } from 'zod';

export interface ServerOptions {
  readonly version: string;
  /** Called on the first tool call, so the server starts without a token. */
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
  'Repotted reads and changes GitHub repository settings, merge methods, Actions policy and rulesets.',
  'capture describes a repository as a profile. plan compares a repository with a profile and lists the changes, without writing anything.',
  'apply makes the changes of one earlier plan, by its plan_id, and only if the repository has not changed since. Show the user the plan and get their agreement before calling apply.',
].join(' ');

/**
 * An MCP server over the core engine. capture and plan only read. apply
 * takes nothing but the id of a plan this server made, so an agent can only
 * apply changes that were shown as a plan first.
 */
export function createServer(options: ServerOptions): McpServer {
  const server = new McpServer({ name: 'repotted', version: options.version }, { instructions });
  const plans = new Map<string, Plan>();
  let github: Promise<GitHub> | undefined;
  const client = (): Promise<GitHub> => {
    github ??= options.github().catch((error: unknown) => {
      github = undefined;
      throw error;
    });
    return github;
  };

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
            : await loadProfile(path.resolve(options.cwd, profilePath));
        const plan = await createPlan(await client(), parseRepo(name), desired);
        if (plan.changes.length === 0) {
          return text(formatPlan(plan));
        }
        const id = randomUUID();
        plans.set(id, plan);
        return text(`${formatPlan(plan)}\n\nplan_id: ${id}`);
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
          const plan = plans.get(id);
          if (plan === undefined) {
            return text('No plan has that plan_id. Call plan first.', true);
          }
          try {
            const applied = await applyPlan(await client(), plan);
            plans.delete(id);
            return text(
              `Applied ${applied.length} ${applied.length === 1 ? 'change' : 'changes'} to ${plan.repository}.`,
            );
          } catch (error) {
            if (error instanceof StalePlanError) {
              plans.delete(id);
              return text(`${error.message}\n\nCurrent plan:\n${formatPlan(error.current)}`, true);
            }
            if (error instanceof ApplyError) {
              plans.delete(id);
              return text(describeFailure(error), true);
            }
            throw error;
          }
        }),
    );
  }

  return server;
}
