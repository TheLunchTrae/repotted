import { describe, expect, test } from 'vitest';

import { checkActionPatterns, describeActionCheck, findActions } from '../src/action-patterns.js';
import { type GitHub, GitHubError, responseError } from '../src/github.js';

/** A GitHub that answers each path with what `answers` holds for it, throws what is an error, and 404s the rest. */
function fakeGitHub(answers: Readonly<Record<string, unknown>>): GitHub & { readonly paths: string[] } {
  const paths: string[] = [];
  return {
    paths,
    request(_method, path) {
      paths.push(path);
      const answer = answers[path];
      return answer === undefined || answer instanceof Error
        ? Promise.reject(answer ?? new GitHubError(404, 'Not Found'))
        : Promise.resolve(answer);
    },
  };
}

const codeql = { full_name: 'github/codeql-action', archived: false };

describe('checkActionPatterns', () => {
  test('says what is not a pattern without asking GitHub', async () => {
    const github = fakeGitHub({});

    const checks = await checkActionPatterns(github, [
      'octo org/tools',
      '!',
      'octo-org',
      'octo-org/',
      'octo-org//init@v1',
      'octo-org/deploy@v1@v2',
      'octo-org/deploy@',
      'octo_org/deploy',
      'octo-org/de?ploy',
      'octo-org/../deploy',
      'octo-org/deploy/../../x@v1',
      'octo-org/deploy@v1:2',
    ]);

    expect(checks.map((check) => (check.status === 'invalid' ? [check.reason, check.message] : check.status))).toEqual([
      ['space', "a name can't have a space"],
      ['empty', "it's empty"],
      ['missing_repository', 'it needs a repository, as owner/repository'],
      ['missing_repository', 'it needs a repository, as owner/repository'],
      ['empty_name', 'a name is missing beside a /'],
      ['several_refs', 'it has more than one @'],
      ['empty_ref', 'nothing follows the @'],
      ['invalid_characters', "an owner can't have _"],
      ['invalid_characters', "a repository can't have ?"],
      ['invalid_characters', "a repository can't be only dots"],
      ['invalid_characters', "a path can't be only dots"],
      ['invalid_characters', "a tag or branch can't have :"],
    ]);
    expect(github.paths).toEqual([]);
  });

  test('leaves what a wildcard cannot name unchecked, and says whether a pattern blocks', async () => {
    const github = fakeGitHub({});

    expect(await checkActionPatterns(github, ['*', 'space-org*/*', '!*/octocat**@*'])).toEqual([
      { pattern: '*', blocks: false, status: 'unchecked', why: 'everything' },
      { pattern: 'space-org*/*', blocks: false, status: 'unchecked', why: 'wildcard_owner' },
      { pattern: '!*/octocat**@*', blocks: true, status: 'unchecked', why: 'wildcard_owner' },
    ]);
    expect(github.paths).toEqual([]);
  });

  test('finds the owner of a wildcard repository as GitHub spells it', async () => {
    const github = fakeGitHub({
      '/users/Actions': { login: 'actions', type: 'Organization' },
      '/users/octocat': { login: 'octocat', type: 'User' },
    });

    expect(await checkActionPatterns(github, ['Actions/*', 'octocat/setup-*@v1', 'nobody/*'])).toEqual([
      {
        pattern: 'Actions/*',
        blocks: false,
        status: 'owner',
        owner: 'actions',
        owner_type: 'organization',
        all_repositories: true,
      },
      {
        pattern: 'octocat/setup-*@v1',
        blocks: false,
        status: 'owner',
        owner: 'octocat',
        owner_type: 'user',
        all_repositories: false,
      },
      { pattern: 'nobody/*', blocks: false, status: 'not_found', missing: 'owner', name: 'nobody' },
    ]);
  });

  test('finds a repository, its ref and its path, and what is missing', async () => {
    const sha = 'a'.repeat(40);
    const github = fakeGitHub({
      '/repos/Github/CodeQL-Action': codeql,
      '/repos/Github/CodeQL-Action/git/ref/tags/v3': { ref: 'refs/tags/v3' },
      '/repos/Github/CodeQL-Action/git/ref/heads/releases/v3': { ref: 'refs/heads/releases/v3' },
      [`/repos/Github/CodeQL-Action/commits/${sha}`]: { sha },
      '/repos/Github/CodeQL-Action/contents/init?ref=v3': [{ name: 'action.yml', type: 'file' }],
      '/repos/Github/CodeQL-Action/contents/.github/workflows/pr.yml': { name: 'pr.yml', type: 'file' },
      '/repos/octo-org/old-deploy': { full_name: 'octo-org/old-deploy', archived: true },
    });
    const match = { blocks: false, status: 'match', repository: 'github/codeql-action', archived: false };

    expect(
      await checkActionPatterns(github, [
        'Github/CodeQL-Action/init@v3',
        'Github/CodeQL-Action@releases/v3',
        `Github/CodeQL-Action@${sha}`,
        'Github/CodeQL-Action/.github/workflows/pr.yml@*',
        'Github/CodeQL-Action/*/x@v*',
        'Github/CodeQL-Action@v9',
        `Github/CodeQL-Action@${'b'.repeat(40)}`,
        'Github/CodeQL-Action/upload@v3',
        '!octo-org/old-deploy@*',
        'octo-org/deplyo@*',
      ]),
    ).toEqual([
      {
        pattern: 'Github/CodeQL-Action/init@v3',
        ...match,
        ref: 'v3',
        ref_kind: 'tag',
        path: 'init',
        path_kind: 'folder',
      },
      { pattern: 'Github/CodeQL-Action@releases/v3', ...match, ref: 'releases/v3', ref_kind: 'branch' },
      { pattern: `Github/CodeQL-Action@${sha}`, ...match, ref: sha, ref_kind: 'commit' },
      {
        pattern: 'Github/CodeQL-Action/.github/workflows/pr.yml@*',
        ...match,
        path: '.github/workflows/pr.yml',
        path_kind: 'file',
      },
      { pattern: 'Github/CodeQL-Action/*/x@v*', ...match },
      {
        pattern: 'Github/CodeQL-Action@v9',
        blocks: false,
        status: 'missing_ref',
        repository: 'github/codeql-action',
        ref: 'v9',
      },
      {
        pattern: `Github/CodeQL-Action@${'b'.repeat(40)}`,
        blocks: false,
        status: 'missing_ref',
        repository: 'github/codeql-action',
        ref: 'b'.repeat(40),
      },
      {
        pattern: 'Github/CodeQL-Action/upload@v3',
        blocks: false,
        status: 'missing_path',
        repository: 'github/codeql-action',
        path: 'upload',
      },
      {
        pattern: '!octo-org/old-deploy@*',
        blocks: true,
        status: 'match',
        repository: 'octo-org/old-deploy',
        archived: true,
      },
      {
        pattern: 'octo-org/deplyo@*',
        blocks: false,
        status: 'not_found',
        missing: 'repository',
        name: 'octo-org/deplyo',
      },
    ]);
  });

  test('asks once for what patterns share, and answers each pattern given, in order', async () => {
    const github = fakeGitHub({
      '/repos/github/codeql-action': codeql,
      '/repos/github/codeql-action/git/ref/tags/v3': { ref: 'refs/tags/v3' },
    });

    const checks = await checkActionPatterns(github, [
      'github/codeql-action@v3',
      ' github/codeql-action@*',
      'github/codeql-action@v3',
      '!github/codeql-action@v3',
    ]);

    expect(checks.map((check) => check.pattern)).toEqual([
      'github/codeql-action@v3',
      'github/codeql-action@*',
      'github/codeql-action@v3',
      '!github/codeql-action@v3',
    ]);
    expect(github.paths.toSorted()).toEqual([
      '/repos/github/codeql-action',
      '/repos/github/codeql-action/git/ref/tags/v3',
    ]);
  });

  test('looks up at most four patterns at once', async () => {
    let running = 0;
    let most = 0;
    const github: GitHub = {
      async request() {
        running += 1;
        most = Math.max(most, running);
        await new Promise((resolve) => {
          setImmediate(resolve);
        });
        running -= 1;
        return { login: 'actions', type: 'Organization' };
      },
    };

    const checks = await checkActionPatterns(
      github,
      Array.from({ length: 10 }, (_, index) => `owner-${index}/*`),
    );

    expect(checks).toHaveLength(10);
    expect(most).toBe(4);
  });

  test('reports a failed lookup on its pattern, a rate limit included, and goes on', async () => {
    const github = fakeGitHub({
      '/repos/octo-org/a': responseError(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' }),
      '/repos/octo-org/b': new GitHubError(500, 'Server Error'),
      '/repos/octo-org/c': { full_name: 'octo-org/c' },
    });

    expect(await checkActionPatterns(github, ['octo-org/a', 'octo-org/b', 'octo-org/c'])).toEqual([
      {
        pattern: 'octo-org/a',
        blocks: false,
        status: 'error',
        message: 'API rate limit exceeded',
        rate_limited: true,
      },
      { pattern: 'octo-org/b', blocks: false, status: 'error', message: 'Server Error', rate_limited: false },
      { pattern: 'octo-org/c', blocks: false, status: 'match', repository: 'octo-org/c', archived: false },
    ]);
  });

  test('fails as a whole when GitHub rejects the sign-in', async () => {
    const rejected = new GitHubError(401, 'Bad credentials');

    await expect(checkActionPatterns(fakeGitHub({ '/users/actions': rejected }), ['actions/*'])).rejects.toBe(rejected);
  });
});

test('describeActionCheck says each check in a line', async () => {
  const github = fakeGitHub({
    '/users/actions': { login: 'actions', type: 'Organization' },
    '/repos/github/codeql-action': codeql,
    '/repos/github/codeql-action/git/ref/tags/v3': { ref: 'refs/tags/v3' },
    '/repos/github/codeql-action/contents/init?ref=v3': [],
    [`/repos/github/codeql-action/commits/${'a'.repeat(40)}`]: {},
    '/repos/octo-org/old-deploy': { full_name: 'octo-org/old-deploy', archived: true },
    '/repos/octo-org/broken': new GitHubError(500, 'Server Error'),
  });

  const checks = await checkActionPatterns(github, [
    'actions/*',
    'github/codeql-action/init@v3',
    `github/codeql-action@${'a'.repeat(40)}`,
    'github/codeql-action@v9',
    'github/codeql-action/upload@*',
    'octo-org/deplyo@*',
    '!octo-org/old-deploy@*',
    'space-org*/*',
    '*',
    'octo org/tools',
    'octo-org/broken',
  ]);

  expect(checks.map(describeActionCheck)).toEqual([
    'actions/*: any repository from actions, an organization',
    'github/codeql-action/init@v3: github/codeql-action, folder init, tag v3',
    `github/codeql-action@${'a'.repeat(40)}: github/codeql-action, commit aaaaaaa`,
    'github/codeql-action@v9: github/codeql-action has no tag or branch v9',
    'github/codeql-action/upload@*: github/codeql-action has no upload folder or file',
    'octo-org/deplyo@*: no repository octo-org/deplyo you can see',
    '!octo-org/old-deploy@*: blocks octo-org/old-deploy, archived',
    "space-org*/*: a wildcard owner can't be checked",
    '*: matches every action',
    "octo org/tools: not a pattern: a name can't have a space",
    'octo-org/broken: could not be checked: Server Error',
  ]);
});

describe('findActions', () => {
  const search = '/search/repositories?q=setup%20dotnet%20archived%3Afalse&sort=stars&order=desc&per_page=10';

  test('lists the repositories a search finds, and the action file at the top of each', async () => {
    const github = fakeGitHub({
      [search]: {
        items: [
          { full_name: 'actions/setup-dotnet', description: 'Set up .NET', stargazers_count: 1100 },
          { full_name: 'dotnet/sdk', description: null, stargazers_count: 3000 },
          { full_name: 'octo-org/yaml-action' },
          { full_name: 'octo-org/empty' },
        ],
      },
      '/repos/actions/setup-dotnet/contents/': [
        { name: 'README.md', type: 'file' },
        { name: 'action.yml', type: 'file' },
      ],
      '/repos/dotnet/sdk/contents/': [{ name: 'action.yml', type: 'dir' }],
      '/repos/octo-org/yaml-action/contents/': [{ name: 'action.yaml', type: 'file' }],
    });

    expect(await findActions(github, 'setup dotnet')).toEqual([
      { repository: 'actions/setup-dotnet', description: 'Set up .NET', stars: 1100, action_file: 'action.yml' },
      { repository: 'dotnet/sdk', description: null, stars: 3000, action_file: null },
      { repository: 'octo-org/yaml-action', description: null, stars: 0, action_file: 'action.yaml' },
      { repository: 'octo-org/empty', description: null, stars: 0, action_file: null },
    ]);
  });

  test('fails with the rate limit when GitHub limits the search or a listing', async () => {
    const limited = responseError(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' });

    await expect(findActions(fakeGitHub({ [search]: limited }), 'setup dotnet')).rejects.toBe(limited);
    await expect(
      findActions(
        fakeGitHub({ [search]: { items: [{ full_name: 'a/b' }] }, '/repos/a/b/contents/': limited }),
        'setup dotnet',
      ),
    ).rejects.toBe(limited);
  });
});
