import { type Signal, signal } from '@preact/signals';
import { listProfiles } from '@repotted/core';
import { afterEach, expect, test, vi } from 'vitest';

import { FakeGitRepository } from '../../../core/tests/support/fake-git.js';
import { answered, FakeFleet, FakeGitHub } from '../../../core/tests/support/fake-github.js';
import { Apply } from '../../src/app/apply/apply.js';
import { BatchApply } from '../../src/app/apply/batch-apply.js';
import { repositoryFoldersKey } from '../../src/app/preferences/preference-changes.js';
import { type Change, SharedPreferences, preferencesFile } from '../../src/app/preferences/shared-preferences.js';
import type { ProfileListing } from '../../src/app/profiles/profiles.js';
import { reviewAssignedProfiles } from '../../src/app/repositories/profile-reviews.js';
import {
  profileVersion,
  RepositoryProfiles,
  repositoryProfilesKey,
  tagsFor,
} from '../../src/app/repositories/repository-profiles.js';
import * as files from '../../src/engine/files.js';
import { mkdir, rm, writeFile } from '../../src/engine/files.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await rm('/', { recursive: true });
});

const folder = '/profiles';

function store(start: Record<string, unknown> = {}): {
  readonly kept: Record<string, unknown>;
  read: (key: string) => unknown;
  update: (key: string, change: Change) => void;
  save: (key: string, change: Change) => Promise<boolean>;
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
    save(key, change) {
      this.update(key, change);
      return Promise.resolve(true);
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

test('a shared environment edit marks direct and transitive assignments changed without writing GitHub', async () => {
  const listings = await profiles({
    'production.yaml': 'kind: environment\nenvironments: [{ name: production, wait_timer: 5 }]\n',
    'base.yaml': 'references: { environments: [./production.yaml] }\n',
    'service.yaml': 'extends: ./base.yaml\nrepository: { has_wiki: false }\n',
  });
  const preferences = store();
  const assignments = new RepositoryProfiles(preferences, { listings, folder: signal(folder) });
  assignments.setProfiles('lunch/direct', ['production.yaml']);
  assignments.setProfiles('lunch/service', ['service.yaml']);
  await assignments.check();
  for (const [repository, profile] of [
    ['lunch/direct', 'production.yaml'],
    ['lunch/service', 'service.yaml'],
  ] as const) {
    await assignments.recordApplied(repository, [{ profile, version: await profileVersion(`${folder}/${profile}`) }]);
    expect(assignments.status(repository)).toEqual({ kind: 'current' });
  }

  await writeFile(
    `${folder}/production.yaml`,
    'kind: environment\nenvironments: [{ name: production, wait_timer: 30 }]\n',
  );
  listings.value = await listProfiles(folder);
  await assignments.check();

  expect(assignments.status('lunch/direct')).toMatchObject({ kind: 'changed', changed: ['production.yaml'] });
  expect(assignments.status('lunch/service')).toMatchObject({ kind: 'changed', changed: ['service.yaml'] });
});

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

test('inherits folder profiles before its own and notices moves made elsewhere without applying', async () => {
  const listings = await profiles({
    'base.yaml': 'repository: { has_wiki: false }\n',
    'node.yaml': 'repository: { has_projects: false }\n',
    'web.yaml': 'repository: { has_issues: false }\n',
  });
  const preferences = store({
    [repositoryFoldersKey]: [{ name: 'Packages', repositories: ['Lunch/App'], profiles: ['base.yaml', 'node.yaml'] }],
  });
  const assignments = new RepositoryProfiles(preferences, { listings, folder: signal(folder) });
  assignments.setProfiles('lunch/app', ['node.yaml', 'web.yaml']);

  expect(assignments.profilesOf('lunch/app')).toEqual(['base.yaml', 'node.yaml', 'web.yaml']);
  expect(assignments.repositoriesWithProfiles.value).toContain('lunch/app');
  await assignments.check();
  await assignments.recordApplied(
    'lunch/app',
    await Promise.all(
      assignments.profilesOf('lunch/app').map(async (profile) => ({
        profile,
        version: await profileVersion(`${folder}/${profile}`),
      })),
    ),
  );
  expect(assignments.status('lunch/app')).toEqual({ kind: 'current' });

  preferences.update(repositoryFoldersKey, () => [
    { name: 'Sites', repositories: ['lunch/app'], profiles: ['web.yaml'] },
  ]);
  await assignments.check();

  expect(assignments.profilesOf('lunch/app')).toEqual(['web.yaml', 'node.yaml']);
  expect(assignments.status('lunch/app')).toMatchObject({
    kind: 'changed',
    removed: ['base.yaml'],
    reordered: true,
  });
});

test('records an apply of inherited profiles without copying them to the repository', async () => {
  const listings = await profiles({ 'base.yaml': 'repository: { has_wiki: false }\n' });
  const preferences = store({
    [repositoryFoldersKey]: [{ name: 'Work', repositories: ['lunch/app'], profiles: ['base.yaml'] }],
  });
  const assignments = new RepositoryProfiles(preferences, { listings, folder: signal(folder) });
  const apply = new Apply(
    new FakeGitHub(),
    () => undefined,
    (work) => work(),
    assignments,
  );
  await apply.startFromProfiles('lunch/app', [{ file: `${folder}/base.yaml`, name: 'base', folder }]);
  await apply.review();
  await apply.apply();
  await assignments.check();

  expect(assignments.status('lunch/app')).toEqual({ kind: 'current' });
  expect(preferences.kept[repositoryProfilesKey]).toMatchObject({ 'lunch/app': { profiles: [] } });
  preferences.update(repositoryFoldersKey, () => undefined);
  expect(assignments.profilesOf('lunch/app')).toEqual([]);
});

test('a batch reviews folder then own layers and records only complete successful applies', async () => {
  const listings = await profiles({
    'base.yaml': 'repository: { has_wiki: false }\n',
    'node.yaml': 'repository: { has_projects: false }\n',
    'web.yaml': 'extends: base.yaml\nrepository: { has_wiki: true }\n',
  });
  const names = ['lunch/app', 'lunch/api', 'lunch/web'];
  const preferences = store({
    [repositoryFoldersKey]: [{ name: 'Work', repositories: names, profiles: ['base.yaml', 'node.yaml'] }],
  });
  const assignments = new RepositoryProfiles(preferences, { listings, folder: signal(folder) });
  assignments.setProfiles('lunch/web', ['web.yaml']);
  await assignments.check();
  const fakes = names.map((name) => new FakeGitHub({}, name));
  const github = new FakeFleet(fakes);
  const batch = new BatchApply(github, () => undefined, assignments);
  const apply = new Apply(github, () => undefined, undefined, assignments);
  const review = reviewAssignedProfiles(names, assignments, folder, apply, batch);
  expect(review?.path).toBe('/batch');
  await review?.work;

  expect(batch.state.value.kind).toBe('reviewed');
  expect(fakes.flatMap((fake) => fake.calls).every((call) => call.method === 'GET')).toBe(true);
  expect(assignments.status('lunch/app')).toEqual({ kind: 'not-applied' });
  await batch.leaveOut('lunch/api', 'repository.has_wiki', true);
  const app = fakes[0];
  if (app !== undefined) {
    app.state.repository['has_wiki'] = false;
  }
  await batch.apply();

  expect(batch.state.value).toMatchObject({ kind: 'applied', left: 1 });
  expect(assignments.status('lunch/app')).toEqual({ kind: 'not-applied' });
  expect(assignments.status('lunch/api')).toEqual({ kind: 'not-applied' });
  expect(assignments.status('lunch/web')).toEqual({ kind: 'current' });
  expect(fakes[1]?.state.repository).toMatchObject({ has_wiki: true, has_projects: false });
  expect(fakes[2]?.state.repository).toMatchObject({ has_wiki: true, has_projects: false });
  expect(assignments.ownProfilesOf('lunch/web')).toEqual(['web.yaml']);
});

test('an in-line batch can be marked as applied without writing settings', async () => {
  const listings = await profiles({ 'base.yaml': 'repository: { has_wiki: true }\n' });
  const names = ['lunch/app', 'lunch/api'];
  const assignments = new RepositoryProfiles(
    store({
      [repositoryFoldersKey]: [{ name: 'Work', repositories: names, profiles: ['base.yaml'] }],
    }),
    { listings, folder: signal(folder) },
  );
  await assignments.check();
  const fakes = names.map((name) => new FakeGitHub({}, name));
  const batch = new BatchApply(new FakeFleet(fakes), () => undefined, assignments);
  await batch.startFromProfiles(
    names.map((repository) => ({
      repository,
      profiles: [{ file: `${folder}/base.yaml`, name: 'base', folder }],
    })),
  );

  expect(batch.ready.value).toEqual([]);
  expect(batch.canRecordWithoutChanges.value).toBe(true);
  expect(assignments.status('lunch/app')).toEqual({ kind: 'not-applied' });
  await batch.apply();

  expect(batch.state.value).toMatchObject({ kind: 'applied', left: 0 });
  expect(names.map((name) => assignments.status(name))).toEqual([{ kind: 'current' }, { kind: 'current' }]);
  expect(fakes.flatMap((fake) => fake.calls).every((call) => call.method === 'GET')).toBe(true);
});

test('a move review that lands late cannot advance a newer apply from its edits', async () => {
  const listings = await profiles({ 'base.yaml': 'repository: { has_wiki: false }\n' });
  const assignments = new RepositoryProfiles(
    store({
      [repositoryFoldersKey]: [{ name: 'Work', repositories: ['lunch/app'], profiles: ['base.yaml'] }],
    }),
    { listings, folder: signal(folder) },
  );
  let release = (): void => undefined;
  let reading = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    reading = resolve;
  });
  const write = files.writeFile;
  vi.spyOn(files, 'writeFile').mockImplementationOnce(async (...args) => {
    reading();
    await held;
    return write(...args);
  });
  const github = new FakeFleet([new FakeGitHub(), new FakeGitHub({}, 'lunch/other')]);
  const apply = new Apply(github, () => undefined);
  const batch = new BatchApply(github, () => undefined);
  const late = reviewAssignedProfiles(['lunch/app'], assignments, folder, apply, batch);
  await entered;
  await apply.close();
  await apply.start('lunch/other', { file: `${folder}/base.yaml`, name: 'base', folder });
  expect(apply.state.value).toMatchObject({ kind: 'editing', repository: 'lunch/other' });

  release();
  await late?.work;

  expect(apply.state.value).toMatchObject({ kind: 'editing', repository: 'lunch/other' });
});

