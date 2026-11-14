import { afterEach, expect, test } from 'vitest';

import { FakeGitRepository } from '../../core/tests/fake-git.js';
import { type LocalFolder, type LocalFolders, replaceWorkingCopy, syncLocalFolder } from '../src/app/local-folder.js';
import type { Preferences } from '../src/app/preferences.js';
import { Profiles } from '../src/app/profiles.js';
import { mkdir, readFile, rm, watchFiles, writeFile } from '../src/engine/files.js';

afterEach(async () => {
  await rm('/', { recursive: true });
});

/** A folder on the computer, in memory, whose writes can be made to fail. */
class Disk implements LocalFolder {
  readonly name: string;
  readonly kept = new Map<string, string>();
  failing: Error | undefined;

  constructor(name: string, files: Record<string, string> = {}) {
    this.name = name;
    for (const [path, text] of Object.entries(files)) {
      this.kept.set(path, text);
    }
  }

  files(): Promise<ReadonlyMap<string, string>> {
    return this.failing === undefined ? Promise.resolve(new Map(this.kept)) : Promise.reject(this.failing);
  }

  write(path: string, text: string): Promise<void> {
    if (path.includes('refused')) {
      return Promise.reject(new Error(`The browser refused to write ${path}`));
    }
    this.kept.set(path, text);
    return Promise.resolve();
  }

  remove(path: string): Promise<void> {
    this.kept.delete(path);
    return Promise.resolve();
  }
}

/** The browser's folders: what the picker gives next, the folder remembered, and whether it may be used. */
class Folders implements LocalFolders {
  supported = true;
  next: Disk | undefined;
  remembered: Disk | undefined;
  allowed = true;
  /** Whether the user says yes when the browser asks again. */
  grants = true;

  pick(): Promise<LocalFolder | undefined> {
    return Promise.resolve(this.next);
  }

  saved(): Promise<{ folder: LocalFolder; allowed: boolean } | undefined> {
    return Promise.resolve(
      this.remembered === undefined ? undefined : { folder: this.remembered, allowed: this.allowed },
    );
  }

  allow(): Promise<boolean> {
    this.allowed = this.grants;
    return Promise.resolve(this.allowed);
  }

  remember(folder: LocalFolder): Promise<void> {
    this.remembered = folder instanceof Disk ? folder : undefined;
    return Promise.resolve();
  }

  forget(): Promise<void> {
    this.remembered = undefined;
    return Promise.resolve();
  }
}

function memory(): Preferences {
  const kept: Record<string, unknown> = {};
  return {
    read: (key) => kept[key],
    write: (key, value) => {
      kept[key] = value;
    },
  };
}

const base = 'repository:\n  has_wiki: false\n';
const working = '/profiles/folder';

async function here(files: Record<string, string>, folder = working): Promise<void> {
  for (const [file, text] of Object.entries(files)) {
    await mkdir(`${folder}/${file}`.replace(/\/[^/]+$/u, ''), { recursive: true });
    await writeFile(`${folder}/${file}`, text);
  }
}

function names(profiles: Profiles): string[] {
  return profiles.listings.value.map((listing) => profiles.pathOf(listing));
}

test('a first sync brings each side what the other has and deletes nothing, and later changes travel both ways', async () => {
  const disk = new Disk('config', {
    'base.yaml': base,
    'teams/web.yaml': 'extends: ../base.yaml\n',
    '.hidden.yaml': 'x',
  });
  await here({ 'mine.yaml': 'merge: {}\n' });

  expect(await syncLocalFolder(working, disk)).toEqual({
    pulled: ['base.yaml', 'teams/web.yaml'],
    pushed: ['mine.yaml'],
    conflicts: [],
    failures: [],
  });
  expect(await readFile(`${working}/teams/web.yaml`, 'utf8')).toBe('extends: ../base.yaml\n');
  expect(disk.kept.get('mine.yaml')).toBe('merge: {}\n');

  // A change here, a change there, and a deletion on each side.
  await here({ 'base.yaml': 'repository:\n  has_wiki: true\n' });
  disk.kept.set('teams/web.yaml', 'extends: ../base.yaml\nmerge: {}\n');
  disk.kept.set('new.yaml', 'labels: []\n');
  await rm(`${working}/mine.yaml`);
  expect(await syncLocalFolder(working, disk)).toEqual({
    pulled: ['new.yaml', 'teams/web.yaml'],
    pushed: ['base.yaml', 'mine.yaml'],
    conflicts: [],
    failures: [],
  });
  expect(disk.kept.get('base.yaml')).toBe('repository:\n  has_wiki: true\n');
  expect(disk.kept.has('mine.yaml')).toBe(false);
  // A file that is not a profile is never touched.
  expect(disk.kept.get('.hidden.yaml')).toBe('x');

  disk.kept.delete('new.yaml');
  expect(await syncLocalFolder(working, disk)).toMatchObject({ pulled: ['new.yaml'], pushed: [] });
  await expect(readFile(`${working}/new.yaml`, 'utf8')).rejects.toThrow();
});

