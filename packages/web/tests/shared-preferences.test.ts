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
