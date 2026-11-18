import { resolveProfile } from '@repotted/core';
import { afterEach, expect, test, vi } from 'vitest';
import { parse } from 'yaml';

import { FakeGitRepository } from '../../../core/tests/support/fake-git.js';
import { settingSections } from '../../src/app/profile-editor/setting-fields.js';
import { Profiles } from '../../src/app/profiles/profiles.js';
import * as files from '../../src/engine/files.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await files.rm('/', { recursive: true });
});

async function setup(): Promise<Profiles> {
  const profiles = new Profiles(
    new FakeGitRepository(),
    { read: () => undefined, write: () => undefined },
    () => undefined,
  );
  await profiles.refresh();
  await profiles.create({ name: 'API', folder: 'apps', start: { kind: 'empty' }, ownerType: undefined });
  return profiles;
}

test.each([
  {
    section: 'actions_policies' as const,
    kind: 'actions-policy',
    entry: {
      name: 'Release',
      enforcement: 'active',
      rules: [{ type: 'restrict_action_events', parameters: { allowed_events: ['release'] } }],
    },
  },
  { section: 'environments' as const, kind: 'environment', entry: { name: 'production', wait_timer: 15 } },
  {
    section: 'rulesets' as const,
    kind: 'ruleset',
    entry: { name: 'Main', target: 'branch', enforcement: 'active', rules: [{ type: 'deletion' }] },
  },
])('a new $kind is saved separately and linked without an inline copy', async ({ section, kind, entry }) => {
  const profiles = await setup();
  const listing = profiles.selected.value!;
  const editor = profiles.editor.value!;
  const key = await editor.addEntry(section, entry);
  editor.setReusable(section, key, 'Shared setup');
  expect(editor.canSaveAsDraft.value).toBe(false);
  await profiles.save();
  expect(editor.saveError.value).toBeUndefined();
  expect(editor.dirty.value).toBe(false);
  expect(parse(await files.readFile(listing.file, 'utf8'))).toEqual({
    references: { [section]: [`../definitions/${kind}/Shared setup.yaml`] },
  });
  expect((await resolveProfile(listing.file)).profile[section]).toEqual([entry]);
  const definition = profiles.definitions.value[0]!;
  expect(definition.kind).toBe(kind);
  await profiles.select(definition);
  const sharedEditor = profiles.editor.value!;
  const row = sharedEditor.entries.value[section][0]!;
  const changed =
    section === 'environments' ? { ...row.entry, wait_timer: 7 } : { ...row.entry, enforcement: 'disabled' };
  await sharedEditor.changeEntry(row, changed);
  await profiles.save();
  expect((await resolveProfile(listing.file)).profile[section]).toEqual([changed]);
});

test('saving a reusable policy preserves general Actions settings and unrelated edits', async () => {
  const profiles = await setup();
  const listing = profiles.selected.value!;
  const editor = profiles.editor.value!;
  const fields = settingSections.flatMap((section) => section.groups.flatMap((group) => group.fields));
  await editor.set(
    fields.find((field) => field.path.join('.') === 'actions.default_workflow_permissions')!,
    'read',
  );
  await editor.set(
    fields.find((field) => field.path.join('.') === 'repository.has_wiki')!,
    false,
  );
  const entry = {
    name: 'Release',
    enforcement: 'active',
    rules: [{ type: 'restrict_action_events', parameters: { allowed_events: ['release'] } }],
  };
  const key = await editor.addEntry('actions_policies', entry);
  editor.setReusable('actions_policies', key, 'Release workflows');
  await profiles.save();
  expect(editor.saveError.value).toBeUndefined();
  expect(editor.dirty.value).toBe(false);
  expect(parse(await files.readFile(listing.file, 'utf8'))).toEqual({
    repository: { has_wiki: false },
    actions: { default_workflow_permissions: 'read' },
    references: { actions_policies: ['../definitions/actions-policy/Release workflows.yaml'] },
  });
  expect((await resolveProfile(listing.file)).profile.actions_policies).toEqual([entry]);
});

