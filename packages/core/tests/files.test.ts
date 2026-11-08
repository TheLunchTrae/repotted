import { chmod, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test, vi } from 'vitest';

import { replaceFile } from '../src/files.js';

vi.mock(import('node:fs/promises'), async (original) => {
  const actual = await original();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const directory = await mkdtemp(path.join(tmpdir(), 'repotted-files-'));

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

function busy(): Error {
  return Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
}

describe('replaceFile', () => {
  test('keeps the mode of the file it replaces and waits out a move Windows holds up', async () => {
    const file = path.join(directory, 'held.yaml');
    await writeFile(file, 'old\n');
    await chmod(file, 0o664);
    vi.mocked(rename).mockRejectedValueOnce(busy()).mockRejectedValueOnce(busy());

    await replaceFile(file, 'new\n');

    expect(await readFile(file, 'utf8')).toBe('new\n');
    expect((await stat(file)).mode & 0o777).toBe(0o664);
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  test('keeps the old file and no temporary one when the move keeps failing', async () => {
    const file = path.join(directory, 'stuck.yaml');
    await writeFile(file, 'old\n');
    vi.mocked(rename).mockRejectedValue(busy());

    const failure = await replaceFile(file, 'new\n').then(
      () => undefined,
      (error: unknown) => error,
    );
    vi.mocked(rename).mockReset();

    expect(failure).toMatchObject({ code: 'EBUSY' });
    expect(await readFile(file, 'utf8')).toBe('old\n');
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  test('lets two writes of one file run at once', async () => {
    const file = path.join(directory, 'twice.yaml');

    await Promise.all([replaceFile(file, 'one\n'), replaceFile(file, 'two\n')]);

    expect(['one\n', 'two\n']).toContain(await readFile(file, 'utf8'));
  });

  test('refuses to bring back a file deleted meanwhile when asked to replace only', async () => {
    const file = path.join(directory, 'gone.yaml');

    const failure = await replaceFile(file, 'new\n', { create: false }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({ code: 'ENOENT' });
    expect((await readdir(directory)).filter((name) => name.startsWith('.gone.yaml'))).toEqual([]);
  });
});
