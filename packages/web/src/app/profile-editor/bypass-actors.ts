import { computed, signal } from '@preact/signals';
import type { FoundGitHubApp } from '@repotted/core';

import { type Entry, isEntry, withKey } from './entry-forms.js';

export type BypassMode = 'always' | 'pull_request' | 'exempt';

export const bypassModes: readonly (readonly [BypassMode, string])[] = [
  ['always', 'Always'],
  ['pull_request', 'Pull requests only'],
  ['exempt', 'Exempt'],
];

// GitHub's IDs for the built-in repository roles that can bypass a ruleset.
const repositoryRoleNames: ReadonlyMap<number, string> = new Map([
  [5, 'Repository admin'],
  [2, 'Maintain'],
  [4, 'Write'],
]);

export const builtInRepositoryRoleIds: readonly number[] = [...repositoryRoleNames.keys()];

export interface NewBypassActor {
  readonly actor_type: string;
  readonly actor_id: number | null;
}

// GitHub ignores the ID of an organization or enterprise owner and reads one back as 1, and a deploy key has none.
export const organizationAdminBypassActor: NewBypassActor = { actor_type: 'OrganizationAdmin', actor_id: 1 };
export const deployKeysBypassActor: NewBypassActor = { actor_type: 'DeployKey', actor_id: null };

const actorTypesWithoutIds: ReadonlySet<string> = new Set(['OrganizationAdmin', 'EnterpriseOwner', 'DeployKey']);

export function bypassActors(entry: Entry): readonly Entry[] {
  return Array.isArray(entry['bypass_actors']) ? entry['bypass_actors'].filter(isEntry) : [];
}

export function bypassActorKey(actor: Entry | NewBypassActor): string {
  const type = String(actor.actor_type);
  return actorTypesWithoutIds.has(type) ? type : `${type}:${String(actor.actor_id)}`;
}

export function hasBypassActor(entry: Entry, actor: NewBypassActor): boolean {
  const key = bypassActorKey(actor);
  return bypassActors(entry).some((listed) => bypassActorKey(listed) === key);
}

export interface BypassActorDescription {
  readonly name: string;
  readonly kind: string;
}

export function describeBypassActor(actor: Entry, appNames: ReadonlyMap<number, string>): BypassActorDescription {
  const id = typeof actor['actor_id'] === 'number' ? actor['actor_id'] : undefined;
  switch (actor['actor_type']) {
    case 'RepositoryRole': {
      const role = id === undefined ? undefined : repositoryRoleNames.get(id);
      return role === undefined
        ? { name: `Custom role ${String(id)}`, kind: 'Custom repository role, by ID' }
        : { name: role, kind: 'Repository role' };
    }
    case 'OrganizationAdmin':
      return { name: 'Organization admin', kind: 'Organization owners' };
    case 'EnterpriseOwner':
      return { name: 'Enterprise owner', kind: 'Enterprise owners' };
    case 'DeployKey':
      return { name: 'Deploy keys', kind: 'Every deploy key on the repository' };
    case 'Integration':
      return {
        name: (id === undefined ? undefined : appNames.get(id)) ?? `App ${String(id)}`,
        kind: `GitHub App, ID ${String(id)}`,
      };
    case 'Team':
      return { name: `Team ${String(id)}`, kind: 'Team, by ID' };
    default:
      return { name: String(actor['actor_type']), kind: id === undefined ? '' : `ID ${id}` };
  }
}

/**
 * GitHub offers the pull request mode only in branch rulesets, and never to
 * deploy keys. A ruleset that leaves its target to each repository can be a
 * branch ruleset, so it gets the mode.
 */
export function bypassModeFits(actor: Entry | NewBypassActor, mode: BypassMode, rulesetTarget: unknown): boolean {
  return mode !== 'pull_request' || (actor.actor_type !== 'DeployKey' && (rulesetTarget ?? 'branch') === 'branch');
}

export function withBypassActorAdded(entry: Entry, actor: NewBypassActor): Entry {
  if (hasBypassActor(entry, actor)) {
    return entry;
  }
  return withKey(entry, 'bypass_actors', [
    ...bypassActors(entry),
    { actor_id: actor.actor_id, actor_type: actor.actor_type, bypass_mode: 'always' },
  ]);
}

/** Removing every actor leaves an empty list, which still manages it: nobody bypasses. */
export function withBypassActorsRemoved(entry: Entry, keys: ReadonlySet<string>): Entry {
  return withKey(
    entry,
    'bypass_actors',
    bypassActors(entry).filter((actor) => !keys.has(bypassActorKey(actor))),
  );
}

