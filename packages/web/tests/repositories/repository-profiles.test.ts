import { type Signal, signal } from '@preact/signals';
import { listProfiles } from '@repotted/core';
import { afterEach, expect, test } from 'vitest';

import { answered, FakeGitHub } from '../../../core/tests/support/fake-github.js';
import { Apply } from '../../src/app/apply/apply.js';
import type { Change } from '../../src/app/preferences/shared-preferences.js';
import type { ProfileListing } from '../../src/app/profiles/profiles.js';
import {
  profileVersion,
  RepositoryProfiles,
  repositoryProfilesKey,
  tagsFor,
} from '../../src/app/repositories/repository-profiles.js';
import { mkdir, rm, writeFile } from '../../src/engine/files.js';

afterEach(async () => {
  await rm('/', { recursive: true });
});

const folder = '/profiles';

function store(start: Record<string, unknown> = {}): {
  readonly kept: Record<string, unknown>;
  read: (key: string) => unknown;
  update: (key: string, change: Change) => void;
} {
  const values = signal<Record<string, unknown>>({ ...start });
  return {
    get kept() {
      return values.value;
    },
    read: (key) => values.value[key],
    update: (key, change) => {
      const value = change(values.value[key]);
      const others = Object.entries(values.value).filter(([other]) => other !== key);
      values.value = Object.fromEntries(value === undefined ? others : [...others, [key, value]]);
    },
  };
}

async function profiles(texts: Readonly<Record<string, string>>): Promise<Signal<readonly ProfileListing[]>> {
  await mkdir(`${folder}/web`, { recursive: true });
  for (const [name, text] of Object.entries(texts)) {
    await writeFile(`${folder}/${name}`, text);
  }
  return signal(await listProfiles(folder));
}

test('makes a short tag of each name that is its own, after the tags people chose', () => {
  const tags = tagsFor(
    ['npm-package.yaml', 'npm-cli.yaml', 'base.yaml', 'web/base.yaml', 'a-very-long-profile-name.yaml', 'public.yaml'],
    { 'public.yaml': 'pub', 'base.yaml': 'npm' },
  );

  expect(Object.fromEntries(tags)).toEqual({
    'public.yaml': 'pub',
    'base.yaml': 'npm',
    'a-very-long-profile-name.yaml': 'a',
    'npm-cli.yaml': 'npm-cli',
    'npm-package.yaml': 'npm-package',
    'web/base.yaml': 'base',
  });
  expect(tagsFor(['x/a.yaml', 'y/a.yaml', 'z/a.yaml'], {}).get('z/a.yaml')).toBe('a3');
  expect(
    tagsFor(['longer-than-twelve.yaml'], { 'longer-than-twelve.yaml': 'thirteen-long' }).get('longer-than-twelve.yaml'),
  ).toBe('thirteen-lon');
});

test('keeps a list of profiles for each repository, by any case of its name, and forgets an empty one', () => {
  const preferences = store();
  const assignments = new RepositoryProfiles(preferences, {
    listings: signal<readonly ProfileListing[]>([]),
    folder: signal(folder),
  });

  assignments.setProfiles('Lunch/App', ['base.yaml', 'web/node.yaml', 'base.yaml']);

  expect(assignments.profilesOf('lunch/app')).toEqual(['base.yaml', 'web/node.yaml']);
  expect(preferences.kept[repositoryProfilesKey]).toEqual({
    'lunch/app': { profiles: ['base.yaml', 'web/node.yaml'] },
  });
  expect(assignments.repositoriesWithProfiles.value).toEqual(['lunch/app']);

  assignments.setProfiles('lunch/app', []);

  expect(preferences.kept[repositoryProfilesKey]).toBeUndefined();
});

test('reads a hand-edited list that is not one as no profiles', () => {
  const preferences = store({ [repositoryProfilesKey]: { 'lunch/app': { profiles: 'base.yaml' } } });
  const assignments = new RepositoryProfiles(preferences, {
    listings: signal<readonly ProfileListing[]>([]),
    folder: signal(folder),
  });

  expect(assignments.profilesOf('lunch/app')).toEqual([]);
});

