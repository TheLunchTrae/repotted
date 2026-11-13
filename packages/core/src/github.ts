import { Octokit } from '@octokit/core';
import { z } from 'zod';

export type Method = 'GET' | 'PATCH' | 'POST' | 'PUT' | 'DELETE';

/** The REST calls Repotted makes. Responses are untrusted and parsed by each section. */
export interface GitHub {
  request(method: Method, path: string, body?: unknown): Promise<unknown>;
}

/**
 * A request GitHub answered with an error. The message is GitHub's own,
 * followed by the details it lists in `errors`; the page of its docs that it
 * links to is kept apart, so a reason shown to people does not carry it.
 */
export class GitHubError extends Error {
  readonly status: number;
  readonly documentationUrl: string | undefined;
  /** Whether GitHub refused the request for a rate limit, which a later try may pass. */
  readonly rateLimited: boolean;

  constructor(
    status: number,
    message: string,
    details: { readonly documentationUrl?: string; readonly rateLimited?: boolean } = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'GitHubError';
    this.status = status;
    this.documentationUrl = details.documentationUrl;
    this.rateLimited = details.rateLimited ?? false;
  }
}

// A field in an unexpected form is left out, so GitHub's message survives it.
const errorBody = z.object({
  message: z.string(),
  errors: z.array(z.unknown()).optional().catch(undefined),
  documentation_url: z.string().optional().catch(undefined),
});

/**
 * One of GitHub's `errors` as text: a string as it is, an object by its
 * `message`, and one without a message, such as GitHub's standard validation
 * errors, by its field, or else its resource, and its code, as
 * `key_prefix already_exists`.
 */
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

/**
 * The error for a response GitHub sent with an error status, from its body
 * and headers. GitHub answers a rate limit with a 429, or a 403 with no
 * requests remaining or a `retry-after`; a secondary limit can come with
 * neither header, and its message then says it is a rate limit.
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
  return new GitHubError(
    status,
    message,
    { ...(documentationUrl === undefined ? {} : { documentationUrl }), rateLimited },
    options,
  );
}

/** A repository named `owner/name`. */
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

// What Octokit's RequestError carries: the response, when GitHub sent one.
const requestFailure = z.object({
  status: z.number(),
  response: z.object({ data: z.unknown(), headers: z.record(z.string(), z.unknown()) }).optional(),
});

/**
 * A client for GitHub's REST API. It signs requests with `auth` when that is
 * a token; when it is a `fetch`, that function sends each request and signs
 * it, which lets a sign-in that refreshes its token supply the current one.
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
        const failure = requestFailure.safeParse(error);
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

/**
 * Reads a list GitHub serves in pages, a page at a time, until a page comes
 * back short or the items reach the `total` a page reports.
 */
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
