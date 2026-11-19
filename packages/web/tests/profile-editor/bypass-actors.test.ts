import { expect, test } from 'vitest';

import {
  bypassActorKey,
  bypassActorNote,
  bypassListProblem,
  deployKeysBypassActor,
  describeBypassActor,
  GitHubAppLookup,
  organizationAdminBypassActor,
  parseBypassActorId,
  withBypassActorAdded,
  withBypassActorsRemoved,
  withBypassListManaged,
  withBypassMode,
} from '../../src/app/profile-editor/bypass-actors.js';

const admin = { actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'exempt' };
const dependabot = { actor_id: 29_110, actor_type: 'Integration', bypass_mode: 'always' };
const saved = { name: 'Main', target: 'branch', bypass_actors: [admin, dependabot] };

test('an actor is added once, in the always mode, after the ones listed', () => {
  const added = withBypassActorAdded(saved, deployKeysBypassActor);
  expect(added['bypass_actors']).toEqual([
    admin,
    dependabot,
    { actor_id: null, actor_type: 'DeployKey', bypass_mode: 'always' },
  ]);
  expect(withBypassActorAdded(added, deployKeysBypassActor)).toBe(added);
  // GitHub reads an organization admin back with ID 1, whatever was sent, so one already listed with it matches.
  const withOwners = withBypassActorAdded(saved, organizationAdminBypassActor);
  expect(withBypassActorAdded(withOwners, { actor_type: 'OrganizationAdmin', actor_id: null })).toBe(withOwners);
});

test('removing every actor still manages the list, so nobody bypasses', () => {
  const keys = new Set([bypassActorKey(admin), bypassActorKey(dependabot)]);
  expect(withBypassActorsRemoved(saved, keys)['bypass_actors']).toEqual([]);
  expect(withBypassActorsRemoved(saved, new Set([bypassActorKey(admin)]))['bypass_actors']).toEqual([dependabot]);
});

test('a mode set on several actors skips the ones GitHub does not allow it for', () => {
  const listed = withBypassActorAdded(saved, deployKeysBypassActor);
  const every = new Set(['RepositoryRole:5', 'Integration:29110', 'DeployKey']);
  expect(withBypassMode(listed, every, 'pull_request')['bypass_actors']).toEqual([
    { ...admin, bypass_mode: 'pull_request' },
    { ...dependabot, bypass_mode: 'pull_request' },
    { actor_id: null, actor_type: 'DeployKey', bypass_mode: 'always' },
  ]);
  const tags = { ...listed, target: 'tag' };
  expect(withBypassMode(tags, every, 'pull_request')).toEqual(tags);
  expect(withBypassMode(tags, every, 'always')['bypass_actors']).toEqual([
    { ...admin, bypass_mode: 'always' },
    dependabot,
    { actor_id: null, actor_type: 'DeployKey', bypass_mode: 'always' },
  ]);
});

test('a pull request mode GitHub would refuse blocks the save', () => {
  expect(bypassListProblem(withBypassMode(saved, new Set(['RepositoryRole:5']), 'pull_request'))).toBeUndefined();
  const onPullRequests = withBypassMode(saved, new Set(['RepositoryRole:5']), 'pull_request');
  expect(bypassListProblem({ ...onPullRequests, target: 'tag' })).toBeDefined();
  expect(
    bypassListProblem({
      bypass_actors: [{ actor_id: null, actor_type: 'DeployKey', bypass_mode: 'pull_request' }],
    }),
  ).toBeDefined();
  expect(bypassListProblem({ ...onPullRequests, target: undefined })).toBeUndefined();
});

test('a list that names someone twice blocks the save, even with two modes', () => {
  expect(bypassListProblem({ bypass_actors: [admin, { ...admin, bypass_mode: 'always' }] })).toBe(
    'The bypass list names someone twice. Remove one of them.',
  );
  expect(
    bypassListProblem({
      bypass_actors: [
        { actor_id: 1, actor_type: 'OrganizationAdmin', bypass_mode: 'always' },
        { actor_id: null, actor_type: 'OrganizationAdmin', bypass_mode: 'exempt' },
      ],
    }),
  ).toBeDefined();
  expect(bypassListProblem(saved)).toBeUndefined();
});

