import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { replaceFile } from './files.js';
import { type GitHub, GitHubError, parseRepo, type RepoRef, repoPath } from './github.js';

/**
 * The file in a synced folder that records what the folder and its
 * repository last agreed on. It is JSON, so profile listings skip it.
 */
export const syncStateFile = '.repotted-sync.json';

const syncState = z.strictObject({
  repository: z.string(),
  /** GitHub's id for the repository, which a repository made again under the same name does not share. */
  id: z.number().optional(),
  path: z.string(),
  branch: z.string(),
  commit: z.string().nullable(),
  /** The git blob id of each profile, by its path in the folder, as of the last sync. */
  files: z.record(z.string(), z.string()),
});

type SyncState = z.infer<typeof syncState>;

export interface SyncOptions {
  /** `owner/name`. A folder's first sync needs it; later syncs read it from the folder. */
  readonly repository?: string;
  /** The folder in the repository that holds the profiles; the root when left out. */
  readonly path?: string;
  /** Which side wins a file that changed both here and on GitHub since the last sync. */
  readonly prefer?: 'local' | 'remote';
  /** The files `prefer` settles, by path in the folder; every file in conflict when left out. */
  readonly only?: readonly string[];
  /** The commit message; Repotted writes one from the files when left out. */
  readonly message?: string;
}

export interface SyncResult {
  readonly repository: string;
  readonly path: string;
  readonly branch: string;
  /** The branch's commit after the sync, or null for a repository with no commits. */
  readonly commit: string | null;
  /** Files written or deleted here from GitHub, by path in the folder. */
  readonly pulled: readonly string[];
  /** Files committed to GitHub from here. */
  readonly pushed: readonly string[];
  /** Files that changed on both sides and were left as they are on each. */
  readonly conflicts: readonly string[];
}

export class SyncError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SyncError';
  }
}

/** Says what to change when GitHub refuses a sync, and passes anything else on. */
function explain(error: unknown, repository: string, branch: string): unknown {
  if (!(error instanceof GitHubError)) {
    return error;
  }
  // GitHub explains a rule violation on the lines after its first.
  const detail = error.message.split('\n')[0] ?? error.message;
  if (/rule|protected branch/iu.test(error.message)) {
    return new SyncError(
      `GitHub refused the commit to ${branch} in ${repository}: ${detail}. A ruleset or branch protection on ${branch}, such as one that requires pull requests, needs a bypass for you or the Repotted App.`,
      { cause: error },
    );
  }
  if (error.status === 403 || error.status === 404) {
    return new SyncError(
      `Repotted cannot reach the profiles in ${repository}: ${detail}. The repository must exist, the Repotted App must be installed on it, and it needs the Contents permission, read and write.`,
      { cause: error },
    );
  }
  return error;
}

/** The id git gives a file's content, which GitHub's trees list. */
export function blobId(content: Uint8Array): string {
  return createHash('sha1').update(`blob ${content.byteLength}\0`).update(content).digest('hex');
}

// A path a profile can have on every OS the app runs on: no hidden or reserved
// segments, which also keeps .github workflows and this file out of a sync.
const reserved = /^\.|[<>:"\\|?*]|[. ]$/u;

function badSegment(segment: string): boolean {
  return (
    segment === '' ||
    reserved.test(segment) ||
    Array.from({ length: segment.length }, (_, index) => segment.charCodeAt(index)).some((code) => code < 32)
  );
}

function isProfilePath(file: string): boolean {
  return /\.ya?ml$/iu.test(file) && !file.split('/').some(badSegment);
}

/** A folder in the repository as `a/b`, or '' for the root. */
function repositoryFolder(value: string | undefined): string {
  const trimmed = (value ?? '').replace(/^\/+|\/+$/gu, '');
  if (trimmed === '') {
    return '';
  }
  if (trimmed.split('/').some(badSegment)) {
    throw new SyncError(`Expected a folder in the repository, such as profiles, got "${value ?? ''}".`);
  }
  return trimmed;
}

function sameRepository(a: string, b: string): boolean {
  // GitHub names match without case.
  return a.toLowerCase() === b.toLowerCase();
}

async function readState(folder: string): Promise<SyncState | undefined> {
  let text: string;
  try {
    text = await readFile(path.join(folder, syncStateFile), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  const parsed = syncState.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new SyncError(`${path.join(folder, syncStateFile)} is not a Repotted sync record.`);
  }
  return parsed.data;
}

/**
 * Where a pulled file goes, once each folder on the way is known to be a real
 * folder inside the synced one: writing through a link could reach any file.
 */
async function pullTarget(folder: string, file: string): Promise<string> {
  const segments = file.split('/');
  for (let index = 1; index < segments.length; index += 1) {
    const step = path.join(folder, ...segments.slice(0, index));
    const found = await lstat(step).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return undefined;
      }
      throw error;
    });
    if (found === undefined) {
      break;
    }
    if (!found.isDirectory()) {
      throw new SyncError(
        `${segments.slice(0, index).join('/')} in ${folder} is a link or a file, so Repotted cannot sync ${file} into it.`,
      );
    }
  }
  return path.join(folder, ...segments);
}

