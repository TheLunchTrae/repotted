import { fromBase64, toBase64 } from '../src/bytes.js';
import { type GitHub, GitHubError, type Method } from '../src/github.js';

type Tree = Map<string, { id: string; mode: string }>;

/**
 * SHA-1 in hex, computed at once: the fake names commits, trees, and blobs
 * as git does, inside methods that answer without waiting, which the web
 * platform's own digest can't do.
 */
function sha1(bytes: Uint8Array): string {
  const length = bytes.length;
  const padded = new Uint8Array((((length + 8) >> 6) + 1) << 6);
  padded.set(bytes);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(length / 0x20000000));
  view.setUint32(padded.length - 4, length << 3);
  const state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const words = new Uint32Array(80);
  const rotate = (value: number, by: number): number => (value << by) | (value >>> (32 - by));
  for (let block = 0; block < padded.length; block += 64) {
    for (let index = 0; index < 80; index += 1) {
      words[index] =
        index < 16
          ? view.getUint32(block + index * 4)
          : rotate(
              (words[index - 3] ?? 0) ^ (words[index - 8] ?? 0) ^ (words[index - 14] ?? 0) ^ (words[index - 16] ?? 0),
              1,
            );
    }
    let [a = 0, b = 0, c = 0, d = 0, e = 0] = state;
    for (let index = 0; index < 80; index += 1) {
      const [mix, constant] =
        index < 20
          ? [(b & c) | (~b & d), 0x5a827999]
          : index < 40
            ? [b ^ c ^ d, 0x6ed9eba1]
            : index < 60
              ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc]
              : [b ^ c ^ d, 0xca62c1d6];
      const next = (rotate(a, 5) + mix + e + constant + (words[index] ?? 0)) | 0;
      e = d;
      d = c;
      c = rotate(b, 30);
      b = a;
      a = next;
    }
    state[0] = ((state[0] ?? 0) + a) | 0;
    state[1] = ((state[1] ?? 0) + b) | 0;
    state[2] = ((state[2] ?? 0) + c) | 0;
    state[3] = ((state[3] ?? 0) + d) | 0;
    state[4] = ((state[4] ?? 0) + e) | 0;
  }
  return state.map((word) => (word >>> 0).toString(16).padStart(8, '0')).join('');
}

/** The id git gives a file's content. */
function blobId(content: Uint8Array): string {
  const header = new TextEncoder().encode(`blob ${content.byteLength}\0`);
  const whole = new Uint8Array(header.length + content.byteLength);
  whole.set(header);
  whole.set(content, header.length);
  return sha1(whole);
}

interface Commit {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly message: string;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GitHubError(422, 'Body must be an object');
  }
  return Object.fromEntries(Object.entries(value));
}

function hash(value: string): string {
  return sha1(new TextEncoder().encode(value));
}

/**
 * One repository's git data, as the contents and git data APIs serve it, for
 * the sync tests. Its owner can write to it directly, as a push from
 * elsewhere would.
 */
export class FakeGitRepository implements GitHub {
  /** How many fakes exist, which numbers each one. */
  private static made = 0;
  readonly blobs = new Map<string, Uint8Array>();
  readonly trees = new Map<string, Tree>();
  readonly commits = new Map<string, Commit>();
  readonly refs = new Map<string, string>();
  readonly calls: { method: Method; path: string }[] = [];
  /** Runs just before a branch moves, as a push that lands first would. */
  beforeRefUpdate: (() => void) | undefined;
  /** Runs just before a blob is read, as an edit made here during a sync would. */
  beforeBlobRead: (() => void) | undefined;
  /** The error GitHub answers every write with, as a ruleset or a missing permission would. */
  refuseWrites: GitHubError | undefined;

  readonly fullName: string;
  /** GitHub's id for the repository; each fake is a repository of its own. */
  readonly id: number;
  defaultBranch: string;

  constructor(fullName = 'lunch/config', defaultBranch = 'main') {
    this.fullName = fullName;
    this.defaultBranch = defaultBranch;
    FakeGitRepository.made += 1;
    this.id = FakeGitRepository.made;
  }

