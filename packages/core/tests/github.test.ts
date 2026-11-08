import { afterEach, describe, expect, test, vi } from 'vitest';

import { createGitHub, GitHubError } from '../src/github.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Makes Octokit's requests answer with this status, JSON body and headers. */
function answer(status: number, body: unknown, headers: Record<string, string> = {}): void {
  vi.stubGlobal('fetch', () =>
    Promise.resolve(
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } }),
    ),
  );
}

async function failure(): Promise<unknown> {
  return createGitHub('token')
    .request('PUT', '/repos/lunch/app/rulesets/1', {})
    .then(
      () => undefined,
      (error: unknown) => error,
    );
}

describe('createGitHub', () => {
  test("keeps GitHub's message and error details, and its docs link apart", async () => {
    answer(422, {
      message: 'Validation Failed',
      errors: [{ resource: 'Ruleset', code: 'custom', message: 'Invalid target patterns' }, "Invalid rule 'x'"],
      documentation_url: 'https://docs.github.com/rest/repos/rules',
      status: '422',
    });

    const error = await failure();
    expect(error).toBeInstanceOf(GitHubError);
    expect(error).toMatchObject({
      status: 422,
      message: "Validation Failed: Invalid target patterns: Invalid rule 'x'",
      documentationUrl: 'https://docs.github.com/rest/repos/rules',
      rateLimited: false,
    });
  });

  test("keeps GitHub's message when its other fields come in an unexpected form", async () => {
    answer(422, { message: 'Update is not a fast forward', errors: 'not a list', documentation_url: null });
    expect(await failure()).toMatchObject({
      status: 422,
      message: 'Update is not a fast forward',
      documentationUrl: undefined,
    });

    answer(403, { message: 'Upgrade to GitHub Pro', errors: { message: 'an object' }, documentation_url: 7 });
    expect(await failure()).toMatchObject({
      status: 403,
      message: 'Upgrade to GitHub Pro',
      documentationUrl: undefined,
    });
  });

  test('reads a rate limit from the status and the headers GitHub sends with it', async () => {
    for (const [status, headers] of [
      [403, { 'x-ratelimit-remaining': '0' }],
      [403, { 'retry-after': '60' }],
      [429, {}],
    ] as const) {
      answer(status, { message: 'Forbidden' }, headers);
      expect(await failure(), `${status} ${JSON.stringify(headers)}`).toMatchObject({ status, rateLimited: true });
    }

    answer(403, { message: 'Forbidden' });
    expect(await failure()).toMatchObject({ status: 403, rateLimited: false });
    answer(403, { message: 'Resource not accessible by integration' }, { 'x-ratelimit-remaining': '4999' });
    expect(await failure()).toMatchObject({ status: 403, rateLimited: false });
  });

  test("keeps Octokit's status and message for a request that never reached GitHub", async () => {
    vi.stubGlobal('fetch', () =>
      Promise.reject(new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND') })),
    );

    const error = await failure();
    expect(error).toBeInstanceOf(GitHubError);
    expect(error).toMatchObject({
      status: 500,
      message: 'getaddrinfo ENOTFOUND',
      documentationUrl: undefined,
      rateLimited: false,
    });
  });
});
