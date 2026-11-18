import { resolveProfile } from '@repotted/core';
import { afterEach, expect, test } from 'vitest';

import { FakeGitRepository } from '../../../core/tests/support/fake-git.js';
import { ProfileEditor } from '../../src/app/profile-editor/profile-editor.js';
import { settingSections } from '../../src/app/profile-editor/setting-fields.js';
import { Profiles } from '../../src/app/profiles/profiles.js';
import { readFile, rm, writeFile } from '../../src/engine/files.js';

afterEach(() => rm('/', { recursive: true }));

async function setup(): Promise<Profiles> {
  const kept = new Profiles(
    new FakeGitRepository(),
    { read: () => undefined, write: () => undefined },
    () => undefined,
  );
  await kept.refresh();
  await kept.create({
    name: 'production',
    definitionKind: 'environment',
    targetName: 'production',
    folder: 'definitions',
    start: { kind: 'empty' },
    ownerType: undefined,
  });
  return kept;
}

test('libraries separate definitions from the profile tree while new profiles persist relative references', async () => {
  const kept = await setup();
  expect(kept.definitions.value).toHaveLength(1);
  expect(kept.tree.value.count).toBe(0);
  expect(
    await kept.create({
      name: 'API',
      folder: 'teams',
      start: { kind: 'empty' },
      ownerType: undefined,
      references: { environments: ['definitions/production.yaml'] },
    }),
  ).toBeUndefined();
  const api = kept.selected.value!;
  expect(await readFile(api.file, 'utf8')).toContain('../definitions/production.yaml');
  expect((await resolveProfile(api.file)).profile.environments).toEqual([{ name: 'production' }]);
  expect(kept.tree.value.count).toBe(1);
  expect(await kept.move([api], 'apps/backend')).toBeUndefined();
  const moved = kept.listings.value.find((item) => item.name === 'API')!;
  expect(await readFile(moved.file, 'utf8')).toContain('../../definitions/production.yaml');
  expect((await resolveProfile(moved.file)).profile.environments).toEqual([{ name: 'production' }]);
});

test('a shared edit refreshes consumers without losing unrelated unsaved profile settings', async () => {
  const kept = await setup();
  const definition = kept.selected.value!;
  for (const name of ['API', 'Website']) {
    await kept.create({
      name,
      folder: '',
      start: { kind: 'empty' },
      ownerType: undefined,
      references: { environments: ['definitions/production.yaml'] },
    });
  }
  const api = kept.listings.value.find((item) => item.name === 'API')!;
  await kept.select(api);
  const apiEditor = kept.editor.value!;
  const wiki = settingSections
    .flatMap((section) => section.groups.flatMap((group) => group.fields))
    .find((field) => field.path.join('.') === 'repository.has_wiki')!;
  await apiEditor.set(wiki, false);
  await kept.select(definition);
  const row = kept.editor.value!.entries.value.environments[0]!;
  await kept.editor.value!.changeEntry(row, { ...row.entry, wait_timer: 7 });
  await kept.save();
  expect(apiEditor.dirty.value).toBe(true);
  expect(apiEditor.entries.value.environments[0]?.entry).toEqual({ name: 'production', wait_timer: 7 });
  for (const profile of kept.dependents(definition)) {
    expect((await resolveProfile(profile.file)).profile.environments).toEqual([{ name: 'production', wait_timer: 7 }]);
  }
  await kept.select(api);
  await kept.save();
  expect((await resolveProfile(api.file)).profile.repository).toEqual({ has_wiki: false });
  expect(await readFile(api.file, 'utf8')).not.toContain('wait_timer');
});

test('unsaved reference edits protect a definition from deletion and detach without copying it', async () => {
  const kept = await setup();
  const definition = kept.selected.value!;
  await kept.create({ name: 'API', folder: '', start: { kind: 'empty' }, ownerType: undefined });
  const api = kept.selected.value!;
  const editor = kept.editor.value!;
  await editor.setReferences({ environments: ['definitions/production.yaml'] });
  expect(editor.canSave.value).toBe(true);
  expect(editor.canSaveAsDraft.value).toBe(false);
  expect(await kept.remove(definition)).toMatch(/references/u);
  await kept.save();
  expect(editor.dirty.value).toBe(false);
  expect((await resolveProfile(api.file)).profile.environments).toEqual([{ name: 'production' }]);
  await editor.setReferences({});
  await kept.save();
  expect((await resolveProfile(api.file)).profile.environments).toBeUndefined();
  expect(await kept.remove(definition)).toBeUndefined();
});

test('a queued reference save refuses concurrent profile edits', async () => {
  const kept = await setup();
  await kept.create({ name: 'API', folder: '', start: { kind: 'empty' }, ownerType: undefined });
  const file = kept.selected.value!.file;
  const editor = new ProfileEditor(file);
  await editor.load();
  await editor.setReferences({ environments: ['definitions/production.yaml'] });
  const started = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const saving = editor.save(async (work) => {
    started.resolve(undefined);
    await release.promise;
    await work();
  });
  await started.promise;
  await writeFile(file, 'repository: { has_wiki: true }\n');
  release.resolve(undefined);
  await saving;
  expect(editor.saveError.value).toMatch(/changed elsewhere/u);
  expect(editor.dirty.value).toBe(true);
  expect(await readFile(file, 'utf8')).toBe('repository: { has_wiki: true }\n');
});