test.each(['single', 'batch'] as const)(
  'a move waits for an active %s write before it can open a review',
  async (kind) => {
    const listings = await profiles({ 'base.yaml': 'repository: { has_wiki: false }\n' });
    const assignments = new RepositoryProfiles(
      store({
        [repositoryFoldersKey]: [{ name: 'Work', repositories: ['lunch/app', 'lunch/api'], profiles: ['base.yaml'] }],
      }),
      { listings, folder: signal(folder) },
    );
    let release = (): void => undefined;
    let writing = false;
    let started = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fleet = new FakeFleet([new FakeGitHub(), new FakeGitHub({}, 'lunch/api')]);
    const github = {
      request: async (...args: Parameters<FakeGitHub['request']>): Promise<unknown> => {
        if (writing && args[0] !== 'GET') {
          started();
          await held;
        }
        return fleet.request(...args);
      },
    };
    const apply = new Apply(github, () => undefined);
    const batch = new BatchApply(github, () => undefined);
    const profile = { file: `${folder}/base.yaml`, name: 'base', folder };
    if (kind === 'single') {
      await apply.startReview('lunch/app', [profile]);
    } else {
      await batch.start(['lunch/app'], profile);
    }
    writing = true;
    const pending = kind === 'single' ? apply.apply() : batch.apply();
    await entered;

    expect(reviewAssignedProfiles(['lunch/api'], assignments, folder, apply, batch)).toBeUndefined();
    expect(reviewAssignedProfiles(['lunch/app', 'lunch/api'], assignments, folder, apply, batch)).toBeUndefined();

    release();
    await pending;
    const review = reviewAssignedProfiles(['lunch/api'], assignments, folder, apply, batch);
    expect(review?.path).toBe('/apply');
    await review?.work;
    expect(apply.state.value).toMatchObject({ kind: 'reviewed', repository: 'lunch/api' });
  },
);

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

  await assignments.recordApplied('lunch/app', [
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

test('ownership belongs to each repository and survives refresh independently of its applied baseline', async () => {
  const listings = await profiles({ 'base.yaml': 'rulesets: []\n' });
  const preferences = store();
  const assignments = new RepositoryProfiles(preferences, { listings, folder: signal(folder) });
  assignments.setProfiles('lunch/app', ['base.yaml'], ['rulesets']);
  assignments.setProfiles('lunch/api', ['base.yaml']);
  const versions = [{ profile: 'base.yaml', version: await profileVersion(`${folder}/base.yaml`) }];
  await assignments.recordApplied('lunch/app', versions, ['rulesets']);
  await assignments.check();
  expect(assignments.status('lunch/app')).toEqual({ kind: 'current' });

  assignments.setProfiles('lunch/app', ['base.yaml'], ['environments']);
  expect(assignments.status('lunch/app')).toMatchObject({ kind: 'changed', ownershipChanged: true, changed: [] });
  const refreshed = new RepositoryProfiles(preferences, { listings, folder: signal(folder) });
  await refreshed.check();
  expect(refreshed.authoritativeOf('LUNCH/APP')).toEqual(['environments']);
  expect(refreshed.authoritativeOf('lunch/api')).toEqual([]);
  expect(refreshed.status('lunch/app')).toMatchObject({ kind: 'changed', ownershipChanged: true });

  assignments.setProfiles('lunch/app', ['base.yaml'], []);
  expect(assignments.authoritativeOf('lunch/app')).toEqual([]);
  assignments.setProfiles('lunch/app', []);
  expect(assignments.assignment('lunch/app')).toBeUndefined();
});

const liveRule = (id: number, name: string) => ({
  id,
  name,
  target: 'branch',
  enforcement: 'active',
  bypass_actors: [],
  rules: [],
});

test('a batch owns the complete inherited combination independently per repository and detects live drift', async () => {
  const listings = await profiles({
    'base.yaml': 'rulesets: [{ name: Main }]\n',
    'service.yaml': 'rulesets: [{ name: Release }]\n',
  });
  const preferences = store({
    [repositoryFoldersKey]: [{ name: 'Work', repositories: ['lunch/app', 'lunch/api'], profiles: ['base.yaml'] }],
  });
  const assignments = new RepositoryProfiles(preferences, { listings, folder: signal(folder) });
  assignments.setProfiles('lunch/app', ['service.yaml'], ['rulesets']);
  assignments.setProfiles('lunch/api', ['service.yaml']);
  await assignments.check();
  const app = new FakeGitHub({ rulesets: [liveRule(1, 'Main'), liveRule(2, 'Release'), liveRule(3, 'Legacy')] });
  const api = new FakeGitHub(
    { rulesets: [liveRule(1, 'Main'), liveRule(2, 'Release'), liveRule(3, 'Legacy')] },
    'lunch/api',
  );
  const batch = new BatchApply(new FakeFleet([app, api]), () => undefined, assignments);
  const members = ['lunch/app', 'lunch/api'].map((repository) => ({
    repository,
    profiles: assignments
      .profilesOf(repository)
      .map((path) => ({ file: assignments.fileOf(path), name: path, folder })),
  }));
  await batch.startFromProfiles(members);
  expect(batch.members.value.map((member) => [member.repository, member.changes, member.authoritative])).toEqual([
    ['lunch/app', 1, ['rulesets']],
    ['lunch/api', 0, []],
  ]);
  expect(app.writes).toEqual([]);
  await batch.apply();
  expect(app.state.rulesets.map((rule) => rule.name)).toEqual(['Main', 'Release']);
  expect(api.state.rulesets.map((rule) => rule.name)).toEqual(['Main', 'Release', 'Legacy']);
  expect(assignments.status('lunch/app')).toEqual({ kind: 'current' });
  expect(assignments.status('lunch/api')).toEqual({ kind: 'current' });

  app.state.rulesets.push(liveRule(4, 'Manual'));
  await batch.startFromProfiles(members);
  expect(batch.members.value.find((member) => member.repository === 'lunch/app')?.sections).toMatchObject([
    { rows: [{ label: 'Manual', kind: 'removes' }] },
  ]);
  expect(assignments.status('lunch/app')).toEqual({ kind: 'current' });
});

test.each(['browser', 'repository'] as const)(
  'a batch confirms once after every repository and its %s records finish',
  async (destination) => {
    const listings = await profiles({ 'base.yaml': 'repository: { has_wiki: false }\n' });
    const names = ['lunch/app', 'lunch/api'];
    const initial = Object.fromEntries(names.map((name) => [name, { profiles: ['base.yaml'] }]));
    const kept: Record<string, unknown> = { [repositoryProfilesKey]: initial };
    const config = new FakeGitRepository();
    config.write({ [`profiles/${preferencesFile}`]: JSON.stringify(kept) });
    let holdRecords = false;
    let releaseRecords = (): void => undefined;
    const recordsHeld = new Promise<void>((resolve) => {
      releaseRecords = resolve;
    });
    const confirm = vi.fn();
    const preferences = new SharedPreferences(
      {
        request: async (...args: Parameters<FakeGitRepository['request']>): Promise<unknown> => {
          if (holdRecords) {
            await recordsHeld;
          }
          return config.request(...args);
        },
      },
      {
        read: (key) => kept[key],
        write: (key, value) => {
          kept[key] = value;
          return true;
        },
      },
      () => undefined,
      confirm,
    );
    if (destination === 'repository') {
      await preferences.use({ kind: 'repository', repository: 'lunch/config', path: 'profiles' });
    }
    const assignments = new RepositoryProfiles(preferences, { listings, folder: signal(folder) });
    await assignments.check();
    const fleet = new FakeFleet(names.map((name) => new FakeGitHub({}, name)));
    let applying = false;
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const github = {
      request: async (...args: Parameters<FakeFleet['request']>): Promise<unknown> => {
        if (applying && args[1] === '/repos/lunch/api') {
          await held;
        }
        return fleet.request(...args);
      },
    };
    const batch = new BatchApply(github, () => undefined, assignments, confirm);
    await batch.start(['lunch/app', 'lunch/api'], { file: `${folder}/base.yaml`, name: 'base' });
    applying = true;
    holdRecords = true;
    const work = batch.apply();
    try {
      await vi.waitFor(() => expect(assignments.status('lunch/app')).toEqual({ kind: 'current' }));
      expect(confirm).not.toHaveBeenCalled();
      release();
      if (destination === 'repository') {
        await vi.waitFor(() =>
          expect(batch.state.value).toMatchObject({
            kind: 'applying',
            results: [{ finished: true }, { finished: true }],
          }),
        );
        expect(confirm).not.toHaveBeenCalled();
      }
    } finally {
      release();
      releaseRecords();
      await work;
    }
    expect(confirm).toHaveBeenCalledExactlyOnceWith(2);
    expect(assignments.status('lunch/api')).toEqual({ kind: 'current' });
  },
);

test('a batch keeps successful records without confirming a failed repository or refused storage', async () => {
  const listings = await profiles({ 'base.yaml': 'repository: { has_wiki: false }\n' });
  const names = ['lunch/app', 'lunch/api'];
  const initial = Object.fromEntries(names.map((name) => [name, { profiles: ['base.yaml'] }]));
  const confirm = vi.fn();
  const kept: Record<string, unknown> = { [repositoryProfilesKey]: initial };
  let writable = true;
  const preferences = new SharedPreferences(
    new FakeGitRepository(),
    {
      read: (key) => kept[key],
      write: (key, value) => {
        if (writable) {
          kept[key] = value;
        }
        return writable;
      },
    },
    () => undefined,
    confirm,
  );
  const assignments = new RepositoryProfiles(preferences, { listings, folder: signal(folder) });
  await assignments.check();
  const app = new FakeGitHub({}, 'lunch/app');
  const api = new FakeGitHub({}, 'lunch/api');
  const batch = new BatchApply(new FakeFleet([app, api]), () => undefined, assignments, confirm);
  const profile = { file: `${folder}/base.yaml`, name: 'base' };
  await batch.start(names, profile);
  api.fail('PATCH /repos/lunch/api', answered(422, 'Validation Failed'), 1);
  await batch.apply();
  expect(assignments.status('lunch/app')).toEqual({ kind: 'current' });
  expect(assignments.status('lunch/api')).toEqual({ kind: 'not-applied' });
  expect(confirm).not.toHaveBeenCalled();

  await batch.reviewAgain();
  writable = false;
  await batch.apply();
  expect(api.state.repository['has_wiki']).toBe(false);
  expect(assignments.status('lunch/api')).toEqual({ kind: 'not-applied' });
  expect(confirm).not.toHaveBeenCalled();
});

test('one-time ownership overrides never change the saved assignment or mark it applied', async () => {
  const listings = await profiles({ 'base.yaml': 'rulesets: []\n' });
  const preferences = store();
  const assignments = new RepositoryProfiles(preferences, { listings, folder: signal(folder) });
  assignments.setProfiles('lunch/app', ['base.yaml'], ['rulesets']);
  await assignments.check();
  const github = new FakeGitHub({ rulesets: [liveRule(1, 'Keep')] });
  const apply = new Apply(
    github,
    () => undefined,
    (work) => work(),
    assignments,
  );
  await apply.startReview('lunch/app', [{ file: `${folder}/base.yaml`, name: 'base' }], []);
  expect(apply.state.value).toMatchObject({
    kind: 'reviewed',
    plan: { changes: [] },
    assignment: { recordsVersions: false },
  });
  expect(apply.canRecordWithoutChanges.value).toBe(false);
  expect(assignments.authoritativeOf('lunch/app')).toEqual(['rulesets']);
  expect(github.writes).toEqual([]);
  expect(assignments.status('lunch/app')).toEqual({ kind: 'not-applied' });
});

test.each(['single', 'batch'] as const)(
  'changing ownership during %s revalidation refuses every write',
  async (kind) => {
    const listings = await profiles({ 'base.yaml': 'rulesets: []\n' });
    const assignments = new RepositoryProfiles(store(), { listings, folder: signal(folder) });
    assignments.setProfiles('lunch/app', ['base.yaml'], ['rulesets']);
    const fake = new FakeGitHub({ rulesets: [liveRule(1, 'Keep')] });
    let hold = false;
    let release = (): void => undefined;
    let entered = (): void => undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const github = {
      request: async (...args: Parameters<FakeGitHub['request']>): Promise<unknown> => {
        if (hold && args[0] === 'GET') {
          entered();
          await waiting;
        }
        return fake.request(...args);
      },
    };
    const apply = new Apply(
      github,
      () => undefined,
      (work) => work(),
      assignments,
    );
    const batch = new BatchApply(github, () => undefined, assignments);
    const chosenProfiles = [{ file: `${folder}/base.yaml`, name: 'base' }];
    if (kind === 'single') {
      await apply.startReview('lunch/app', chosenProfiles);
    } else {
      await batch.startFromProfiles([{ repository: 'lunch/app', profiles: chosenProfiles }]);
    }
    hold = true;
    const applying = kind === 'single' ? apply.apply() : batch.apply();
    await reading;
    assignments.setProfiles('lunch/app', ['base.yaml'], []);
    release();
    await applying;
    expect(fake.writes).toEqual([]);
    if (kind === 'single') {
      expect(apply.state.value.kind).toBe('failed');
      if (apply.state.value.kind === 'failed') {
        expect(apply.state.value.message).toContain('assignment changed');
      }
      await apply.reviewAgain();
      expect(apply.state.value).toMatchObject({ kind: 'reviewed', plan: { changes: [] } });
    } else {
      expect(batch.state.value).toMatchObject({ kind: 'applied', left: 1, results: [{ finished: false }] });
      if (batch.state.value.kind === 'applied') {
        expect(batch.state.value.results[0]?.said).toContain('assignment changed');
      }
    }
  },
);

test('marking an unchanged assignment as applied rechecks live drift before recording its baseline', async () => {
  const listings = await profiles({ 'base.yaml': 'rulesets: []\n' });
  const assignments = new RepositoryProfiles(store(), { listings, folder: signal(folder) });
  assignments.setProfiles('lunch/app', ['base.yaml'], ['rulesets']);
  await assignments.check();
  const github = new FakeGitHub();
  const apply = new Apply(
    github,
    () => undefined,
    (work) => work(),
    assignments,
  );
  await apply.startReview('lunch/app', [{ file: `${folder}/base.yaml`, name: 'base' }]);
  expect(apply.canRecordWithoutChanges.value).toBe(true);
  github.state.rulesets.push(liveRule(1, 'Manual'));
  await apply.recordWithoutChanges();
  expect(apply.state.value).toMatchObject({
    kind: 'reviewed',
    sections: [{ rows: [{ label: 'Manual', kind: 'removes' }] }],
  });
  expect(assignments.status('lunch/app')).toEqual({ kind: 'not-applied' });
  expect(github.writes).toEqual([]);
});

test('an owned empty assignment can remove all entries and removal stops future enforcement', async () => {
  const assignments = new RepositoryProfiles(store(), { listings: signal([]), folder: signal(folder) });
  assignments.setProfiles('lunch/app', [], ['rulesets']);
  const github = new FakeGitHub({ rulesets: [liveRule(1, 'Old')] });
  const apply = new Apply(
    github,
    () => undefined,
    (work) => work(),
    assignments,
  );
  await apply.startReview('lunch/app', []);
  await apply.apply();
  expect(github.state.rulesets).toEqual([]);
  expect(assignments.status('lunch/app')).toEqual({ kind: 'current' });
  assignments.setProfiles('lunch/app', [], []);
  expect(assignments.status('lunch/app')).toEqual({ kind: 'none' });
  expect(github.state.rulesets).toEqual([]);
});

test('assignment ownership syncs with config preferences and reloads changes made elsewhere', async () => {
  const listings = await profiles({ 'base.yaml': 'rulesets: []\n' });
  const github = new FakeGitRepository('lunch/config');
  const file = `profiles/${preferencesFile}`;
  github.write({
    [file]: JSON.stringify({
      [repositoryProfilesKey]: {
        'lunch/app': { profiles: ['base.yaml'], authoritative: ['rulesets'] },
        'lunch/api': { profiles: ['base.yaml'] },
      },
    }),
  });
  const preferences = new SharedPreferences(github, { read: () => undefined, write: () => true }, () => undefined);
  await preferences.use({ kind: 'repository', repository: 'lunch/config', path: 'profiles' });
  const assignments = new RepositoryProfiles(preferences, { listings, folder: signal(folder) });
  expect(assignments.authoritativeOf('lunch/app')).toEqual(['rulesets']);
  assignments.setProfiles('lunch/api', ['base.yaml'], ['environments']);
  await vi.waitFor(() => {
    expect(JSON.parse(github.files()[file] ?? '{}')).toMatchObject({
      [repositoryProfilesKey]: {
        'lunch/app': { authoritative: ['rulesets'] },
        'lunch/api': { authoritative: ['environments'] },
      },
    });
  });
  github.write({
    [file]: JSON.stringify({
      [repositoryProfilesKey]: {
        'lunch/app': { profiles: ['base.yaml'], authoritative: ['labels'] },
        'lunch/api': { profiles: ['base.yaml'], authoritative: ['environments'] },
      },
    }),
  });
  await preferences.reload();
  expect(assignments.authoritativeOf('lunch/app')).toEqual(['labels']);
  expect(assignments.authoritativeOf('lunch/api')).toEqual(['environments']);
});

test('transitive reusable edits change assignment status and missing definitions block authoritative review', async () => {
  const listings = await profiles({
    'policy.yaml': 'kind: actions-policy\nactions_policies: [{ name: Release, enforcement: active }]\n',
    'base.yaml': 'references: { actions_policies: [policy.yaml] }\n',
    'service.yaml': 'extends: base.yaml\n',
  });
  const assignments = new RepositoryProfiles(store(), { listings, folder: signal(folder) });
  assignments.setProfiles('lunch/app', ['service.yaml'], ['rulesets']);
  await assignments.recordApplied(
    'lunch/app',
    [{ profile: 'service.yaml', version: await profileVersion(`${folder}/service.yaml`) }],
    ['rulesets'],
  );
  await assignments.check();
  expect(assignments.status('lunch/app')).toEqual({ kind: 'current' });

  await writeFile(
    `${folder}/policy.yaml`,
    'kind: actions-policy\nactions_policies: [{ name: Release, enforcement: disabled }]\n',
  );
  listings.value = await listProfiles(folder);
  await assignments.check();
  expect(assignments.status('lunch/app')).toMatchObject({ kind: 'changed', changed: ['service.yaml'] });

  await rm(`${folder}/policy.yaml`);
  listings.value = await listProfiles(folder);
  await assignments.check();
  expect(assignments.status('lunch/app')).toMatchObject({ kind: 'missing', unreadable: ['service.yaml'] });
  const github = new FakeGitHub({ rulesets: [liveRule(1, 'Preserve')] });
  const apply = new Apply(
    github,
    () => undefined,
    (work) => work(),
    assignments,
  );
  await apply.startReview('lunch/app', [{ file: `${folder}/service.yaml`, name: 'service' }]);
  expect(apply.state.value.kind).toBe('failed');
  await apply.apply();
  expect(github.writes).toEqual([]);
});

test.each(['single', 'batch'] as const)(
  'a %s review cannot record source versions read after its plan changed',
  async (kind) => {
    const listings = await profiles({ 'base.yaml': 'repository: { has_wiki: false }\n' });
    const assignments = new RepositoryProfiles(store(), { listings, folder: signal(folder) });
    assignments.setProfiles('lunch/app', ['base.yaml']);
    const fake = new FakeGitHub();
    let liveWasRead = false;
    const github = {
      request: async (...args: Parameters<FakeGitHub['request']>): Promise<unknown> => {
        liveWasRead = true;
        return fake.request(...args);
      },
    };
    const versions = await import('../../src/app/repositories/repository-profiles.js');
    const readVersion = versions.profileVersion;
    vi.spyOn(versions, 'profileVersion').mockImplementation(async (file) => {
      if (liveWasRead) {
        await writeFile(`${folder}/base.yaml`, 'repository: { has_wiki: true }\n');
      }
      return readVersion(file);
    });
    const chosenProfiles = [{ file: `${folder}/base.yaml`, name: 'base' }];
    if (kind === 'single') {
      const apply = new Apply(
        github,
        () => undefined,
        (work) => work(),
        assignments,
      );
      await apply.startReview('lunch/app', chosenProfiles);
      expect(apply.state.value.kind).toBe('failed');
      if (apply.state.value.kind === 'failed') {
        expect(apply.state.value.message).toContain('sources changed during review');
      }
    } else {
      const batch = new BatchApply(github, () => undefined, assignments);
      await batch.startFromProfiles([{ repository: 'lunch/app', profiles: chosenProfiles }]);
      expect(batch.state.value.kind).toBe('failed');
      if (batch.state.value.kind === 'failed') {
        expect(batch.state.value.message).toContain('sources changed during review');
      }
    }
    expect(assignments.assignment('lunch/app')?.applied).toBeUndefined();
    expect(fake.writes).toEqual([]);
  },
);

test('a batch can show an unrelated profile review after a late source loss, but cannot apply it', async () => {
  const listings = await profiles({
    'assigned.yaml': 'repository: { has_projects: false }\n',
    'once.yaml': 'repository: { has_wiki: false }\n',
  });
  const assignments = new RepositoryProfiles(store(), { listings, folder: signal(folder) });
  assignments.setProfiles('lunch/app', ['assigned.yaml']);
  const fake = new FakeGitHub();
  const readingAccess = Promise.withResolvers<undefined>();
  const releaseAccess = Promise.withResolvers<undefined>();
  const github = {
    request: async (...args: Parameters<FakeGitHub['request']>): Promise<unknown> => {
      if (args[1].startsWith('/user/installations')) {
        readingAccess.resolve(undefined);
        await releaseAccess.promise;
      }
      return fake.request(...args);
    },
  };
  const batch = new BatchApply(github, () => undefined, assignments);
  const reviewing = batch.start(['lunch/app'], { file: `${folder}/once.yaml`, name: 'once' });
  await readingAccess.promise;
  await rm(`${folder}/once.yaml`);
  releaseAccess.resolve(undefined);
  await reviewing;

  expect(batch.state.value.kind).toBe('reviewed');
  expect(batch.members.value).toMatchObject([{ repository: 'lunch/app', status: 'changes' }]);
  await batch.apply();

  const state = batch.state.value;
  expect(state).toMatchObject({ kind: 'applied', results: [{ repository: 'lunch/app', finished: false }] });
  if (state.kind === 'applied') {
    expect(state.results[0]?.said).toContain('Cannot read profile');
  }
  expect(assignments.assignment('lunch/app')?.applied).toBeUndefined();
  expect(fake.writes).toEqual([]);
});