test('a profile changed on both sides stays as it is in both until one side is kept', async () => {
  const disk = new Disk('config', { 'base.yaml': base, 'other.yaml': base });
  await syncLocalFolder(working, disk);
  await here({ 'base.yaml': 'mine\n', 'other.yaml': 'mine too\n' });
  disk.kept.set('base.yaml', 'theirs\n');
  disk.kept.set('other.yaml', 'theirs too\n');

  expect(await syncLocalFolder(working, disk)).toEqual({
    pulled: [],
    pushed: [],
    conflicts: ['base.yaml', 'other.yaml'],
    failures: [],
  });
  expect(await readFile(`${working}/base.yaml`, 'utf8')).toBe('mine\n');
  expect(disk.kept.get('base.yaml')).toBe('theirs\n');

  // Keeping a side settles only the profiles named.
  expect(await syncLocalFolder(working, disk, { prefer: 'remote', only: ['base.yaml'] })).toEqual({
    pulled: ['base.yaml'],
    pushed: [],
    conflicts: ['other.yaml'],
    failures: [],
  });
  expect(await readFile(`${working}/base.yaml`, 'utf8')).toBe('theirs\n');
  expect(await syncLocalFolder(working, disk, { prefer: 'local', only: ['other.yaml'] })).toMatchObject({
    pushed: ['other.yaml'],
    conflicts: [],
    failures: [],
  });
  expect(disk.kept.get('other.yaml')).toBe('mine too\n');
});

test('a profile that cannot be written fails the sync without holding up the rest, and what was settled stays settled', async () => {
  const disk = new Disk('config', { 'theirs.yaml': base });
  await here({ 'a.yaml': 'a\n', 'refused.yaml': 'r\n', 'z.yaml': 'z\n' });

  expect(await syncLocalFolder(working, disk)).toMatchObject({
    failures: ['refused.yaml: The browser refused to write refused.yaml'],
  });
  // The profiles on either side of the one refused were settled all the same.
  expect(disk.kept.get('a.yaml')).toBe('a\n');
  expect(disk.kept.get('z.yaml')).toBe('z\n');
  expect(await readFile(`${working}/theirs.yaml`, 'utf8')).toBe(base);

  // What reached the folder before the failure is not taken for something deleted here, or there.
  disk.kept.delete('a.yaml');
  await rm(`${working}/refused.yaml`);
  expect(await syncLocalFolder(working, disk)).toEqual({ pulled: ['a.yaml'], pushed: [], conflicts: [], failures: [] });
  await expect(readFile(`${working}/a.yaml`, 'utf8')).rejects.toThrow();
});

test('a profile made here is never written over a file in the folder whose name differs only in case', async () => {
  const disk = new Disk('config', { 'Team.yaml': 'theirs\n' });
  await syncLocalFolder(working, disk);
  await here({ 'team.yaml': 'mine\n' });

  expect(await syncLocalFolder(working, disk)).toEqual({
    pulled: [],
    pushed: [],
    conflicts: ['team.yaml'],
    failures: [],
  });
  // Keeping this side writes nothing either, since on some computers the two names are one file.
  expect(await syncLocalFolder(working, disk, { prefer: 'local', only: ['team.yaml'] })).toMatchObject({
    pushed: [],
    conflicts: ['team.yaml'],
  });
  expect([...disk.kept]).toEqual([['Team.yaml', 'theirs\n']]);

  expect(await syncLocalFolder(working, disk, { prefer: 'remote', only: ['team.yaml'] })).toMatchObject({
    pulled: ['team.yaml'],
    conflicts: [],
    failures: [],
  });
  await expect(readFile(`${working}/team.yaml`, 'utf8')).rejects.toThrow();
});