test('closing a queued creation preserves the currently open profile', async () => {
  const kept = await setup();
  await kept.create({ name: 'API', folder: '', start: { kind: 'empty' }, ownerType: undefined });
  const api = kept.selected.value!;
  const started = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const preceding = kept.write(async () => {
    started.resolve(undefined);
    await release.promise;
  });
  await started.promise;
  const closed = new AbortController();
  const creating = kept.create(
    {
      name: 'Main',
      definitionKind: 'ruleset',
      targetName: 'Main',
      folder: '',
      start: { kind: 'empty' },
      ownerType: undefined,
    },
    closed.signal,
  );
  closed.abort();
  release.resolve(undefined);
  await preceding;
  await creating;
  expect(kept.definitions.value).toHaveLength(2);
  expect(kept.selected.value?.file).toBe(api.file);
});

test('malformed imports with picked references return an error without leaving a file', async () => {
  const kept = await setup();
  expect(
    await kept.create({
      name: 'Bad',
      folder: '',
      start: { kind: 'import', text: 'repository: [\n' },
      ownerType: undefined,
      references: { environments: ['definitions/production.yaml'] },
    }),
  ).toBeTypeOf('string');
  expect(kept.listings.value.some((item) => item.name === 'Bad')).toBe(false);
});

test('deleting a stale definition cannot delete a profile that replaced it', async () => {
  const kept = await setup();
  const definition = kept.selected.value!;
  await writeFile(definition.file, 'repository: { has_wiki: false }\n');
  expect(await kept.remove(definition)).toMatch(/changed/u);
  expect(await readFile(definition.file, 'utf8')).toBe('repository: { has_wiki: false }\n');
});

test.each(['duplicate', 'import'] as const)(
  '%s adds picked references without dropping existing ones',
  async (kind) => {
    const kept = await setup();
    await kept.create({
      name: 'approved',
      definitionKind: 'actions-policy',
      folder: 'definitions',
      start: { kind: 'empty' },
      ownerType: undefined,
    });
    await kept.create({
      name: 'staging',
      definitionKind: 'environment',
      targetName: 'staging',
      folder: 'definitions',
      start: { kind: 'empty' },
      ownerType: undefined,
    });
    await kept.create({
      name: 'Source',
      folder: 'sources',
      start: { kind: 'empty' },
      ownerType: undefined,
      references: { actions: 'definitions/approved.yaml', environments: ['definitions/production.yaml'] },
    });
    const source = kept.selected.value!;
    const text = await readFile(source.file, 'utf8');
    expect(
      await kept.create({
        name: 'Copy',
        folder: 'copies',
        start: kind === 'duplicate' ? { kind, source } : { kind, text },
        ownerType: undefined,
        references: { environments: ['definitions/staging.yaml', 'definitions/../definitions/staging.yaml'] },
      }),
    ).toBeUndefined();
    expect((await resolveProfile(kept.selected.value!.file)).references).toEqual({
      actions: '../definitions/approved.yaml',
      environments: ['../definitions/production.yaml', '../definitions/staging.yaml'],
    });
  },
);

test('repairing a setting retains references when another shared definition is added', async () => {
  const kept = await setup();
  await kept.create({
    name: 'approved',
    definitionKind: 'actions-policy',
    folder: 'definitions',
    start: { kind: 'empty' },
    ownerType: undefined,
  });
  const file = `${kept.folder.value}/repair.yaml`;
  await writeFile(file, 'references: { actions: definitions/approved.yaml }\nrepository: { has_wiki: wrong }\n');
  const editor = new ProfileEditor(file);
  await editor.load();
  expect(editor.references.value).toEqual({ actions: 'definitions/approved.yaml' });
  await editor.setReferences({ ...editor.references.value, environments: ['definitions/production.yaml'] });
  const wiki = settingSections
    .flatMap((section) => section.groups.flatMap((group) => group.fields))
    .find((field) => field.path.join('.') === 'repository.has_wiki')!;
  await editor.set(wiki, false);
  await editor.save(async (work) => work());
  expect(editor.saveError.value).toBeUndefined();
  expect((await resolveProfile(file)).references).toEqual({
    actions: 'definitions/approved.yaml',
    environments: ['definitions/production.yaml'],
  });
});

test('pending reference changes preview resolved entries and retain existing local edits', async () => {
  const kept = await setup();
  await kept.create({ name: 'API', folder: '', start: { kind: 'empty' }, ownerType: undefined });
  const editor = kept.editor.value!;
  await editor.addEntry('environments', { name: 'local', wait_timer: 3 });
  await editor.setReferences({ environments: ['definitions/production.yaml'] });
  expect(editor.entries.value.environments.map((row) => row.entry)).toEqual([
    { name: 'production' },
    { name: 'local', wait_timer: 3 },
  ]);
  await kept.save();
  await editor.setReferences({});
  expect(editor.entries.value.environments.map((row) => row.entry)).toEqual([{ name: 'local', wait_timer: 3 }]);
  await kept.save();
  expect((await resolveProfile(kept.selected.value!.file)).profile.environments).toEqual([
    { name: 'local', wait_timer: 3 },
  ]);
});

test('unfinished entries remain available to fix when references change', async () => {
  const kept = await setup();
  await kept.create({ name: 'API', folder: '', start: { kind: 'empty' }, ownerType: undefined });
  const editor = kept.editor.value!;
  await editor.addEntry('environments', { name: '' });
  await editor.setReferences({ environments: ['definitions/production.yaml'] });
  const unfinished = editor.entries.value.environments.find((row) => row.entry?.['name'] === '');
  expect(unfinished).toBeDefined();
  await editor.changeEntry(unfinished!, { name: 'local' });
  await kept.save();
  expect((await resolveProfile(kept.selected.value!.file)).profile.environments).toEqual([
    { name: 'production' },
    { name: 'local' },
  ]);
});
