import { describe, expect, test } from 'vitest';

import {
  type ConfigChange,
  configCommitMessage,
  longestCommitSubject,
  mostCommitBodyLines,
  profileFileChanges,
} from '../../src/profiles/commit-messages.js';

function hide(name: string): ConfigChange {
  return { action: 'Hide', noun: 'repository', nouns: 'repositories', name };
}

function createProfile(name: string): ConfigChange {
  return { action: 'Create', noun: 'profile', nouns: 'profiles', name };
}

function subjectOf(message: string): string {
  return message.split('\n')[0] ?? '';
}

describe('configCommitMessage', () => {
  test('names one change in the subject alone', () => {
    expect(configCommitMessage([createProfile('web/base')])).toBe('Create profile: web/base');
  });

  test('puts the part after the noun before the names', () => {
    expect(
      configCommitMessage([
        { action: 'Move', noun: 'repository', nouns: 'repositories', after: 'to folder Work', name: 'octo/app' },
        { action: 'Move', noun: 'repository', nouns: 'repositories', after: 'to folder Work', name: 'octo/api' },
      ]),
    ).toBe('Move repositories to folder Work: octo/app, octo/api');
  });

  test('lists changes of one kind in one clause, and a name once', () => {
    expect(configCommitMessage([hide('octo/a'), hide('octo/b'), hide('octo/a')])).toBe(
      'Hide repositories: octo/a, octo/b',
    );
  });

  test('joins changes of different kinds that fit', () => {
    expect(
      configCommitMessage([
        createProfile('base'),
        { action: 'Delete', noun: 'profile', nouns: 'profiles', name: 'old' },
      ]),
    ).toBe('Create profile: base; delete profile: old');
  });

  test('names as many as fit, counts the rest, and lists each in the body', () => {
    const names = Array.from({ length: 8 }, (_, index) => `lunchbox-labs/repository-${index + 1}`);
    const message = configCommitMessage(names.map(hide));
    const subject = subjectOf(message);

    expect(subject).toBe('Hide repositories: lunchbox-labs/repository-1 and 7 more');
    expect(subject.length).toBeLessThanOrEqual(longestCommitSubject);
    expect(message.split('\n').slice(2)).toEqual(names.map((name) => `- Hide repository: ${name}`));
  });

  test('counts each kind when the names of several kinds do not fit', () => {
    const message = configCommitMessage([
      ...['web/base', 'web/strict', 'api/base'].map(createProfile),
      ...['octo/first-repository', 'octo/second-repository'].map(hide),
    ]);

    expect(subjectOf(message)).toBe('Create 3 profiles; hide 2 repositories');
    expect(message.split('\n').slice(2)).toEqual([
      '- Create profile: web/base',
      '- Create profile: web/strict',
      '- Create profile: api/base',
      '- Hide repository: octo/first-repository',
      '- Hide repository: octo/second-repository',
    ]);
  });

  test('counts the kinds that fit and the changes after them', () => {
    const kinds = ['Create', 'Update', 'Rename', 'Delete', 'Move', 'Copy', 'Archive', 'Restore'].map(
      (action): ConfigChange => ({ action, noun: 'profile', nouns: 'profiles', name: `${action.toLowerCase()}-one` }),
    );
    const subject = subjectOf(configCommitMessage(kinds));

    expect(subject).toBe('Create 1 profile; update 1 profile; rename 1 profile and 5 more changes');
  });

  test('clips a single name too long for any subject', () => {
    const subject = subjectOf(configCommitMessage([createProfile('x'.repeat(200))]));

    expect(subject).toHaveLength(longestCommitSubject);
    expect(subject.endsWith('…')).toBe(true);
  });

  test('stops the body at its longest and counts the rest', () => {
    const names = Array.from({ length: 120 }, (_, index) => `octo/repository-${index}`);
    const body = configCommitMessage(names.map(hide)).split('\n').slice(2);

    expect(body).toHaveLength(mostCommitBodyLines);
    expect(body.at(-1)).toBe(`- and ${120 - mostCommitBodyLines + 1} more`);
  });

  test('says files changed when nothing more is known', () => {
    expect(configCommitMessage([])).toBe('Update Repotted files');
  });
});

describe('profileFileChanges', () => {
  test('names profiles by their path without .yaml', () => {
    expect(
      configCommitMessage(
        profileFileChanges([
          { file: 'web/base.yaml', kind: 'update', contentId: 'a' },
          { file: 'api.yml', kind: 'create', contentId: 'b' },
          { file: 'old.yaml', kind: 'delete', contentId: 'c' },
        ]),
      ),
    ).toBe('Update profile: web/base; create profile: api; delete profile: old');
  });

  test('a delete and a create of the same content in one folder is a rename', () => {
    expect(
      profileFileChanges([
        { file: 'web/old.yaml', kind: 'delete', contentId: 'same' },
        { file: 'web/new.yaml', kind: 'create', contentId: 'same' },
      ]),
    ).toEqual([{ action: 'Rename', noun: 'profile', nouns: 'profiles', name: 'web/old to web/new' }]);
  });

  test('one into another folder is a move', () => {
    expect(
      configCommitMessage(
        profileFileChanges([
          { file: 'base.yaml', kind: 'delete', contentId: 'same' },
          { file: 'web/base.yaml', kind: 'create', contentId: 'same' },
        ]),
      ),
    ).toBe('Move profile: base to web/base');
  });

  test('pairs each create with one delete at most', () => {
    expect(
      configCommitMessage(
        profileFileChanges([
          { file: 'a.yaml', kind: 'delete', contentId: 'same' },
          { file: 'b.yaml', kind: 'delete', contentId: 'same' },
          { file: 'c.yaml', kind: 'create', contentId: 'same' },
        ]),
      ),
    ).toBe('Rename profile: a to c; delete profile: b');
  });
});
