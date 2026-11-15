import { z } from 'zod';

import { fromBase64 } from './bytes.js';
import { type GitHub, GitHubError, parseRepo, type RepoRef, repoPath } from './github.js';
import { isProfilePath, repositoryFolder, SyncError } from './sync.js';

export type BranchProfileChange =
  | { readonly status: 'added' | 'modified'; readonly profilePath: string; readonly content: Uint8Array }
  | { readonly status: 'removed'; readonly profilePath: string }
  | {
      readonly status: 'renamed';
      readonly profilePath: string;
      readonly previousProfilePath: string;
      readonly content: Uint8Array;
    };

export interface BranchChanges {
  readonly repository: string;
  readonly path: string;
  readonly branch: string;
  readonly defaultBranch: string;
  readonly defaultBranchCommit: string;
  readonly branchCommit: string;
  readonly commitsAheadOfDefaultBranch: number;
  readonly commitsBehindDefaultBranch: number;
  readonly changedFilesTruncated: boolean;
  readonly changedProfiles: readonly BranchProfileChange[];
  readonly otherChangedFiles: readonly string[];
}

export interface BranchOptions {
  readonly repository: string;
  readonly path?: string;
}

const comparisonFileListLimit = 300;
const concurrentBlobReads = 4;

const repositoryInfo = z.looseObject({ default_branch: z.string() });
const comparison = z.looseObject({
  ahead_by: z.number(),
  behind_by: z.number(),
  base_commit: z.looseObject({ sha: z.string() }),
  merge_base_commit: z.looseObject({ sha: z.string() }),
  files: z
    .array(
      z.looseObject({
        filename: z.string(),
        status: z.string(),
        sha: z
          .string()
          .nullish()
          .transform((value) => value ?? undefined),
        previous_filename: z
          .string()
          .nullish()
          .transform((value) => value ?? undefined),
      }),
    )
    .default([]),
});
const headInfo = z.looseObject({ object: z.looseObject({ sha: z.string() }) });
const blobInfo = z.looseObject({ content: z.string(), encoding: z.literal('base64') });
const branchList = z.array(z.looseObject({ name: z.string() }));

function encodeBranchKeepingSlashes(branch: string): string {
  return branch.split('/').map(encodeURIComponent).join('/');
}

/** Git refuses a part that is empty or starts with a dot, and a `.` or `..` part would move the request to another path. */
function isBranchName(branch: string): boolean {
  return branch.split('/').every((part) => part !== '' && !part.startsWith('.'));
}

function explainRefusedRead(error: unknown, repository: string, branch: string | undefined): unknown {
  if (!(error instanceof GitHubError)) {
    return error;
  }
  if (error.status === 404 && branch !== undefined) {
    return new SyncError(`${repository} has no branch named ${branch}, or Repotted cannot read it.`, { cause: error });
  }
  if (error.status === 403 || error.status === 404) {
    return new SyncError(
      `Repotted cannot read ${repository}: ${error.message.split('\n')[0] ?? error.message}. The Repotted App must be installed on it, with the Contents permission.`,
      { cause: error },
    );
  }
  return error;
}

async function readDefaultBranch(github: GitHub, repo: RepoRef, repository: string): Promise<string> {
  try {
    return repositoryInfo.parse(await github.request('GET', repoPath(repo))).default_branch;
  } catch (error) {
    throw explainRefusedRead(error, repository, undefined);
  }
}

export async function listBranches(
  github: GitHub,
  repository: string,
): Promise<{
  readonly defaultBranch: string;
  readonly branches: readonly string[];
  readonly moreBranchesThanListed: boolean;
}> {
  const repo = parseRepo(repository);
  const defaultBranch = await readDefaultBranch(github, repo, repository);
  let listed: { name: string }[];
  try {
    listed = branchList.parse(await github.request('GET', `${repoPath(repo)}/branches?per_page=100`));
  } catch (error) {
    throw explainRefusedRead(error, repository, undefined);
  }
  return {
    defaultBranch,
    branches: listed.map((item) => item.name).filter((name) => name !== defaultBranch),
    moreBranchesThanListed: listed.length >= 100,
  };
}

function pathInsideFolder(file: string, folder: string): string | undefined {
  if (folder === '') {
    return file;
  }
  return file.startsWith(`${folder}/`) ? file.slice(folder.length + 1) : undefined;
}

