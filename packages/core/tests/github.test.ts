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

  test('reads a rate limit from the headers GitHub sends with it', async () => {
    answer(403, { message: 'API rate limit exceeded for user ID 7.' }, { 'x-ratelimit-remaining': '0' });
    expect(await failure()).toMatchObject({ status: 403, rateLimited: true });

    answer(403, { message: 'Resource not accessible by integration' }, { 'x-ratelimit-remaining': '4999' });
    expect(await failure()).toMatchObject({ status: 403, rateLimited: false });
  });
});
