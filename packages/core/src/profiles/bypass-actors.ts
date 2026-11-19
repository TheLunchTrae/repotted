import { type Document, isMap, isSeq } from 'yaml';

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

export function settleIgnoredBypassActorIds(document: Document): void {
  const rulesets = document.get('rulesets', true);
  if (!isSeq(rulesets)) {
    return;
  }
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
      const actorId = actor.get('actor_id');
      if (typeof actorType !== 'string' || !(actorId === null || typeof actorId === 'number')) {
        continue;
      }
      const kept = bypassActorIdGitHubKeeps(actorType, actorId);
      if (kept !== actorId) {
        actor.set('actor_id', kept);
      }
    }
  }
}
