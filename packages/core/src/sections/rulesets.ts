import { z } from 'zod';

import type { Change, SectionPlan } from '../change.js';
import { type GitHub, GitHubError, repoPath, type RepoRef } from '../github.js';
import { fieldChanges, matches } from '../match.js';
import { bypassActor, ruleset, type Ruleset, type RulesetEntry } from '../schema.js';

const summary = z.object({ id: z.number().int(), source_type: z.string().optional() });

const liveRuleset = z.object({
  id: z.number().int(),
  name: z.string(),
  target: ruleset.shape.target,
  enforcement: ruleset.shape.enforcement,
  bypass_actors: z.array(bypassActor.strip()).nullish(),
  conditions: z.record(z.string(), z.unknown()).nullish(),
  rules: z.array(z.object({ type: z.string(), parameters: z.record(z.string(), z.unknown()).optional() })).nullish(),
});

export interface LiveRuleset {
  readonly id: number;
  readonly ruleset: Ruleset;
}

export type LiveRulesets =
  | { readonly available: true; readonly rulesets: readonly LiveRuleset[] }
  | { readonly available: false; readonly reason: string };

const pageSize = 100;

function normalize(data: unknown): LiveRuleset {
  const live = liveRuleset.parse(data);
  const conditions = live.conditions ?? undefined;
  return {
    id: live.id,
    ruleset: {
      name: live.name,
      target: live.target,
      enforcement: live.enforcement,
      bypass_actors: live.bypass_actors ?? [],
      ...(conditions === undefined ? {} : { conditions }),
      rules: (live.rules ?? []).map((rule) => ({
        type: rule.type,
        ...(rule.parameters === undefined ? {} : { parameters: rule.parameters }),
      })),
    },
  };
}

/** Reads the repository's own rulesets, not ones it inherits from an organization. */
export async function readRulesets(github: GitHub, repo: RepoRef): Promise<LiveRulesets> {
  const base = `${repoPath(repo)}/rulesets`;
  const ids: number[] = [];
  try {
    for (let page = 1; ; page += 1) {
      const listed = z
        .array(summary)
        .parse(await github.request('GET', `${base}?includes_parents=false&per_page=${pageSize}&page=${page}`));
      ids.push(...listed.filter((item) => (item.source_type ?? 'Repository') === 'Repository').map((item) => item.id));
      if (listed.length < pageSize) {
        break;
      }
    }
  } catch (error) {
    // Private repositories on free plans have no rulesets; GitHub answers 403 with an upgrade prompt.
    if (error instanceof GitHubError && error.status === 403 && /upgrade/iu.test(error.message)) {
      return { available: false, reason: 'this repository’s plan does not support rulesets' };
    }
    throw error;
  }
  const rulesets: LiveRuleset[] = [];
  for (const id of ids) {
    rulesets.push(normalize(await github.request('GET', `${base}/${id}`)));
  }
  return { available: true, rulesets };
}

function isAbsent(entry: RulesetEntry): entry is Extract<RulesetEntry, { absent: true }> {
  return 'absent' in entry;
}

/**
 * Creates and updates come before deletes, so a profile that replaces one
 * ruleset with another never leaves the branch unprotected in between.
 */
export function planRulesets(desired: readonly RulesetEntry[], live: LiveRulesets, repo: RepoRef): SectionPlan {
  if (!live.available) {
    return { changes: [], warnings: [`Skipped rulesets: ${live.reason}`] };
  }
  const base = `${repoPath(repo)}/rulesets`;
  const byName = new Map(live.rulesets.map((entry) => [entry.ruleset.name, entry]));
  const creates: Change[] = [];
  const updates: Change[] = [];
  const deletes: Change[] = [];

  for (const entry of desired) {
    const current = byName.get(entry.name);
    if (isAbsent(entry)) {
      if (current !== undefined) {
        deletes.push({
          section: 'rulesets',
          action: 'delete',
          target: entry.name,
          fields: [],
          request: { method: 'DELETE', path: `${base}/${current.id}` },
        });
      }
    } else if (current === undefined) {
      creates.push({
        section: 'rulesets',
        action: 'create',
        target: entry.name,
        fields: [],
        request: { method: 'POST', path: base, body: entry },
      });
    } else if (!matches(entry, current.ruleset)) {
      updates.push({
        section: 'rulesets',
        action: 'update',
        target: entry.name,
        fields: fieldChanges(entry, current.ruleset),
        request: { method: 'PUT', path: `${base}/${current.id}`, body: entry },
      });
    }
  }

  return { changes: [...creates, ...updates, ...deletes], warnings: [] };
}
