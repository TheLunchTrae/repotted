import { IDBFactory } from 'fake-indexeddb';
import { afterEach, expect, test, vi } from 'vitest';

import { FakeFleet, FakeGitHub } from '../../../core/tests/support/fake-github.js';
import { Apply } from '../../src/app/apply/apply.js';
import { BatchApply } from '../../src/app/apply/batch-apply.js';
import { browserFiles, type FileKeeper, keepFiles, type SiteLocks } from '../../src/app/storage/kept-files.js';
import { mkdir, readFile, rm, writeFile } from '../../src/engine/files.js';

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
  expect((await keepFiles(keeper, siteLocks())).keeping.value).toBe('keeping');
  await mkdir('/profiles/browser/teams', { recursive: true });
  await writeFile('/profiles/browser/base.yaml', 'one');
  await writeFile('/profiles/browser/teams/web.yaml', 'two');
  await writeFile('/profiles/browser/base.yaml', 'three');
  await writeFile('/profiles/browser/.base.yaml.0a1b2c.tmp', 'half');
  await writeFile('/profiles/browser/old.yaml', 'gone');
  await rm('/profiles/browser/old.yaml');
  // A branch's preview reads its profiles into files that last only as long as the preview.
  await mkdir('/preview/1/after', { recursive: true });
  await writeFile('/preview/1/after/base.yaml', 'branch');
  // A queued apply outlasts the visit, so the next one can carry on with it.
  await mkdir('/queue', { recursive: true });
  await writeFile('/queue/first.json', 'queued');
  await vi.waitFor(async () => {
    expect(await text(keeper.load())).toEqual({
      '/queue/first.json': 'queued',
      '/profiles/browser/base.yaml': 'three',
      '/profiles/browser/teams/web.yaml': 'two',
    });
  });

  // The next visit loads the page's modules afresh, with nothing in memory.
  vi.resetModules();
  const next = await import('../../src/app/storage/kept-files.js');
  const files = await import('../../src/engine/files.js');
  expect(
    (
      await next.keepFiles(
        next.browserFiles(() => browser),
        siteLocks(),
      )
    ).keeping.value,
  ).toBe('keeping');

  expect(await files.readFile('/profiles/browser/base.yaml', 'utf8')).toBe('three');
  expect(await files.readFile('/profiles/browser/teams/web.yaml', 'utf8')).toBe('two');
  expect(await files.readFile('/queue/first.json', 'utf8')).toBe('queued');
});

test('the files read as writing from a change until IndexedDB has it, and after a failed write too', async () => {
  const writes: { readonly finish: () => void; readonly fail: () => void }[] = [];
  const keeper: FileKeeper = {
    load: () => Promise.resolve(new Map()),
    put: () =>
      new Promise((resolve, reject) => {
        writes.push({
          finish: () => {
            resolve();
          },
          fail: () => {
            reject(new Error('Storage is full.'));
          },
        });
      }),
    remove: () => Promise.resolve(),
  };
  vi.stubGlobal('reportError', vi.fn());
  const { writing, settled } = await keepFiles(keeper, siteLocks());
  await mkdir('/profiles', { recursive: true });
  expect(writing.value).toBe(false);

  await writeFile('/profiles/a.yaml', 'one');
  await writeFile('/profiles/b.yaml', 'two');
  let bothSettled = false;
  const settling = settled().then(() => {
    bothSettled = true;
  });
  await vi.waitFor(() => {
    expect(writes).toHaveLength(1);
  });
  expect(writing.value).toBe(true);

  // The first write is done, and the second is still under way.
  writes[0]?.finish();
  await vi.waitFor(() => {
    expect(writes).toHaveLength(2);
  });
  expect(writing.value).toBe(true);
  expect(bothSettled).toBe(false);

  writes[1]?.fail();
  await vi.waitFor(() => {
    expect(writing.value).toBe(false);
  });
  // What was asked to wait for the changes goes on once they are kept or can't be.
  await settling;
  vi.unstubAllGlobals();
});

