import { z } from 'zod';

import type { Change } from '../change.js';
import { type GitHub, repoPath, type RepoRef } from '../github.js';
import { fieldChanges } from '../match.js';
import { mergeFields, type MergeSettings, type Profile, repositoryFields, type RepositorySettings } from '../schema.js';

// Each schema drops the response keys it does not manage.
const liveRepository = z.object(repositoryFields).partial();
const liveMerge = z.object(mergeFields).partial();

export interface LiveRepository {
  readonly repository: RepositorySettings;
  readonly merge: MergeSettings;
}

export async function readRepository(github: GitHub, repo: RepoRef): Promise<LiveRepository> {
  const data = await github.request('GET', repoPath(repo));
  return { repository: liveRepository.parse(data), merge: liveMerge.parse(data) };
}

const commitSettingPairs = [
  ['merge_commit_title', 'merge_commit_message'],
  ['squash_merge_commit_title', 'squash_merge_commit_message'],
] as const;

function settingsChange(
  section: 'repository' | 'merge',
  target: string,
  desired: Record<string, unknown>,
  live: Record<string, unknown>,
  repo: RepoRef,
): Change[] {
  const fields = fieldChanges(desired, live);
  if (fields.length === 0) {
    return [];
  }
  const body: Record<string, unknown> = Object.fromEntries(fields.map((field) => [field.field, field.to]));
  // GitHub takes a commit message setting only with its title setting, so a
  // write of either carries both, using the live value for the other.
  for (const pair of commitSettingPairs) {
    if (pair.some((key) => key in body)) {
      for (const key of pair) {
        const value = body[key] ?? desired[key] ?? live[key];
        if (value !== undefined) {
          body[key] = value;
        }
      }
    }
  }
  return [
    {
      section,
      action: 'update',
      target,
      fields,
      request: {
        method: 'PATCH',
        path: repoPath(repo),
        body,
      },
    },
  ];
}

export function planRepository(
  desired: Pick<Profile, 'repository' | 'merge'>,
  live: LiveRepository,
  repo: RepoRef,
): Change[] {
  return [
    ...(desired.repository === undefined
      ? []
      : settingsChange('repository', 'repository settings', desired.repository, live.repository, repo)),
    ...(desired.merge === undefined ? [] : settingsChange('merge', 'merge methods', desired.merge, live.merge, repo)),
  ];
}
