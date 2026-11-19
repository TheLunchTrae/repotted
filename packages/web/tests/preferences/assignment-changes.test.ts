import { configCommitMessage } from '@repotted/core';
import { expect, test } from 'vitest';

import { preferenceChanges, repositoryFoldersKey } from '../../src/app/preferences/preference-changes.js';
import { repositoryProfilesKey } from '../../src/app/repositories/saved-assignments.js';

function message(before: Record<string, unknown>, after: Record<string, unknown>): string {
  return configCommitMessage(preferenceChanges(before, after));
}

function assignments(value: Record<string, unknown>): Record<string, unknown> {
  return { [repositoryProfilesKey]: value };
}

function appliedEach(profiles: readonly string[], version = 'v1'): { profile: string; version: string }[] {
  return profiles.map((profile) => ({ profile, version }));
}

test('names one profile assigned to one repository by the profile', () => {
  expect(message({}, assignments({ 'octo/app': { profiles: ['base.yaml'] } }))).toBe(
    'Assign profile base to repository: octo/app',
  );
});

test('names the profiles assigned to one repository together, by their path without .yaml', () => {
  expect(message({}, assignments({ 'octo/app': { profiles: ['base.yaml', 'web/app.yaml'] } }))).toBe(
    'Assign profiles to repository octo/app: base, web/app',
  );
});

test('names a profile taken off a repository, also when its whole entry goes', () => {
  expect(
    message(
      assignments({ 'octo/app': { profiles: ['base.yaml', 'old.yaml'] } }),
      assignments({ 'octo/app': { profiles: ['base.yaml'] } }),
    ),
  ).toBe('Remove profile old from repository: octo/app');
  expect(
    message(assignments({ 'octo/app': { profiles: ['base.yaml'], applied: appliedEach(['base.yaml']) } }), {}),
  ).toBe('Remove profile base from repository: octo/app');
});

test('names every change to one repository in one clause that names the repository', () => {
  expect(
    message(
      assignments({ 'octo/app': { profiles: ['base.yaml'] } }),
      assignments({ 'octo/app': { profiles: ['core/base.yaml'] } }),
    ),
  ).toBe('Update profiles for repository octo/app: assign core/base, remove base');
  expect(
    message(
      assignments({ 'octo/app': { profiles: ['base.yaml', 'web.yaml'] } }),
      assignments({ 'octo/app': { profiles: ['web.yaml', 'base.yaml'], authoritative: ['labels'] } }),
    ),
  ).toBe(
    'Update profiles for repository octo/app: reorder and 1 more\n\n- Update profiles for repository octo/app: reorder\n- Update profiles for repository octo/app: change full section ownership',
  );
});

test('names the repository first when its changes are too many for the subject', () => {
  const lines = message(
    {},
    assignments({
      'octo/web-app': {
        profiles: ['base.yaml', 'web.yaml'],
        authoritative: ['labels'],
        applied: appliedEach(['base.yaml', 'web.yaml']),
      },
    }),
  ).split('\n');

  expect(lines[0]).toBe('Update profiles for repository octo/web-app: apply base and 2 more');
  expect(lines.slice(2)).toEqual([
    '- Update profiles for repository octo/web-app: apply base',
    '- Update profiles for repository octo/web-app: apply web',
    '- Update profiles for repository octo/web-app: change full section ownership',
  ]);
});

test('counts the changes to one repository as profile changes when not even one fits beside its name', () => {
  expect(
    message(
      {},
      assignments({
        'lunchbox-labs/frontend-application': {
          profiles: ['shared/base.yaml', 'web.yaml'],
          authoritative: ['labels'],
          applied: appliedEach(['shared/base.yaml', 'web.yaml']),
        },
      }),
    ).split('\n')[0],
  ).toBe('Make 3 profile changes for repository lunchbox-labs/frontend-application');
});

test('names profiles put in another order', () => {
  expect(
    message(
      assignments({ 'octo/app': { profiles: ['base.yaml', 'web.yaml'] } }),
      assignments({ 'octo/app': { profiles: ['web.yaml', 'base.yaml'] } }),
    ),
  ).toBe('Reorder profiles for repository: octo/app');
});

test('names a change to which sections a repository fully owns', () => {
  expect(
    message(
      assignments({ 'octo/app': { profiles: ['base.yaml'] } }),
      assignments({ 'octo/app': { profiles: ['base.yaml'], authoritative: ['labels'] } }),
    ),
  ).toBe('Change full section ownership for repository: octo/app');
});

test('a profile applied by itself is named as applied, not assigned', () => {
  expect(
    message({}, assignments({ 'octo/app': { profiles: ['base.yaml'], applied: appliedEach(['base.yaml']) } })),
  ).toBe('Apply profile base to repository: octo/app');
});

test('a profile applied by itself with part of it left out is named as assigned', () => {
  expect(message({}, assignments({ 'octo/app': { profiles: ['base.yaml'], applied: [] } }))).toBe(
    'Assign profile base to repository: octo/app',
  );
});

