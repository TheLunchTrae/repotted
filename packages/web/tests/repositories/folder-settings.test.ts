import { GitHubError } from '@repotted/core';
import { afterEach, expect, test, vi } from 'vitest';

import { FakeGitRepository } from '../../../core/tests/support/fake-git.js';
import { repositoryFoldersKey } from '../../src/app/preferences/preference-changes.js';
import type { BrowserPreferences } from '../../src/app/preferences/preferences.js';
import { preferencesFile, SharedPreferences } from '../../src/app/preferences/shared-preferences.js';
import { FolderSettings } from '../../src/app/repositories/folder-settings.js';
import { Repositories } from '../../src/app/repositories/repositories.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const source = { kind: 'repository', repository: 'lunch/config', path: 'profiles' } as const;
const file = `profiles/${preferencesFile}`;

async function opened({
  remote = false,
  members = ['lunch/app', 'lunch/api'],
}: {
  readonly remote?: boolean;
  readonly members?: readonly string[];
} = {}) {
  const kept: Record<string, unknown> = {
    [repositoryFoldersKey]: [{ name: 'Work', repositories: members, profiles: ['base.yaml'] }],
  };
  const storage = { writable: true };
  const browser: BrowserPreferences = {
    read: (key) => kept[key],
    write: (key, value) => {
      if (!storage.writable) {
        return false;
      }
      kept[key] = value;
      return true;
    },
  };
  const github = new FakeGitRepository('lunch/config');
  if (remote) {
    github.write({ [file]: JSON.stringify(kept) });
  }
  const preferences = new SharedPreferences(github, browser, () => undefined);
  if (remote) {
    await preferences.use(source);
  }
  const review = vi.fn((_names: readonly string[]) => true);
  const repositories = new Repositories(
    github,
    { login: 'lunch', name: null },
    preferences,
    browser,
    () => undefined,
    review,
  );
  return { settings: new FolderSettings('Work', repositories), repositories, review, github, storage };
}

test('Save changes the folder settings without applying; Apply uses those saved settings without another edit', async () => {
  const { settings, repositories, review, github } = await opened();
  settings.layers.value = ['base.yaml', 'node.yaml'];
  settings.applyOnMove.value = true;
  expect(settings.apply()).toBe(false);

  expect(await settings.save(false)).toBe(true);
  expect(review).not.toHaveBeenCalled();
  expect(repositories.folder('Work')).toEqual({
    name: 'Work',
    repositories: ['lunch/app', 'lunch/api'],
    profiles: ['base.yaml', 'node.yaml'],
    applyProfilesOnMove: true,
  });
  const reopened = new FolderSettings('Work', repositories);
  expect(reopened.canSave.value).toBe(false);
  expect(reopened.canSaveAndApply.value).toBe(false);
  expect(reopened.apply()).toBe(true);
  expect(review).toHaveBeenCalledExactlyOnceWith(['lunch/app', 'lunch/api']);
  expect(github.log()).toEqual([]);
});

test('Save and apply waits for persistence, ignores repeated actions, and reviews every member despite list filters', async () => {
  const { settings, repositories, review, github } = await opened({ remote: true });
  const commitsBefore = github.log().length;
  const held = Promise.withResolvers<undefined>();
  const entered = Promise.withResolvers<undefined>();
  const request = github.request.bind(github);
  vi.spyOn(github, 'request').mockImplementationOnce(async (...args) => {
    entered.resolve(undefined);
    await held.promise;
    return request(...args);
  });
  repositories.search.value = 'not-a-member';
  settings.layers.value = ['base.yaml', 'node.yaml'];
  review.mockImplementation((names) => {
    expect(names).toEqual(['lunch/app', 'lunch/api']);
    expect(JSON.parse(github.files()[file] ?? '{}')).toEqual({
      [repositoryFoldersKey]: [
        { name: 'Work', repositories: ['lunch/app', 'lunch/api'], profiles: ['base.yaml', 'node.yaml'] },
      ],
    });
    return true;
  });
  const saving = settings.save(true);
  await entered.promise;
  expect(settings.saving.value).toBe('save-and-apply');
  expect(settings.canSave.value).toBe(false);
  expect(settings.canApply.value).toBe(false);
  expect(await settings.save(true)).toBe(false);
  expect(settings.apply()).toBe(false);
  expect(review).not.toHaveBeenCalled();

  held.resolve(undefined);
  expect(await saving).toBe(true);
  expect(review).toHaveBeenCalledOnce();
  expect(github.log()).toHaveLength(commitsBefore + 1);
});