test('pull requests only, with the target left to each repository, says where it works', () => {
  const onPullRequests = { ...admin, bypass_mode: 'pull_request' };
  expect(bypassActorNote(onPullRequests, undefined)).toBe(
    'Works only where the repository’s ruleset targets branches.',
  );
  expect(bypassActorNote(onPullRequests, 'branch')).toBeUndefined();
  expect(bypassActorNote(admin, undefined)).toBeUndefined();
});

test('leaving the list to GitHub and managing it again gives the saved list back', () => {
  const left = withBypassListManaged(saved, false, saved);
  expect(left).toEqual({ name: 'Main', target: 'branch' });
  expect(withBypassListManaged(left, true, saved)).toEqual(saved);
  expect(withBypassListManaged({ name: 'New' }, true, undefined)).toEqual({ name: 'New', bypass_actors: [] });
});

test('actors are named for people, with an app found earlier named as it is on GitHub', () => {
  const names = new Map([[29_110, 'Dependabot']]);
  expect(describeBypassActor(admin, names).name).toBe('Repository admin');
  expect(describeBypassActor({ actor_id: 81, actor_type: 'RepositoryRole' }, names).name).toBe('Custom role 81');
  expect(describeBypassActor(dependabot, names).name).toBe('Dependabot');
  expect(describeBypassActor(dependabot, new Map()).name).toBe('App 29110');
});

test('an ID is a positive whole number', () => {
  expect(parseBypassActorId(' 4410 ')).toBe(4410);
  expect(parseBypassActorId('0')).toBeUndefined();
  expect(parseBypassActorId('12a')).toBeUndefined();
  expect(parseBypassActorId('99999999999999999')).toBeUndefined();
});

function held(): {
  readonly find: (slug: string) => Promise<{ id: number; slug: string; name: string } | undefined>;
  readonly answer: (slug: string, app: { id: number; slug: string; name: string } | undefined) => void;
} {
  const waiting = new Map<string, (app: { id: number; slug: string; name: string } | undefined) => void>();
  return {
    find: (slug) =>
      new Promise((resolve) => {
        waiting.set(slug, resolve);
      }),
    answer: (slug, app) => {
      waiting.get(slug)?.(app);
    },
  };
}

test('an older lookup that answers after a newer one changes nothing', async () => {
  const github = held();
  const lookup = new GitHubAppLookup(github.find);
  const first = lookup.find('renovate');
  const second = lookup.find('dependabot');
  expect(lookup.state.value).toEqual({ kind: 'finding' });

  github.answer('dependabot', { id: 29_110, slug: 'dependabot', name: 'Dependabot' });
  await second;
  github.answer('renovate', { id: 2740, slug: 'renovate', name: 'Renovate' });
  await first;
  expect(lookup.state.value).toEqual({ kind: 'found', app: { id: 29_110, slug: 'dependabot', name: 'Dependabot' } });
  expect([...lookup.namesById.value]).toEqual([[29_110, 'Dependabot']]);
});

test('a lookup answers that an app is missing, or why it failed, and a reset leaves it behind', async () => {
  const github = held();
  const lookup = new GitHubAppLookup(github.find);
  const missing = lookup.find('nothing');
  github.answer('nothing', undefined);
  await missing;
  expect(lookup.state.value).toEqual({ kind: 'missing', slug: 'nothing' });

  const failing = new GitHubAppLookup(() => Promise.reject(new Error('GitHub is down')));
  await failing.find('dependabot');
  expect(failing.state.value).toEqual({ kind: 'failed', message: 'GitHub is down' });

  const late = lookup.find('renovate');
  lookup.reset();
  github.answer('renovate', { id: 2740, slug: 'renovate', name: 'Renovate' });
  await late;
  expect(lookup.state.value).toEqual({ kind: 'idle' });
});
