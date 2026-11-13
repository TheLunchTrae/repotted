import { fileURLToPath } from 'node:url';

/**
 * The engine's two Node modules and what stands in for each in the page: the
 * files it keeps in memory, and POSIX paths. The build and the tests both
 * bundle the engine through this map.
 */
export const engineAliases = {
  'node:fs/promises': fileURLToPath(new URL('src/engine/files.ts', import.meta.url)),
  'node:path': fileURLToPath(new URL('src/engine/path.ts', import.meta.url)),
};
