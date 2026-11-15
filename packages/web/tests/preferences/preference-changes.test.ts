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

test('names a preference by its key when nothing more is known', () => {
  expect(message({ other: 1 }, { other: 2 })).toBe('Update preference: other');
  expect(
    message({ [hiddenRepositoriesKey]: ['octo/a', 'octo/b'] }, { [hiddenRepositoriesKey]: ['octo/b', 'octo/a'] }),
  ).toBe(`Update preference: ${hiddenRepositoriesKey}`);
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
