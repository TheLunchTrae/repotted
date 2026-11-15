import { chmod, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { randomHex } from './bytes.js';

// Antivirus or the search indexer can briefly hold a file that was just written.
const transientWindowsFileLockErrorCodes = new Set(['EPERM', 'EBUSY', 'EACCES']);

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined;
}

/**
 * The temporary file's name starts with a dot, so neither a sync nor a profile
 * listing takes it for a profile. `create: false` keeps a write from bringing
 * back a file deleted meanwhile.
 */
export async function replaceFile(
  file: string,
  content: Uint8Array | string,
  { create = true }: { create?: boolean } = {},
): Promise<void> {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomHex(6)}.tmp`);
  try {
    await writeFile(temporary, content);
    const existing = await stat(file).catch((error: unknown) => {
      if (create && errorCode(error) === 'ENOENT') {
        return undefined;
      }
      throw error;
    });
    // Set after writing, since the mode a write asks for passes through the umask.
    if (existing !== undefined) {
      await chmod(temporary, existing.mode);
    }
    for (let attempt = 1; ; attempt += 1) {
      try {
        await rename(temporary, file);
        return;
      } catch (error) {
        if (attempt === 5 || !transientWindowsFileLockErrorCodes.has(errorCode(error) ?? '')) {
          throw error;
        }
        await new Promise((done) => setTimeout(done, attempt * 50));
      }
    }
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