test('tells a repository whose profiles changed since the last apply from one up to date', async () => {
  const listings = await profiles({
    'base.yaml': 'repository: { has_wiki: false }\n',
    'node.yaml': 'repository: { has_issues: true }\n',
  });
  const preferences = store();
  const assignments = new RepositoryProfiles(preferences, { listings, folder: signal(folder) });
  assignments.setProfiles('lunch/app', ['base.yaml', 'node.yaml']);

  expect(assignments.status('lunch/app')).toEqual({ kind: 'checking' });
  await assignments.check();
  expect(assignments.status('lunch/app')).toEqual({ kind: 'not-applied' });

  assignments.recordApplied('lunch/app', [
    { profile: 'base.yaml', version: await profileVersion(`${folder}/base.yaml`) },
    { profile: 'node.yaml', version: await profileVersion(`${folder}/node.yaml`) },
  ]);
  expect(assignments.status('lunch/app')).toEqual({ kind: 'current' });

  await writeFile(`${folder}/node.yaml`, 'repository: { has_issues: false }\n');
  await assignments.check();
  expect(assignments.status('lunch/app')).toEqual({
    kind: 'changed',
    changed: ['node.yaml'],
    notApplied: [],
    removed: [],
    reordered: false,
  });

  assignments.setProfiles('lunch/app', ['node.yaml', 'base.yaml']);
  expect(assignments.status('lunch/app')).toMatchObject({ kind: 'changed', reordered: true });
});

test('a draft or a comment changes no version, since neither changes what applies', async () => {
  await profiles({ 'base.yaml': 'repository: { has_wiki: false }\n' });
  const before = await profileVersion(`${folder}/base.yaml`);

  await writeFile(
    `${folder}/base.yaml`,
    '# Kept for every repository.\nrepository: { has_wiki: false }\ndrafts:\n  repository: { has_projects: false }\n',
  );

  expect(await profileVersion(`${folder}/base.yaml`)).toBe(before);
});

test('names a profile that is gone or cannot be read, which stops an apply of the list', async () => {
  const listings = await profiles({
    'base.yaml': 'repository: { has_wiki: false }\n',
    'broken.yaml': 'repository: { has_wiki: maybe }\n',
  });
  const assignments = new RepositoryProfiles(store(), { listings, folder: signal(folder) });
  assignments.setProfiles('lunch/app', ['base.yaml', 'gone.yaml', 'broken.yaml']);

  expect(assignments.status('lunch/app')).toEqual({
    kind: 'missing',
    missing: ['gone.yaml'],
    unreadable: ['broken.yaml'],
  });
});

test("an apply of a repository's own profiles records each one's version, and one of another profile can add it", async () => {
  const listings = await profiles({
    'base.yaml': 'repository: { has_wiki: false }\n',
    'node.yaml': 'repository: { has_projects: false }\n',
  });
  const assignments = new RepositoryProfiles(store(), { listings, folder: signal(folder) });
  const github = new FakeGitHub();
  const apply = new Apply(
    github,
    () => undefined,
    (work) => work(),
    assignments,
  );

  await apply.start('lunch/app', { file: `${folder}/base.yaml`, name: 'base', folder });
  await apply.review();
  expect(apply.state.value).toMatchObject({ assignment: { kind: 'add', profileName: 'base' } });
  await apply.apply();

  await assignments.check();
  expect(assignments.profilesOf('lunch/app')).toEqual(['base.yaml']);
  expect(assignments.status('lunch/app')).toEqual({ kind: 'current' });

  await apply.start('lunch/app', { file: `${folder}/node.yaml`, name: 'node', folder });
  await apply.review();
  apply.addToRepositoryProfiles.value = false;
  await apply.apply();

  expect(assignments.profilesOf('lunch/app')).toEqual(['base.yaml']);

  assignments.setProfiles('lunch/app', ['base.yaml', 'node.yaml']);
  await assignments.check();
  expect(assignments.status('lunch/app')).toMatchObject({ kind: 'changed', notApplied: ['node.yaml'] });
  await apply.startFromProfiles(
    'lunch/app',
    assignments.profilesOf('lunch/app').map((profilePath) => ({
      file: assignments.fileOf(profilePath),
      name: profilePath,
      folder,
    })),
  );
  await apply.review();
  expect(apply.state.value).toMatchObject({ assignment: { kind: 'own' } });
  // The node profile was applied once already, so the repository has what the two set.
  expect(apply.canApply.value).toBe(false);
  expect(apply.canRecordWithoutChanges.value).toBe(true);

  await apply.recordWithoutChanges();

  expect(apply.state.value).toMatchObject({ kind: 'applied', changes: 0 });
  expect(assignments.status('lunch/app')).toEqual({ kind: 'current' });
});