test('a browser with no storage to give keeps nothing and says so', async () => {
  const put = vi.fn<FileKeeper['put']>();
  const keeper: FileKeeper = {
    load: () => Promise.reject(new Error('The browser refused the request.')),
    put,
    remove: vi.fn<FileKeeper['remove']>(),
  };

  expect((await keepFiles(keeper, siteLocks())).keeping.value).toBe('visit-only');
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
  const { keeping } = await keepFiles(keeper, siteLocks());
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
    ).keeping.value,
  ).toBe('keeping');
  const load = vi.fn<FileKeeper['load']>();
  const put = vi.fn<FileKeeper['put']>();

  const second = await keepFiles({ load, put, remove: vi.fn<FileKeeper['remove']>() }, locks);
  await mkdir('/profiles', { recursive: true });
  await writeFile('/profiles/a.yaml', 'one');

  expect(second.keeping.value).toBe('elsewhere');
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

  expect((await keepFiles(keeper, siteLocks())).keeping.value).toBe('keeping');

  expect(await readFile('/profiles/a.yaml', 'utf8')).toBe('one');
  expect(await readFile('/profiles/c.yaml', 'utf8')).toBe('three');
});

test('a browser that has no locks, or refuses them, loads and keeps nothing, and the app still opens', async () => {
  const load = vi.fn<FileKeeper['load']>();
  const put = vi.fn<FileKeeper['put']>();
  const keeper: FileKeeper = { load, put, remove: vi.fn<FileKeeper['remove']>() };
  const refusing: SiteLocks = {
    request: () => Promise.reject(new DOMException('The request was denied.', 'SecurityError')),
  };

  expect((await keepFiles(keeper, refusing)).keeping.value).toBe('visit-only');
  expect((await keepFiles(keeper, undefined)).keeping.value).toBe('visit-only');
  await mkdir('/profiles', { recursive: true });
  await writeFile('/profiles/a.yaml', 'one');

  expect(load).not.toHaveBeenCalled();
  expect(put).not.toHaveBeenCalled();
});

test('profile drafts survive a reload, while profile applies, one-time changes, and batches do not', async () => {
  const browser = new IDBFactory();
  const keeper = browserFiles(() => browser);
  const profile = { file: '/profiles/base.yaml', name: 'base', folder: '/profiles' };
  const content = 'repository: { has_wiki: false }\ndrafts: { repository: { has_wiki: true } }\n';
  await keepFiles(keeper, siteLocks());
  await mkdir('/profiles', { recursive: true });
  await writeFile(profile.file, content);
  const github = new FakeFleet([new FakeGitHub({}, 'lunch/app'), new FakeGitHub({}, 'lunch/api')]);
  const apply = new Apply(github, () => undefined);
  const batch = new BatchApply(github, () => undefined);
  await apply.start('lunch/app', profile);
  const once = new Apply(github, () => undefined);
  await once.startWithoutProfile('lunch/app');
  await once.editor.value?.addEntry('labels', { name: 'once-only', color: 'ffffff' });
  await once.review();
  await batch.start(['lunch/api'], profile);

  await vi.waitFor(async () => {
    expect(await text(keeper.load())).toEqual({ [profile.file]: content });
  });

  // Loading persistent storage also ignores files outside the profiles workspace.
  await keeper.put('/apply/other/apply.yaml', new TextEncoder().encode('apply_to: lunch/app\n'));
  vi.resetModules();
  const next = await import('../../src/app/storage/kept-files.js');
  const files = await import('../../src/engine/files.js');
  await next.keepFiles(
    next.browserFiles(() => browser),
    siteLocks(),
  );

  expect(await files.readFile(profile.file, 'utf8')).toBe(content);
  await expect(files.stat('/apply')).rejects.toMatchObject({ code: 'ENOENT' });
});
