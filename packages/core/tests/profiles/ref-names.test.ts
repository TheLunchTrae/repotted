import { describe, expect, test } from 'vitest';

import { entryValueProblems, settingValueProblems } from '../../src/profiles/profile.js';
import { branchNameProblem, branchPatternProblem } from '../../src/profiles/ref-names.js';
import { profile } from '../../src/profiles/schema.js';

describe('a branch name', () => {
  test.each(['main', 'release/1.2', 'feature/a-b_c', 'v1.0'])('takes %s', (name) => {
    expect(branchNameProblem(name)).toBeUndefined();
  });

  test.each([
    ['-main', "A branch name can't start with a dash."],
    ['HEAD', "A branch name can't be HEAD."],
    ['main dev', "A branch name can't have spaces."],
    ['release..1', "A branch name can't have two dots in a row."],
    ['a@{1}', "A branch name can't be @ or have @{ in it."],
    ['@', "A branch name can't be @ or have @{ in it."],
    ['feature*', "A branch name can't have ~ ^ : ? * [ or \\."],
    ['a:b', "A branch name can't have ~ ^ : ? * [ or \\."],
    ['/main', "A branch name can't start or end with /, or have two in a row."],
    ['main/', "A branch name can't start or end with /, or have two in a row."],
    ['a//b', "A branch name can't start or end with /, or have two in a row."],
    ['a/.hidden', 'No part of a branch name between slashes can start with a dot.'],
    ['a.lock/b', 'No part of a branch name between slashes can end with .lock.'],
    ['main.', "A branch name can't end with a dot."],
    ['tab\there', "A branch name can't have spaces."],
    ['bell\u0007', "A branch name can't have control characters."],
  ])('refuses %j', (name, problem) => {
    expect(branchNameProblem(name)).toBe(problem);
  });

  test('leaves an empty name to the field that holds it', () => {
    expect(branchNameProblem('')).toBeUndefined();
  });
});

describe('a deployment pattern', () => {
  test.each(['main', 'release/*', 'v[0-9]*', 'feature/?'])('takes %s, wildcards and all', (pattern) => {
    expect(branchPatternProblem(pattern)).toBeUndefined();
  });

  test.each([
    ['', "A pattern can't be empty."],
    ['release/ *', "A pattern can't have spaces."],
    ['~main', "A pattern can't have ~ ^ : or \\."],
    ['feature/**/', "A pattern can't start or end with /, or have two in a row."],
  ])('refuses %j', (pattern, problem) => {
    expect(branchPatternProblem(pattern)).toBe(problem);
  });
});

describe('the profile file', () => {
  test("refuses a default branch or Pages branch git wouldn't take", () => {
    expect(profile.safeParse({ repository: { default_branch: 'main dev' } }).error?.issues[0]?.message).toBe(
      "A branch name can't have spaces.",
    );
    expect(profile.safeParse({ pages: { source: { branch: 'gh..pages' } } }).error?.issues[0]?.message).toBe(
      "A branch name can't have two dots in a row.",
    );
    expect(profile.safeParse({ repository: { default_branch: 'main' } }).success).toBe(true);
  });

  test("refuses an environment's deployment pattern git wouldn't take", () => {
    const environment = {
      name: 'production',
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
      branch_policies: [{ name: 'release/*' }, { name: 'bad pattern', type: 'tag' }],
    };
    expect(profile.safeParse({ environments: [environment] }).error?.issues[0]).toMatchObject({
      path: ['environments', 0, 'branch_policies', 1, 'name'],
      message: "A pattern can't have spaces.",
    });
  });
});

describe('one value checked by the rules of the file', () => {
  test('checks a setting by its path, with the problem under its value', () => {
    expect(settingValueProblems('repository', ['default_branch'], 'main dev')).toEqual([
      { path: [], message: "A branch name can't have spaces." },
    ]);
    expect(settingValueProblems('repository', ['default_branch'], 'main')).toEqual([]);
    expect(settingValueProblems('pages', ['source', 'branch'], 'a..b')).toEqual([
      { path: [], message: "A branch name can't have two dots in a row." },
    ]);
  });

  test('takes any custom property, and names a setting a section lacks', () => {
    expect(settingValueProblems('custom_properties', ['team'], 'anything')).toEqual([]);
    expect(settingValueProblems('merge', ['no_such_setting'], true)).toEqual([
      { path: [], message: 'merge has no setting no_such_setting' },
    ]);
    expect(settingValueProblems('drafts', ['x'], 1)).toEqual([]);
  });

  test('checks a draft entry as the entry it would be once finished', () => {
    const problems = entryValueProblems('environments', {
      draft: true,
      name: 'staging',
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
      branch_policies: [{ name: 'a b' }],
    });
    expect(problems).toEqual([{ path: ['branch_policies', 0, 'name'], message: "A pattern can't have spaces." }]);
    expect(entryValueProblems('labels', { name: 'bug', color: 'd73a4a' })).toEqual([]);
  });
});
