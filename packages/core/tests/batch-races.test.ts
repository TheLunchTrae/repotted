import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';

import { addToBatch, batchManifest, createBatch, readBatch } from '../src/batch.js';

// Runs once a staged apply is made, so a test can act as another program between a batch's read and its write.
const hook: { afterCreate: (() => Promise<void>) | undefined } = { afterCreate: undefined };

vi.mock(import('../src/staged.js'), async (original) => {
  const staged = await original();
  return {
    ...staged,
    createStagedApply: async (...args: Parameters<typeof staged.createStagedApply>) => {
      const result = await staged.createStagedApply(...args);
      await hook.afterCreate?.();
      return result;
    },
  };
});

const { createStagedApply } = await import('../src/staged.js');

const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'repotted-batch-races-')));

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

afterEach(() => {
  hook.afterCreate = undefined;
});

async function place(): Promise<{ root: string; profile: string; folder: string }> {
  const root = path.join(directory, randomUUID());
  await mkdir(root);
  const profile = path.join(root, 'profile.yaml');
  await writeFile(profile, 'repository: { has_wiki: false }\n');
  return { root, profile, folder: path.join(root, 'batch') };
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

describe('a batch changed by another program', () => {
  test('a start whose manifest cannot be written removes the staged applies it made', async () => {
    const { profile, folder } = await place();
    const manifest = path.join(folder, batchManifest);
    hook.afterCreate = async () => {
      await writeFile(manifest, 'made elsewhere\n', { flag: 'w' });
    };

    await expect(createBatch(folder, { repositories: ['lunch/app', 'lunch/web'], profile })).rejects.toThrow(
      `Cannot start a batch in ${folder}`,
    );
    expect(await exists(path.join(folder, 'lunch', 'app.yaml'))).toBe(false);
    expect(await exists(path.join(folder, 'lunch', 'web.yaml'))).toBe(false);
    // The other program's manifest stays.
    expect(await readFile(manifest, 'utf8')).toBe('made elsewhere\n');
  });

  test('an addition that another program made first removes the staged apply it made', async () => {
    const { root, profile, folder } = await place();
    await createBatch(folder, { repositories: ['lunch/app'], profile });
    const elsewhere = path.join(root, 'web.yaml');
    await createStagedApply(elsewhere, 'lunch/web', profile);
    hook.afterCreate = async () => {
      hook.afterCreate = undefined;
      await addToBatch(folder, { join: [elsewhere] });
    };

    await expect(addToBatch(folder, { repositories: ['lunch/web'] })).rejects.toThrow(
      'lunch/web is already in the batch',
    );
    expect(await exists(path.join(folder, 'lunch', 'web.yaml'))).toBe(false);
    expect((await readBatch(folder)).members).toMatchObject([
      { repository: 'lunch/app', joined: false },
      { repository: 'lunch/web', file: elsewhere, joined: true },
    ]);
    expect(await exists(elsewhere)).toBe(true);
  });
});