test('a failed profile write rolls back the definitions and keeps choices for retry', async () => {
  const profiles = await setup();
  const listing = profiles.selected.value!;
  const before = await files.readFile(listing.file, 'utf8');
  const editor = profiles.editor.value!;
  const key = await editor.addEntry('environments', { name: 'production', wait_timer: 15 });
  editor.setReusable('environments', key, 'Production');
  const rename = vi.spyOn(files, 'rename').mockRejectedValueOnce(new Error('disk refused the profile write'));
  await profiles.save();
  expect(editor.saveError.value).toContain('Cannot save profile');
  expect(editor.reusableName(key)).toBe('Production');
  expect(editor.canSave.value).toBe(true);
  expect(await files.readFile(listing.file, 'utf8')).toBe(before);
  await expect(files.stat('/profiles/browser/definitions/environment/Production.yaml')).rejects.toMatchObject({
    code: 'ENOENT',
  });
  rename.mockRestore();
  await profiles.save();
  expect(editor.saveError.value).toBeUndefined();
  expect((await resolveProfile(listing.file)).profile.environments).toEqual([{ name: 'production', wait_timer: 15 }]);
});

test('a duplicate library name found after a queued save preserves both files', async () => {
  const profiles = await setup();
  const listing = profiles.selected.value!;
  const editor = profiles.editor.value!;
  const key = await editor.addEntry('environments', { name: 'production' });
  editor.setReusable('environments', key, 'Production');
  const started = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const previous = profiles.write(async () => {
    started.resolve(undefined);
    await release.promise;
    await files.mkdir('/profiles/browser/definitions/environment', { recursive: true });
    await files.writeFile(
      '/profiles/browser/definitions/environment/production.yml',
      'kind: environment\nenvironments: [{ name: other }]\n',
    );
  });
  await started.promise;
  const saving = profiles.save();
  release.resolve(undefined);
  await previous;
  await saving;
  expect(editor.saveError.value).toMatch(/already in/u);
  expect(editor.reusableName(key)).toBe('Production');
  expect(await files.readFile(listing.file, 'utf8')).not.toContain('references');
  expect(
    (await resolveProfile('/profiles/browser/definitions/environment/production.yml')).profile.environments,
  ).toEqual([{ name: 'other' }]);
});

test('reset and taking out an item clear its reusable choice, and invalid names block saving', async () => {
  const profiles = await setup();
  const editor = profiles.editor.value!;
  const key = await editor.addEntry('environments', { name: 'production' });
  editor.setReusable('environments', key, '../outside');
  expect(editor.canSave.value).toBe(false);
  expect(editor.reusableProblem.value?.message).toMatch(/name cannot/u);
  await editor.takeOut(editor.entries.value.environments[0]!);
  expect(editor.reusableDefinitions.value).toEqual([]);
  expect(editor.dirty.value).toBe(false);
  await editor.resetAll();
  expect(editor.dirty.value).toBe(false);
});

test('changes made while a reusable save waits remain unsaved over the linked definition', async () => {
  const profiles = await setup();
  const listing = profiles.selected.value!;
  const editor = profiles.editor.value!;
  const key = await editor.addEntry('environments', { name: 'staging', wait_timer: 5 });
  editor.setReusable('environments', key, 'Staging');
  const started = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const previous = profiles.write(async () => {
    started.resolve(undefined);
    await release.promise;
  });
  await started.promise;
  const saving = profiles.save();
  const row = editor.entries.value.environments[0]!;
  await editor.changeEntry(row, { name: 'staging', wait_timer: 9 });
  release.resolve(undefined);
  await previous;
  await saving;
  expect(editor.saveError.value).toBeUndefined();
  expect((await resolveProfile(listing.file)).profile.environments).toEqual([{ name: 'staging', wait_timer: 5 }]);
  expect(editor.dirty.value).toBe(true);
  expect(editor.entries.value.environments[0]?.entry).toEqual({ name: 'staging', wait_timer: 9 });
  await profiles.save();
  expect(editor.saveError.value).toBeUndefined();
  expect((await resolveProfile(listing.file)).profile.environments).toEqual([{ name: 'staging', wait_timer: 9 }]);
  expect((await resolveProfile('/profiles/browser/definitions/environment/Staging.yaml')).profile.environments).toEqual(
    [{ name: 'staging', wait_timer: 5 }],
  );
});
