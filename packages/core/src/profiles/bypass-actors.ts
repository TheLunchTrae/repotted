import { type Document, isMap, isScalar, isSeq } from 'yaml';

import { isDeepEqual } from '../shared/equal.js';
import type { Profile } from './schema.js';

const actorTypesGitHubReadsBackAsOne: ReadonlySet<string> = new Set(['OrganizationAdmin', 'EnterpriseOwner']);

/**
 * GitHub ignores the ID of an organization or enterprise owner and reads one
 * back as 1, and a deploy key has none. Settling both sides on these keeps a
 * hand-written ID from showing as a change GitHub would never make.
 */
export function bypassActorIdGitHubKeeps(actorType: string, actorId: number | null): number | null {
  if (actorType === 'DeployKey') {
    return null;
  }
  return actorTypesGitHubReadsBackAsOne.has(actorType) ? 1 : actorId;
}

export function settleIgnoredBypassActorIds(document: Document): boolean {
  const rulesets = document.get('rulesets', true);
  if (!isSeq(rulesets)) {
    return false;
  }
  let settledAny = false;
  for (const ruleset of rulesets.items) {
    const actors = isMap(ruleset) ? ruleset.get('bypass_actors', true) : undefined;
    if (!isSeq(actors)) {
      continue;
    }
    for (const actor of actors.items) {
      if (!isMap(actor)) {
        continue;
      }
      const actorType = actor.get('actor_type');
      const actorIdNode = actor.get('actor_id', true);
      if (typeof actorType !== 'string' || !isScalar(actorIdNode)) {
        continue;
      }
      const actorId = actorIdNode.value;
      if (!(actorId === null || typeof actorId === 'number')) {
        continue;
      }
      const kept = bypassActorIdGitHubKeeps(actorType, actorId);
      if (kept !== actorId) {
        actorIdNode.value = kept;
        delete actorIdNode.tag;
        delete actorIdNode.format;
        settledAny = true;
      }
    }
  }
  return settledAny;
}

type ProfileRuleset = NonNullable<Profile['rulesets']>[number];
type BypassActor = NonNullable<Extract<ProfileRuleset, { bypass_actors?: unknown }>['bypass_actors']>[number];

function bypassActorsOf(ruleset: ProfileRuleset | undefined): readonly BypassActor[] | undefined {
  return ruleset !== undefined && 'bypass_actors' in ruleset ? ruleset.bypass_actors : undefined;
}

function withIdsGitHubKeeps(actors: readonly BypassActor[]): BypassActor[] {
  return actors.map((actor) => ({ ...actor, actor_id: bypassActorIdGitHubKeeps(actor.actor_type, actor.actor_id) }));
}

/** The rulesets whose ignored bypass actor IDs a save sets to the ones GitHub keeps, for a preview to explain the change. */
export function rulesetsWithBypassActorIdsSettledBySave(before: Profile, after: Profile): string[] {
  const beforeByName = new Map((before.rulesets ?? []).map((ruleset) => [ruleset.name, ruleset]));
  return (after.rulesets ?? [])
    .filter((ruleset) => {
      const actorsBefore = bypassActorsOf(beforeByName.get(ruleset.name));
      const actorsAfter = bypassActorsOf(ruleset);
      if (actorsBefore === undefined || actorsAfter === undefined) {
        return false;
      }
      const settledBefore = withIdsGitHubKeeps(actorsBefore);
      return !isDeepEqual(settledBefore, actorsBefore) && isDeepEqual(settledBefore, actorsAfter);
    })
    .map((ruleset) => ruleset.name);
}
