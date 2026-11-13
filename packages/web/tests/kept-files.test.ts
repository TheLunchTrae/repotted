import { IDBFactory } from 'fake-indexeddb';
import { afterEach, expect, test, vi } from 'vitest';

import { browserFiles, type FileKeeper, keepFiles, type SiteLocks } from '../src/app/kept-files.js';
import { mkdir, readFile, rm, writeFile } from '../src/engine/files.js';

/** A browser's locks for one site: a named lock is held by one holder until its work ends. */
function siteLocks(): SiteLocks {
  const held = new Set<string>();
  return {
    async request(name, _options, work) {
      if (held.has(name)) {
        return work(null);
      }
      held.add(name);
      try {
        return await work({ name });
      } finally {
        held.delete(name);
      }
    },
  };
}

afterEach(async () => {
  await rm('/', { recursive: true });
});

async function text(kept: Promise<ReadonlyMap<string, Uint8Array>>): Promise<Record<string, string>> {
  return Object.fromEntries([...(await kept)].map(([file, content]) => [file, new TextDecoder().decode(content)]));
}

test('a later visit finds the files as the last one left them', async () => {
  const browser = new IDBFactory();
  const keeper = browserFiles(() => browser);
  expect((await keepFiles(keeper, siteLocks())).value).toBe('keeping');
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
  expect(
    (
      await next.keepFiles(
        next.browserFiles(() => browser),
        siteLocks(),
      )
    ).value,
  ).toBe('keeping');

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

  expect((await keepFiles(keeper, siteLocks())).value).toBe('visit-only');
  await mkdir('/profiles', { recursive: true });
  await writeFile('/profiles/a.yaml', 'one');

  expect(put).not.toHaveBeenCalled();
});

test("the first change that cannot be kept is the last one tried, so what is kept stays one moment's files", async () => {
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
  const reported = vi.fn();
  vi.stubGlobal('reportError', reported);
  const keeping = await keepFiles(keeper, siteLocks());
  await mkdir('/profiles', { recursive: true });

  // A sync writes a profile, then its record of it. The profile's write fails.
  await writeFile('/profiles/base.yaml', 'one');
  await writeFile('/profiles/.repotted-sync.json', '{}');

  await vi.waitFor(() => {
    expect(keeping.value).toBe('stopped');
  });
  await writeFile('/profiles/later.yaml', 'two');
  await new Promise((resolve) => {
    setTimeout(resolve, 10);
  });
  expect([...kept.keys()]).toEqual([]);
  expect(reported).toHaveBeenCalledWith(new Error('Storage is full.'));
  vi.unstubAllGlobals();
});

test('a second tab of the site neither loads the files nor keeps any', async () => {
  const locks = siteLocks();
  const browser = new IDBFactory();
  expect(
    (
      await keepFiles(
        browserFiles(() => browser),
        locks,
      )
    ).value,
  ).toBe('keeping');
  const load = vi.fn<FileKeeper['load']>();
  const put = vi.fn<FileKeeper['put']>();

  const second = await keepFiles({ load, put, remove: vi.fn<FileKeeper['remove']>() }, locks);
  await mkdir('/profiles', { recursive: true });
  await writeFile('/profiles/a.yaml', 'one');

  expect(second.value).toBe('elsewhere');
  expect(load).not.toHaveBeenCalled();
  expect(put).not.toHaveBeenCalled();
});

test('a kept file that cannot be placed is left out, and the rest load', async () => {
  const text = (value: string): Uint8Array => new TextEncoder().encode(value);
  const keeper: FileKeeper = {
    load: () =>
      Promise.resolve(
        new Map([
          ['/profiles/a.yaml', text('one')],
          ['/profiles/a.yaml/b.yaml', text('under a file')],
          ['/profiles/c.yaml', text('three')],
        ]),
      ),
    put: () => Promise.resolve(),
    remove: () => Promise.resolve(),
  };

  expect((await keepFiles(keeper, siteLocks())).value).toBe('keeping');

  expect(await readFile('/profiles/a.yaml', 'utf8')).toBe('one');
  expect(await readFile('/profiles/c.yaml', 'utf8')).toBe('three');
});
