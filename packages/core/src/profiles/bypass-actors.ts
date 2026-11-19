import { type Document, isMap, isScalar, isSeq } from 'yaml';

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

/** Returns whether it changed any ID. */
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

function hasIgnoredBypassActorId(ruleset: NonNullable<Profile['rulesets']>[number]): boolean {
  return (
    'bypass_actors' in ruleset &&
    (ruleset.bypass_actors ?? []).some(
      (actor) => bypassActorIdGitHubKeeps(actor.actor_type, actor.actor_id) !== actor.actor_id,
    )
  );
}

/** The rulesets whose ignored bypass actor IDs a save sets to the ones GitHub keeps, for a preview to explain the change. */
export function rulesetsWithBypassActorIdsSettledBySave(before: Profile, after: Profile): string[] {
  const settledAfter = new Set((after.rulesets ?? []).filter(hasIgnoredBypassActorId).map((ruleset) => ruleset.name));
  return (before.rulesets ?? [])
    .filter((ruleset) => hasIgnoredBypassActorId(ruleset) && !settledAfter.has(ruleset.name))
    .map((ruleset) => ruleset.name);
}