test('a failed settings save retains edits and opens no review until a retry succeeds', async () => {
  const { settings, review, github } = await opened({ remote: true });
  settings.layers.value = ['node.yaml'];
  github.refuseWrites = new GitHubError(403, 'Write refused');

  expect(await settings.save(true)).toBe(false);
  expect(settings.error.value).toContain('Write refused');
  expect(settings.dirty.value).toBe(true);
  expect(settings.canSaveAndApply.value).toBe(true);
  expect(review).not.toHaveBeenCalled();

  github.refuseWrites = undefined;
  expect(await settings.save(true)).toBe(true);
  expect(settings.error.value).toBeUndefined();
  expect(review).toHaveBeenCalledExactlyOnceWith(['lunch/app', 'lunch/api']);
});

test('a second settings change queued during Save and apply cannot replace the visible profiles in its review', async () => {
  const { settings, repositories, review, github } = await opened({ remote: true });
  const held = Promise.withResolvers<undefined>();
  const entered = Promise.withResolvers<undefined>();
  const request = github.request.bind(github);
  vi.spyOn(github, 'request').mockImplementationOnce(async (...args) => {
    entered.resolve(undefined);
    await held.promise;
    return request(...args);
  });
  settings.layers.value = ['node.yaml'];
  const saving = settings.save(true);
  await entered.promise;
  const otherSave = repositories.setFolderProfiles('Work', ['other.yaml'], false);
  held.resolve(undefined);

  expect(await saving).toBe(false);
  await otherSave;
  expect(review).not.toHaveBeenCalled();
  expect(settings.error.value).toContain('changed while saving');
  expect(settings.canSave.value).toBe(true);
  expect(settings.layers.value).toEqual(['node.yaml']);
  expect(await settings.save(true)).toBe(true);
  expect(repositories.folder('Work')?.profiles).toEqual(['node.yaml']);
  expect(review).toHaveBeenCalledExactlyOnceWith(['lunch/app', 'lunch/api']);
});

test('refused browser storage keeps the dialog unsaved and does not apply', async () => {
  const { settings, review, storage } = await opened();
  settings.layers.value = ['node.yaml'];
  storage.writable = false;

  expect(await settings.save(true)).toBe(false);
  expect(settings.error.value).toContain("Couldn't save");
  expect(settings.dirty.value).toBe(true);
  expect(review).not.toHaveBeenCalled();
});

test('reverting or reopening after a failed save cannot apply the pending profiles as if they were saved', async () => {
  const { settings, repositories, review, github } = await opened({ remote: true });
  settings.layers.value = ['node.yaml'];
  github.refuseWrites = new GitHubError(403, 'Write refused');
  expect(await settings.save(true)).toBe(false);
  settings.layers.value = ['base.yaml'];
  expect(settings.apply()).toBe(false);
  expect(settings.canSave.value).toBe(true);

  const reopened = new FolderSettings('Work', repositories);
  expect(reopened.apply()).toBe(false);
  expect(reopened.canSave.value).toBe(true);
  expect(review).not.toHaveBeenCalled();

  github.refuseWrites = undefined;
  expect(await settings.save(false)).toBe(true);
  expect(repositories.folder('Work')?.profiles).toEqual(['base.yaml']);
  expect(settings.apply()).toBe(true);
  expect(review).toHaveBeenCalledExactlyOnceWith(['lunch/app', 'lunch/api']);
});