/** The blob id of the file there now; undefined when there is none. */
async function currentId(target: string, file: string): Promise<string | undefined> {
  const found = await lstat(target).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  });
  if (found === undefined) {
    return undefined;
  }
  if (!found.isFile()) {
    throw new SyncError(`${file} in the synced folder is a link or a folder, so Repotted cannot sync it.`);
  }
  return blobId(await readFile(target));
}

/** Two files whose paths differ only in case, which macOS and Windows folders cannot hold side by side. */
function caseClash(files: Iterable<string>): [string, string] | undefined {
  const lowered = new Map<string, string>();
  for (const file of files) {
    const other = lowered.get(file.toLowerCase());
    if (other !== undefined) {
      return [other, file];
    }
    lowered.set(file.toLowerCase(), file);
  }
  return undefined;
}

/** The profiles under a folder, by path with `/` separators, as their content. Links are not followed. */
async function localFiles(folder: string, prefix = ''): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  for (const entry of await readdir(path.join(folder, prefix), { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.name.startsWith('.')) {
      continue;
    }
    if (entry.isDirectory()) {
      for (const [file, content] of await localFiles(folder, relative)) {
        files.set(file, content);
      }
    } else if (entry.isFile() && isProfilePath(relative)) {
      files.set(relative, await readFile(path.join(folder, relative)));
    }
  }
  return files;
}

const repositoryInfo = z.looseObject({ id: z.number(), default_branch: z.string() });
const sha = z.looseObject({ sha: z.string() });
const reference = z.looseObject({ object: sha });
const commitInfo = z.looseObject({ tree: sha });
const treeInfo = z.looseObject({
  truncated: z.boolean(),
  tree: z.array(z.looseObject({ path: z.string(), type: z.string(), mode: z.string(), sha: z.string() })),
});
const blobInfo = z.looseObject({ content: z.string(), encoding: z.literal('base64') });

interface Remote {
  /** The branch's commit and its tree, or null when the repository has no commits yet. */
  readonly head: { commit: string; tree: string } | null;
  /** Each profile's blob id and file mode, by path in the folder. */
  readonly files: Map<string, { id: string; mode: string }>;
}

function branchPath(repo: RepoRef, branch: string): string {
  return `${repoPath(repo)}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`;
}

