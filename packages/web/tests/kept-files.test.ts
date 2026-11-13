import { IDBFactory } from 'fake-indexeddb';
import { afterEach, expect, test, vi } from 'vitest';

import { browserFiles, type FileKeeper, keepFiles } from '../src/app/kept-files.js';
import { mkdir, rm, writeFile } from '../src/engine/files.js';

afterEach(async () => {
  await rm('/', { recursive: true });
});

async function text(kept: Promise<ReadonlyMap<string, Uint8Array>>): Promise<Record<string, string>> {
  return Object.fromEntries([...(await kept)].map(([file, content]) => [file, new TextDecoder().decode(content)]));
}

test('a later visit finds the files as the last one left them', async () => {
  const browser = new IDBFactory();
  const keeper = browserFiles(browser);
  expect(await keepFiles(keeper, () => undefined)).toBe(true);
  await mkdir('/profiles/browser/teams', { recursive: true });
  await writeFile('/profiles/browser/base.yaml', 'one');
  await writeFile('/profiles/browser/teams/web.yaml', 'two');
  await writeFile('/profiles/browser/base.yaml', 'three');
  await writeFile('/profiles/browser/.base.yaml.0a1b2c.tmp', 'half');
  await writeFile('/profiles/browser/old.yaml', 'gone');
  await rm('/profiles/browser/old.yaml');
  await vi.waitFor(async () => {
    expect(await text(keeper.load())).toEqual({
      '/profiles/browser/base.yaml': 'three',
      '/profiles/browser/teams/web.yaml': 'two',
    });
  });

  // The next visit loads the page's modules afresh, with nothing in memory.
  vi.resetModules();
  const next = await import('../src/app/kept-files.js');
  const files = await import('../src/engine/files.js');
  expect(await next.keepFiles(next.browserFiles(browser), () => undefined)).toBe(true);

  expect(await files.readFile('/profiles/browser/base.yaml', 'utf8')).toBe('three');
  expect(await files.readFile('/profiles/browser/teams/web.yaml', 'utf8')).toBe('two');
});

test('a browser with no storage to give keeps nothing and says so', async () => {
  const put = vi.fn<FileKeeper['put']>();
  const keeper: FileKeeper = {
    load: () => Promise.reject(new Error('The browser refused the request.')),
    put,
    remove: vi.fn<FileKeeper['remove']>(),
  };

  expect(await keepFiles(keeper, () => undefined)).toBe(false);
  await mkdir('/profiles', { recursive: true });
  await writeFile('/profiles/a.yaml', 'one');

  expect(put).not.toHaveBeenCalled();
});

test('a change that cannot be kept is reported, and later changes are still kept', async () => {
  const kept = new Map<string, Uint8Array>();
  const keeper: FileKeeper = {
    load: () => Promise.resolve(new Map()),
    put: vi
      .fn<FileKeeper['put']>((file, content) => {
        kept.set(file, content);
        return Promise.resolve();
      })
      .mockRejectedValueOnce(new Error('Storage is full.')),
    remove: () => Promise.resolve(),
  };
  const problems: unknown[] = [];
  await keepFiles(keeper, (error) => problems.push(error));
  await mkdir('/profiles', { recursive: true });

  await writeFile('/profiles/a.yaml', 'one');
  await writeFile('/profiles/b.yaml', 'two');

  await vi.waitFor(() => {
    expect([...kept.keys()]).toEqual(['/profiles/b.yaml']);
  });
  expect(problems).toEqual([new Error('Storage is full.')]);
});
