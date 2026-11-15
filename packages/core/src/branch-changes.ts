// What a branch of a config repository changes in its profiles, measured
// against the repository's default branch, for a preview that reads it
// without syncing it. GitHub works out which files changed, and only the
// changed profiles are read.

import { z } from 'zod';

import { fromBase64 } from './bytes.js';
import { type GitHub, GitHubError, parseRepo, type RepoRef, repoPath } from './github.js';
import { isProfilePath, repositoryFolder, SyncError } from './sync.js';

/** One profile a branch changes, by its path in the profiles folder. */
export type BranchFileChange =
  | { readonly status: 'added' | 'modified'; readonly file: string; readonly content: Uint8Array }
  | { readonly status: 'removed'; readonly file: string }
  /** Moved from `previous`, both paths in the profiles folder, and maybe changed as well. */
  | { readonly status: 'renamed'; readonly file: string; readonly previous: string; readonly content: Uint8Array };

export interface BranchChanges {
  readonly repository: string;
  readonly path: string;
  readonly branch: string;
  /** The default branch the branch is measured against. */
  readonly base: string;
  /** The default branch's commit, and the branch's own. */
  readonly baseCommit: string;
  readonly headCommit: string;
  /** How many commits the branch has that the default branch doesn't, and the other way round. */
  readonly ahead: number;
  readonly behind: number;
  /** Whether GitHub left changed files out of its list, which holds 300 at most. */
  readonly truncated: boolean;
  /** The profiles the branch changes, by path. */
  readonly files: readonly BranchFileChange[];
  /** Other files in the profiles folder that the branch changes, by path, such as the shared preferences. */
  readonly others: readonly string[];
}

export interface BranchOptions {
  /** `owner/name` of the config repository. */
  readonly repository: string;
  /** The folder in the repository that holds the profiles; the root when left out. */
  readonly path?: string;
}

/** The most files GitHub lists in a comparison. */
const compareLimit = 300;
/** How many blobs are read at once. */
const blobReads = 4;

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

/** A branch name as it goes in a path, each part encoded and the slashes kept. */
function encodeBranch(branch: string): string {
  return branch.split('/').map(encodeURIComponent).join('/');
}

/**
 * Whether a name could be a branch. Git refuses a part that is empty or starts
 * with a dot, and a `.` or `..` part would move the request to another path.
 */
function isBranchName(branch: string): boolean {
  return branch.split('/').every((part) => part !== '' && !part.startsWith('.'));
}

