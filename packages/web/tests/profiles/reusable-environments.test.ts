import { resolveProfile } from '@repotted/core';
import { afterEach, expect, test } from 'vitest';
import { parse } from 'yaml';

import { FakeGitHub } from '../../../core/tests/support/fake-github.js';
import type { Preferences } from '../../src/app/preferences/preferences.js';
import { Profiles } from '../../src/app/profiles/profiles.js';
import { readFile, rm, writeFile } from '../../src/engine/files.js';

afterEach(async () => {
  await rm('/', { recursive: true });
});

function preferences(): Preferences {
  const saved: Record<string, unknown> = {};
  return {
    read: (key) => saved[key],
    write: (key, value) => {
      saved[key] = value;
    },
  };
}

test('creates and duplicates environment definitions and blocks deleting one that a profile references', async () => {
  const github = new FakeGitHub();
  const profiles = new Profiles(github, preferences(), () => undefined);
  await profiles.refresh();
  expect(
    await profiles.create({
      name: 'production',
      folder: '',
      definitionKind: 'environment',
      targetName: 'Production',
      start: { kind: 'empty' },
      ownerType: 'organization',
    }),
  ).toBeUndefined();
  const definition = profiles.listings.value.find((listing) => listing.name === 'production');
  expect(definition?.kind).toBe('environment');
  if (definition === undefined) {
    throw new Error('Expected the created environment to be listed');
  }
  const saved: unknown = parse(await readFile(definition.file, 'utf8'));
  expect(saved).toMatchObject({ kind: 'environment', environments: [{ name: 'Production' }] });
  expect(profiles.editor.value?.definitionSection.value).toBe('environments');
  expect(
    await profiles.create({
      name: 'production-copy',
      folder: '',
      start: { kind: 'duplicate', source: definition },
      ownerType: undefined,
    }),
  ).toBeUndefined();
  expect((await resolveProfile('/profiles/browser/production-copy.yaml')).profile.environments).toEqual([
    { name: 'Production' },
  ]);
  await writeFile('/profiles/browser/service.yaml', 'references: { environments: [./production.yaml] }\n');
  await profiles.refresh();
  expect(await profiles.remove(definition)).toContain('service');
  expect((await resolveProfile('/profiles/browser/service.yaml')).profile.environments).toEqual([
    { name: 'Production' },
  ]);
  expect(github.writes).toEqual([]);
});

test('captures one named environment into browser storage and leaves unavailable captures unsaved', async () => {
  const github = new FakeGitHub({
    environments: [
      {
        name: 'Production',
        wait_timer: 20,
        prevent_self_review: false,
        reviewers: [],
        deployment_branch_policy: null,
        branch_policies: [],
      },
    ],
  });
  const profiles = new Profiles(github, preferences(), () => undefined);
  await profiles.refresh();
  const create = (name: string, targetName: string): ReturnType<Profiles['create']> =>
    profiles.create({
      name,
      folder: '',
      definitionKind: 'environment',
      targetName,
      start: { kind: 'repository', repository: 'lunch/app' },
      ownerType: undefined,
    });
  expect(await create('production', 'production')).toBeUndefined();
  expect((await resolveProfile('/profiles/browser/production.yaml')).profile.environments).toEqual([
    {
      name: 'Production',
      wait_timer: 20,
      prevent_self_review: false,
      reviewers: [],
      deployment_branch_policy: null,
    },
  ]);
  expect(await create('missing', 'missing')).toContain('missing');
  expect(profiles.listings.value.map((listing) => listing.name)).toEqual(['production']);
  expect(github.writes).toEqual([]);
});
