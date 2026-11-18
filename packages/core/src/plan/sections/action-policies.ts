import { z } from 'zod';

import { type GitHub, repoPath, type RepoRef } from '../../github/client.js';
import type { ActionPolicy, ActionPolicyEntry } from '../../profiles/schema.js';
import type { Change, SectionPlan } from '../change.js';
import { readResource, type Unavailable, warningForUnavailable } from '../endpoints.js';
import { bodyChanges, matches, overlay } from '../match.js';

const policySummary = z.object({ id: z.number().int(), source_type: z.string() });
const policyList = z.object({ total_count: z.number().int(), policies: z.array(policySummary) });
const livePolicy = z.object({
  id: z.number().int(),
  name: z.string(),
  enforcement: z.enum(['active', 'evaluate', 'disabled']),
  conditions: z.record(z.string(), z.unknown()).nullish(),
  rules: z.array(z.object({ type: z.string(), parameters: z.record(z.string(), z.unknown()).optional() })).nullish(),
});

type StoredPolicy = Omit<z.infer<typeof livePolicy>, 'id' | 'rules' | 'conditions'> & {
  conditions?: Record<string, unknown>;
  rules: NonNullable<ActionPolicy['rules']>;
};
interface LivePolicy {
  readonly id: number;
  readonly policy: StoredPolicy;
}
type LivePolicies = { readonly available: true; readonly policies: readonly LivePolicy[] } | Unavailable;

export async function readActionPolicies(github: GitHub, repo: RepoRef): Promise<LivePolicies> {
  const listed: z.infer<typeof policySummary>[] = [];
  for (let page = 1; ; page += 1) {
    const read = await readResource(
      github,
      repo,
      `/actions/policies?has_parents=false&per_page=100&page=${page}`,
      'Actions policies',
    );
    if (!read.available) {
      return read;
    }
    const data = policyList.parse(read.value);
    listed.push(...data.policies);
    if (listed.length >= data.total_count || data.policies.length === 0) {
      break;
    }
  }
  const policies: LivePolicy[] = [];
  for (const item of listed.filter((item) => item.source_type === 'Repository')) {
    const read = await readResource(github, repo, `/actions/policies/${item.id}`, 'Actions policy');
    if (!read.available) {
      return read;
    }
    const { id, conditions, rules, ...policy } = livePolicy.parse(read.value);
    policies.push({
      id,
      policy: {
        ...policy,
        ...(conditions === null || conditions === undefined ? {} : { conditions }),
        rules: rules ?? [],
      },
    });
  }
  return { available: true, policies };
}

// Existing stored conditions may use empty arrays, which GitHub rejects on a new write.
export function describeActionPolicy(policy: StoredPolicy): StoredPolicy {
  const workflow = policy.conditions?.['workflow_path'];
  if (
    typeof workflow !== 'object' ||
    workflow === null ||
    !('include' in workflow) ||
    !('exclude' in workflow) ||
    !Array.isArray(workflow.include) ||
    !Array.isArray(workflow.exclude) ||
    workflow.include.length + workflow.exclude.length > 0
  ) {
    return policy;
  }
  return { ...policy, conditions: { ...policy.conditions, workflow_path: { include: ['~ALL'], exclude: [] } } };
}

function writePolicy(entry: ActionPolicy, current?: StoredPolicy): StoredPolicy {
  const conditions =
    entry.conditions === undefined ? current?.conditions : overlay(entry.conditions, current?.conditions);
  const rules =
    entry.rules?.map((rule) => {
      const previous = current?.rules.find((item) => item.type === rule.type)?.parameters;
      const parameters = rule.parameters === undefined ? previous : overlay(rule.parameters, previous);
      return {
        type: rule.type,
        ...(parameters === undefined ? {} : { parameters: z.record(z.string(), z.unknown()).parse(parameters) }),
      };
    }) ??
    current?.rules ??
    [];
  for (const rule of rules) {
    const required = { restrict_actions_actors: 'allowed_actors', restrict_action_events: 'allowed_events' }[rule.type];
    if (required !== undefined && rule.parameters?.[required] === undefined) {
      throw new Error(`Actions policy "${entry.name}": ${rule.type} needs ${required}`);
    }
  }
  return describeActionPolicy({
    name: entry.name,
    enforcement: entry.enforcement ?? current?.enforcement ?? 'active',
    ...(conditions === undefined ? {} : { conditions: z.record(z.string(), z.unknown()).parse(conditions) }),
    rules,
  });
}

export function planActionPolicies(
  desired: readonly ActionPolicyEntry[],
  live: LivePolicies,
  repo: RepoRef,
): SectionPlan {
  if (!live.available) {
    return { changes: [], warnings: [{ section: 'actions_policies', ...warningForUnavailable(live) }] };
  }
  const byName = new Map(live.policies.map((item) => [item.policy.name, item]));
  if (byName.size !== live.policies.length) {
    throw new Error('Cannot manage Actions policies with duplicate names; their targets are ambiguous');
  }
  const base = `${repoPath(repo)}/actions/policies`;
  const creates: Change[] = [];
  const updates: Change[] = [];
  const deletes: Change[] = [];
  for (const entry of desired) {
    const current = byName.get(entry.name);
    if (entry.absent === true) {
      if (current !== undefined) {
        deletes.push({
          section: 'actions_policies',
          action: 'delete',
          target: entry.name,
          entry: { name: entry.name },
          fields: [],
          request: { method: 'DELETE', path: `${base}/${current.id}` },
        });
      }
    } else if (current === undefined || !matches(entry, current.policy)) {
      const body = writePolicy(entry, current?.policy);
      const change: Change = {
        section: 'actions_policies',
        action: current === undefined ? 'create' : 'update',
        target: entry.name,
        entry: { name: entry.name },
        fields: bodyChanges(body, current?.policy),
        request: {
          method: current === undefined ? 'POST' : 'PUT',
          path: current === undefined ? base : `${base}/${current.id}`,
          body,
        },
      };
      (current === undefined ? creates : updates).push(change);
    }
  }
  return { changes: [...creates, ...updates, ...deletes], warnings: [] };
}