test('an apply names only each profile whose version it records anew, inherited ones too', () => {
  expect(
    message(
      assignments({
        'octo/app': { profiles: ['base.yaml'], applied: appliedEach(['shared.yaml', 'base.yaml']) },
      }),
      assignments({
        'octo/app': {
          profiles: ['base.yaml'],
          applied: [
            { profile: 'shared.yaml', version: 'v1' },
            { profile: 'base.yaml', version: 'v2' },
          ],
        },
      }),
    ),
  ).toBe('Apply profile base to repository: octo/app');
  expect(message({}, assignments({ 'octo/app': { profiles: [], applied: appliedEach(['shared.yaml']) } }))).toBe(
    'Apply profile shared to repository: octo/app',
  );
});

test('an apply that records no new version is named by repository', () => {
  const applied = appliedEach(['web.yaml', 'base.yaml']);
  expect(
    message(
      assignments({ 'octo/app': { profiles: ['web.yaml', 'base.yaml'], applied: applied.toReversed() } }),
      assignments({ 'octo/app': { profiles: ['web.yaml', 'base.yaml'], applied } }),
    ),
  ).toBe('Apply profiles to repository: octo/app');
  expect(
    message(
      assignments({ 'octo/app': { profiles: [], authoritative: ['labels'] } }),
      assignments({
        'octo/app': { profiles: [], authoritative: ['labels'], applied: [], appliedAuthoritative: ['labels'] },
      }),
    ),
  ).toBe('Apply profiles to repository: octo/app');
});

test('profiles applied together to several repositories share one clause', () => {
  const before = { 'octo/a': { profiles: [] }, 'octo/b': { profiles: [] } };
  const after = {
    'octo/a': { profiles: [], applied: appliedEach(['base.yaml', 'web.yaml']) },
    'octo/b': { profiles: [], applied: appliedEach(['base.yaml', 'web.yaml']) },
  };
  expect(message(assignments(before), assignments(after))).toBe(
    'Apply profiles base, web to repositories: octo/a, octo/b',
  );
});

test('one profile applied to many repositories is named once, with the repositories counted past the subject', () => {
  const repositories = Array.from({ length: 20 }, (_, index) => `octo/repo-${index + 1}`);
  const before = Object.fromEntries(repositories.map((name) => [name, { profiles: ['base.yaml'] }]));
  const after = Object.fromEntries(
    repositories.map((name) => [name, { profiles: ['base.yaml'], applied: appliedEach(['base.yaml']) }]),
  );
  const lines = message(assignments(before), assignments(after)).split('\n');

  expect(lines[0]).toBe('Apply profile base to repositories: octo/repo-1 and 19 more');
  expect(lines.slice(2)).toEqual(repositories.toSorted().map((name) => `- Apply profile base to repository: ${name}`));
});

test('names the profiles given to a folder and whether they apply to repositories moved there', () => {
  expect(
    message(
      { [repositoryFoldersKey]: [{ name: 'Work', repositories: [], profiles: ['base.yaml'] }] },
      { [repositoryFoldersKey]: [{ name: 'Work', repositories: [], profiles: ['base.yaml', 'web.yaml'] }] },
    ),
  ).toBe('Assign profile web to folder: Work');
  expect(
    message(
      { [repositoryFoldersKey]: [{ name: 'Work', repositories: [] }] },
      { [repositoryFoldersKey]: [{ name: 'Work', repositories: [], applyProfilesOnMove: true }] },
    ),
  ).toBe('Apply profiles on move into folder: Work');
  expect(
    message(
      {
        [repositoryFoldersKey]: [
          { name: 'Work', repositories: [], profiles: ['base.yaml'], applyProfilesOnMove: true },
        ],
      },
      { [repositoryFoldersKey]: [{ name: 'Work', repositories: [] }] },
    ).split('\n')[0],
  ).toBe('Update profiles for folder Work: remove base and 1 more');
});

test('a folder made names its profiles, a folder deleted does not, and a folder renamed keeps them', () => {
  expect(
    message({}, { [repositoryFoldersKey]: [{ name: 'Work', repositories: [], profiles: ['base.yaml', 'web.yaml'] }] }),
  ).toBe('Create folder: Work; assign profiles to folder Work: base, web');
  expect(
    message({ [repositoryFoldersKey]: [{ name: 'Work', repositories: ['octo/app'], profiles: ['base.yaml'] }] }, {}),
  ).toBe('Delete folder: Work');
  expect(
    message(
      { [repositoryFoldersKey]: [{ name: 'Work', repositories: ['octo/app'], profiles: ['base.yaml'] }] },
      { [repositoryFoldersKey]: [{ name: 'Team', repositories: ['octo/app'], profiles: ['base.yaml'] }] },
    ),
  ).toBe('Rename folder: Work to Team');
});

test('folder and assignment changes saved together are both named', () => {
  expect(
    message(
      { [repositoryFoldersKey]: [{ name: 'Work', repositories: [] }] },
      {
        [repositoryFoldersKey]: [{ name: 'Work', repositories: [], profiles: ['base.yaml'] }],
        ...assignments({ 'octo/app': { profiles: ['web.yaml'] } }),
      },
    ),
  ).toBe(
    'Assign profile base to folder: Work; assign profile web to 1 repository\n\n- Assign profile base to folder: Work\n- Assign profile web to repository: octo/app',
  );
});