/** A row's own edits go by its place in the list, since a hand-written list can name an actor twice. */
export function withBypassActorAtIndexRemoved(entry: Entry, index: number): Entry {
  return withKey(
    entry,
    'bypass_actors',
    bypassActors(entry).filter((_actor, at) => at !== index),
  );
}

export function withBypassModeAtIndex(entry: Entry, index: number, mode: BypassMode): Entry {
  return withKey(
    entry,
    'bypass_actors',
    bypassActors(entry).map((actor, at) =>
      at === index && bypassModeFits(actor, mode, entry['target']) ? { ...actor, bypass_mode: mode } : actor,
    ),
  );
}

/** An actor the mode doesn't fit keeps the mode it has. */
export function withBypassMode(entry: Entry, keys: ReadonlySet<string>, mode: BypassMode): Entry {
  return withKey(
    entry,
    'bypass_actors',
    bypassActors(entry).map((actor) =>
      keys.has(bypassActorKey(actor)) && bypassModeFits(actor, mode, entry['target'])
        ? { ...actor, bypass_mode: mode }
        : actor,
    ),
  );
}

/** Managing it again starts from the list the profile's file has, so leaving it and coming back is no change. */
export function withBypassListManaged(entry: Entry, managed: boolean, saved: Entry | undefined): Entry {
  if (!managed) {
    return withKey(entry, 'bypass_actors', undefined);
  }
  return entry['bypass_actors'] === undefined ? withKey(entry, 'bypass_actors', saved?.['bypass_actors'] ?? []) : entry;
}

export function bypassActorProblem(actor: Entry, rulesetTarget: unknown): string | undefined {
  if (actor['bypass_mode'] !== 'pull_request' || bypassModeFits(actor, 'pull_request', rulesetTarget)) {
    return undefined;
  }
  return actor['actor_type'] === 'DeployKey'
    ? 'Deploy keys can’t bypass on pull requests only. Choose Always or Exempt.'
    : 'Pull requests only works in a branch ruleset. Choose Always or Exempt.';
}

/** A ruleset that leaves its target to each repository is a branch ruleset on some and not on others. */
export function bypassActorNote(actor: Entry, rulesetTarget: unknown): string | undefined {
  return actor['bypass_mode'] === 'pull_request' && rulesetTarget === undefined
    ? 'Works only where the repository’s ruleset targets branches.'
    : undefined;
}

export function bypassListProblem(entry: Entry): string | undefined {
  const target = entry['target'];
  const actors = bypassActors(entry);
  if (actors.some((actor) => bypassActorProblem(actor, target) !== undefined)) {
    return 'A bypass is set to Pull requests only where GitHub doesn’t allow it.';
  }
  const keys = actors.map((actor) => bypassActorKey(actor));
  return new Set(keys).size === keys.length ? undefined : 'The bypass list names someone twice. Remove one of them.';
}

export function parseBypassActorId(typed: string): number | undefined {
  const digits = typed.trim();
  return /^[1-9]\d{0,15}$/u.test(digits) && Number.isSafeInteger(Number(digits)) ? Number(digits) : undefined;
}

export type GitHubAppLookupState =
  | { readonly kind: 'idle' | 'finding' }
  | { readonly kind: 'found'; readonly app: FoundGitHubApp }
  | { readonly kind: 'missing'; readonly slug: string }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * One lookup counts at a time: a newer one, or a reset, leaves the one before
 * it behind, so an older answer never replaces a newer one. The names of the
 * apps it finds stay, so a bypass list can name them in place of their IDs.
 */
export class GitHubAppLookup {
  readonly #find: (slug: string) => Promise<FoundGitHubApp | undefined>;
  readonly #state = signal<GitHubAppLookupState>({ kind: 'idle' });
  readonly #namesById = signal<ReadonlyMap<number, string>>(new Map());
  #latestLookupTurn = 0;

  constructor(find: (slug: string) => Promise<FoundGitHubApp | undefined>) {
    this.#find = find;
  }

  readonly state = computed(() => this.#state.value);

  readonly namesById = computed(() => this.#namesById.value);

  async find(slug: string): Promise<void> {
    const turn = (this.#latestLookupTurn += 1);
    this.#state.value = { kind: 'finding' };
    try {
      const app = await this.#find(slug);
      if (turn !== this.#latestLookupTurn) {
        return;
      }
      if (app === undefined) {
        this.#state.value = { kind: 'missing', slug };
        return;
      }
      this.#namesById.value = new Map([...this.#namesById.value, [app.id, app.name]]);
      this.#state.value = { kind: 'found', app };
    } catch (error) {
      if (turn === this.#latestLookupTurn) {
        this.#state.value = { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
      }
    }
  }

  reset(): void {
    this.#latestLookupTurn += 1;
    this.#state.value = { kind: 'idle' };
  }
}
