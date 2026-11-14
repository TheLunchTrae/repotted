import * as z from 'zod/mini';

import { mkdir, readdir, readFile, rm, writeFile } from '../engine/files.js';
import { dirname, join } from '../engine/path.js';

/** A folder on the user's computer that holds profiles, as the browser lets the page use it. */
export interface LocalFolder {
  /** The folder's own name, which is all the browser tells of where it is. */
  readonly name: string;
  /** Every profile file in it, by its path from the folder with `/` separators, with its text. */
  files(): Promise<ReadonlyMap<string, string>>;
  write(path: string, text: string): Promise<void>;
  remove(path: string): Promise<void>;
}

/** The browser's way to a folder on the computer: asking for one, and finding the one last used. */
export interface LocalFolders {
  /** Whether this browser can give a page a folder at all. */
  readonly supported: boolean;
  /** Asks the user for a folder. Undefined when they pick none. Needs a press of a button. */
  pick(): Promise<LocalFolder | undefined>;
  /** The folder remembered from before, and whether the browser still lets the page use it. */
  saved(): Promise<{ readonly folder: LocalFolder; readonly allowed: boolean } | undefined>;
  /** Asks the user to let the page use the remembered folder again. Needs a press of a button. */
  allow(): Promise<boolean>;
  /** Remembers a picked folder as the one to use from now on, in place of any other. */
  remember(folder: LocalFolder): Promise<void>;
  forget(): Promise<void>;
}

export interface FolderSyncResult {
  /** The profiles taken from the folder, by path. */
  readonly pulled: readonly string[];
  /** The profiles written to the folder, or deleted from it. */
  readonly pushed: readonly string[];
  /** The profiles that changed both here and in the folder since the last sync, which stay as they are in both. */
  readonly conflicts: readonly string[];
  /** The profiles that couldn't be read or written, each with why. They stay as they are in both. */
  readonly failures: readonly string[];
}

// What the working copy and the folder last agreed on, by path, so a sync can tell which side changed.
const record = '.repotted-folder.json';

/** Every profile file under a working copy, by its path from it, with its text. Hidden files and folders stay out. */
async function workingFiles(folder: string, prefix = ''): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await readdir(join(folder, prefix), { withFileTypes: true })) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    // The same files stay out on both sides, or one left out of the folder's would read as deleted there.
    if (entry.name.startsWith('.') || entry.name === 'node_modules') {
      continue;
    }
    if (entry.isDirectory()) {
      for (const [inner, text] of await workingFiles(folder, path)) {
        files.set(inner, text);
      }
    } else if (/\.ya?ml$/iu.test(entry.name)) {
      files.set(path, await readFile(join(folder, path), 'utf8'));
    }
  }
  return files;
}

const agreedFiles = z.record(z.string(), z.string());

async function agreed(working: string): Promise<Map<string, string>> {
  try {
    return new Map(Object.entries(agreedFiles.parse(JSON.parse(await readFile(join(working, record), 'utf8')))));
  } catch {
    // A working copy with no record, or one that can't be read, starts over as a first sync.
    return new Map();
  }
}

/**
 * The profiles of a working copy that the folder has not received as they
 * are: made or changed since the last sync, or never synced. A profile
 * deleted here since then is not among them.
 */
export async function unsyncedFiles(working: string): Promise<ReadonlyMap<string, string>> {
  const [here, base] = await Promise.all([
    workingFiles(working).catch(() => new Map<string, string>()),
    agreed(working),
  ]);
  return new Map([...here].filter(([path, text]) => base.get(path) !== text));
}

/**
 * Brings a working copy and a folder on the computer in line. A profile
 * that changed on one side since the last sync goes to the other, and so
 * does one made or deleted there. One that changed on both stays as it is
 * in both and is a conflict, until `prefer` names the side to keep for the
 * paths in `only`. On a first sync nothing is deleted on either side.
 *
 * A profile made here whose name differs only in case from a file in the
 * folder is a conflict too, and is never written whichever side is
 * preferred: on a computer that takes the two names for one file, writing
 * it would replace the other.
 *
 * A profile that can't be read or written doesn't hold up the rest: every
 * other one is settled, and it is named in `failures` with why.
 */
export async function syncLocalFolder(
  working: string,
  folder: LocalFolder,
  options: { readonly prefer?: 'local' | 'remote'; readonly only?: readonly string[] } = {},
): Promise<FolderSyncResult> {
  await mkdir(working, { recursive: true });
  const [here, listed, base] = await Promise.all([workingFiles(working), folder.files(), agreed(working)]);
  // Only profiles sync: a hidden file or folder, installed packages, or a file of another kind, is never read, written, or deleted.
  const there = new Map(
    [...listed].filter(
      ([path]) =>
        /\.ya?ml$/iu.test(path) && !path.split('/').some((part) => part.startsWith('.') || part === 'node_modules'),
    ),
  );
  const pulled: string[] = [];
  const pushed: string[] = [];
  const conflicts: string[] = [];
  const failures: string[] = [];
  const next = new Map(base);
  const settle = (path: string, text: string | undefined): void => {
    if (text === undefined) {
      next.delete(path);
    } else {
      next.set(path, text);
    }
  };
  const clashes = (path: string): boolean =>
    [...there.keys()].some((other) => other !== path && other.toLowerCase() === path.toLowerCase());
  try {
    for (const path of [...new Set([...here.keys(), ...there.keys(), ...base.keys()])].sort()) {
      const mine = here.get(path);
      const theirs = there.get(path);
      const was = base.get(path);
      if (mine === theirs) {
        settle(path, mine);
        continue;
      }
      const preferred = options.only?.includes(path) === true ? options.prefer : undefined;
      try {
        if (preferred === 'remote' || (preferred === undefined && mine === was)) {
          if (theirs === undefined) {
            await rm(join(working, path), { force: true });
          } else {
            await mkdir(dirname(join(working, path)), { recursive: true });
            await writeFile(join(working, path), theirs);
          }
          settle(path, theirs);
          pulled.push(path);
        } else if (mine !== undefined && theirs === undefined && clashes(path)) {
          conflicts.push(path);
        } else if (preferred === 'local' || theirs === was) {
          await (mine === undefined ? folder.remove(path) : folder.write(path, mine));
          settle(path, mine);
          pushed.push(path);
        } else {
          conflicts.push(path);
        }
      } catch (error) {
        failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    // What was settled before a failure stays settled, so the next sync doesn't take it for a change.
    await writeFile(join(working, record), JSON.stringify(Object.fromEntries(next)));
  }
  return { pulled, pushed, conflicts, failures };
}

/** Replaces one working copy with another, its record of the last sync included, and removes the other. */
export async function replaceWorkingCopy(from: string, to: string): Promise<void> {
  const files = await workingFiles(from);
  const agreedOn = await readFile(join(from, record));
  // The record goes first and comes back last. What the browser keeps of a
  // copy cut short then reads as profiles never synced, which a sync brings
  // back, never as profiles deleted here, which it would delete in the folder.
  await rm(join(to, record), { force: true });
  await rm(to, { recursive: true, force: true });
  for (const [path, text] of files) {
    await mkdir(dirname(join(to, path)), { recursive: true });
    await writeFile(join(to, path), text);
  }
  await mkdir(to, { recursive: true });
  await writeFile(join(to, record), agreedOn);
  await rm(from, { recursive: true, force: true });
}
