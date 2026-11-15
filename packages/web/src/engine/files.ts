// The files the engine works on, kept in memory. The engine reads and writes
// profiles, staged applies, and batches through `node:fs/promises`; the web
// build maps that module to this one, so the engine runs in the page as it
// does under Node. It has the functions the engine calls and no others, with
// the error codes the engine reads, ENOENT and EEXIST, as Node gives them. A
// store, such as the browser's storage, fills the folders it owns and follows
// `watchFiles` to keep each change. The engine replaces a file through a
// temporary one beside it, named `.<name>.<random>.tmp`, so a watcher hears
// of that file written and removed before the file itself.

import { basename, dirname, join, resolve } from './path.js';

interface FileNode {
  readonly kind: 'file';
  content: Uint8Array;
}

interface FolderNode {
  readonly kind: 'folder';
  readonly children: Map<string, FileNode | FolderNode>;
}

type Node = FileNode | FolderNode;

export type FileChange = (absolutePath: string, contentCopyUnlessRemoved: Uint8Array | undefined) => void;

const root: FolderNode = { kind: 'folder', children: new Map() };
const watchers = new Set<FileChange>();

class FileError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'FileError';
    this.code = code;
  }
}

function segments(target: string): string[] {
  return resolve('/', target).split('/').filter(Boolean);
}

function find(target: string): Node | undefined {
  let node: Node = root;
  for (const name of segments(target)) {
    const next: Node | undefined = node.kind === 'folder' ? node.children.get(name) : undefined;
    if (next === undefined) {
      return undefined;
    }
    node = next;
  }
  return node;
}

function existing(target: string): Node {
  const node = find(target);
  if (node === undefined) {
    throw new FileError('ENOENT', `no such file or directory, '${target}'`);
  }
  return node;
}

function parentOf(target: string): FolderNode {
  const parent = existing(dirname(resolve('/', target)));
  if (parent.kind !== 'folder') {
    throw new FileError('ENOTDIR', `not a directory, '${target}'`);
  }
  return parent;
}

function leaf(target: string): string {
  return basename(resolve('/', target));
}

/**
 * Tells the watchers of a change once the file function that made it has
 * finished and before its caller goes on, so a watcher that throws fails
 * neither the change nor the other watchers.
 */
function announce(target: string, content: Uint8Array | undefined): void {
  const file = resolve('/', target);
  for (const watcher of watchers) {
    queueMicrotask(() => {
      watcher(file, content?.slice());
    });
  }
}

function announceRemoved(target: string, node: Node): void {
  if (node.kind === 'file') {
    announce(target, undefined);
    return;
  }
  for (const [name, child] of node.children) {
    announceRemoved(join(target, name), child);
  }
}

export function watchFiles(watcher: FileChange): () => void {
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
  };
}

function runAsNodeFsPromise<Result>(work: () => Result): Promise<Result> {
  return new Promise((resolve) => {
    resolve(work());
  });
}

export function readFile(target: string): Promise<Uint8Array>;
export function readFile(target: string, encoding: 'utf8'): Promise<string>;
export function readFile(target: string, encoding?: 'utf8'): Promise<Uint8Array | string> {
  return runAsNodeFsPromise(() => {
    const node = existing(target);
    if (node.kind !== 'file') {
      throw new FileError('EISDIR', `illegal operation on a directory, read '${target}'`);
    }
    return encoding === undefined ? node.content.slice() : new TextDecoder().decode(node.content);
  });
}

export function writeFile(
  target: string,
  content: Uint8Array | string,
  options: { readonly flag?: 'wx' } = {},
): Promise<void> {
  return runAsNodeFsPromise(() => {
    const parent = parentOf(target);
    const name = leaf(target);
    const current = parent.children.get(name);
    if (current !== undefined && options.flag === 'wx') {
      throw new FileError('EEXIST', `file already exists, open '${target}'`);
    }
    if (current?.kind === 'folder') {
      throw new FileError('EISDIR', `illegal operation on a directory, open '${target}'`);
    }
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content.slice();
    parent.children.set(name, { kind: 'file', content: bytes });
    announce(target, bytes);
  });
}

