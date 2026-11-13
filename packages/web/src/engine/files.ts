// The files the engine works on, kept in memory. The engine reads and writes
// profiles, staged applies, and batches through `node:fs/promises`; the web
// build maps that module to this one, so the engine runs in the page as it
// does under Node. It has the functions the engine calls and no others, with
// Node's error codes, which the engine reads. A store, such as the browser's
// storage, fills the folders it owns and follows `watchFiles` to keep each
// change.

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

/** A change to one file: its absolute path, and its content, or undefined once it is removed. */
export type FileChange = (file: string, content: Uint8Array | undefined) => void;

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

function announce(target: string, content: Uint8Array | undefined): void {
  const file = resolve('/', target);
  for (const watcher of watchers) {
    watcher(file, content);
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

/** Calls `watcher` after each file is written or removed, until the returned function is called. */
export function watchFiles(watcher: FileChange): () => void {
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
  };
}

/** Runs `work` as Node's file functions do: what it throws comes back as a rejection. */
function settle<Result>(work: () => Result): Promise<Result> {
  return new Promise((resolve) => {
    resolve(work());
  });
}

export function readFile(target: string): Promise<Uint8Array>;
export function readFile(target: string, encoding: 'utf8'): Promise<string>;
export function readFile(target: string, encoding?: 'utf8'): Promise<Uint8Array | string> {
  return settle(() => {
    const node = existing(target);
    if (node.kind !== 'file') {
      throw new FileError('EISDIR', `illegal operation on a directory, read '${target}'`);
    }
    return encoding === undefined ? node.content.slice() : new TextDecoder().decode(node.content);
  });
}

/** Writes a file whole. With the flag `wx`, the file must not exist yet. */
export function writeFile(
  target: string,
  content: Uint8Array | string,
  options: { readonly flag?: 'wx' } = {},
): Promise<void> {
  return settle(() => {
    const parent = parentOf(target);
    const name = basename(target);
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
  return settle(() => {
    return stats(existing(target));
  });
}

/** There are no links, so this is `stat`. */
export const lstat = stat;

/** There are no links, so a path that exists is its own real path. */
export function realpath(target: string): Promise<string> {
  return settle(() => {
    existing(target);
    return resolve('/', target);
  });
}

export function chmod(target: string, _mode: number): Promise<void> {
  return settle(() => {
    existing(target);
  });
}

/** A folder's entry, as the engine's `Dirent` from `node:fs`. */
export interface Dirent extends Stats {
  readonly name: string;
}

export function readdir(target: string, _options: { readonly withFileTypes: true }): Promise<Dirent[]> {
  return settle(() => {
    const node = existing(target);
    if (node.kind !== 'folder') {
      throw new FileError('ENOTDIR', `not a directory, scandir '${target}'`);
    }
    return [...node.children].map(([name, child]) => ({ name, ...stats(child) }));
  });
}

/** Makes a folder and the folders above it, and answers the first one it made, as Node does. */
export function mkdir(target: string, _options: { readonly recursive: true }): Promise<string | undefined> {
  return settle(() => {
    let node = root;
    let made: string | undefined;
    let current = '';
    for (const name of segments(target)) {
      current = `${current}/${name}`;
      let next = node.children.get(name);
      if (next === undefined) {
        next = { kind: 'folder', children: new Map() };
        node.children.set(name, next);
        made ??= current;
      }
      if (next.kind !== 'folder') {
        throw new FileError('EEXIST', `file already exists, mkdir '${target}'`);
      }
      node = next;
    }
    return made;
  });
}

/** Removes a file, or with `recursive` a folder and what it holds. With `force`, a path that isn't there is fine. */
export function rm(
  target: string,
  options: { readonly force?: boolean; readonly recursive?: boolean } = {},
): Promise<void> {
  return settle(() => {
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
    if (node === root) {
      root.children.clear();
    } else {
      parentOf(target).children.delete(basename(target));
    }
    announceRemoved(target, node);
  });
}

/** Removes a folder that holds nothing. */
export function rmdir(target: string): Promise<void> {
  return settle(() => {
    const node = existing(target);
    if (node.kind !== 'folder') {
      throw new FileError('ENOTDIR', `not a directory, rmdir '${target}'`);
    }
    if (node.children.size > 0) {
      throw new FileError('ENOTEMPTY', `directory not empty, rmdir '${target}'`);
    }
    if (node !== root) {
      parentOf(target).children.delete(basename(target));
    }
  });
}

/** Moves a file over whatever file is at `to`, which is how the engine replaces a file whole. */
export function rename(from: string, to: string): Promise<void> {
  return settle(() => {
    const node = existing(from);
    if (node.kind !== 'file') {
      throw new FileError('EISDIR', `illegal operation on a directory, rename '${from}'`);
    }
    const parent = parentOf(to);
    if (parent.children.get(basename(to))?.kind === 'folder') {
      throw new FileError('EISDIR', `illegal operation on a directory, rename '${to}'`);
    }
    parentOf(from).children.delete(basename(from));
    parent.children.set(basename(to), node);
    announce(from, undefined);
    announce(to, node.content);
  });
}
