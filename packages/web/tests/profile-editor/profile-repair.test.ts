import { resolveProfile } from '@repotted/core';
import { afterEach, expect, test } from 'vitest';

import { ProfileEditor } from '../../src/app/profile-editor/profile-editor.js';
import { mkdir, readFile, rm, writeFile } from '../../src/engine/files.js';

afterEach(async () => {
  await rm('/', { recursive: true });
});

const file = '/profiles/teams/web.yaml';
const invalid = 'repository: [\n';
const corrected = '# Keep this comment.\r\nextends: ../base.yaml\r\nrepository:\r\n  has_wiki: true\r\n';
const write = (work: () => Promise<void>): Promise<void> => work();

async function opened(text = invalid): Promise<ProfileEditor> {
  await mkdir('/profiles/teams', { recursive: true });
  await writeFile('/profiles/base.yaml', 'repository:\n  has_issues: false\n');
  await writeFile(file, text);
  const editor = new ProfileEditor(file);
  await editor.load();
  return editor;
}

function repairOf(editor: ProfileEditor) {
  const repair = editor.repair.value;
  if (repair === undefined) {
    throw new Error('An invalid profile should offer its YAML for repair.');
  }
  return repair;
}

test('previews replacement text at its file path without writing the invalid file', async () => {
  await opened();
  const result = await resolveProfile(file, corrected);
  expect(result.chain).toEqual([file, '/profiles/base.yaml']);
  expect(result.profile.repository).toEqual({ has_wiki: true, has_issues: false });
  expect(await readFile(file, 'utf8')).toBe(invalid);
  await expect(resolveProfile(file, 'extends: web.yaml\n')).rejects.toThrow('extends itself');
  await writeFile('/profiles/base.yaml', 'extends: teams/web.yaml\n');
  await expect(resolveProfile(file, corrected)).rejects.toThrow('extends itself');
});

test.each([invalid, 'repository: [\n'])('an invalid profile offers a validated whole-file repair: %s', async (text) => {
  const editor = await opened(text);
  const repair = repairOf(editor);
  expect(repair.text.value).toBe(text);
  expect(repair.problem.value).toBeDefined();
  expect(editor.canSave.value).toBe(false);

  await repair.type('merge: [\n');
  expect(editor.dirty.value).toBe(true);
  expect(repair.problem.value).toBeDefined();
  await editor.save(write);
  expect(await readFile(file, 'utf8')).toBe(text);

  await repair.type(corrected);
  expect(editor.canSave.value).toBe(true);
  await editor.save(write);
  expect(await readFile(file, 'utf8')).toBe(corrected);
  expect(editor.loaded.value).toBe(true);
  expect(editor.repair.value).toBeUndefined();
  expect(editor.dirty.value).toBe(false);
});

test.each([invalid, 'repository:\n  description: Changed elsewhere\n'])(
  'refresh keeps corrections and their original version when the file changes to %s',
  async (elsewhere) => {
    const editor = await opened();
    const repair = repairOf(editor);
    await repair.type(corrected);
    await writeFile(file, `# Changed elsewhere\n${elsewhere}`);
    await editor.load();
    expect(repairOf(editor)).toBe(repair);
    expect(repair.text.value).toBe(corrected);
    expect(editor.dirty.value).toBe(true);

    await editor.save(write);
    expect(repair.saveError.value).toContain('changed elsewhere');
    expect(await readFile(file, 'utf8')).toBe(`# Changed elsewhere\n${elsewhere}`);
    expect(repair.text.value).toBe(corrected);
    expect(editor.dirty.value).toBe(true);

    await editor.resetAll();
    expect(editor.dirty.value).toBe(false);
    expect(editor.repair.value?.text.value).toBe(
      elsewhere === invalid ? `# Changed elsewhere\n${elsewhere}` : undefined,
    );
  },
);

test('a whole-file save refuses a change made while it waits in the queue', async () => {
  const editor = await opened();
  const repair = repairOf(editor);
  await repair.type(corrected);
  const release = Promise.withResolvers<undefined>();
  const saving = editor.save(async (work) => {
    await release.promise;
    await work();
  });
  await writeFile(file, '# Someone else\nrepository:\n  has_wiki: false\n');
  release.resolve(undefined);
  await saving;
  expect(repair.saveError.value).toContain('changed elsewhere');
  expect(await readFile(file, 'utf8')).toContain('# Someone else');
  expect(repair.text.value).toBe(corrected);
});

test('syntax repair opens the settings even when the configuration or a base is invalid', async () => {
  const editor = await opened();
  const repair = repairOf(editor);
  await repair.type('extends: ../missing.yaml\nrepository:\n  has_wiki: broken\n');
  expect(repair.canSave.value).toBe(true);
  await editor.save(write);
  expect(editor.repair.value).toBeUndefined();
  expect(editor.loaded.value).toBe(true);
  expect(editor.problemsBlockingSave.value.length).toBeGreaterThan(0);
});

test('text typed while saving stays unsaved, including a return to the original text', async () => {
  const editor = await opened();
  const repair = repairOf(editor);
  await repair.type(corrected);
  const release = Promise.withResolvers<undefined>();
  const saving = editor.save(async (work) => {
    await release.promise;
    await work();
  });
  await repair.type(invalid);
  await editor.load();
  release.resolve(undefined);
  await saving;
  expect(await readFile(file, 'utf8')).toBe(corrected);
  expect(repairOf(editor)).toBe(repair);
  expect(repair.text.value).toBe(invalid);
  expect(editor.dirty.value).toBe(true);
  expect(editor.canSave.value).toBe(false);
});

test('an older validation cannot enable saving newer invalid text', async () => {
  const editor = await opened();
  const repair = repairOf(editor);
  const older = repair.type(corrected);
  const newer = repair.type('merge: [\n');
  await Promise.all([older, newer]);
  expect(repair.problem.value).toBeDefined();
  expect(repair.checking.value).toBe(false);
  expect(editor.canSave.value).toBe(false);
});

test.each([invalid, 'repository:\n  has_wiki: false\n'])(
  'corrections typed during a reload survive its result: %s',
  async (text) => {
    const editor = await opened();
    const repair = repairOf(editor);
    await writeFile(file, text);
    const loading = editor.load();
    await repair.type(corrected);
    await loading;
    expect(repairOf(editor)).toBe(repair);
    expect(repair.text.value).toBe(corrected);
    expect(editor.dirty.value).toBe(true);
    await editor.save(write);
    if (text === invalid) {
      expect(await readFile(file, 'utf8')).toBe(corrected);
    } else {
      expect(repair.saveError.value).toContain('changed elsewhere');
      expect(await readFile(file, 'utf8')).toBe(text);
    }
  },
);