test('a working copy is replaced record first, so one cut short never reads as profiles deleted here', async () => {
  const disk = new Disk('config', { 'one.yaml': base, 'two.yaml': base });
  await syncLocalFolder(working, disk);
  await syncLocalFolder('/profiles/folder-next', new Disk('other', { 'three.yaml': base }));
  const changes: string[] = [];
  const stop = watchFiles((file, content) => {
    changes.push(`${content === undefined ? 'rm' : 'write'} ${file}`);
  });

  await replaceWorkingCopy('/profiles/folder-next', working);
  stop();

  const inPlace = changes.filter((change) => change.includes(`${working}/`));
  expect(inPlace[0]).toBe(`rm ${working}/.repotted-folder.json`);
  expect(inPlace.at(-1)).toBe(`write ${working}/.repotted-folder.json`);
  // The copy syncs as one that agrees with its folder.
  expect(await syncLocalFolder(working, new Disk('other', { 'three.yaml': base }))).toEqual({
    pulled: [],
    pushed: [],
    conflicts: [],
    failures: [],
  });
});

test('profiles kept in a folder on the computer sync with it on each change, and the folder is remembered', async () => {
  const folders = new Folders();
  folders.next = new Disk('config', { 'base.yaml': base });
  await here({ 'local.yaml': 'merge: {}\n', 'Base.yaml': 'not this one\n' }, '/profiles/browser');
  const profiles = new Profiles(new FakeGitRepository(), memory(), () => undefined, folders);
  await profiles.refresh();

  expect(await profiles.useFolder(true)).toBeUndefined();

  expect(profiles.source.value).toEqual({ kind: 'folder', name: 'config' });
  expect(folders.remembered).toBe(folders.next);
  // The browser's profiles are added beside the folder's, and never over one of the same name in any case.
  expect(names(profiles)).toEqual(['base.yaml', 'local.yaml']);
  expect(profiles.conflicts.value).toEqual([]);
  expect(folders.next.kept.get('base.yaml')).toBe(base);
  expect(folders.next.kept.get('local.yaml')).toBe('merge: {}\n');
  expect(profiles.sync.value).toEqual({ status: 'synced', pulled: 1, pushed: 1 });

  // A write from the app reaches the folder, and a change in the folder reaches the app.
  await profiles.write(() => writeFile(`${working}/base.yaml`, 'repository:\n  has_wiki: true\n'));
  expect(folders.next.kept.get('base.yaml')).toBe('repository:\n  has_wiki: true\n');
  folders.next.kept.set('outside.yaml', 'labels: []\n');
  await profiles.refresh();
  expect(names(profiles)).toEqual(['base.yaml', 'local.yaml', 'outside.yaml']);

  await profiles.keepInBrowser();
  expect(profiles.source.value).toEqual({ kind: 'browser' });
  expect(folders.remembered).toBeUndefined();
  expect(folders.next.kept.size).toBe(3);
});

test('picking no folder, or one that cannot be read, leaves the profiles where they are', async () => {
  const folders = new Folders();
  await here({ 'local.yaml': 'merge: {}\n' }, '/profiles/browser');
  const profiles = new Profiles(new FakeGitRepository(), memory(), () => undefined, folders);
  await profiles.refresh();

  expect(await profiles.useFolder(false)).toBeUndefined();
  expect(profiles.source.value).toEqual({ kind: 'browser' });

  folders.next = new Disk('broken');
  folders.next.failing = new Error('The folder is gone');
  expect(await profiles.useFolder(true)).toBe('The folder is gone');
  expect(profiles.connectError.value).toBe('The folder is gone');
  expect(profiles.source.value).toEqual({ kind: 'browser' });
  expect(folders.remembered).toBeUndefined();
  expect(names(profiles)).toEqual(['local.yaml']);
});

test('another folder replaces the first only once it has synced', async () => {
  const folders = new Folders();
  const first = new Disk('first', { 'base.yaml': base });
  folders.next = first;
  const profiles = new Profiles(new FakeGitRepository(), memory(), () => undefined, folders);
  await profiles.useFolder(false);

  const broken = new Disk('broken');
  broken.failing = new Error('The folder is gone');
  folders.next = broken;
  await profiles.useFolder(false);
  expect(profiles.source.value).toEqual({ kind: 'folder', name: 'first' });
  expect(folders.remembered).toBe(first);
  expect(names(profiles)).toEqual(['base.yaml']);

  folders.next = new Disk('second', { 'other.yaml': base });
  await profiles.useFolder(false);
  expect(profiles.source.value).toEqual({ kind: 'folder', name: 'second' });
  expect(names(profiles)).toEqual(['other.yaml']);
  // The first folder keeps its profile, and the second isn't given it.
  expect(first.kept.has('base.yaml')).toBe(true);
  expect(folders.next.kept.has('base.yaml')).toBe(false);
});

