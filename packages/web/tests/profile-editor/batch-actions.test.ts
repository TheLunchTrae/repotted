import { editProfile, previewProfile, resolveProfile } from '@repotted/core';
import { afterEach, expect, test } from 'vitest';

import type { EntryList, EntryRow } from '../../src/app/profile-editor/entry-edits.js';
import { ProfileEditor, type SettingRow } from '../../src/app/profile-editor/profile-editor.js';
import { type SettingField, type SettingGroup, settingSections } from '../../src/app/profile-editor/setting-fields.js';
import { mkdir, readFile, rm, writeFile } from '../../src/engine/files.js';

afterEach(async () => {
  await rm('/', { recursive: true });
});

async function opened(files: Record<string, string>, name = 'web.yaml'): Promise<ProfileEditor> {
  await mkdir('/profiles', { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    await writeFile(`/profiles/${file}`, text);
  }
  const editor = new ProfileEditor(`/profiles/${name}`);
  await editor.load();
  return editor;
}

const allFields = settingSections.flatMap((section) => section.groups.flatMap((group) => group.fields));

function field(path: string): SettingField {
  const found = allFields.find((item) => item.path.join('.') === path);
  if (found === undefined) {
    throw new Error(`The editor has no setting ${path}.`);
  }
  return found;
}

function group(title: string): SettingGroup {
  const found = settingSections.flatMap((section) => section.groups).find((item) => item.title === title);
  if (found === undefined) {
    throw new Error(`The editor has no group ${title}.`);
  }
  return found;
}

function batchOf(editor: ProfileEditor, title: string) {
  return editor.sections.value.flatMap((section) => section.groups).find((item) => item.group.title === title)?.batch;
}

function row(editor: ProfileEditor, path: string): SettingRow | undefined {
  return editor.sections.value
    .flatMap((section) => section.groups.flatMap((item) => item.rows))
    .find((item) => item.field.path.join('.') === path);
}

function entry(editor: ProfileEditor, list: EntryList, name: string): EntryRow {
  const found = editor.entries.value[list].find((item) => item.entry?.['name'] === name || item.savedName === name);
  if (found === undefined) {
    throw new Error(`The editor has no ${list} entry ${name}.`);
  }
  return found;
}

const write = (work: () => Promise<void>): Promise<void> => work();

const base = 'security:\n  code_scanning_default_setup:\n    threat_model: remote\n';

const codeScanning = `extends: base.yaml
security:
  vulnerability_alerts: true
  code_scanning_default_setup:
    state: configured
    query_suite: extended
    runner_type: standard
`;

test('Remove all stops naming what the group sets here, hidden settings included, and leaves base values', async () => {
  const editor = await opened({ 'base.yaml': base, 'web.yaml': codeScanning });
  await editor.set(field('security.code_scanning_default_setup.state'), 'not-configured');
  expect(row(editor, 'security.code_scanning_default_setup.query_suite')).toBeUndefined();
  expect(batchOf(editor, 'Code scanning')).toEqual({ namedHere: 3, namedHereThatGitHubHides: 2, unsaved: 1 });

  await editor.removeAllIn(group('Code scanning'));

  expect(batchOf(editor, 'Code scanning')).toEqual({ namedHere: 0, namedHereThatGitHubHides: 0, unsaved: 3 });
  expect(editor.batchDone.value).toEqual({
    scope: group('Code scanning'),
    action: 'removed',
    count: 3,
    hiddenByGitHub: 2,
  });
  expect(row(editor, 'security.code_scanning_default_setup.threat_model')).toMatchObject({
    value: 'remote',
    source: 'base.yaml',
  });
  expect(await readFile('/profiles/web.yaml', 'utf8')).toBe(codeScanning);

  await editor.save(write);
  const text = await readFile('/profiles/web.yaml', 'utf8');
  expect(text).not.toContain('code_scanning_default_setup');
  expect(text).toContain('vulnerability_alerts: true');
  expect(editor.batchDone.value).toBeUndefined();
});

test('Reset all puts back only its own group, typed text included', async () => {
  const editor = await opened({ 'web.yaml': 'repository:\n  has_wiki: false\n  default_branch: main\n' });
  await editor.set(field('repository.has_wiki'), true);
  await editor.type(field('repository.default_branch'), '  ');
  await editor.set(field('merge.allow_squash_merge'), false);
  const general = field('repository.default_branch');
  const generalGroup = settingSections
    .flatMap((section) => section.groups)
    .find((item) => item.fields.includes(general));
  if (generalGroup === undefined) {
    throw new Error('The default branch has no group.');
  }
  expect(batchOf(editor, generalGroup.title)?.unsaved).toBe(1);

  await editor.resetAllIn(generalGroup);

  expect(row(editor, 'repository.default_branch')).toMatchObject({ textBeingTyped: undefined, value: 'main' });
  expect(row(editor, 'repository.has_wiki')?.unsaved).toBe(true);
  expect(row(editor, 'merge.allow_squash_merge')?.unsaved).toBe(true);
  expect(editor.batchDone.value).toMatchObject({ action: 'reset', count: 1 });
});

test('Undo brings back every change as it was before, and goes with the next change', async () => {
  const editor = await opened({ 'base.yaml': base, 'web.yaml': codeScanning });
  await editor.set(field('security.code_scanning_default_setup.query_suite'), 'default');
  await editor.type(field('security.code_scanning_default_setup.runner_label'), '  ');

  await editor.removeAllIn(group('Code scanning'));
  expect(row(editor, 'security.code_scanning_default_setup.runner_label')?.textBeingTyped).toBeUndefined();
  await editor.undoBatch();

  expect(editor.batchDone.value).toBeUndefined();
  expect(row(editor, 'security.code_scanning_default_setup.query_suite')).toMatchObject({
    value: 'default',
    unsaved: true,
  });
  expect(row(editor, 'security.code_scanning_default_setup.state')).toMatchObject({
    value: 'configured',
    unsaved: false,
  });
  expect(row(editor, 'security.code_scanning_default_setup.runner_label')?.textBeingTyped).toBe('  ');

  await editor.resetAllIn(group('Code scanning'));
  expect(editor.batchDone.value).toBeDefined();
  await editor.set(field('security.vulnerability_alerts'), false);
  expect(editor.batchDone.value).toBeUndefined();
});

test('a change made while the batch change previews takes away its undo', async () => {
  const editor = await opened({ 'base.yaml': base, 'web.yaml': codeScanning });

  const removing = editor.removeAllIn(group('Code scanning'));
  const changing = editor.set(field('security.vulnerability_alerts'), false);
  await Promise.all([removing, changing]);

  expect(editor.batchDone.value).toBeUndefined();
});

const lists = `extends: base.yaml
rulesets:
  - name: Main
    target: branch
    enforcement: active
labels:
  - name: bug
    color: d73a4a
`;

test("a list's Reset all and Take out all leave a base's entries and other lists alone, and Undo takes them back", async () => {
  const editor = await opened({
    'base.yaml': 'rulesets:\n  - name: Signed\n    target: branch\n    enforcement: active\n',
    'web.yaml': lists,
  });
  await editor.changeEntry(entry(editor, 'rulesets', 'Main'), {
    ...entry(editor, 'rulesets', 'Main').entry,
    enforcement: 'disabled',
  });
  await editor.addEntry('rulesets', { name: 'Tags', target: 'tag', enforcement: 'active' });
  await editor.changeEntry(entry(editor, 'labels', 'bug'), { name: 'bug', color: '000000' });
  expect(editor.entryListBatches.value.rulesets).toEqual({
    selected: 0,
    unsaved: 2,
    canBeTakenOut: 2,
    canBePutBack: 0,
  });

  await editor.takeOutAllIn('rulesets');

  expect(entry(editor, 'rulesets', 'Main').entry).toBeUndefined();
  expect(editor.entries.value.rulesets.some((item) => item.entry?.['name'] === 'Tags')).toBe(false);
  expect(entry(editor, 'rulesets', 'Signed').entry).toBeDefined();
  expect(editor.batchDone.value).toMatchObject({ scope: 'rulesets', action: 'taken-out', count: 2 });

  await editor.undoBatch();
  expect(entry(editor, 'rulesets', 'Main').entry?.['enforcement']).toBe('disabled');
  expect(entry(editor, 'rulesets', 'Tags').unsaved).toBe(true);

  await editor.resetAllEntriesIn('rulesets');
  expect(editor.entryListBatches.value.rulesets.unsaved).toBe(0);
  expect(entry(editor, 'labels', 'bug').unsaved).toBe(true);
  expect(editor.batchDone.value).toMatchObject({ scope: 'rulesets', action: 'reset', count: 2 });
});

test('a fresh read takes away the undo, so it cannot bring back changes made before a sync', async () => {
  const editor = await opened({ 'base.yaml': base, 'web.yaml': codeScanning });
  await editor.removeAllIn(group('Code scanning'));
  expect(editor.batchDone.value).toBeDefined();

  await editor.load();

  expect(editor.batchDone.value).toBeUndefined();
});

test('every other kind of change takes away the undo', async () => {
  const editor = await opened({
    'base.yaml': base,
    'web.yaml': `${codeScanning}${lists.replace('extends: base.yaml\n', '')}`,
  });
  const changes: readonly (readonly [string, () => Promise<void>])[] = [
    ['a reset', () => editor.reset(field('security.vulnerability_alerts'))],
    ['the profile-wide reset', () => editor.resetAll()],
    ['typing', () => editor.type(field('security.code_scanning_default_setup.runner_label'), 'big')],
    ['an entry change', () => editor.changeEntry(entry(editor, 'labels', 'bug'), { name: 'bug', color: '000000' })],
    ['putting an entry back', () => editor.putBack(entry(editor, 'labels', 'bug'))],
    ['a new entry', () => editor.addEntry('labels', { name: 'docs', color: '0075ca' }).then(() => undefined)],
  ];
  for (const [name, change] of changes) {
    await editor.resetAll();
    await editor.set(field('security.vulnerability_alerts'), false);
    await editor.removeAllIn(group('Code scanning'));
    expect(editor.batchDone.value, name).toBeDefined();
    await change();
    expect(editor.batchDone.value, name).toBeUndefined();
  }
});

test('a change made while a list batch previews takes away its undo', async () => {
  const editor = await opened({ 'web.yaml': lists.replace('extends: base.yaml\n', '') });

  const takingOut = editor.takeOutAllIn('rulesets');
  const changing = editor.changeEntry(entry(editor, 'labels', 'bug'), { name: 'bug', color: '000000' });
  await Promise.all([takingOut, changing]);

  expect(editor.batchDone.value).toBeUndefined();
});

test('batch actions and Undo do nothing while a save is writing', async () => {
  const editor = await opened({ 'base.yaml': base, 'web.yaml': codeScanning });
  await editor.set(field('security.vulnerability_alerts'), false);
  let finishWriting = (): void => undefined;
  const writing = new Promise<void>((resolve) => {
    finishWriting = resolve;
  });
  const saving = editor.save(async (work) => {
    await writing;
    await work();
  });
  expect(editor.saving.value).toBe(true);

  await editor.removeAllIn(group('Code scanning'));
  await editor.resetAllIn(group('Code scanning'));
  await editor.takeOutAllIn('rulesets');

  expect(editor.batchDone.value).toBeUndefined();
  finishWriting();
  await saving;
  expect(await readFile('/profiles/web.yaml', 'utf8')).toContain('query_suite: extended');
});

test('settings owners of the profile type lack are neither counted nor removed', async () => {
  const forking = field('repository.allow_forking');
  const forkingGroup = settingSections
    .flatMap((section) => section.groups)
    .find((item) => item.fields.includes(forking));
  if (forkingGroup === undefined) {
    throw new Error('Forking has no group.');
  }
  const editor = await opened({ 'web.yaml': 'owner_type: user\n' });
  expect(editor.loadError.value).toBeUndefined();
  expect(row(editor, 'repository.allow_forking')).toBeUndefined();
  await editor.set(forking, false);
  expect(batchOf(editor, forkingGroup.title)).toMatchObject({ namedHere: 0, unsaved: 0 });

  await editor.removeAllIn(forkingGroup);
  expect(editor.batchDone.value).toBeUndefined();
});

test("a base's entry changed here counts for Reset all but can't be taken out", async () => {
  const editor = await opened({
    'base.yaml': 'rulesets:\n  - name: Signed\n    target: branch\n    enforcement: active\n',
    'web.yaml': 'extends: base.yaml\n',
  });
  await editor.changeEntry(entry(editor, 'rulesets', 'Signed'), {
    ...entry(editor, 'rulesets', 'Signed').entry,
    enforcement: 'disabled',
  });

  expect(editor.entryListBatches.value.rulesets).toEqual({
    selected: 0,
    unsaved: 1,
    canBeTakenOut: 0,
    canBePutBack: 0,
  });
});

test('Take out all drops a change to an entry a sync took away, so the save can go on', async () => {
  const editor = await opened({ 'web.yaml': lists.replace('extends: base.yaml\n', '') });
  await editor.changeEntry(entry(editor, 'labels', 'bug'), { name: 'bug', color: '000000' });
  await writeFile('/profiles/web.yaml', 'rulesets:\n  - name: Main\n    target: branch\n    enforcement: active\n');
  await editor.load();
  expect(entry(editor, 'labels', 'bug').outOfDate).toBe(true);

  await editor.takeOutAllIn('labels');

  expect(editor.entries.value.labels).toEqual([]);
  expect(editor.dirty.value).toBe(false);
});

test('a batch made while a fresh read waits loses its undo when the read finishes', async () => {
  await mkdir('/profiles', { recursive: true });
  await writeFile('/profiles/web.yaml', 'repository:\n  has_wiki: false\n');
  let holdRead = false;
  let finishRead = (): void => undefined;
  const reading = new Promise<void>((resolve) => {
    finishRead = resolve;
  });
  const editor = new ProfileEditor('/profiles/web.yaml', undefined, {
    canHoldDrafts: true,
    resolve: async (file) => {
      if (holdRead) {
        await reading;
      }
      return resolveProfile(file);
    },
    preview: previewProfile,
    edit: editProfile,
  });
  await editor.load();
  await editor.set(field('repository.has_wiki'), true);
  holdRead = true;
  const loading = editor.load();
  const features = settingSections
    .flatMap((section) => section.groups)
    .find((item) => item.fields.includes(field('repository.has_wiki')));
  if (features === undefined) {
    throw new Error('The wiki setting has no group.');
  }
  await editor.removeAllIn(features);
  expect(editor.batchDone.value).toBeDefined();

  finishRead();
  await loading;

  expect(editor.batchDone.value).toBeUndefined();
});

test('resetting every save problem clears a batch undo snapshot', async () => {
  const editor = await opened({ 'web.yaml': 'repository:\n  has_wiki: false\n' });
  await editor.type(field('repository.default_branch'), 'main dev');
  const features = settingSections
    .flatMap((section) => section.groups)
    .find((item) => item.fields.includes(field('repository.has_wiki')));
  if (features === undefined) {
    throw new Error('The wiki setting has no group.');
  }
  await editor.removeAllIn(features);
  expect(editor.batchDone.value).toBeDefined();

  await editor.resetEverythingBlockingSave();

  expect(editor.problemsBlockingSave.value).toEqual([]);
  expect(editor.batchDone.value).toBeUndefined();
});

function foundKeys(editor: ProfileEditor): string[] {
  return editor.found.value.flatMap((item) => item.rows.map((found) => found.field.path.join('.')));
}

test("Find a setting's Remove all and Reset all change only the settings found, and Undo takes them back", async () => {
  const editor = await opened({ 'base.yaml': base, 'web.yaml': codeScanning });
  await editor.set(field('security.code_scanning_default_setup.runner_type'), 'labeled');
  editor.search('query suite');
  expect(foundKeys(editor)).toContain('security.code_scanning_default_setup.query_suite');
  expect(editor.foundBatch.value).toEqual({ namedHere: 1, unsaved: 0 });

  await editor.removeAllFound();

  expect(row(editor, 'security.code_scanning_default_setup.query_suite')?.unsaved).toBe(true);
  expect(row(editor, 'security.code_scanning_default_setup.state')?.unsaved).toBe(false);
  expect(row(editor, 'security.code_scanning_default_setup.runner_type')?.value).toBe('labeled');
  expect(editor.batchDone.value).toMatchObject({ scope: 'found', action: 'removed', count: 1 });
  expect(editor.foundBatch.value).toEqual({ namedHere: 0, unsaved: 1 });

  await editor.undoBatch();
  expect(row(editor, 'security.code_scanning_default_setup.query_suite')?.unsaved).toBe(false);

  await editor.set(field('security.code_scanning_default_setup.query_suite'), 'default');
  await editor.resetAllFound();
  expect(row(editor, 'security.code_scanning_default_setup.query_suite')).toMatchObject({
    value: 'extended',
    unsaved: false,
  });
  expect(row(editor, 'security.code_scanning_default_setup.runner_type')?.unsaved).toBe(true);
  expect(editor.batchDone.value).toMatchObject({ scope: 'found', action: 'reset', count: 1 });
});

test('a setting shown only for an option found under it is not removed with the settings found', async () => {
  const editor = await opened({ 'web.yaml': 'repository:\n  has_pull_requests: true\n' });
  editor.search('who can create');
  expect(foundKeys(editor)).toContain('repository.has_pull_requests');
  expect(editor.foundBatch.value).toEqual({ namedHere: 0, unsaved: 0 });

  await editor.removeAllFound();

  expect(row(editor, 'repository.has_pull_requests')).toMatchObject({ value: true, unsaved: false });
  expect(editor.batchDone.value).toBeUndefined();
});

test("a list's batch actions change only the selected entries while any are, and selecting keeps the undo", async () => {
  const editor = await opened({
    'web.yaml': `${lists.replace('extends: base.yaml\n', '')}  - name: Docs\n    color: 0075ca\n`,
  });
  const bug = entry(editor, 'labels', 'bug');
  editor.selectEntry(bug, true);
  expect(editor.entryListBatches.value.labels).toEqual({
    selected: 1,
    unsaved: 0,
    canBeTakenOut: 1,
    canBePutBack: 0,
  });

  await editor.takeOutAllIn('labels');

  expect(entry(editor, 'labels', 'bug').entry).toBeUndefined();
  expect(entry(editor, 'labels', 'Docs').entry).toBeDefined();
  expect(editor.batchDone.value).toMatchObject({ scope: 'labels', action: 'taken-out', count: 1 });
  editor.selectEntry(entry(editor, 'labels', 'Docs'), true);
  editor.deselectAllEntriesIn('rulesets');
  expect(editor.batchDone.value).toBeDefined();
  expect(editor.entryListBatches.value.labels).toMatchObject({ selected: 2, canBeTakenOut: 1, canBePutBack: 1 });

  await editor.putAllBackIn('labels');
  expect(entry(editor, 'labels', 'bug')).toMatchObject({ unsaved: false, entry: { name: 'bug' } });
  expect(editor.batchDone.value).toMatchObject({ scope: 'labels', action: 'put-back', count: 1 });

  editor.deselectAllEntriesIn('labels');
  expect(editor.entryListBatches.value.labels).toMatchObject({ selected: 0, canBeTakenOut: 2 });
  editor.selectAllEntriesIn('labels');
  expect(editor.entryListBatches.value.labels.selected).toBe(2);
  expect(editor.entryListBatches.value.rulesets.selected).toBe(0);
});

test('Put all back brings back each entry taken out, and a new one that went is no longer selected', async () => {
  const editor = await opened({ 'web.yaml': lists.replace('extends: base.yaml\n', '') });
  const key = await editor.addEntry('labels', { name: 'docs', color: '0075ca' });
  const added = editor.entries.value.labels.find((item) => item.key === key);
  if (added === undefined) {
    throw new Error('The new label is not listed.');
  }
  editor.selectEntry(added, true);
  await editor.resetEntry(added);
  expect(editor.selectedEntryKeys.value.size).toBe(0);

  await editor.takeOutAllIn('rulesets');
  await editor.takeOutAllIn('labels');
  await editor.putAllBackIn('rulesets');

  expect(entry(editor, 'rulesets', 'Main')).toMatchObject({ unsaved: false, entry: { name: 'Main' } });
  expect(entry(editor, 'labels', 'bug').entry).toBeUndefined();
  expect(editor.batchDone.value).toMatchObject({ scope: 'rulesets', action: 'put-back', count: 1 });
});

test("the save bar's Reset offers Undo, which brings back every change; other resets don't", async () => {
  const editor = await opened({ 'web.yaml': lists.replace('extends: base.yaml\n', '') });
  await editor.set(field('repository.has_wiki'), false);
  await editor.type(field('repository.default_branch'), 'main dev');
  await editor.changeEntry(entry(editor, 'labels', 'bug'), { name: 'bug', color: '000000' });

  await editor.resetAll({ offerUndo: true });

  expect(editor.dirty.value).toBe(false);
  expect(editor.batchDone.value).toEqual({ scope: 'profile', action: 'reset', count: 3, hiddenByGitHub: 0 });

  await editor.undoBatch();
  expect(row(editor, 'repository.has_wiki')).toMatchObject({ value: false, unsaved: true });
  expect(row(editor, 'repository.default_branch')?.textBeingTyped).toBe('main dev');
  expect(entry(editor, 'labels', 'bug').entry?.['color']).toBe('000000');

  await editor.resetAll();
  expect(editor.batchDone.value).toBeUndefined();
  await editor.resetAll({ offerUndo: true });
  expect(editor.batchDone.value).toBeUndefined();
});

test('the save bar Reset holds no undo while saving, and a change while a found batch previews takes its undo', async () => {
  const editor = await opened({ 'base.yaml': base, 'web.yaml': codeScanning });
  await editor.set(field('security.vulnerability_alerts'), false);
  let finishWriting = (): void => undefined;
  const writing = new Promise<void>((resolve) => {
    finishWriting = resolve;
  });
  const saving = editor.save(async (work) => {
    await writing;
    await work();
  });
  await editor.resetAll({ offerUndo: true });
  expect(editor.batchDone.value).toBeUndefined();
  finishWriting();
  await saving;

  editor.search('query suite');
  const removing = editor.removeAllFound();
  const changing = editor.set(field('security.vulnerability_alerts'), true);
  await Promise.all([removing, changing]);
  expect(editor.batchDone.value).toBeUndefined();
});

test('a fresh read clears the selection, so a key given to another entry is not selected', async () => {
  const editor = await opened({ 'web.yaml': lists.replace('extends: base.yaml\n', '') });
  editor.selectEntry(entry(editor, 'rulesets', 'Main'), true);
  await writeFile('/profiles/web.yaml', 'labels:\n  - name: bug\n    color: d73a4a\n');
  await editor.load();
  await writeFile('/profiles/web.yaml', lists.replace('extends: base.yaml\n', ''));
  await editor.load();

  expect(editor.entryListBatches.value.rulesets.selected).toBe(0);
});

test('a save clears the selection', async () => {
  const editor = await opened({ 'web.yaml': lists.replace('extends: base.yaml\n', '') });
  editor.selectEntry(entry(editor, 'labels', 'bug'), true);
  await editor.set(field('repository.has_wiki'), false);

  await editor.save(write);

  expect(editor.entryListBatches.value.labels.selected).toBe(0);
});
