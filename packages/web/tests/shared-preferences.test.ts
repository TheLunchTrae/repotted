import { computed } from '@preact/signals';
import { GitHubError } from '@repotted/core';
import { expect, test, vi } from 'vitest';

import { FakeGitRepository } from '../../core/tests/fake-git.js';
import type { Preferences } from '../src/app/preferences.js';
import { preferencesFile, SharedPreferences } from '../src/app/shared-preferences.js';

const source = { kind: 'repository', repository: 'lunch/config', path: 'profiles' } as const;
const file = `profiles/${preferencesFile}`;

function memory(start: Record<string, unknown> = {}): Preferences & { readonly kept: Record<string, unknown> } {
  const kept = { ...start };
  return {
    kept,
    read: (key) => kept[key],
    write: (key, value) => {
      kept[key] = value;
    },
  };
}

/** Adds a name to a list, as the repositories page does. */
function adding(name: string): (current: unknown) => unknown {
  return (current) => [...(Array.isArray(current) ? (current as unknown[]) : []), name];
}

function saved(repository: FakeGitRepository): unknown {
  const text = repository.files()[file];
  return text === undefined ? undefined : JSON.parse(text);
}

/** Waits until every read and save queued so far has run. */
async function settled(preferences: SharedPreferences): Promise<void> {
  await preferences.use(source);
  await vi.waitFor(() => {
    expect(preferences.error.value).toBeUndefined();
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('kept in this browser until the profiles are kept in a repository, and again after', async () => {
  const repository = new FakeGitRepository();
  repository.write({ [file]: '{ "hidden-repositories": ["lunch/old"] }' });
  const browser = memory({ 'hidden-repositories': ['lunch/mine'] });
  const preferences = new SharedPreferences(repository, browser, () => undefined);
  const hidden = computed(() => preferences.read('hidden-repositories'));

  expect(hidden.value).toEqual(['lunch/mine']);
  await preferences.use(source);
  expect(hidden.value).toEqual(['lunch/old']);

  await preferences.use({ kind: 'browser' });
  preferences.write('hidden-repositories', ['lunch/other']);
  expect(browser.kept['hidden-repositories']).toEqual(['lunch/other']);
  expect(hidden.value).toEqual(['lunch/other']);
  expect(saved(repository)).toEqual({ 'hidden-repositories': ['lunch/old'] });
});

test('a write commits the file beside the profiles, keeping keys saved elsewhere', async () => {
  const repository = new FakeGitRepository();
  repository.write({ 'profiles/web.yaml': 'name: web\n' });
  const preferences = new SharedPreferences(repository, memory(), () => undefined);
  await preferences.use(source);

  preferences.write('hidden-repositories', ['lunch/old']);
  await settled(preferences);
  expect(saved(repository)).toEqual({ 'hidden-repositories': ['lunch/old'] });
  expect(repository.log()[0]).toBe('Update Repotted preferences');

  // Another browser saves its own choice meanwhile.
  repository.write({ [file]: '{ "hidden-repositories": ["lunch/old"], "other": 1 }' });
  preferences.write('hidden-repository-owners', ['acme']);
  await settled(preferences);
  expect(saved(repository)).toEqual({
    'hidden-repositories': ['lunch/old'],
    'hidden-repository-owners': ['acme'],
    other: 1,
  });
  expect(preferences.read('other')).toBe(1);

  preferences.write('hidden-repository-owners', undefined);
  await settled(preferences);
  expect(saved(repository)).toEqual({ 'hidden-repositories': ['lunch/old'], other: 1 });
});

test('a save that loses to one made elsewhere reads the file again and keeps both', async () => {
  const repository = new FakeGitRepository();
  repository.write({ [file]: '{}' });
  const preferences = new SharedPreferences(repository, memory(), () => undefined);
  await preferences.use(source);
  repository.beforeContentsWrite = () => {
    repository.write({ [file]: '{ "other": 1 }' });
  };

  preferences.write('hidden-repositories', ['lunch/old']);
  await settled(preferences);

  expect(saved(repository)).toEqual({ 'hidden-repositories': ['lunch/old'], other: 1 });
});

test('a write made while the file is read is kept and saved', async () => {
  const repository = new FakeGitRepository();
  repository.write({ [file]: '{ "other": 1 }' });
  const preferences = new SharedPreferences(repository, memory(), () => undefined);

  const reading = preferences.use(source);
  preferences.write('hidden-repositories', ['lunch/old']);
  await reading;
  expect(preferences.read('hidden-repositories')).toEqual(['lunch/old']);
  await settled(preferences);

  expect(saved(repository)).toEqual({ 'hidden-repositories': ['lunch/old'], other: 1 });
});

test('a save GitHub refuses keeps the choice here, says why, and goes with the next write', async () => {
  const repository = new FakeGitRepository();
  const preferences = new SharedPreferences(repository, memory(), () => undefined);
  await preferences.use(source);
  repository.refuseWrites = new GitHubError(403, 'Resource not accessible by integration');

  preferences.write('hidden-repositories', ['lunch/old']);
  await vi.waitFor(() => {
    expect(preferences.error.value).toBe(
      "Couldn't save your preferences to lunch/config: Resource not accessible by integration",
    );
  });
  expect(preferences.read('hidden-repositories')).toEqual(['lunch/old']);

  repository.refuseWrites = undefined;
  preferences.write('hidden-repository-owners', ['acme']);
  await settled(preferences);
  expect(saved(repository)).toEqual({ 'hidden-repositories': ['lunch/old'], 'hidden-repository-owners': ['acme'] });
});

test('a file that is not an object of preferences reads as empty and is replaced by the next save', async () => {
  const repository = new FakeGitRepository();
  repository.write({ [file]: 'not json' });
  const preferences = new SharedPreferences(repository, memory(), () => undefined);
  await preferences.use(source);
  expect(preferences.read('hidden-repositories')).toBeUndefined();

  preferences.write('hidden-repositories', ['lunch/old']);
  await settled(preferences);
  expect(saved(repository)).toEqual({ 'hidden-repositories': ['lunch/old'] });
});

test('a refused sign-in while reading is reported as signed out', async () => {
  const repository = new FakeGitRepository();
  vi.spyOn(repository, 'request').mockRejectedValue(new GitHubError(401, 'Bad credentials'));
  const signedOut = vi.fn();
  const preferences = new SharedPreferences(repository, memory(), signedOut);

  await preferences.use(source);

  expect(signedOut).toHaveBeenCalledOnce();
  expect(preferences.error.value).toBeUndefined();
});

test('a change made from an old copy of the file is made onto the file as it is, keeping names added elsewhere', async () => {
  const repository = new FakeGitRepository();
  repository.write({ [file]: '{ "hidden-repositories": ["lunch/old"] }' });
  const preferences = new SharedPreferences(repository, memory(), () => undefined);
  await preferences.use(source);

  // Another browser hides one after this one read the file.
  repository.write({ [file]: '{ "hidden-repositories": ["lunch/old", "acme/web"] }' });
  preferences.update('hidden-repositories', adding('zeta/site'));
  expect(preferences.read('hidden-repositories')).toEqual(['lunch/old', 'zeta/site']);
  await settled(preferences);

  expect(saved(repository)).toEqual({ 'hidden-repositories': ['lunch/old', 'acme/web', 'zeta/site'] });
  expect(preferences.read('hidden-repositories')).toEqual(['lunch/old', 'acme/web', 'zeta/site']);
});

test('a change made while the file is read, or after the read failed, keeps what the file holds', async () => {
  const repository = new FakeGitRepository();
  repository.write({ [file]: '{ "hidden-repositories": ["acme/web", "acme/api"] }' });
  const preferences = new SharedPreferences(repository, memory(), () => undefined);

  const reading = preferences.use(source);
  preferences.update('hidden-repositories', adding('zeta/site'));
  await reading;
  expect(preferences.read('hidden-repositories')).toEqual(['acme/web', 'acme/api', 'zeta/site']);
  await settled(preferences);
  expect(saved(repository)).toEqual({ 'hidden-repositories': ['acme/web', 'acme/api', 'zeta/site'] });

  const failing = new SharedPreferences(repository, memory(), () => undefined);
  const request = repository.request.bind(repository);
  const once = vi.spyOn(repository, 'request').mockRejectedValueOnce(new GitHubError(500, 'Server error'));
  await failing.use(source);
  expect(failing.error.value).toBe("Couldn't read your preferences from lunch/config: Server error");
  once.mockImplementation(request);
  failing.update('hidden-repositories', adding('lunch/new'));
  await settled(failing);
  expect(saved(repository)).toEqual({ 'hidden-repositories': ['acme/web', 'acme/api', 'zeta/site', 'lunch/new'] });
});

test('a reload shows what was saved elsewhere since the file was read', async () => {
  const repository = new FakeGitRepository();
  const preferences = new SharedPreferences(repository, memory(), () => undefined);
  await preferences.use(source);

  repository.write({ [file]: '{ "hidden-repositories": ["acme/web"] }' });
  expect(preferences.read('hidden-repositories')).toBeUndefined();
  await preferences.reload();

  expect(preferences.read('hidden-repositories')).toEqual(['acme/web']);
});

test('a save that finds the file made meanwhile tries again onto it', async () => {
  const repository = new FakeGitRepository();
  const preferences = new SharedPreferences(repository, memory(), () => undefined);
  await preferences.use(source);
  repository.beforeContentsWrite = () => {
    repository.write({ [file]: '{ "other": 1 }' });
  };

  preferences.write('hidden-repositories', ['lunch/old']);
  await settled(preferences);

  expect(saved(repository)).toEqual({ 'hidden-repositories': ['lunch/old'], other: 1 });
});

test('a save that keeps losing gives up after three tries and says why', async () => {
  const repository = new FakeGitRepository();
  repository.write({ [file]: '{}' });
  const preferences = new SharedPreferences(repository, memory(), () => undefined);
  await preferences.use(source);
  const put = vi.fn();
  const request = repository.request.bind(repository);
  vi.spyOn(repository, 'request').mockImplementation(async (method, path, body) => {
    if (method === 'PUT') {
      put();
      throw new GitHubError(409, 'is at a different sha');
    }
    return request(method, path, body);
  });

  preferences.write('hidden-repositories', ['lunch/old']);
  await vi.waitFor(() => {
    expect(preferences.error.value).toBe("Couldn't save your preferences to lunch/config: is at a different sha");
  });

  expect(put).toHaveBeenCalledTimes(3);
  expect(preferences.read('hidden-repositories')).toEqual(['lunch/old']);
});

test('a read of a file no longer used is thrown away, and a change made for it is still saved there', async () => {
  const repository = new FakeGitRepository();
  repository.write({ [file]: '{ "hidden-repositories": ["lunch/old"] }' });
  const browser = memory({ 'hidden-repositories': ['lunch/mine'] });
  const preferences = new SharedPreferences(repository, browser, () => undefined);

  const reading = preferences.use(source);
  preferences.update('hidden-repositories', adding('acme/web'));
  await preferences.use({ kind: 'browser' });
  await reading;
  expect(preferences.read('hidden-repositories')).toEqual(['lunch/mine']);

  await preferences.use(source);
  await settled(preferences);
  expect(saved(repository)).toEqual({ 'hidden-repositories': ['lunch/old', 'acme/web'] });
  expect(browser.kept['hidden-repositories']).toEqual(['lunch/mine']);
});

test('a read after a save failed tries the save again, and keeps saying why until it succeeds', async () => {
  const repository = new FakeGitRepository();
  repository.write({ [file]: '{}' });
  const preferences = new SharedPreferences(repository, memory(), () => undefined);
  await preferences.use(source);
  repository.refuseWrites = new GitHubError(403, 'Resource not accessible by integration');
  preferences.update('hidden-repositories', adding('acme/web'));
  await vi.waitFor(() => {
    expect(preferences.error.value).toBeDefined();
  });

  await preferences.reload();
  expect(preferences.error.value).toBeDefined();
  expect(preferences.read('hidden-repositories')).toEqual(['acme/web']);

  repository.refuseWrites = undefined;
  await preferences.reload();
  await settled(preferences);
  expect(saved(repository)).toEqual({ 'hidden-repositories': ['acme/web'] });
});
