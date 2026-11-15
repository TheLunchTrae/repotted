import { Octokit } from '@octokit/core';
import { z } from 'zod';

export type Method = 'GET' | 'PATCH' | 'POST' | 'PUT' | 'DELETE';

/** Responses are untrusted and parsed by each section. */
export interface GitHub {
  request(method: Method, path: string, body?: unknown): Promise<unknown>;
}

/**
 * The message is GitHub's own, followed by the details it lists in `errors`.
 * Its documentation link is kept apart, so a reason shown to people does not
 * carry it.
 */
export class GitHubError extends Error {
  readonly status: number;
  readonly documentationUrl: string | undefined;
  readonly rateLimited: boolean;
  readonly retryAt: Date | undefined;

  constructor(
    status: number,
    message: string,
    details: { readonly documentationUrl?: string; readonly rateLimited?: boolean; readonly retryAt?: Date } = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'GitHubError';
    this.status = status;
    this.documentationUrl = details.documentationUrl;
    this.rateLimited = details.rateLimited ?? false;
    this.retryAt = details.retryAt;
  }
}

// A field in an unexpected form is left out, so GitHub's message survives it.
const errorBody = z.object({
  message: z.string(),
  errors: z.array(z.unknown()).optional().catch(undefined),
  documentation_url: z.string().optional().catch(undefined),
});

// GitHub's standard validation errors carry no message, and read as `key_prefix already_exists`.
function errorDetail(item: unknown): string[] {
  if (typeof item === 'string') {
    return [item];
  }
  const field = (key: string): string | undefined => {
    const value: unknown = typeof item === 'object' && item !== null ? Reflect.get(item, key) : undefined;
    return typeof value === 'string' && value !== '' ? value : undefined;
  };
  const message = field('message');
  if (message !== undefined) {
    return [message];
  }
  const named = [field('field') ?? field('resource'), field('code')].filter((part) => part !== undefined);
  return named.length === 0 ? [] : [named.join(' ')];
}

function retryTime(headers: Readonly<Record<string, unknown>>, now: number): Date | undefined {
  const after = Number(headers['retry-after']);
  if (headers['retry-after'] !== undefined && Number.isFinite(after) && after >= 0) {
    return new Date(now + after * 1000);
  }
  const reset = Number(headers['x-ratelimit-reset']);
  return String(headers['x-ratelimit-remaining']) === '0' &&
    headers['x-ratelimit-reset'] !== undefined &&
    Number.isFinite(reset)
    ? new Date(reset * 1000)
    : undefined;
}

/**
 * GitHub answers a rate limit with a 429, or a 403 with no requests remaining
 * or a `retry-after`. A secondary limit can come with neither header, and only
 * its message then says it is a rate limit.
 */
export function responseError(
  status: number,
  data: unknown,
  headers: Readonly<Record<string, unknown>> = {},
  options?: ErrorOptions,
): GitHubError {
  const body = errorBody.safeParse(data);
  const documentationUrl = body.success ? body.data.documentation_url : undefined;
  const message = body.success
    ? [body.data.message, ...(body.data.errors ?? []).flatMap(errorDetail)].join(': ')
    : typeof data === 'string' && data !== ''
      ? data
      : `GitHub answered ${status}`;
  const rateLimited =
    status === 429 ||
    (status === 403 &&
      (String(headers['x-ratelimit-remaining']) === '0' ||
        headers['retry-after'] !== undefined ||
        /rate limit/iu.test(message)));
  const retryAt = rateLimited ? retryTime(headers, Date.now()) : undefined;
  return new GitHubError(
    status,
    message,
    {
      ...(documentationUrl === undefined ? {} : { documentationUrl }),
      rateLimited,
      ...(retryAt === undefined ? {} : { retryAt }),
    },
    options,
  );
}

export interface RepoRef {
  readonly owner: string;
  readonly name: string;
}

export const repoPattern = /^([\w.-]+)\/([\w.-]+)$/u;

export function parseRepo(value: string): RepoRef {
  const match = repoPattern.exec(value);
  const owner = match?.[1];
  const name = match?.[2];
  // GitHub names never consist of dots alone, and `..` would leave /repos.
  if (owner === undefined || name === undefined || /^\.+$/u.test(owner) || /^\.+$/u.test(name)) {
    throw new Error(`Expected a repository as owner/name, got "${value}"`);
  }
  return { owner, name };
}

export function repoPath(repo: RepoRef): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
}

const octokitRequestError = z.object({
  status: z.number(),
  response: z.object({ data: z.unknown(), headers: z.record(z.string(), z.unknown()) }).optional(),
});

/**
 * An `auth` that is a `fetch` sends and signs each request itself, which lets
 * a sign-in that refreshes its token supply the current one.
 */
export function createGitHub(auth: string | typeof fetch): GitHub {
  const octokit = new Octokit({
    userAgent: 'repotted',
    ...(typeof auth === 'string' ? { auth } : { request: { fetch: auth } }),
  });
  return {
    async request(method, path, body) {
      try {
        const response = await octokit.request(`${method} ${path}`, {
          headers: { 'x-github-api-version': '2022-11-28' },
          ...(body === undefined ? {} : { data: body }),
        });
        const data: unknown = response.data;
        return data;
      } catch (error) {
        const failure = octokitRequestError.safeParse(error);
        if (!failure.success || !(error instanceof Error)) {
          throw error;
        }
        const { status, response } = failure.data;
        // Octokit gives a request that never reached GitHub the status 500 and no response.
        throw response === undefined
          ? new GitHubError(status, error.message, {}, { cause: error })
          : responseError(status, response.data, response.headers, { cause: error });
      }
    },
  };
}

const pageSize = 100;

export async function readAllPages<Item>(
  path: string,
  fetchPage: (url: string) => Promise<{ readonly items: readonly Item[]; readonly total?: number }>,
): Promise<Item[]> {
  const items: Item[] = [];
  const separator = path.includes('?') ? '&' : '?';
  for (let page = 1; ; page += 1) {
    const { items: pageItems, total } = await fetchPage(`${path}${separator}per_page=${pageSize}&page=${page}`);
    items.push(...pageItems);
    if (pageItems.length < pageSize || (total !== undefined && items.length >= total)) {
      return items;
    }
  }
}
