import { Octokit } from '@octokit/core';

export type Method = 'GET' | 'PATCH' | 'POST' | 'PUT' | 'DELETE';

/** The REST calls Repotted makes. Responses are untrusted and parsed by each section. */
export interface GitHub {
  request(method: Method, path: string, body?: unknown): Promise<unknown>;
}

export class GitHubError extends Error {
  readonly status: number;

  constructor(status: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GitHubError';
    this.status = status;
  }
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
  if (owner === undefined || name === undefined) {
    throw new Error(`Expected a repository as owner/name, got "${value}"`);
  }
  return { owner, name };
}

export function repoPath(repo: RepoRef): string {
  return `/repos/${repo.owner}/${repo.name}`;
}

function errorStatus(error: unknown): number | undefined {
  if (error instanceof Error && 'status' in error && typeof error.status === 'number') {
    return error.status;
  }
  return undefined;
}

export function createGitHub(token: string): GitHub {
  const octokit = new Octokit({ auth: token, userAgent: 'repotted' });
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
        const status = errorStatus(error);
        if (status !== undefined && error instanceof Error) {
          throw new GitHubError(status, error.message, { cause: error });
        }
        throw error;
      }
    },
  };
}