interface Stats {
  isFile(): boolean;
  isDirectory(): boolean;
  /** Every file is an ordinary one; there are no permissions to keep. */
  readonly mode: number;
}

function stats(node: Node): Stats {
  return { isFile: () => node.kind === 'file', isDirectory: () => node.kind === 'folder', mode: 0o644 };
}

export function stat(target: string): Promise<Stats> {
  return runAsNodeFsPromise(() => {
    return stats(existing(target));
  });
}

/** There are no links, so this is `stat`. */
export const lstat = stat;

/** There are no links, so a path that exists is its own real path. */
export function realpath(target: string): Promise<string> {
  return runAsNodeFsPromise(() => {
    existing(target);
    return resolve('/', target);
  });
}

export function chmod(target: string, _mode: number): Promise<void> {
  return runAsNodeFsPromise(() => {
    existing(target);
  });
}

export interface Dirent extends Stats {
  readonly name: string;
}

export function readdir(target: string, _options: { readonly withFileTypes: true }): Promise<Dirent[]> {
  return runAsNodeFsPromise(() => {
    const node = existing(target);
    if (node.kind !== 'folder') {
      throw new FileError('ENOTDIR', `not a directory, scandir '${target}'`);
    }
    return [...node.children].map(([name, child]) => ({ name, ...stats(child) }));
  });
}

export function mkdir(target: string, _options: { readonly recursive: true }): Promise<string | undefined> {
  return runAsNodeFsPromise(() => {
    let node = root;
    let firstFolderMade: string | undefined;
    let current = '';
    for (const name of segments(target)) {
      current = `${current}/${name}`;
      let next = node.children.get(name);
      if (next === undefined) {
        next = { kind: 'folder', children: new Map() };
        node.children.set(name, next);
        firstFolderMade ??= current;
      }
      if (next.kind !== 'folder') {
        throw new FileError('EEXIST', `file already exists, mkdir '${target}'`);
      }
      node = next;
    }
    return firstFolderMade;
  });
}

export function rm(
  target: string,
  options: { readonly force?: boolean; readonly recursive?: boolean } = {},
): Promise<void> {
  return runAsNodeFsPromise(() => {
    const node = find(target);
    if (node === undefined) {
      if (options.force === true) {
        return;
      }
      throw new FileError('ENOENT', `no such file or directory, rm '${target}'`);
    }
    if (node.kind === 'folder' && options.recursive !== true) {
      throw new FileError('EISDIR', `path is a directory, rm '${target}'`);
    }
    announceRemoved(target, node);
    if (node === root) {
      root.children.clear();
    } else {
      parentOf(target).children.delete(leaf(target));
    }
  });
}

export function rmdir(target: string): Promise<void> {
  return runAsNodeFsPromise(() => {
    const node = existing(target);
    if (node.kind !== 'folder') {
      throw new FileError('ENOTDIR', `not a directory, rmdir '${target}'`);
    }
    if (node.children.size > 0) {
      throw new FileError('ENOTEMPTY', `directory not empty, rmdir '${target}'`);
    }
    if (node !== root) {
      parentOf(target).children.delete(leaf(target));
    }
  });
}

export function rename(from: string, to: string): Promise<void> {
  return runAsNodeFsPromise(() => {
    const node = existing(from);
    if (node.kind !== 'file') {
      throw new FileError('EISDIR', `illegal operation on a directory, rename '${from}'`);
    }
    const parent = parentOf(to);
    if (parent.children.get(leaf(to))?.kind === 'folder') {
      throw new FileError('EISDIR', `illegal operation on a directory, rename '${to}'`);
    }
    parentOf(from).children.delete(leaf(from));
    parent.children.set(leaf(to), node);
    announce(from, undefined);
    announce(to, node.content);
  });
}