test('a remote settings change cannot be applied while the dialog still shows a different profile list', async () => {
  const { settings, repositories, review, github } = await opened({ remote: true });
  github.write({
    [file]: JSON.stringify({
      [repositoryFoldersKey]: [{ name: 'Work', repositories: ['lunch/app', 'lunch/api'], profiles: ['node.yaml'] }],
    }),
  });
  await repositories.preferences.reload();

  expect(settings.layers.value).toEqual(['base.yaml']);
  expect(settings.apply()).toBe(false);
  expect(settings.canSave.value).toBe(true);
  expect(review).not.toHaveBeenCalled();
  expect(await settings.save(false)).toBe(true);
  expect(repositories.folder('Work')?.profiles).toEqual(['base.yaml']);
  expect(settings.apply()).toBe(true);
});

test('a folder deleted elsewhere during save is not recreated or reviewed', async () => {
  const { settings, repositories, review, github } = await opened({ remote: true });
  github.write({ [file]: '{}' });
  settings.layers.value = ['node.yaml'];

  expect(await settings.save(true)).toBe(false);
  expect(settings.error.value).toBe('This folder no longer exists.');
  expect(repositories.folder('Work')).toBeUndefined();
  expect(review).not.toHaveBeenCalled();
});

test('changing preference destinations during save does not open a review with the other destination’s settings', async () => {
  const { settings, repositories, review, github } = await opened({ remote: true });
  const held = Promise.withResolvers<undefined>();
  const entered = Promise.withResolvers<undefined>();
  const request = github.request.bind(github);
  vi.spyOn(github, 'request').mockImplementationOnce(async (...args) => {
    entered.resolve(undefined);
    await held.promise;
    return request(...args);
  });
  settings.layers.value = ['node.yaml'];
  const saving = settings.save(true);
  await entered.promise;
  await repositories.preferences.use({ kind: 'browser' });
  held.resolve(undefined);

  expect(await saving).toBe(false);
  expect(settings.error.value).toContain("Couldn't save");
  expect(review).not.toHaveBeenCalled();
  expect(repositories.folder('Work')?.profiles).toEqual(['base.yaml']);
});

test('a busy apply leaves successfully saved settings ready for Apply after the write finishes', async () => {
  const { settings, review, github } = await opened({ remote: true });
  settings.layers.value = ['node.yaml'];
  review.mockReturnValue(false);

  expect(await settings.save(true)).toBe(false);
  expect(settings.error.value).toContain('An apply is writing');
  expect(settings.dirty.value).toBe(false);
  expect(settings.canApply.value).toBe(true);
  const commits = github.log();

  review.mockReturnValue(true);
  expect(settings.apply()).toBe(true);
  expect(settings.error.value).toBeUndefined();
  expect(github.log()).toEqual(commits);
});

test('closing a dialog during a save lets it finish without opening a late review', async () => {
  const { settings, review, github } = await opened({ remote: true });
  const commitsBefore = github.log().length;
  const held = Promise.withResolvers<undefined>();
  const entered = Promise.withResolvers<undefined>();
  const request = github.request.bind(github);
  vi.spyOn(github, 'request').mockImplementationOnce(async (...args) => {
    entered.resolve(undefined);
    await held.promise;
    return request(...args);
  });
  settings.layers.value = ['node.yaml'];
  const saving = settings.save(true);
  await entered.promise;
  settings.close();
  held.resolve(undefined);

  expect(await saving).toBe(false);
  expect(github.log()).toHaveLength(commitsBefore + 1);
  expect(review).not.toHaveBeenCalled();
  expect(settings.apply()).toBe(false);
});

test('an empty folder or empty profile list can be saved without an apply', async () => {
  const empty = await opened({ members: [] });
  empty.settings.applyOnMove.value = true;
  expect(empty.settings.canSaveAndApply.value).toBe(false);
  expect(empty.settings.apply()).toBe(false);
  expect(await empty.settings.save(false)).toBe(true);

  const withoutProfiles = await opened();
  withoutProfiles.settings.layers.value = [];
  expect(await withoutProfiles.settings.save(true)).toBe(false);
  expect(await withoutProfiles.settings.save(false)).toBe(true);
  expect(withoutProfiles.settings.apply()).toBe(false);
  expect(withoutProfiles.repositories.folder('Work')?.profiles).toBeUndefined();
});