async function readRemote(github: GitHub, repo: RepoRef, branch: string, folder: string): Promise<Remote> {
  let commit: string;
  try {
    commit = reference.parse(await github.request('GET', branchPath(repo, branch))).object.sha;
  } catch (error) {
    // GitHub answers 409 for a repository with no commits.
    if (error instanceof GitHubError && error.status === 409) {
      return { head: null, files: new Map() };
    }
    if (error instanceof GitHubError && error.status === 404) {
      throw new SyncError(
        `${repo.owner}/${repo.name} has no branch named ${branch}, or Repotted cannot read it. The Repotted App needs the Contents permission, read and write.`,
        { cause: error },
      );
    }
    throw error;
  }
  const tree = commitInfo.parse(await github.request('GET', `${repoPath(repo)}/git/commits/${commit}`)).tree.sha;
  const listing = treeInfo.parse(await github.request('GET', `${repoPath(repo)}/git/trees/${tree}?recursive=1`));
  if (listing.truncated) {
    throw new SyncError(
      `${repo.owner}/${repo.name} has more files than GitHub lists at once. Keep the profiles in a smaller repository.`,
    );
  }
  const prefix = folder === '' ? '' : `${folder}/`;
  const files = new Map<string, { id: string; mode: string }>();
  const lowered = new Map<string, string>();
  for (const item of listing.tree) {
    // Only regular files: a link (120000) or submodule is not a profile.
    if (item.type !== 'blob' || (item.mode !== '100644' && item.mode !== '100755') || !item.path.startsWith(prefix)) {
      continue;
    }
    const file = item.path.slice(prefix.length);
    if (!isProfilePath(file)) {
      continue;
    }
    // macOS and Windows folders do not tell these apart.
    const clash = lowered.get(file.toLowerCase());
    if (clash !== undefined) {
      throw new SyncError(
        `${repo.owner}/${repo.name} has both ${clash} and ${file}, which differ only in case. Rename one.`,
      );
    }
    lowered.set(file.toLowerCase(), file);
    files.set(file, { id: item.sha, mode: item.mode });
  }
  return { head: { commit, tree }, files };
}

const comparison = z.looseObject({ status: z.string() });

/** Whether the branch's head is the commit the folder last synced at, or comes after it. */
async function descends(github: GitHub, repo: RepoRef, commit: string | null, head: Remote['head']): Promise<boolean> {
  if (commit === null || head === null) {
    return false;
  }
  if (commit === head.commit) {
    return true;
  }
  try {
    const { status } = comparison.parse(
      await github.request('GET', `${repoPath(repo)}/compare/${commit}...${head.commit}?per_page=1`),
    );
    return status === 'ahead' || status === 'identical';
  } catch (error) {
    // GitHub no longer has the commit, or it shares no history with the branch.
    if (error instanceof GitHubError && (error.status === 404 || error.status === 422)) {
      return false;
    }
    throw error;
  }
}

async function readBlob(github: GitHub, repo: RepoRef, id: string): Promise<Uint8Array> {
  const blob = blobInfo.parse(await github.request('GET', `${repoPath(repo)}/git/blobs/${id}`));
  return Buffer.from(blob.content, 'base64');
}

function commitMessage(changes: readonly { file: string; verb: 'Add' | 'Update' | 'Delete' }[]): string {
  const [only] = changes;
  if (changes.length === 1 && only !== undefined) {
    return `${only.verb} ${only.file}`;
  }
  return `Update ${changes.length} profiles\n\n${changes.map((change) => `- ${change.verb.toLowerCase()} ${change.file}`).join('\n')}`;
}

type Action = 'pull' | 'push' | 'conflict' | 'same';

/**
 * What to do with one file, from its blob id as of the last sync, here, and
 * on GitHub; undefined is a file that does not exist on that side.
 */
function decide(
  base: string | undefined,
  local: string | undefined,
  remote: string | undefined,
  prefer: SyncOptions['prefer'],
): Action {
  if (local === remote) {
    return 'same';
  }
  if (local === base) {
    return 'pull';
  }
  if (remote === base) {
    return 'push';
  }
  if (prefer === 'local') {
    return 'push';
  }
  if (prefer === 'remote') {
    return 'pull';
  }
  return 'conflict';
}

/**
 * Brings a folder of profiles and a folder in a GitHub repository in line:
 * a file changed on one side since the last sync takes that side's version,
 * and a file changed on both is left alone on each and reported, unless
 * `prefer` names the side to keep. Local changes go to the branch as one
 * commit, which only fast-forwards the branch. Only YAML profiles sync;
 * hidden files and folders stay out of it on both sides.
 */
