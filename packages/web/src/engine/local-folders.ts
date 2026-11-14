// A folder on the user's computer, through the File System Access API, which
// only Chromium browsers have. The folder's handle is kept in IndexedDB, in a
// database of its own, so the page finds it on the next visit; the browser
// asks the user again before the page may use it then.

import type { LocalFolder, LocalFolders } from '../app/local-folder.js';

// The parts of the API the DOM library leaves out.
interface Permissions {
  queryPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
}
type Entry = FileSystemDirectoryHandle | FileSystemFileHandle;
type Directory = FileSystemDirectoryHandle & Permissions & { values(): AsyncIterable<Entry> };
type Picker = (options: { mode: 'readwrite'; id: string }) => Promise<FileSystemDirectoryHandle>;

/** Whether a value is a directory handle with the parts of the API the DOM library leaves out. */
function isDirectory(value: unknown): value is Directory {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'directory' &&
    'values' in value &&
    'queryPermission' in value
  );
}

function isPicker(value: unknown): value is Picker {
  return typeof value === 'function';
}

const database = 'repotted-folders';
const store = 'handles';
const key = 'profiles';

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

async function files(directory: Directory, prefix = ''): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for await (const entry of directory.values()) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    // Hidden files and folders stay out, as they do in a sync with GitHub, and so do installed packages.
    if (entry.name.startsWith('.') || entry.name === 'node_modules') {
      continue;
    }
    if (isDirectory(entry)) {
      for (const [inner, text] of await files(entry, path)) {
        found.set(inner, text);
      }
    } else if (entry.kind === 'directory') {
      continue;
    } else if (/\.ya?ml$/iu.test(entry.name)) {
      found.set(path, await (await entry.getFile()).text());
    }
  }
  return found;
}

async function parent(
  directory: Directory,
  path: string,
  create: boolean,
): Promise<[FileSystemDirectoryHandle, string]> {
  const parts = path.split('/');
  const name = parts.pop() ?? '';
  let at: FileSystemDirectoryHandle = directory;
  for (const part of parts) {
    at = await at.getDirectoryHandle(part, { create });
  }
  return [at, name];
}

function folderOf(directory: Directory): LocalFolder {
  return {
    name: directory.name,
    files: () => files(directory),
    async write(path, text) {
      const [at, name] = await parent(directory, path, true);
      const writable = await (await at.getFileHandle(name, { create: true })).createWritable();
      try {
        await writable.write(text);
        await writable.close();
      } catch (error) {
        // The file stays as it was when a write is cut short.
        await writable.abort().catch(() => undefined);
        throw error;
      }
    },
    async remove(path) {
      try {
        const [at, name] = await parent(directory, path, false);
        await at.removeEntry(name);
      } catch (error) {
        // A file that is already gone is removed.
        if (!(error instanceof DOMException && error.name === 'NotFoundError')) {
          throw error;
        }
      }
    },
  };
}

/**
 * The browser's folders. `indexedDB` and `showDirectoryPicker` are asked for
 * at each use, since naming the first can throw and the second is missing
 * outside Chromium browsers; `scope` is what the picker is called on.
 */
export function browserFolders(
  indexedDB: () => IDBFactory,
  showDirectoryPicker: () => unknown,
  scope: object,
): LocalFolders {
  const picker = (): Picker | undefined => {
    const found = showDirectoryPicker();
    return isPicker(found) ? (options) => Reflect.apply(found, scope, [options]) : undefined;
  };
  const open = async (): Promise<IDBDatabase> => {
    const request = indexedDB().open(database, 1);
    request.addEventListener('upgradeneeded', () => {
      request.result.createObjectStore(store);
    });
    return settled(request);
  };
  const kept = async (): Promise<Directory | undefined> => {
    const connection = await open();
    try {
      const found: unknown = await settled(connection.transaction(store).objectStore(store).get(key));
      return isDirectory(found) ? found : undefined;
    } finally {
      connection.close();
    }
  };
  const keep = async (directory: Directory | undefined): Promise<void> => {
    const connection = await open();
    try {
      const handles = connection.transaction(store, 'readwrite').objectStore(store);
      await (directory === undefined ? settled(handles.delete(key)) : settled(handles.put(directory, key)));
    } finally {
      connection.close();
    }
  };
  const picked = new WeakMap<LocalFolder, Directory>();
  return {
    get supported() {
      return picker() !== undefined;
    },
    async pick() {
      const ask = picker();
      if (ask === undefined) {
        return undefined;
      }
      let directory: FileSystemDirectoryHandle;
      try {
        directory = await ask({ mode: 'readwrite', id: 'repotted-profiles' });
      } catch (error) {
        // Closing the picker picks nothing.
        if (error instanceof DOMException && error.name === 'AbortError') {
          return undefined;
        }
        throw error;
      }
      if (!isDirectory(directory)) {
        throw new Error('The browser gave a folder Repotted cannot use.');
      }
      const folder = folderOf(directory);
      picked.set(folder, directory);
      return folder;
    },
    async saved() {
      const directory = await kept().catch(() => undefined);
      return directory === undefined
        ? undefined
        : {
            folder: folderOf(directory),
            allowed: (await directory.queryPermission({ mode: 'readwrite' })) === 'granted',
          };
    },
    async allow() {
      const directory = await kept();
      return directory !== undefined && (await directory.requestPermission({ mode: 'readwrite' })) === 'granted';
    },
    async remember(folder) {
      const directory = picked.get(folder);
      if (directory !== undefined) {
        await keep(directory);
      }
    },
    forget: () => keep(undefined),
  };
}