test('an apply of a profile kept outside the profiles folder offers nothing to add', async () => {
  await profiles({});
  await mkdir('/built-in', { recursive: true });
  await writeFile('/built-in/protect.yaml', 'repository: { has_wiki: false }\n');
  const assignments = new RepositoryProfiles(store(), {
    listings: signal<readonly ProfileListing[]>([]),
    folder: signal(folder),
  });
  const apply = new Apply(
    new FakeGitHub(),
    () => undefined,
    (work) => work(),
    assignments,
  );

  await apply.start('lunch/app', { file: '/built-in/protect.yaml', name: 'protect', folder: '/built-in' });
  await apply.review();
  await apply.apply();

  expect(assignments.profilesOf('lunch/app')).toEqual([]);
});

const twoProfiles = {
  'base.yaml': 'repository: { has_wiki: false }\n',
  'node.yaml': 'repository: { has_projects: false }\nlabels:\n  - name: bug\n    color: d73a4a\n',
};

async function appliedTogether(
  assignments: RepositoryProfiles,
  github: FakeGitHub,
  profilePaths: readonly string[],
): Promise<Apply> {
  const apply = new Apply(
    github,
    () => undefined,
    (work) => work(),
    assignments,
  );
  await apply.startFromProfiles(
    'lunch/app',
    profilePaths.map((profilePath) => ({ file: assignments.fileOf(profilePath), name: profilePath, folder })),
  );
  await apply.review();
  return apply;
}

test('a profile taken out of the list since the last apply counts as a change', async () => {
  const listings = await profiles(twoProfiles);
  const assignments = new RepositoryProfiles(store(), { listings, folder: signal(folder) });
  assignments.setProfiles('lunch/app', ['base.yaml', 'node.yaml']);
  await (await appliedTogether(assignments, new FakeGitHub(), ['base.yaml', 'node.yaml'])).apply();
  await assignments.check();
  expect(assignments.status('lunch/app')).toEqual({ kind: 'current' });

  assignments.setProfiles('lunch/app', ['base.yaml']);

  expect(assignments.status('lunch/app')).toEqual({
    kind: 'changed',
    changed: [],
    notApplied: [],
    removed: ['node.yaml'],
    reordered: false,
  });
});

test('a profile that stops resolving after it was listed shows as unreadable, not as still being checked', async () => {
  const listings = await profiles(twoProfiles);
  const assignments = new RepositoryProfiles(store(), { listings, folder: signal(folder) });
  assignments.setProfiles('lunch/app', ['base.yaml', 'node.yaml']);
  await writeFile(`${folder}/node.yaml`, 'extends: gone.yaml\n');

  await assignments.check();

  expect(assignments.status('lunch/app')).toEqual({ kind: 'missing', missing: [], unreadable: ['node.yaml'] });
});

test('only the newest check of the versions counts', async () => {
  const listings = await profiles(twoProfiles);
  const assignments = new RepositoryProfiles(store(), { listings, folder: signal(folder) });
  assignments.setProfiles('lunch/app', ['base.yaml']);

  const older = assignments.check();
  const newer = assignments.check();
  await older;

  expect(assignments.status('lunch/app')).toEqual({ kind: 'checking' });
  await newer;
  expect(assignments.status('lunch/app')).toEqual({ kind: 'not-applied' });
});

test('an apply that leaves a change out records no versions, and a profile added that way counts as not applied', async () => {
  const listings = await profiles(twoProfiles);
  const assignments = new RepositoryProfiles(store(), { listings, folder: signal(folder) });
  assignments.setProfiles('lunch/app', ['base.yaml', 'node.yaml']);
  const apply = await appliedTogether(assignments, new FakeGitHub(), ['base.yaml', 'node.yaml']);

  await apply.leaveOut('labels/bug', true);
  expect(apply.state.value).toMatchObject({ assignment: { kind: 'own', recordsVersions: false } });
  await apply.apply();
  await assignments.check();

  expect(assignments.assignment('lunch/app')?.applied).toBeUndefined();
  expect(assignments.status('lunch/app')).toEqual({ kind: 'not-applied' });

  assignments.setProfiles('lunch/app', []);
  const single = new Apply(
    new FakeGitHub(),
    () => undefined,
    (work) => work(),
    assignments,
  );
  await single.start('lunch/app', { file: `${folder}/node.yaml`, name: 'node', folder });
  await single.review();
  await single.leaveOut('labels/bug', true);
  await single.apply();
  await assignments.check();

  expect(assignments.profilesOf('lunch/app')).toEqual(['node.yaml']);
  expect(assignments.status('lunch/app')).toEqual({ kind: 'not-applied' });
});