test('on a later visit the browser asks before the folder is used, and nothing syncs until the user allows it', async () => {
  const folders = new Folders();
  const disk = new Disk('config', { 'base.yaml': base });
  folders.next = disk;
  const preferences = memory();
  await new Profiles(new FakeGitRepository(), preferences, () => undefined, folders).useFolder(false);

  folders.allowed = false;
  disk.kept.set('new.yaml', 'labels: []\n');
  const later = new Profiles(new FakeGitRepository(), preferences, () => undefined, folders);
  await later.refresh();

  expect(later.source.value).toEqual({ kind: 'folder', name: 'config' });
  expect(later.needsFolderAccess.value).toBe(true);
  expect(later.sync.value).toMatchObject({ status: 'failed' });
  // The profiles as they were at the last sync still show.
  expect(names(later)).toEqual(['base.yaml']);

  folders.grants = false;
  await later.allowFolder();
  expect(later.needsFolderAccess.value).toBe(true);

  folders.grants = true;
  await later.allowFolder();
  expect(later.needsFolderAccess.value).toBe(false);
  expect(later.sync.value).toEqual({ status: 'synced', pulled: 1, pushed: 0 });
  expect(names(later)).toEqual(['base.yaml', 'new.yaml']);
});

test('a folder the browser no longer has says so, and unsaved changes hold a change of folder back', async () => {
  const folders = new Folders();
  folders.next = new Disk('config', { 'base.yaml': base });
  const preferences = memory();
  await new Profiles(new FakeGitRepository(), preferences, () => undefined, folders).useFolder(false);

  folders.remembered = undefined;
  const later = new Profiles(new FakeGitRepository(), preferences, () => undefined, folders);
  await later.refresh();
  const sync = later.sync.value;
  expect(sync.status === 'failed' ? sync.message : '').toContain('Choose it again in Settings');
  expect(later.needsFolderAccess.value).toBe(false);

  await later.select(later.listings.value[0]);
  const editor = later.editor.value;
  const wiki = editor?.sections.value
    .flatMap((section) => section.groups.flatMap((group) => group.rows))
    .find((row) => row.field.key === 'has_wiki')?.field;
  if (editor === undefined || wiki === undefined) {
    throw new Error('The open profile should have an editor with a wiki setting.');
  }
  await editor.set(wiki, true);
  folders.next = new Disk('other');
  expect(await later.useFolder(false)).toBe('Save or reset your unsaved changes first.');
  expect(later.source.value).toEqual({ kind: 'folder', name: 'config' });
});

test('changes the folder never received go with a change of folder, and hold back a move elsewhere', async () => {
  const folders = new Folders();
  const disk = new Disk('config', { 'base.yaml': base });
  folders.next = disk;
  const preferences = memory();
  await new Profiles(new FakeGitRepository(), preferences, () => undefined, folders).useFolder(false);

  // A later visit without the browser's leave: a save and a new profile stay in this browser.
  folders.allowed = false;
  const later = new Profiles(new FakeGitRepository(), preferences, () => undefined, folders);
  await later.write(() => writeFile(`${working}/base.yaml`, 'mine\n'));
  expect(
    await later.create({ name: 'new', folder: '', start: { kind: 'empty' }, ownerType: undefined }),
  ).toBeUndefined();
  expect(disk.kept.get('base.yaml')).toBe(base);

  await later.keepInBrowser();
  expect(later.source.value).toEqual({ kind: 'folder', name: 'config' });
  expect(later.connectError.value).toContain('has not received every change');
  expect(await later.connect('lunch/config', '', false)).toContain('has not received every change');

  // Choosing the folder again, as the app says to, keeps both: the new profile goes to the folder,
  // and the one that differs from the folder's is a conflict to settle.
  expect(await later.useFolder(false)).toBeUndefined();
  expect(disk.kept.get('new.yaml')).toBe('');
  expect(later.conflicts.value).toEqual(['base.yaml']);
  expect(await readFile(`${working}/base.yaml`, 'utf8')).toBe('mine\n');

  await later.keep('local');
  expect(later.conflicts.value).toEqual([]);
  expect(disk.kept.get('base.yaml')).toBe('mine\n');

  await later.keepInBrowser();
  expect(later.source.value).toEqual({ kind: 'browser' });
});

