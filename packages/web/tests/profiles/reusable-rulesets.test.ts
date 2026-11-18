import { resolveProfile } from '@repotted/core';
import { afterEach, expect, test } from 'vitest';

import { FakeGitHub } from '../../../core/tests/support/fake-github.js';
import type { Preferences } from '../../src/app/preferences/preferences.js';
import { Profiles } from '../../src/app/profiles/profiles.js';
import { readFile, rm } from '../../src/engine/files.js';

afterEach(async () => {
  await rm('/', { recursive: true });
});

function memory(): Preferences {
  const kept = new Map<string, unknown>();
  return {
    read: (key) => kept.get(key),
    write: (key, value) => {
      kept.set(key, value);
    },
  };
}

test('creates, references, and duplicates a ruleset without copying it into a consumer', async () => {
  const github = new FakeGitHub();
  const profiles = new Profiles(github, memory(), () => undefined);
  await profiles.refresh();
  expect(
    await profiles.create({
      name: 'main',
      folder: '',
      definitionKind: 'ruleset',
      targetName: 'Main',
      start: { kind: 'empty' },
      ownerType: undefined,
    }),
  ).toBeUndefined();
  const shared = profiles.listings.value.find((listing) => listing.name === 'main');
  expect(shared?.kind).toBe('ruleset');
  if (shared === undefined) {
    throw new Error('Missing created ruleset');
  }
  expect(
    await profiles.create({ name: 'service', folder: '', start: { kind: 'empty' }, ownerType: undefined }),
  ).toBeUndefined();
  const file = '/profiles/browser/service.yaml';
  await profiles.editor.value!.setReferences({ rulesets: ['main.yaml'] });
  await profiles.save();
  expect(profiles.editor.value!.saveError.value).toBeUndefined();
  expect((await resolveProfile(file)).sources.rulesets['Main']).toBe(shared.file);
  expect(await readFile(file, 'utf8')).not.toContain('name: Main');
  expect(
    await profiles.create({
      name: 'release',
      folder: '',
      start: { kind: 'duplicate', source: shared },
      ownerType: undefined,
    }),
  ).toBeUndefined();
  expect((await resolveProfile('/profiles/browser/release.yaml')).profile.rulesets).toEqual([{ name: 'Main' }]);
  expect(github.writes).toEqual([]);
});

test('captures only the selected ruleset and leaves a missing target unsaved', async () => {
  const github = new FakeGitHub({
    rulesets: [
      {
        id: 1,
        name: 'Main',
        target: 'branch',
        enforcement: 'active',
        bypass_actors: [],
        rules: [{ type: 'deletion' }],
      },
      { id: 2, name: 'Release', target: 'tag', enforcement: 'evaluate', bypass_actors: [], rules: [] },
    ],
  });
  const profiles = new Profiles(github, memory(), () => undefined);
  await profiles.refresh();
  const capture = {
    name: 'release',
    folder: '',
    definitionKind: 'ruleset' as const,
    targetName: 'Release',
    start: { kind: 'repository' as const, repository: 'lunch/app' },
    ownerType: undefined,
  };
  expect(await profiles.create(capture)).toBeUndefined();
  expect((await resolveProfile('/profiles/browser/release.yaml')).profile).toEqual({
    owner_type: 'organization',
    rulesets: [{ name: 'Release', target: 'tag', enforcement: 'evaluate', bypass_actors: [], rules: [] }],
  });
  expect(await profiles.create({ ...capture, name: 'missing', targetName: 'Missing' })).toContain('Missing');
  expect(profiles.listings.value.some((listing) => listing.name === 'missing')).toBe(false);
  expect(github.writes).toEqual([]);
});
