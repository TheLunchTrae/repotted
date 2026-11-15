import { type GitHub, GitHubError, parseRepo } from '@repotted/core';
import * as z from 'zod/mini';

import { readRepositoryFile, writeRepositoryFile } from '../storage/repository-files.js';

/** The topic that marks a repository as where the user keeps profiles, so a new browser can find it. */
export const configTopic = 'repotted-config';
/** At the repository's root, naming the folder that holds the profiles. Hidden, so a sync leaves it out. */
export const markerFile = '.repotted.json';

const markerCommitMessage = 'Name the Repotted profiles folder';
const topicNames = z.object({ names: z.array(z.string()) });
const marker = z.object({ folder: z.string() });

/** Undefined for a marker that is missing, isn't JSON, or names no folder a sync can use. */
export type MarkedFolder = string | undefined;

function topicsPath(repository: string): string {
  const repo = parseRepo(repository);
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/topics`;
}

/** As the connect form trims it, so a folder named either way is the same folder. */
export function normalFolder(folder: string): string {
  return folder.trim().replace(/^\/+|\/+$/gu, '');
}

/** A sync never reads a hidden folder, and `..` would leave the repository. */
function usableFolder(folder: string): boolean {
  return folder === '' || folder.split('/').every((part) => part !== '' && !part.startsWith('.'));
}

function markerText(folder: string): string {
  return `${JSON.stringify({ folder }, null, 2)}\n`;
}

function markedFolderOf(text: string): MarkedFolder {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const found = marker.safeParse(parsed);
  if (!found.success) {
    return undefined;
  }
  const folder = normalFolder(found.data.folder);
  return usableFolder(folder) ? folder : undefined;
}

export async function readMarkedFolder(github: GitHub, repository: string): Promise<MarkedFolder> {
  const file = await readRepositoryFile(github, repository, markerFile);
  return file === undefined ? undefined : markedFolderOf(file.text);
}

async function readTopics(github: GitHub, repository: string): Promise<readonly string[]> {
  return topicNames.parse(await github.request('GET', topicsPath(repository))).names;
}

/**
 * Adds the topic, keeping the repository's others, and commits the marker
 * unless one already names `folder`. Answers whether it made a commit.
 */
export async function markConfigRepository(github: GitHub, repository: string, folder: string): Promise<boolean> {
  const topics = await readTopics(github, repository);
  if (!topics.includes(configTopic)) {
    await github.request('PUT', topicsPath(repository), { names: [...topics, configTopic] });
  }
  const current = await readRepositoryFile(github, repository, markerFile);
  if (current !== undefined && markedFolderOf(current.text) === normalFolder(folder)) {
    return false;
  }
  try {
    await writeRepositoryFile(github, repository, markerFile, {
      text: markerText(normalFolder(folder)),
      sha: current?.sha,
      message: markerCommitMessage,
    });
    return true;
  } catch (error) {
    // Another browser wrote the marker since it was read, naming the folder it just connected, which wins.
    if (error instanceof GitHubError && (error.status === 409 || error.status === 422)) {
      return false;
    }
    throw error;
  }
}

/** Takes the topic off and leaves the marker, which names nothing to a browser without the topic. */
export async function unmarkConfigRepository(github: GitHub, repository: string): Promise<void> {
  const topics = await readTopics(github, repository);
  if (topics.includes(configTopic)) {
    await github.request('PUT', topicsPath(repository), { names: topics.filter((topic) => topic !== configTopic) });
  }
}
