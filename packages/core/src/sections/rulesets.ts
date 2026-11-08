import { isDeepStrictEqual } from 'node:util';

import { z } from 'zod';

import type { Change, SectionPlan } from '../change.js';
import { type GitHub, GitHubError, repoPath, type RepoRef } from '../github.js';
import { type FieldChange, matches, overlay } from '../match.js';
import type { Ruleset, RulesetEntry } from '../schema.js';

const summary = z.object({ id: z.number().int(), source_type: z.string().optional() });

type Rule = NonNullable<Ruleset['rules']>[number];

/** A ruleset with every key a write sends, as GitHub stores it. */
export interface StoredRuleset {
  readonly name: string;
  readonly target: 'branch' | 'tag' | 'push';
  readonly enforcement: 'active' | 'evaluate' | 'disabled';
  readonly bypass_actors: {
    actor_id: number | null;
    actor_type: string;
    bypass_mode: 'always' | 'pull_request' | 'exempt';
  }[];
  readonly conditions?: Record<string, unknown>;
  readonly rules: Rule[];
}

// Looser than the profile schema: GitHub omits actor_id for some actor types
// and documents `always` as the default bypass mode.
const liveRuleset = z.object({
  id: z.number().int(),
  name: z.string(),
  target: z.enum(['branch', 'tag', 'push']),
  enforcement: z.enum(['active', 'evaluate', 'disabled']),
  bypass_actors: z
    .array(
      z.object({
        actor_id: z.number().int().nullish(),
        actor_type: z.string(),
        bypass_mode: z.enum(['always', 'pull_request', 'exempt']).optional(),
      }),
    )
    .nullish(),
  conditions: z.record(z.string(), z.unknown()).nullish(),
  rules: z.array(z.object({ type: z.string(), parameters: z.record(z.string(), z.unknown()).optional() })).nullish(),
});

export interface LiveRuleset {
  readonly id: number;
  readonly ruleset: StoredRuleset;
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
      bypass_actors: (live.bypass_actors ?? []).map((actor) => ({
        actor_id: actor.actor_id ?? null,
        actor_type: actor.actor_type,
        bypass_mode: actor.bypass_mode ?? 'always',
      })),
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
  return entry.absent === true;
}

// Parameters the rulesets API requires but gives a documented default. A new
// rule gets them unless the profile sets them, and the plan shows them.
const ruleDefaults: Record<string, Record<string, unknown>> = {
  pull_request: {
    dismiss_stale_reviews_on_push: false,
    require_code_owner_review: false,
    require_last_push_approval: false,
    required_approving_review_count: 0,
    required_review_thread_resolution: false,
  },
  required_status_checks: { strict_required_status_checks_policy: false },
  update: { update_allows_fetch_and_merge: false },
};

/**
 * The rules to write. Each desired rule takes the live rule of the same type,
 * if any, and lays its parameters over that rule's, so parameters the profile
 * leaves out keep their values. Live rules the profile does not list go.
 */
function writeRules(desired: readonly Rule[], live: readonly Rule[]): Rule[] {
  const unused = [...live];
  return desired.map((rule) => {
    const index = unused.findIndex((candidate) => candidate.type === rule.type);
    const current = index === -1 ? undefined : unused.splice(index, 1)[0];
    const base = current === undefined ? ruleDefaults[rule.type] : current.parameters;
    const parameters = rule.parameters === undefined ? base : overlay(rule.parameters, base ?? {});
    return parameters === undefined
      ? { type: rule.type }
      : { type: rule.type, parameters: z.record(z.string(), z.unknown()).parse(parameters) };
  });
}

function writeRuleset(entry: Ruleset, current: StoredRuleset | undefined): StoredRuleset {
  const conditions =
    entry.conditions === undefined ? current?.conditions : overlay(entry.conditions, current?.conditions);
  return {
    name: entry.name,
    target: entry.target ?? current?.target ?? 'branch',
    enforcement: entry.enforcement ?? current?.enforcement ?? 'active',
    bypass_actors: entry.bypass_actors ?? current?.bypass_actors ?? [],
    ...(conditions === undefined ? {} : { conditions: z.record(z.string(), z.unknown()).parse(conditions) }),
    rules: entry.rules === undefined ? (current?.rules ?? []) : writeRules(entry.rules, current?.rules ?? []),
  };
}

/** Every key the write changes, so a reviewer sees the whole effect. */
function bodyChanges(body: StoredRuleset, current: StoredRuleset | undefined): FieldChange[] {
  const before = new Map<string, unknown>(Object.entries(current ?? {}));
  return Object.entries(body)
    .filter(([field, to]: [string, unknown]) => !isDeepStrictEqual(to, before.get(field)))
    .map(([field, to]: [string, unknown]) => ({ field, from: before.get(field), to }));
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
      const body = writeRuleset(entry, undefined);
      creates.push({
        section: 'rulesets',
        action: 'create',
        target: entry.name,
        fields: bodyChanges(body, undefined),
        request: { method: 'POST', path: base, body },
      });
    } else if (!matches(entry, current.ruleset)) {
      const body = writeRuleset(entry, current.ruleset);
      updates.push({
        section: 'rulesets',
        action: 'update',
        target: entry.name,
        fields: bodyChanges(body, current.ruleset),
        request: { method: 'PUT', path: `${base}/${current.id}`, body },
      });
    }
  }

  return { changes: [...creates, ...updates, ...deletes], warnings: [] };
}