test('a new profile is checked against the folder as it is now, and a folder that fails partway is not taken up', async () => {
  const folders = new Folders();
  const disk = new Disk('config', { 'base.yaml': base });
  folders.next = disk;
  const profiles = new Profiles(new FakeGitRepository(), memory(), () => undefined, folders);
  await profiles.useFolder(false);

  disk.kept.set('Team.yaml', 'labels: []\n');
  expect(await profiles.create({ name: 'team', folder: '', start: { kind: 'empty' }, ownerType: undefined })).toBe(
    'Team.yaml is already in the profiles folder.',
  );
  expect(disk.kept.has('team.yaml')).toBe(false);

  // A folder that refuses a write is not the one used, or remembered.
  await here({ 'refused.yaml': 'r\n' }, '/profiles/browser');
  await profiles.keepInBrowser();
  folders.next = new Disk('strict');
  expect(await profiles.useFolder(true)).toContain('refused to write');
  expect(profiles.source.value).toEqual({ kind: 'browser' });
  expect(folders.remembered).toBeUndefined();
});

test("a folder the browser stops allowing mid-visit asks for the user's leave again, and a refusal says so", async () => {
  const folders = new Folders();
  const disk = new Disk('config', { 'base.yaml': base });
  folders.next = disk;
  const profiles = new Profiles(new FakeGitRepository(), memory(), () => undefined, folders);
  await profiles.useFolder(false);

  disk.failing = new Error('The request is not allowed by the user agent');
  folders.allowed = false;
  await profiles.refresh();
  expect(profiles.needsFolderAccess.value).toBe(true);

  folders.grants = false;
  await profiles.allowFolder();
  const sync = profiles.sync.value;
  expect(sync.status === 'failed' ? sync.message : '').toContain("didn't allow it");

  // The folder is taken afresh from the browser once it is allowed again.
  const fresh = new Disk('config', { 'base.yaml': base, 'fresh.yaml': base });
  folders.remembered = fresh;
  folders.grants = true;
  await profiles.allowFolder();
  expect(names(profiles)).toEqual(['base.yaml', 'fresh.yaml']);
});

test('unsaved changes made while the picker is open still hold a change of folder back', async () => {
  const folders = new Folders();
  folders.next = new Disk('config', { 'base.yaml': base });
  const profiles = new Profiles(new FakeGitRepository(), memory(), () => undefined, folders);
  await profiles.useFolder(false);
  await profiles.select(profiles.listings.value[0]);
  const editor = profiles.editor.value;
  const wiki = editor?.sections.value
    .flatMap((section) => section.groups.flatMap((group) => group.rows))
    .find((row) => row.field.key === 'has_wiki')?.field;
  if (editor === undefined || wiki === undefined) {
    throw new Error('The open profile should have an editor with a wiki setting.');
  }

  // The picker is held open while the user changes a setting.
  let picked: (folder: LocalFolder | undefined) => void = () => undefined;
  folders.pick = () =>
    new Promise((resolve) => {
      picked = resolve;
    });
  const using = profiles.useFolder(false);
  await editor.set(wiki, true);
  picked(new Disk('other'));

  expect(await using).toBe('Save or reset your unsaved changes first.');
  expect(profiles.source.value).toEqual({ kind: 'folder', name: 'config' });
});

test('a profile that cannot be written is said, and a conflict found in the same sync still shows', async () => {
  const folders = new Folders();
  const disk = new Disk('config', { 'base.yaml': base });
  folders.next = disk;
  const profiles = new Profiles(new FakeGitRepository(), memory(), () => undefined, folders);
  await profiles.useFolder(false);

  disk.kept.set('base.yaml', 'theirs\n');
  await writeFile(`${working}/base.yaml`, 'mine\n');
  await writeFile(`${working}/refused.yaml`, 'r\n');
  await profiles.refresh();

  const sync = profiles.sync.value;
  expect(sync.status === 'failed' ? sync.message : '').toContain('refused.yaml: The browser refused to write');
  expect(profiles.conflicts.value).toEqual(['base.yaml']);
});