test('an apply with a one-off edit records no versions', async () => {
  const listings = await profiles(twoProfiles);
  const assignments = new RepositoryProfiles(store(), { listings, folder: signal(folder) });
  assignments.setProfiles('lunch/app', ['base.yaml']);
  const apply = new Apply(
    new FakeGitHub(),
    () => undefined,
    (work) => work(),
    assignments,
  );
  await apply.startFromProfiles('lunch/app', [{ file: `${folder}/base.yaml`, name: 'base', folder }]);
  await apply.backToEdits();

  await apply.editor.value?.addEntry('labels', { name: 'docs', color: '0075ca' });
  await apply.review();

  expect(apply.state.value).toMatchObject({ assignment: { kind: 'own', recordsVersions: false } });
  expect(apply.canRecordWithoutChanges.value).toBe(false);
  await apply.apply();
  expect(assignments.assignment('lunch/app')?.applied).toBeUndefined();
});

test('an apply of the profiles in another order, or of some of them, records nothing', async () => {
  const listings = await profiles(twoProfiles);
  const assignments = new RepositoryProfiles(store(), { listings, folder: signal(folder) });
  assignments.setProfiles('lunch/app', ['base.yaml', 'node.yaml']);

  const reordered = await appliedTogether(assignments, new FakeGitHub(), ['node.yaml', 'base.yaml']);
  expect(reordered.state.value).toMatchObject({ assignment: { kind: 'none' } });
  await reordered.apply();
  const some = new Apply(
    new FakeGitHub(),
    () => undefined,
    (work) => work(),
    assignments,
  );
  await some.start('lunch/app', { file: `${folder}/base.yaml`, name: 'base', folder });
  await some.review();
  expect(some.state.value).toMatchObject({ assignment: { kind: 'none' } });
  await some.apply();

  expect(assignments.assignment('lunch/app')).toEqual({ profiles: ['base.yaml', 'node.yaml'] });
});

test('an apply GitHub refuses partway, or one of a repository that changed since the review, records nothing', async () => {
  const listings = await profiles(twoProfiles);
  const assignments = new RepositoryProfiles(store(), { listings, folder: signal(folder) });
  assignments.setProfiles('lunch/app', ['base.yaml', 'node.yaml']);

  const refusing = new FakeGitHub().fail('POST /repos/lunch/app/labels', answered(422, 'Validation Failed'), 1);
  const refused = await appliedTogether(assignments, refusing, ['base.yaml', 'node.yaml']);
  await refused.apply();
  expect(refused.state.value).toMatchObject({ kind: 'reviewed' });
  await refused.close();

  const changing = new FakeGitHub();
  const stale = await appliedTogether(assignments, changing, ['base.yaml', 'node.yaml']);
  changing.state.repository['has_projects'] = false;
  await stale.apply();
  expect(stale.state.value).toMatchObject({ kind: 'reviewed' });

  expect(assignments.assignment('lunch/app')).toEqual({ profiles: ['base.yaml', 'node.yaml'] });
});

test('an apply recorded after its repository stopped using any profile adds nothing back', async () => {
  const listings = await profiles(twoProfiles);
  const assignments = new RepositoryProfiles(store(), { listings, folder: signal(folder) });
  assignments.setProfiles('lunch/app', ['base.yaml']);
  const apply = await appliedTogether(assignments, new FakeGitHub(), ['base.yaml']);

  assignments.setProfiles('lunch/app', []);
  await apply.apply();

  expect(assignments.assignment('lunch/app')).toBeUndefined();
});

test('an apply that skips a setting GitHub refused to show records no versions, since granting access can change it', async () => {
  const listings = await profiles({ 'base.yaml': 'actions:\n  max_cache_retention_days: 30\n' });
  const assignments = new RepositoryProfiles(store(), { listings, folder: signal(folder) });
  assignments.setProfiles('lunch/app', ['base.yaml']);
  const refusing = new FakeGitHub().fail(
    'GET /repos/lunch/app/actions/cache/retention-limit',
    answered(402, 'Please ensure your account has a valid payment method on file to access this service.'),
  );

  const apply = await appliedTogether(assignments, refusing, ['base.yaml']);

  expect(apply.state.value).toMatchObject({ assignment: { kind: 'own', recordsVersions: false } });
  expect(apply.canRecordWithoutChanges.value).toBe(false);
});
