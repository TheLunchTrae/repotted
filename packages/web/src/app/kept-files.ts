// Keeps the engine's files across visits. The engine works on files in
// memory; this loads what the browser kept into them when the page opens,
// and from then on keeps each change, in the order the changes were made.

import { mkdir, watchFiles, writeFile } from '../engine/files.js';
import { dirname } from '../engine/path.js';

/** Where files are kept between visits, each under its absolute path. */
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

/** The browser's own storage for this site, in IndexedDB. */
export function browserFiles(indexedDB: IDBFactory): FileKeeper {
  let opened: Promise<IDBDatabase> | undefined;
  const open = (): Promise<IDBDatabase> => {
    if (opened === undefined) {
      const request = indexedDB.open(database, 1);
      request.addEventListener('upgradeneeded', () => {
        request.result.createObjectStore(store);
      });
      opened = settled(request);
      // A failed open is tried again by the next call.
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

// The file the engine writes beside a file it is replacing, which is gone again at once.
const temporary = /\/\.[^/]+\.tmp$/u;

/**
 * Puts the kept files in memory, then keeps every later change. It answers
 * false, and keeps nothing, when the browser has no storage to give, as in
 * some private windows; the files then last for the visit. `onProblem` hears
 * of a change that couldn't be kept, such as when storage is full.
 */
export async function keepFiles(keeper: FileKeeper, onProblem: (error: unknown) => void): Promise<boolean> {
  let kept: ReadonlyMap<string, Uint8Array>;
  try {
    kept = await keeper.load();
  } catch {
    return false;
  }
  for (const [file, content] of kept) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  let last = Promise.resolve();
  watchFiles((file, content) => {
    if (temporary.test(file)) {
      return;
    }
    last = last.then(() => (content === undefined ? keeper.remove(file) : keeper.put(file, content))).catch(onProblem);
  });
  return true;
}
