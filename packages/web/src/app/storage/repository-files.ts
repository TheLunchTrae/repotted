import { type GitHub, GitHubError, parseRepo } from '@repotted/core';
import * as z from 'zod/mini';

export interface RepositoryFile {
  readonly sha: string;
  readonly text: string;
}

const contents = z.object({ sha: z.string(), content: z.string() });

function decode(base64: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(base64.replace(/\s/gu, '')), (char) => char.charCodeAt(0)));
}

function encode(text: string): string {
  return btoa(Array.from(new TextEncoder().encode(text), (byte) => String.fromCharCode(byte)).join(''));
}

function contentsPath(repository: string, file: string): string {
  const repo = parseRepo(repository);
  const encodedFile = file.split('/').map(encodeURIComponent).join('/');
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/contents/${encodedFile}`;
}

/** Undefined when the default branch has no such file. */
export async function readRepositoryFile(
  github: GitHub,
  repository: string,
  file: string,
): Promise<RepositoryFile | undefined> {
  let answer: unknown;
  try {
    answer = await github.request('GET', contentsPath(repository, file));
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) {
      return undefined;
    }
    throw error;
  }
  const found = contents.parse(answer);
  return { sha: found.sha, text: decode(found.content) };
}

/**
 * Commits the file to the default branch. `sha` is the blob it replaces, or
 * undefined for a new file; GitHub answers 409 or 422 when that is no longer so.
 */
export async function writeRepositoryFile(
  github: GitHub,
  repository: string,
  file: string,
  change: { readonly text: string; readonly sha: string | undefined; readonly message: string },
): Promise<void> {
  await github.request('PUT', contentsPath(repository, file), {
    message: change.message,
    content: encode(change.text),
    ...(change.sha === undefined ? {} : { sha: change.sha }),
  });
}