/** Only changes made on the branch count: what the default branch changed since is left out, as in a pull request's diff. */
export async function readBranchChanges(
  github: GitHub,
  branch: string,
  options: BranchOptions,
): Promise<BranchChanges> {
  if (!isBranchName(branch)) {
    throw new SyncError(`${branch} is not a branch name.`);
  }
  const repo = parseRepo(options.repository);
  const folder = repositoryFolder(options.path);
  const defaultBranch = await readDefaultBranch(github, repo, options.repository);
  if (branch === defaultBranch) {
    throw new SyncError(`${branch} is the default branch of ${options.repository}, which the profiles come from.`);
  }
  let branchCommit: string;
  try {
    // The singular endpoint matches the name exactly, where the plural one lists every branch it starts.
    branchCommit = headInfo.parse(
      await github.request('GET', `${repoPath(repo)}/git/ref/heads/${encodeBranchKeepingSlashes(branch)}`),
    ).object.sha;
  } catch (error) {
    throw explainRefusedRead(error, options.repository, branch);
  }
  let compared: z.infer<typeof comparison>;
  try {
    // Files are listed on the first page whatever its size, so one commit a page keeps the answer small.
    compared = comparison.parse(
      await github.request(
        'GET',
        `${repoPath(repo)}/compare/${encodeBranchKeepingSlashes(defaultBranch)}...${encodeURIComponent(branchCommit)}?per_page=1`,
      ),
    );
  } catch (error) {
    // The branch exists, so a 404 here means it shares no history with the default branch.
    if (error instanceof GitHubError && error.status === 404) {
      throw new SyncError(
        `${branch} shares no history with ${defaultBranch} in ${options.repository}, so it can't be compared.`,
        {
          cause: error,
        },
      );
    }
    throw explainRefusedRead(error, options.repository, undefined);
  }
  const read = async (sha: string): Promise<Uint8Array> => {
    try {
      return fromBase64(blobInfo.parse(await github.request('GET', `${repoPath(repo)}/git/blobs/${sha}`)).content);
    } catch (error) {
      throw explainRefusedRead(error, options.repository, undefined);
    }
  };
  type ProfileChangeAwaitingContent =
    | { readonly status: 'removed'; readonly profilePath: string }
    | { readonly status: 'added' | 'modified'; readonly profilePath: string; readonly sha: string }
    | {
        readonly status: 'renamed';
        readonly profilePath: string;
        readonly previousProfilePath: string;
        readonly sha: string;
      };
  const changesAwaitingContent: ProfileChangeAwaitingContent[] = [];
  const otherChangedFiles: string[] = [];
  for (const entry of compared.files) {
    const file = pathInsideFolder(entry.filename, folder);
    const was = entry.previous_filename === undefined ? undefined : pathInsideFolder(entry.previous_filename, folder);
    const profile = file !== undefined && isProfilePath(file) ? file : undefined;
    const wasProfile = was !== undefined && isProfilePath(was) ? was : undefined;
    if (file !== undefined && profile === undefined) {
      otherChangedFiles.push(file);
    }
    if (entry.status === 'unchanged') {
      continue;
    }
    if (entry.status === 'renamed' && wasProfile !== undefined) {
      changesAwaitingContent.push(
        profile !== undefined && entry.sha !== undefined
          ? { status: 'renamed', profilePath: profile, previousProfilePath: wasProfile, sha: entry.sha }
          : // Moved out of the profiles, or to a name a profile can't have, it is gone from them.
            { status: 'removed', profilePath: wasProfile },
      );
      continue;
    }
    if (profile === undefined) {
      continue;
    }
    if (entry.status === 'removed') {
      changesAwaitingContent.push({ status: 'removed', profilePath: profile });
    } else if (entry.sha !== undefined) {
      // A copy, or a file moved in from outside the profiles, is new to them.
      const status = entry.status === 'modified' || entry.status === 'changed' ? 'modified' : 'added';
      changesAwaitingContent.push({ status, profilePath: profile, sha: entry.sha });
    }
  }
  const changedProfiles: BranchProfileChange[] = [];
  for (let start = 0; start < changesAwaitingContent.length; start += concurrentBlobReads) {
    changedProfiles.push(
      ...(await Promise.all(
        changesAwaitingContent
          .slice(start, start + concurrentBlobReads)
          .map(async (change): Promise<BranchProfileChange> => {
            if (change.status === 'removed') {
              return change;
            }
            const { sha, ...rest } = change;
            return { ...rest, content: await read(sha) };
          }),
      )),
    );
  }
  return {
    repository: options.repository,
    path: folder,
    branch,
    defaultBranch,
    defaultBranchCommit: compared.base_commit.sha,
    branchCommit,
    commitsAheadOfDefaultBranch: compared.ahead_by,
    commitsBehindDefaultBranch: compared.behind_by,
    changedFilesTruncated: compared.files.length >= comparisonFileListLimit,
    changedProfiles,
    otherChangedFiles,
  };
}
