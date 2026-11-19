import { configCommitMessage } from '@repotted/core';
import { expect, test } from 'vitest';

import {
  hiddenOwnersKey,
  hiddenRepositoriesKey,
  preferenceChanges,
  repositoryFoldersKey,
} from '../../src/app/preferences/preference-changes.js';

function message(before: Record<string, unknown>, after: Record<string, unknown>): string {
  return configCommitMessage(preferenceChanges(before, after));
}

test('names the repositories hidden and shown again', () => {
  expect(
    message(
      { [hiddenRepositoriesKey]: ['octo/old', 'octo/kept'] },
      { [hiddenRepositoriesKey]: ['octo/kept', 'octo/new', 'octo/other'] },
    ),
  ).toBe('Hide repositories: octo/new, octo/other; show repository: octo/old');
});

test('names the owners hidden and shown again, without regard to case', () => {
  expect(message({ [hiddenOwnersKey]: ['Octo'] }, { [hiddenOwnersKey]: ['octo', 'lunch'] })).toBe('Hide owner: lunch');
  expect(message({ [hiddenOwnersKey]: ['octo'] }, {})).toBe('Show owner: octo');
});

test('names a folder made, with the repositories moved into it', () => {
  expect(
    message(
      { [repositoryFoldersKey]: [{ name: 'Work', repositories: ['octo/app'] }] },
      {
        [repositoryFoldersKey]: [
          { name: 'Home', repositories: ['octo/app', 'octo/b'] },
          { name: 'Work', repositories: [] },
        ],
      },
    ),
  ).toBe('Create folder: Home; move repositories to folder Home: octo/app, octo/b');
});

test('names profiles applied on move into a folder alongside a move', () => {
  expect(
    message(
      { [repositoryFoldersKey]: [{ name: 'Work', repositories: [], profiles: ['base.yaml'] }] },
      {
        [repositoryFoldersKey]: [
          { name: 'Work', repositories: ['octo/app'], profiles: ['base.yaml'], applyProfilesOnMove: true },
        ],
      },
    ),
  ).toBe(
    'Apply profiles on move into 1 folder; move 1 repository to folder Work\n\n- Apply profiles on move into folder: Work\n- Move repository to folder Work: octo/app',
  );
});

test('a folder renamed is one rename, even when only its case changes', () => {
  const repositories = ['octo/app'];
  expect(
    message(
      { [repositoryFoldersKey]: [{ name: 'Work', repositories }] },
      { [repositoryFoldersKey]: [{ name: 'Clients', repositories }] },
    ),
  ).toBe('Rename folder: Work to Clients');
  expect(
    message(
      { [repositoryFoldersKey]: [{ name: 'work', repositories }] },
      { [repositoryFoldersKey]: [{ name: 'Work', repositories }] },
    ),
  ).toBe('Rename folder: work to Work');
});

test('a folder deleted takes its repositories with it', () => {
  expect(message({ [repositoryFoldersKey]: [{ name: 'Work', repositories: ['octo/app', 'octo/api'] }] }, {})).toBe(
    'Delete folder: Work',
  );
});

test('names the repositories taken out of a folder', () => {
  expect(
    message(
      { [repositoryFoldersKey]: [{ name: 'Work', repositories: ['octo/app', 'octo/api'] }] },
      { [repositoryFoldersKey]: [{ name: 'Work', repositories: ['octo/api'] }] },
    ),
  ).toBe('Take repository out of folder Work: octo/app');
});

test('a move between folders names where each repository went', () => {
  expect(
    message(
      {
        [repositoryFoldersKey]: [
          { name: 'Home', repositories: [] },
          { name: 'Work', repositories: ['octo/app'] },
        ],
      },
      {
        [repositoryFoldersKey]: [
          { name: 'Home', repositories: ['octo/app'] },
          { name: 'Work', repositories: [] },
        ],
      },
    ),
  ).toBe('Move repository to folder Home: octo/app');
});

test('names a preference when no line names its change, by its key when this version has no words for it', () => {
  expect(message({ other: 1 }, { other: 2 })).toBe('Update preference: other');
  expect(
    message({ [hiddenRepositoriesKey]: ['octo/a', 'octo/b'] }, { [hiddenRepositoriesKey]: ['octo/b', 'octo/a'] }),
  ).toBe('Update preference: hidden repositories');
  expect(message({ [hiddenOwnersKey]: ['b', 'a'] }, { [hiddenOwnersKey]: ['a', 'b'] })).toBe(
    'Update preference: hidden owners',
  );
});

test('a rename saved with a move into the folder names both, and not the repositories already there', () => {
  expect(
    message(
      { [repositoryFoldersKey]: [{ name: 'Work', repositories: ['octo/app', 'octo/api'] }] },
      { [repositoryFoldersKey]: [{ name: 'Team', repositories: ['octo/app', 'octo/api', 'octo/new'] }] },
    ),
  ).toBe('Rename folder: Work to Team; move repository to folder Team: octo/new');
});

test('a repository taken out of a folder renamed in case is named with the new name', () => {
  expect(
    message(
      { [repositoryFoldersKey]: [{ name: 'work', repositories: ['octo/a', 'octo/b'] }] },
      { [repositoryFoldersKey]: [{ name: 'Work', repositories: ['octo/b'] }] },
    ),
  ).toBe('Rename folder: work to Work; take repository out of folder Work: octo/a');
});

test('a folder renamed into one already there is deleted, and its repositories move', () => {
  expect(
    message(
      {
        [repositoryFoldersKey]: [
          { name: 'Home', repositories: ['octo/site'] },
          { name: 'Old', repositories: ['octo/app'] },
        ],
      },
      { [repositoryFoldersKey]: [{ name: 'Home', repositories: ['octo/site', 'octo/app'] }] },
    ),
  ).toBe('Delete folder: Old; move repository to folder Home: octo/app');
});

test('a folder deleted and another made in one save are not a rename', () => {
  expect(
    message(
      { [repositoryFoldersKey]: [{ name: 'Old', repositories: ['octo/a', 'octo/b'] }] },
      { [repositoryFoldersKey]: [{ name: 'New', repositories: [] }] },
    ),
  ).toBe('Create folder: New; delete folder: Old');
});

test('an empty folder renamed is a rename', () => {
  expect(
    message(
      { [repositoryFoldersKey]: [{ name: 'Later', repositories: [] }] },
      { [repositoryFoldersKey]: [{ name: 'Someday', repositories: [] }] },
    ),
  ).toBe('Rename folder: Later to Someday');
});

test('a batch too long for the subject counts each kind and lists every change', () => {
  const hidden = Array.from({ length: 12 }, (_, index) => `lunchbox-labs/repository-${index + 1}`);
  const lines = message(
    { [repositoryFoldersKey]: [{ name: 'Archive', repositories: [] }] },
    {
      [hiddenRepositoriesKey]: hidden,
      [repositoryFoldersKey]: [{ name: 'Archive', repositories: hidden }],
    },
  ).split('\n');

  expect(lines[0]).toBe('Hide 12 repositories; move 12 repositories to folder Archive');
  expect(lines.slice(2)).toEqual([
    ...hidden.map((name) => `- Hide repository: ${name}`),
    ...hidden.map((name) => `- Move repository to folder Archive: ${name}`),
  ]);
});