  private storeTree(tree: Tree): string {
    const id = hash(JSON.stringify([...tree].sort()));
    this.trees.set(id, new Map(tree));
    return id;
  }

  private storeCommit(commit: Commit): string {
    const id = hash(JSON.stringify(commit) + String(this.commits.size));
    this.commits.set(id, commit);
    return id;
  }

  /** The branch's files as text, by path. */
  files(branch = this.defaultBranch): Record<string, string> {
    const head = this.refs.get(branch);
    if (head === undefined) {
      return {};
    }
    const tree: Tree = this.trees.get(this.commits.get(head)?.tree ?? '') ?? new Map();
    return Object.fromEntries(
      [...tree].map(([file, entry]) => [file, new TextDecoder().decode(this.blobs.get(entry.id))]),
    );
  }

  /** Commits files to the branch, a string to write and null to delete, as a push from elsewhere would. */
  write(changes: Record<string, string | null>, options: { mode?: string; message?: string } = {}): string {
    const head = this.refs.get(this.defaultBranch);
    const tree: Tree = new Map(head === undefined ? [] : this.trees.get(this.commits.get(head)?.tree ?? ''));
    for (const [file, text] of Object.entries(changes)) {
      if (text === null) {
        tree.delete(file);
      } else {
        const content = new TextEncoder().encode(text);
        const id = blobId(content);
        this.blobs.set(id, content);
        tree.set(file, { id, mode: options.mode ?? '100644' });
      }
    }
    const commit = this.storeCommit({
      tree: this.storeTree(tree),
      parents: head === undefined ? [] : [head],
      message: options.message ?? 'edit',
    });
    this.refs.set(this.defaultBranch, commit);
    return commit;
  }

