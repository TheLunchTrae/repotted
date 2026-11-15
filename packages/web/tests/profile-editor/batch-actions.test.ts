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
  expect(editor.entryListBatches.value.rulesets).toEqual({ unsaved: 2, canBeTakenOut: 2 });

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