export async function syncFolder(github: GitHub, directory: string, options: SyncOptions = {}): Promise<SyncResult> {
  const folder = path.resolve(directory);
  await mkdir(folder, { recursive: true });
  const saved = await readState(folder);
  const requested = options.repository === undefined ? undefined : parseRepo(options.repository);
  const named = requested === undefined ? undefined : `${requested.owner}/${requested.name}`;
  // The name the folder first synced with, which GitHub matched without case.
  const repositoryName = saved?.repository ?? named;
  if (repositoryName === undefined) {
    throw new SyncError(`${folder} does not sync with a repository yet. Name one with --repository.`);
  }
  const prefix = repositoryFolder(options.path ?? saved?.path);
  if (
    saved !== undefined &&
    ((named !== undefined && !sameRepository(saved.repository, named)) || saved.path !== prefix)
  ) {
    const current = saved.path === '' ? saved.repository : `${saved.repository} (${saved.path})`;
    throw new SyncError(`${folder} syncs with ${current}. Use another folder for another repository.`);
  }
  const repo = parseRepo(repositoryName);
  let info: z.infer<typeof repositoryInfo>;
  try {
    info = repositoryInfo.parse(await github.request('GET', repoPath(repo)));
  } catch (error) {
    throw explain(error, repositoryName, saved?.branch ?? 'the default branch');
  }
  const branch = info.default_branch;
  // A repository made again under the same name shares nothing with what the
  // folder last agreed on, so the sync starts over as a first sync: nothing
  // is deleted on either side, and a file that differs is a conflict.
  const base = new Map(saved === undefined || saved.id !== info.id ? [] : Object.entries(saved.files));
  const pulled = new Set<string>();
  const pushed = new Set<string>();

  // Each attempt starts from what both sides hold now, so a branch that moved
  // under a commit, or a first file that started an empty repository, only
  // means another pass.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let remote: Remote;
    try {
      remote = await readRemote(github, repo, branch, prefix);
    } catch (error) {
      throw explain(error, repositoryName, branch);
    }
    // Neither does a branch whose history no longer holds the last sync's
    // commit, such as an emptied repository, a force push or another
    // default branch.
    let kept: boolean;
    try {
      kept = attempt > 0 || base.size === 0 || (await descends(github, repo, saved?.commit ?? null, remote.head));
    } catch (error) {
      throw explain(error, repositoryName, branch);
    }
    if (!kept) {
      base.clear();
    }
    const local = await localFiles(folder);
    const localIds = new Map([...local].map(([file, content]) => [file, blobId(content)]));
    const localClash = caseClash(localIds.keys());
    if (localClash !== undefined) {
      throw new SyncError(
        `${folder} has both ${localClash[0]} and ${localClash[1]}, which differ only in case. Rename one.`,
      );
    }
    const files = [...new Set([...base.keys(), ...localIds.keys(), ...remote.files.keys()])].sort();
    const toPush: string[] = [];
    const toPull: { file: string; remoteId: string | undefined }[] = [];
    const conflicts: string[] = [];
    const next = new Map<string, string>();
    const keep = (file: string): void => {
      conflicts.push(file);
      const kept = base.get(file);
      if (kept !== undefined) {
        next.set(file, kept);
      }
    };

    for (const file of files) {
      const remoteId = remote.files.get(file)?.id;
      const localId = localIds.get(file);
      const prefer = options.only === undefined || options.only.includes(file) ? options.prefer : undefined;
      const action = decide(base.get(file), localId, remoteId, prefer);
      if (action === 'same') {
        // Both sides agree, which a retry builds on.
        if (localId === undefined) {
          base.delete(file);
        } else {
          next.set(file, localId);
          base.set(file, localId);
        }
      } else if (action === 'pull') {
        toPull.push({ file, remoteId });
      } else if (action === 'push') {
        toPush.push(file);
      } else {
        keep(file);
      }
    }

    // Deletes go first, so a file GitHub renamed only in case is not deleted
    // after its new name is written, on a disk that does not tell them apart.
    toPull.sort((a, b) => Number(a.remoteId !== undefined) - Number(b.remoteId !== undefined));
    const deleted = new Set(toPull.filter((pull) => pull.remoteId === undefined).map((pull) => pull.file));
    for (const { file, remoteId } of toPull) {
      const other = [...localIds.keys()].find(
        (name) => name !== file && name.toLowerCase() === file.toLowerCase() && !deleted.has(name),
      );
      if (remoteId !== undefined && other !== undefined) {
        throw new SyncError(`${other} here and ${file} on GitHub differ only in case. Rename one of them.`);
      }
      const target = await pullTarget(folder, file);
      const content = remoteId === undefined ? undefined : await readBlob(github, repo, remoteId);
      // A file edited here since the sync read it, such as by a save while
      // it ran, keeps the edit and waits as a conflict.
      if ((await currentId(target, file)) !== localIds.get(file)) {
        keep(file);
        continue;
      }
      if (remoteId === undefined || content === undefined) {
        await rm(target, { force: true });
        base.delete(file);
      } else {
        await mkdir(path.dirname(target), { recursive: true });
        await replaceFile(target, content);
        next.set(file, remoteId);
        base.set(file, remoteId);
      }
      pulled.add(file);
    }
    for (const file of toPush) {
      const other = [...remote.files.keys()].find(
        (name) => name !== file && name.toLowerCase() === file.toLowerCase() && !toPush.includes(name),
      );
      if (localIds.has(file) && other !== undefined) {
        throw new SyncError(`${file} here and ${other} on GitHub differ only in case. Rename one of them.`);
      }
    }

    let commit = remote.head?.commit ?? null;
    try {
      if (toPush.length > 0) {
        const changes = toPush.map((file) => ({
          file,
          verb: !localIds.has(file)
            ? ('Delete' as const)
            : remote.files.has(file)
              ? ('Update' as const)
              : ('Add' as const),
        }));
        const message = (subset: typeof changes): string => options.message ?? commitMessage(subset);
        const remotePath = (file: string): string => (prefix === '' ? file : `${prefix}/${file}`);
        if (remote.head === null) {
          // The git data API refuses a repository with no commits, so the
          // first file starts the branch and the next pass commits the rest.
          const first = toPush.find((file) => local.has(file));
          const content = first === undefined ? undefined : local.get(first);
          if (first === undefined || content === undefined) {
            // Only deletes of files the empty repository does not have.
            for (const file of toPush) {
              base.delete(file);
            }
            continue;
          }
          await github.request(
            'PUT',
            `${repoPath(repo)}/contents/${remotePath(first).split('/').map(encodeURIComponent).join('/')}`,
            {
              message: message(changes.filter((change) => change.file === first)),
              content: Buffer.from(content).toString('base64'),
              branch,
            },
          );
          pushed.add(first);
          base.set(first, blobId(content));
          continue;
        }
        const tree = [];
        for (const file of toPush) {
          const content = local.get(file);
          const mode = remote.files.get(file)?.mode ?? '100644';
          if (content === undefined) {
            tree.push({ path: remotePath(file), mode, type: 'blob', sha: null });
            continue;
          }
          const blob = sha.parse(
            await github.request('POST', `${repoPath(repo)}/git/blobs`, {
              content: Buffer.from(content).toString('base64'),
              encoding: 'base64',
            }),
          );
          tree.push({ path: remotePath(file), mode, type: 'blob', sha: blob.sha });
        }
        const newTree = sha.parse(
          await github.request('POST', `${repoPath(repo)}/git/trees`, { base_tree: remote.head.tree, tree }),
        ).sha;
        commit = sha.parse(
          await github.request('POST', `${repoPath(repo)}/git/commits`, {
            message: message(changes),
            tree: newTree,
            parents: [remote.head.commit],
          }),
        ).sha;
        await github.request('PATCH', branchPath(repo, branch), { sha: commit, force: false });
        for (const file of toPush) {
          const id = localIds.get(file);
          if (id === undefined) {
            next.delete(file);
          } else {
            next.set(file, id);
          }
          pushed.add(file);
        }
      }
    } catch (error) {
      // The branch is no longer at the commit this one builds on. What this
      // pass pulled is on disk now and compares as the same next time.
      if (error instanceof GitHubError && /fast.?forward/iu.test(error.message)) {
        continue;
      }
      throw explain(error, repositoryName, branch);
    }

    const state: SyncState = {
      repository: repositoryName,
      id: info.id,
      path: prefix,
      branch,
      commit,
      files: Object.fromEntries([...next].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    };
    await replaceFile(path.join(folder, syncStateFile), `${JSON.stringify(state, null, 2)}\n`);
    return {
      repository: state.repository,
      path: prefix,
      branch,
      commit,
      pulled: [...pulled].sort(),
      pushed: [...pushed].sort(),
      conflicts: conflicts.sort(),
    };
  }
  throw new SyncError(`${repositoryName} kept changing during the sync. Sync again.`);
}