/** Says what to do when GitHub refuses a read, and passes anything else on. */
function explain(error: unknown, repository: string, branch: string | undefined): unknown {
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

async function defaultBranch(github: GitHub, repo: RepoRef, repository: string): Promise<string> {
  try {
    return repositoryInfo.parse(await github.request('GET', repoPath(repo))).default_branch;
  } catch (error) {
    throw explain(error, repository, undefined);
  }
}

/** The repository's default branch, then its other branches by name, as many as one page of GitHub's list holds. */
export async function listBranches(
  github: GitHub,
  repository: string,
): Promise<{ readonly base: string; readonly branches: readonly string[]; readonly more: boolean }> {
  const repo = parseRepo(repository);
  const base = await defaultBranch(github, repo, repository);
  let listed: { name: string }[];
  try {
    listed = branchList.parse(await github.request('GET', `${repoPath(repo)}/branches?per_page=100`));
  } catch (error) {
    throw explain(error, repository, undefined);
  }
  return {
    base,
    branches: listed.map((item) => item.name).filter((name) => name !== base),
    more: listed.length >= 100,
  };
}

/** A path in the repository as a path in the profiles folder, or undefined when it is outside the folder. */
function inFolder(file: string, folder: string): string | undefined {
  if (folder === '') {
    return file;
  }
  return file.startsWith(`${folder}/`) ? file.slice(folder.length + 1) : undefined;
}

/**
 * Reads what `branch` changes in the profiles since it left the default
 * branch, with the branch's content of each profile it adds or changes.
 * Only changes made on the branch count: what the default branch changed
 * since is left out, as a pull request's diff leaves it out.
 */
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
  const base = await defaultBranch(github, repo, options.repository);
  if (branch === base) {
    throw new SyncError(`${branch} is the default branch of ${options.repository}, which the profiles come from.`);
  }
  let headCommit: string;
  try {
    // The singular endpoint matches the name exactly, where the plural one lists every branch it starts.
    headCommit = headInfo.parse(await github.request('GET', `${repoPath(repo)}/git/ref/heads/${encodeBranch(branch)}`))
      .object.sha;
  } catch (error) {
    throw explain(error, options.repository, branch);
  }
  let compared: z.infer<typeof comparison>;
  try {
    // Files are listed on the first page whatever its size, so one commit a page keeps the answer small.
    compared = comparison.parse(
      await github.request(
        'GET',
        `${repoPath(repo)}/compare/${encodeBranch(base)}...${encodeURIComponent(headCommit)}?per_page=1`,
      ),
    );
  } catch (error) {
    // The branch exists, so a 404 here means it shares no history with the default branch.
    if (error instanceof GitHubError && error.status === 404) {
      throw new SyncError(
        `${branch} shares no history with ${base} in ${options.repository}, so it can't be compared.`,
        {
          cause: error,
        },
      );
    }
    throw explain(error, options.repository, undefined);
  }
  const read = async (sha: string): Promise<Uint8Array> => {
    try {
      return fromBase64(blobInfo.parse(await github.request('GET', `${repoPath(repo)}/git/blobs/${sha}`)).content);
    } catch (error) {
      throw explain(error, options.repository, undefined);
    }
  };
  // What each changed profile becomes, its content read once the list is known.
  type Pending =
    | { readonly status: 'removed'; readonly file: string }
    | { readonly status: 'added' | 'modified'; readonly file: string; readonly sha: string }
    | { readonly status: 'renamed'; readonly file: string; readonly previous: string; readonly sha: string };
  const pending: Pending[] = [];
  const others: string[] = [];
  for (const entry of compared.files) {
    const file = inFolder(entry.filename, folder);
    const was = entry.previous_filename === undefined ? undefined : inFolder(entry.previous_filename, folder);
    const profile = file !== undefined && isProfilePath(file) ? file : undefined;
    const wasProfile = was !== undefined && isProfilePath(was) ? was : undefined;
    if (file !== undefined && profile === undefined) {
      others.push(file);
    }
    if (entry.status === 'unchanged') {
      continue;
    }
    if (entry.status === 'renamed' && wasProfile !== undefined) {
      pending.push(
        profile !== undefined && entry.sha !== undefined
          ? { status: 'renamed', file: profile, previous: wasProfile, sha: entry.sha }
          : // Moved out of the profiles, or to a name a profile can't have, it is gone from them.
            { status: 'removed', file: wasProfile },
      );
      continue;
    }
    if (profile === undefined) {
      continue;
    }
    if (entry.status === 'removed') {
      pending.push({ status: 'removed', file: profile });
    } else if (entry.sha !== undefined) {
      // A copy, or a file moved in from outside the profiles, is new to them.
      const status = entry.status === 'modified' || entry.status === 'changed' ? 'modified' : 'added';
      pending.push({ status, file: profile, sha: entry.sha });
    }
  }
  const files: BranchFileChange[] = [];
  // A few reads at a time, which keeps a branch that changes many profiles quick without a burst of requests.
  for (let start = 0; start < pending.length; start += blobReads) {
    files.push(
      ...(await Promise.all(
        pending.slice(start, start + blobReads).map(async (change): Promise<BranchFileChange> => {
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
    base,
    baseCommit: compared.base_commit.sha,
    headCommit,
    ahead: compared.ahead_by,
    behind: compared.behind_by,
    truncated: compared.files.length >= compareLimit,
    files,
    others,
  };
}