  /** Every commit before this one. */
  private ancestors(id: string): Set<string> {
    const found = new Set<string>();
    const queue = [...(this.commits.get(id)?.parents ?? [])];
    for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
      if (!found.has(next)) {
        found.add(next);
        queue.push(...(this.commits.get(next)?.parents ?? []));
      }
    }
    return found;
  }

  /** The branch's commit messages, newest first. */
  log(branch = this.defaultBranch): string[] {
    const messages: string[] = [];
    let id = this.refs.get(branch);
    while (id !== undefined) {
      const commit = this.commits.get(id);
      messages.push(commit?.message ?? '');
      id = commit?.parents[0];
    }
    return messages;
  }

  request(method: Method, path: string, body?: unknown): Promise<unknown> {
    this.calls.push({ method, path });
    try {
      return Promise.resolve(this.handle(method, path, body));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handle(method: Method, path: string, body: unknown): unknown {
    if (method !== 'GET' && this.refuseWrites !== undefined) {
      throw this.refuseWrites;
    }
    const base = `/repos/${this.fullName}`;
    const [route = '', query = ''] = path.split('?');
    if (method === 'GET' && route === base) {
      return { id: this.id, full_name: this.fullName, default_branch: this.defaultBranch };
    }
    const ref = route.startsWith(`${base}/git/refs/heads/`)
      ? decodeURIComponent(route.slice(`${base}/git/refs/heads/`.length))
      : undefined;
    if (ref !== undefined && method === 'GET') {
      if (this.refs.size === 0) {
        throw new GitHubError(409, 'Git Repository is empty.');
      }
      const head = this.refs.get(ref);
      if (head === undefined) {
        throw new GitHubError(404, 'Not Found');
      }
      return { ref: `refs/heads/${ref}`, object: { sha: head, type: 'commit' } };
    }
    if (ref !== undefined && method === 'PATCH') {
      const { sha, force } = object(body);
      const commit = this.commits.get(String(sha));
      this.beforeRefUpdate?.();
      this.beforeRefUpdate = undefined;
      if (commit === undefined || (force !== true && commit.parents[0] !== this.refs.get(ref))) {
        throw new GitHubError(422, 'Update is not a fast forward');
      }
      this.refs.set(ref, String(sha));
      return { object: { sha } };
    }
    if (this.refs.size === 0 && route.startsWith(`${base}/git/`)) {
      throw new GitHubError(409, 'Git Repository is empty.');
    }
    const compare = route.startsWith(`${base}/compare/`)
      ? route.slice(`${base}/compare/`.length).split('...')
      : undefined;
    if (method === 'GET' && compare !== undefined) {
      const [from = '', to = ''] = compare;
      if (!this.commits.has(from) || !this.commits.has(to)) {
        throw new GitHubError(404, 'No common ancestor between these commits.');
      }
      const status =
        from === to
          ? 'identical'
          : this.ancestors(to).has(from)
            ? 'ahead'
            : this.ancestors(from).has(to)
              ? 'behind'
              : 'diverged';
      return { status };
    }
    const id = route.split('/').at(-1) ?? '';
    if (method === 'GET' && route === `${base}/git/commits/${id}`) {
      const commit = this.commits.get(id);
      if (commit === undefined) {
        throw new GitHubError(404, 'Not Found');
      }
      return { sha: id, tree: { sha: commit.tree } };
    }
    if (method === 'GET' && route === `${base}/git/trees/${id}`) {
      const tree = this.trees.get(id);
      if (tree === undefined || query !== 'recursive=1') {
        throw new GitHubError(404, 'Not Found');
      }
      const folders = new Set(
        [...tree.keys()].flatMap((file) =>
          file
            .split('/')
            .slice(0, -1)
            .map((_, index, parts) => parts.slice(0, index + 1).join('/')),
        ),
      );
      return {
        sha: id,
        truncated: false,
        tree: [
          ...[...folders].map((folder) => ({ path: folder, type: 'tree', mode: '040000', sha: hash(folder) })),
          ...[...tree].map(([file, entry]) => ({ path: file, type: 'blob', mode: entry.mode, sha: entry.id })),
        ],
      };
    }
    if (method === 'GET' && route === `${base}/git/blobs/${id}`) {
      this.beforeBlobRead?.();
      this.beforeBlobRead = undefined;
      const content = this.blobs.get(id);
      if (content === undefined) {
        throw new GitHubError(404, 'Not Found');
      }
      return { sha: id, content: toBase64(content), encoding: 'base64' };
    }
    if (method === 'POST' && route === `${base}/git/blobs`) {
      const { content, encoding } = object(body);
      if (encoding !== 'base64' || typeof content !== 'string') {
        throw new GitHubError(422, 'Invalid blob');
      }
      const bytes = fromBase64(content);
      const blob = blobId(bytes);
      this.blobs.set(blob, bytes);
      return { sha: blob };
    }
    if (method === 'POST' && route === `${base}/git/trees`) {
      const { base_tree: baseTree, tree: entries } = object(body);
      const tree: Tree = new Map(this.trees.get(String(baseTree)));
      for (const entry of Array.isArray(entries) ? entries : []) {
        const { path: file, mode, sha } = object(entry);
        if (sha === null) {
          if (!tree.has(String(file))) {
            throw new GitHubError(422, 'GitRPC::BadObjectState');
          }
          tree.delete(String(file));
        } else if (typeof sha === 'string' && this.blobs.has(sha)) {
          tree.set(String(file), { id: sha, mode: String(mode) });
        } else {
          throw new GitHubError(422, 'Invalid tree entry');
        }
      }
      return { sha: this.storeTree(tree) };
    }
    if (method === 'POST' && route === `${base}/git/commits`) {
      const { tree, parents, message } = object(body);
      if (!this.trees.has(String(tree)) || !Array.isArray(parents)) {
        throw new GitHubError(422, 'Invalid commit');
      }
      return { sha: this.storeCommit({ tree: String(tree), parents: parents.map(String), message: String(message) }) };
    }
    if (method === 'PUT' && route.startsWith(`${base}/contents/`)) {
      const file = route.slice(`${base}/contents/`.length).split('/').map(decodeURIComponent).join('/');
      const { content, message, branch } = object(body);
      if (typeof content !== 'string' || branch !== this.defaultBranch || this.files()[file] !== undefined) {
        throw new GitHubError(422, 'Invalid request');
      }
      const commit = this.write(
        { [file]: new TextDecoder().decode(fromBase64(content)) },
        { message: String(message) },
      );
      return { commit: { sha: commit } };
    }
    throw new GitHubError(404, `Not Found: ${method} ${path}`);
  }
}
