// POSIX paths for the engine in the page, where the web build maps
// `node:path` to this module. It has the functions the engine calls, and
// they answer as Node's do on Linux and macOS. The page's files hang from
// `/`, which also stands in for the working directory.

export const sep = '/';

export function isAbsolute(target: string): boolean {
  return target.startsWith('/');
}

/** A path's segments with `.` and empty ones dropped and each `..` taken with the segment before it. */
function normalized(target: string, absolute: boolean): string[] {
  const kept: string[] = [];
  for (const segment of target.split('/')) {
    if (segment === '..') {
      if (kept.length > 0 && kept.at(-1) !== '..') {
        kept.pop();
      } else if (!absolute) {
        kept.push('..');
      }
    } else if (segment !== '' && segment !== '.') {
      kept.push(segment);
    }
  }
  return kept;
}

export function join(...parts: string[]): string {
  const joined = parts.filter((part) => part !== '').join('/');
  const absolute = isAbsolute(joined);
  const path = normalized(joined, absolute).join('/');
  return absolute ? `/${path}` : path === '' ? '.' : path;
}

/** The absolute path that the parts name, each read from the one before it, starting at `/`. */
export function resolve(...parts: string[]): string {
  const from = parts.findLastIndex(isAbsolute);
  return `/${normalized(parts.slice(Math.max(from, 0)).join('/'), true).join('/')}`;
}

function withoutTrailingSlashes(target: string): string {
  return target.replace(/(?<=.)\/+$/u, '');
}

export function dirname(target: string): string {
  const path = withoutTrailingSlashes(target);
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '.' : cut === 0 ? '/' : path.slice(0, cut);
}

export function basename(target: string): string {
  const path = withoutTrailingSlashes(target);
  return path.slice(path.lastIndexOf('/') + 1);
}

/** The path from the folder `from` to `to`, with `..` for each folder it climbs. */
export function relative(from: string, to: string): string {
  const start = normalized(resolve(from), true);
  const end = normalized(resolve(to), true);
  let shared = 0;
  while (shared < start.length && shared < end.length && start[shared] === end[shared]) {
    shared += 1;
  }
  return [...start.slice(shared).map(() => '..'), ...end.slice(shared)].join('/');
}

// eslint-disable-next-line standards/no-default-export -- the engine imports node:path by its default export, and this module stands in for it
export default { basename, dirname, isAbsolute, join, relative, resolve, sep };
