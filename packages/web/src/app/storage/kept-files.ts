// Keeps the engine's files across visits. The engine works on files in
// memory; this loads what the browser kept into them when the page opens,
// and from then on keeps each change, in the order the changes were made.
//
// What is kept must always be the files as they were at some moment. A sync
// writes the profiles it pulls and then its record of them, and a record
// kept without one of its profiles reads, on the next visit, as that profile
// deleted here, which the next sync would carry to GitHub. So one tab keeps
// the files at a time, and the first change that can't be kept is the last
// one tried.

import { computed, type ReadonlySignal, signal } from '@preact/signals';

import { mkdir, watchFiles, writeFile } from '../../engine/files.js';
import { dirname } from '../../engine/path.js';

export interface FileKeeper {
  load(): Promise<ReadonlyMap<string, Uint8Array>>;
  put(file: string, content: Uint8Array): Promise<void>;
  remove(file: string): Promise<void>;
}

const database = 'repotted';
const store = 'files';

function settled<Result>(request: IDBRequest<Result>): Promise<Result> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => {
      resolve(request.result);
    });
    request.addEventListener('error', () => {
      reject(request.error ?? new Error('The browser refused the request.'));
    });
  });
}

function finished(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => {
      resolve();
    });
    const fail = (): void => {
      reject(transaction.error ?? new Error('The browser gave up on the change.'));
    };
    transaction.addEventListener('error', fail);
    transaction.addEventListener('abort', fail);
  });
}

/** `indexedDB` is asked for at each use, since naming it can throw. */
export function browserFiles(indexedDB: () => IDBFactory): FileKeeper {
  let opened: Promise<IDBDatabase> | undefined;
  const open = (): Promise<IDBDatabase> => {
    if (opened === undefined) {
      opened = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB().open(database, 1);
        request.addEventListener('upgradeneeded', () => {
          request.result.createObjectStore(store);
        });
        settled(request).then((connection) => {
          // A later version of the app, in another tab, waits on this connection to change the store.
          connection.addEventListener('versionchange', () => {
            connection.close();
            opened = undefined;
          });
          resolve(connection);
        }, reject);
      });
      opened.catch(() => {
        opened = undefined;
      });
    }
    return opened;
  };
  const change = async (work: (files: IDBObjectStore) => void): Promise<void> => {
    const transaction = (await open()).transaction(store, 'readwrite');
    work(transaction.objectStore(store));
    await finished(transaction);
  };
  return {
    async load() {
      const files = (await open()).transaction(store, 'readonly').objectStore(store);
      const [keys, values] = await Promise.all([settled(files.getAllKeys()), settled(files.getAll())]);
      const kept = new Map<string, Uint8Array>();
      keys.forEach((key, index) => {
        const value: unknown = values[index];
        if (typeof key === 'string' && value instanceof Uint8Array) {
          kept.set(key, value);
        }
      });
      return kept;
    },
    put: (file, content) =>
      change((files) => {
        files.put(content, file);
      }),
    remove: (file) =>
      change((files) => {
        files.delete(file);
      }),
  };
}

/**
 * Whether the files outlast the visit:
 * - `keeping`: each change is kept.
 * - `visit-only`: the browser has no storage or no locks to give, as in some private windows.
 * - `stopped`: a change couldn't be kept, such as when storage is full, so no later one is tried.
 * - `elsewhere`: another tab of the site keeps the files, and this one must not use them.
 */
export type Keeping = 'keeping' | 'visit-only' | 'stopped' | 'elsewhere';

// The file the engine writes beside a file it is replacing, which is gone again at once.
const temporary = /\/\.[^/]+\.tmp$/u;

function isKept(file: string): boolean {
  return file.startsWith('/profiles/') && !temporary.test(file);
}

/** Never kept between visits: its files last only as long as the preview. */
export const branchPreviewFolder = '/preview';
const lockName = 'repotted-files';

export interface SiteLocks {
  request(
    name: string,
    options: { readonly ifAvailable: true },
    work: (lock: object | null) => Promise<unknown> | undefined,
  ): Promise<unknown>;
}

function holdSiteLockUntilTabCloses(locks: SiteLocks): Promise<boolean> {
  return new Promise((resolve, reject) => {
    locks
      .request(lockName, { ifAvailable: true }, (lock) => {
        resolve(lock !== null);
        // Held until the tab closes, when the browser lets it go.
        return lock === null ? undefined : new Promise(() => undefined);
      })
      .catch(reject);
  });
}

export interface KeptFiles {
  /** The answered state changes at most once more, to `stopped`. */
  readonly keeping: ReadonlySignal<Keeping>;
  /** A change made in memory isn't kept yet, so closing the tab now would lose it. */
  readonly writing: ReadonlySignal<boolean>;
}

export async function keepFiles(keeper: FileKeeper, locks: SiteLocks | undefined): Promise<KeptFiles> {
  const keeping = signal<Keeping>('keeping');
  const waiting = signal(0);
  const kept: KeptFiles = { keeping, writing: computed(() => waiting.value > 0) };
  // A browser without locks, or one that refuses them as it does a site whose
  // data it blocks, can't say that no other tab keeps the files, so nothing is kept.
  const held = locks === undefined ? undefined : await holdSiteLockUntilTabCloses(locks).catch(() => undefined);
  if (held !== true) {
    keeping.value = held === undefined ? 'visit-only' : 'elsewhere';
    return kept;
  }
  let loaded: ReadonlyMap<string, Uint8Array>;
  try {
    loaded = await keeper.load();
  } catch {
    keeping.value = 'visit-only';
    return kept;
  }
  for (const [file, content] of loaded) {
    if (!isKept(file)) {
      continue;
    }
    // A file that can't be placed, such as one under a path that is itself a file, is left out.
    await mkdir(dirname(file), { recursive: true })
      .then(() => writeFile(file, content))
      .catch(() => undefined);
  }
  let last = Promise.resolve();
  watchFiles((file, content) => {
    if (!isKept(file)) {
      return;
    }
    waiting.value += 1;
    last = last.then(async () => {
      try {
        if (keeping.value === 'keeping') {
          await (content === undefined ? keeper.remove(file) : keeper.put(file, content));
        }
      } catch (error) {
        keeping.value = 'stopped';
        reportError(error);
      } finally {
        waiting.value -= 1;
      }
    });
  });
  return kept;
}
