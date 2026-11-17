import { resolveProfile } from '@repotted/core';
import { afterEach, expect, test } from 'vitest';

import { ProfileEditor } from '../../src/app/profile-editor/profile-editor.js';
import { mkdir, readFile, rm, writeFile } from '../../src/engine/files.js';

afterEach(async () => {
  await rm('/', { recursive: true });
});

const file = '/profiles/app.yaml';
const write = (work: () => Promise<void>): Promise<void> => work();

async function opened(text: string): Promise<ProfileEditor> {
  await mkdir('/profiles', { recursive: true });
  await writeFile(file, text);
  const editor = new ProfileEditor(file);
  await editor.load();
  expect(editor.loaded.value).toBe(true);
  expect(editor.repair.value).toBeUndefined();
  return editor;
}

function setting(editor: ProfileEditor, path: string) {
  const row = editor.sections.value
    .flatMap((section) => section.groups.flatMap((group) => group.rows))
    .find((row) => row.field.path.join('.') === path);
  if (row === undefined) {
    throw new Error(`Missing setting ${path}`);
  }
  return row;
}

test('invalid saved values open on their fields and can be corrected without editing YAML', async () => {
  const text =
    '# Keep this comment\nrepository:\n  has_wiki: broken # Keep this too\n  has_issues: false\n  default_branch: refs//bad\n';
  const editor = await opened(text);
  expect(setting(editor, 'repository.has_wiki').value).toBe('broken');
  expect(setting(editor, 'repository.has_wiki').typedTextProblem).toBeDefined();
  expect(setting(editor, 'repository.default_branch').typedTextProblem).toBeDefined();
  expect(editor.problemCountByTab.value.get('repository')).toBe(2);
  expect(editor.dirty.value).toBe(false);
  await expect(resolveProfile(file)).rejects.toThrow();

  await editor.set(setting(editor, 'repository.has_wiki').field, true);
  expect(editor.canSave.value).toBe(false);
  await editor.type(setting(editor, 'repository.default_branch').field, 'main');
  expect(editor.canSave.value).toBe(true);
  await editor.openPreview();
  expect(editor.preview.value?.changedLineCount).toBeGreaterThan(0);
  await editor.save(write);
  expect(editor.saveError.value).toBeUndefined();
  expect(editor.dirty.value).toBe(false);
  expect((await resolveProfile(file)).profile.repository).toEqual({
    has_wiki: true,
    has_issues: false,
    default_branch: 'main',
  });
  expect(await readFile(file, 'utf8')).toContain('# Keep this comment');
  expect(await readFile(file, 'utf8')).toContain('# Keep this too');
});

test('unknown keys are ignored at every closed level and removed by saving', async () => {
  const editor = await opened(
    'mystery: ignored\nrepository: { has_wikki: true, has_issues: true }\nactions: { selected_actions: { verified_allowed: true, mistake: true } }\nlabels: [{ name: bug, color: abcdef, extra: ignored }]\n',
  );
  expect(editor.problemsBlockingSave.value).toEqual([]);
  await editor.set(setting(editor, 'repository.has_issues').field, false);
  await editor.save(write);
  expect(editor.saveError.value).toBeUndefined();
  const resolved = await resolveProfile(file);
  expect(resolved.profile.repository).toEqual({ has_issues: false });
  expect(resolved.profile.actions?.selected_actions).toEqual({ verified_allowed: true });
  expect(resolved.profile.labels).toEqual([{ name: 'bug', color: 'abcdef' }]);
  expect(await readFile(file, 'utf8')).not.toContain('has_wikki');
  expect(await readFile(file, 'utf8')).not.toContain('mystery');
});

test.each([
  [
    'merge:\n  allow_merge_commit: false\n  allow_squash_merge: false\n  allow_rebase_merge: false\n',
    'merge.allow_merge_commit',
    true,
  ],
  [
    'actions: { enabled: false }\nsecurity: { code_scanning_default_setup: { state: configured } }\n',
    'actions.enabled',
    true,
  ],
  ['owner_type: user\nrepository: { allow_forking: false }\n', 'repository.allow_forking', undefined],
] as const)('configuration conflicts stay editable: %s', async (text, path, value) => {
  const editor = await opened(text);
  expect(editor.problemsBlockingSave.value.length).toBeGreaterThan(0);
  await editor.set(setting(editor, path).field, value);
  expect(editor.canSave.value).toBe(true);
  await editor.save(write);
  expect(editor.saveError.value).toBeUndefined();
  await expect(resolveProfile(file)).resolves.toBeDefined();
});

test('invalid entries display their errors and save corrections in place', async () => {
  const editor = await opened('labels:\n  - name: bug\n    color: 123\n  - name: feature\n    color: abcdef\n');
  const row = editor.entries.value.labels[0];
  expect(row?.applyProblem).toBeDefined();
  if (row === undefined) {
    throw new Error('Missing label');
  }
  await editor.changeEntry(row, { ...row.entry, color: '123456' });
  expect(editor.canSave.value).toBe(true);
  await editor.save(write);
  expect(editor.saveError.value).toBeUndefined();
  expect((await resolveProfile(file)).profile.labels).toEqual([
    { name: 'bug', color: '123456' },
    { name: 'feature', color: 'abcdef' },
  ]);
});

test('duplicate and unnamed entries can be renamed through their forms', async () => {
  const editor = await opened(
    'labels:\n  - name: bug\n    color: abcdef\n  - name: bug\n    color: fedcba\n  - description: Needs a name\n',
  );
  expect(new Set(editor.entries.value.labels.map((row) => row.key)).size).toBe(3);
  const [, duplicate, unnamed] = editor.entries.value.labels;
  if (duplicate === undefined || unnamed === undefined) {
    throw new Error('Missing invalid labels');
  }
  await editor.changeEntry(duplicate, { ...duplicate.entry, name: 'feature' });
  await editor.changeEntry(unnamed, { ...unnamed.entry, name: 'help' });
  expect(editor.canSave.value).toBe(true);
  await editor.save(write);
  expect(editor.saveError.value).toBeUndefined();
  expect((await resolveProfile(file)).profile.labels?.map((label) => label.name)).toEqual(['bug', 'feature', 'help']);
});

test.each([
  'repository: wrong\n',
  'actions: { selected_actions: wrong }\n',
  'extends: missing.yaml\n',
  'owner_type: invalid\n',
])('invalid areas can be removed in the editor: %s', async (text) => {
  const editor = await opened(text);
  for (const problem of editor.configurationProblems.value) {
    await editor.removeInvalidConfiguration(problem);
  }
  expect(editor.canSave.value).toBe(true);
  await editor.save(write);
  expect(editor.saveError.value).toBeUndefined();
  await expect(resolveProfile(file)).resolves.toBeDefined();
});

test('pending entry changes retain their identity when another field becomes invalid', async () => {
  const editor = await opened('labels: [{ name: bug, color: abcdef, ignored: true }]\n');
  const label = editor.entries.value.labels[0];
  if (label === undefined) {
    throw new Error('Missing label');
  }
  await editor.changeEntry(label, { ...label.entry, color: '123456' });
  await writeFile(file, 'labels: [{ name: bug, color: abcdef, ignored: true }]\nrepository: { has_wiki: broken }\n');
  await editor.load();
  expect(editor.entries.value.labels).toHaveLength(1);
  expect(editor.entries.value.labels[0]?.outOfDate).toBe(false);
  await editor.set(setting(editor, 'repository.has_wiki').field, true);
  expect(editor.canSave.value).toBe(true);
  await editor.save(write);
  expect(editor.saveError.value).toBeUndefined();
  expect((await resolveProfile(file)).profile.labels).toEqual([{ name: 'bug', color: '123456' }]);
});

test('duplicate drafts have distinct forms and can be finished under different names', async () => {
  const editor = await opened(
    'labels: [{ name: bug, draft: true, color: abcdef }, { name: bug, draft: true, color: fedcba }]\n',
  );
  const [first, second] = editor.entries.value.labels;
  if (first === undefined || second === undefined) {
    throw new Error('Missing draft labels');
  }
  expect(first.key).not.toBe(second.key);
  await editor.changeEntry(second, { ...second.entry, name: 'feature' });
  expect(editor.canSave.value).toBe(true);
  await editor.save(write);
  expect(editor.saveError.value).toBeUndefined();
  expect((await resolveProfile(file)).profile.labels).toEqual([
    { name: 'bug', color: 'abcdef' },
    { name: 'feature', color: 'fedcba' },
  ]);
});

test.each([true, false])(
  'removing malformed list items keeps valid neighbors (refresh errors: %s)',
  async (refresh) => {
    const editor = await opened('labels: [42, 43, { name: keep, color: abcdef }]\n');
    if (refresh) {
      const removeFirst = async (): Promise<void> => {
        const [problem] = editor.configurationProblems.value;
        if (problem === undefined) {
          throw new Error('Missing configuration problem');
        }
        await editor.removeInvalidConfiguration(problem);
      };
      await removeFirst();
      await removeFirst();
    } else {
      for (const problem of editor.configurationProblems.value) {
        await editor.removeInvalidConfiguration(problem);
      }
    }
    expect(editor.canSave.value).toBe(true);
    await editor.save(write);
    expect(editor.saveError.value).toBeUndefined();
    expect((await resolveProfile(file)).profile.labels).toEqual([{ name: 'keep', color: 'abcdef' }]);
  },
);

test.each([
  ['pages: { absent: true }\n', 'pages: { build_type: workflow }\n', 'pages.build_type', 'workflow'],
  ['pages: { build_type: workflow }\n', 'pages: { absent: true }\n', 'pages.absent', true],
])('invalid configuration keeps Pages inheritance semantics: %s', async (base, own, path, expected) => {
  await mkdir('/profiles', { recursive: true });
  await writeFile('/profiles/base.yaml', base);
  const editor = await opened(`extends: base.yaml\n${own}repository: { has_wiki: broken }\n`);
  expect(setting(editor, path).value).toBe(expected);
  if (path === 'pages.build_type') {
    expect(setting(editor, 'pages.absent').value).toBeUndefined();
  }
  await editor.set(setting(editor, 'repository.has_wiki').field, true);
  await editor.save(write);
  expect(editor.saveError.value).toBeUndefined();
});

test.each([
  ['labels: [42, { name: keep, color: abcdef }]\n', 'labels: [{ name: keep, color: abcdef }, 42]\n'],
  ['repository: wrong\n', 'repository: { has_issues: true, has_wiki: false }\n'],
  ['actions: { selected_actions: wrong }\n', 'actions: { selected_actions: { verified_allowed: true } }\n'],
])('a queued invalid configuration removal preserves later corrections: %s', async (original, elsewhere) => {
  const editor = await opened(original);
  const [problem] = editor.configurationProblems.value;
  if (problem === undefined) {
    throw new Error('Missing invalid label');
  }
  await editor.removeInvalidConfiguration(problem);
  expect(editor.canSave.value).toBe(true);
  const held = Promise.withResolvers<undefined>();
  const saving = editor.save(async (work) => {
    await held.promise;
    await work();
  });
  await writeFile(file, elsewhere);
  held.resolve(undefined);
  await saving;
  expect(editor.saveError.value).toContain('changed elsewhere');
  expect(await readFile(file, 'utf8')).toBe(elsewhere);
  expect(editor.dirty.value).toBe(true);
});

test.each([0, 1])('duplicate repairs validate the completed edits regardless of rename order: %s', async (renamed) => {
  const editor = await opened('labels: [{ name: bug, color: abcdef }, { name: bug, color: broken }]\n');
  const row = editor.entries.value.labels[renamed];
  if (row === undefined) {
    throw new Error('Missing duplicate label');
  }
  await editor.changeEntry(row, { ...row.entry, name: 'feature' });
  const invalidColor = editor.entries.value.labels[1];
  if (invalidColor === undefined) {
    throw new Error('Missing invalid color');
  }
  await editor.changeEntry(invalidColor, { ...invalidColor.entry, color: 'fedcba' });
  expect(editor.canSave.value).toBe(true);
  await editor.save(write);
  expect(editor.saveError.value).toBeUndefined();
  expect((await resolveProfile(file)).profile.labels?.map((entry) => entry.name)).toEqual(
    renamed === 0 ? ['feature', 'bug'] : ['bug', 'feature'],
  );
});

test('a Pages draft is included in the first save that repairs configuration', async () => {
  const editor = await opened('repository: { has_wiki: broken }\ndrafts: { pages: { absent: true } }\n');
  expect(editor.draftCount.value).toBe(1);
  expect(setting(editor, 'pages.absent').value).toBe(true);
  await editor.set(setting(editor, 'repository.has_wiki').field, true);
  await editor.save(write);
  expect(editor.saveError.value).toBeUndefined();
  const resolved = await resolveProfile(file);
  expect(resolved.profile.pages).toEqual({ absent: true });
  expect(resolved.drafts.pages).toBeUndefined();
  expect(editor.draftCount.value).toBe(0);
});

test('removing a malformed draft section preserves and finishes valid draft neighbors', async () => {
  const editor = await opened('drafts: { repository: wrong, merge: { allow_squash_merge: true } }\n');
  expect(editor.draftCount.value).toBe(1);
  const [problem] = editor.configurationProblems.value;
  if (problem === undefined) {
    throw new Error('Missing draft section error');
  }
  await editor.removeInvalidConfiguration(problem);
  expect(editor.canSave.value).toBe(true);
  await editor.save(write);
  expect(editor.saveError.value).toBeUndefined();
  const resolved = await resolveProfile(file);
  expect(resolved.profile.merge).toEqual({ allow_squash_merge: true });
  expect(editor.draftCount.value).toBe(0);
});

test.each(['ruleset', 'environment'])('entry names cannot redirect a duplicate removal: %s', async (name) => {
  const editor = await opened(
    `rulesets: [{ name: Main }]\nlabels: [{ name: ${name}, draft: true, color: abcdef }, { name: ${name}, draft: true, color: fedcba }]\n`,
  );
  const [problem] = editor.configurationProblems.value;
  if (problem === undefined) {
    throw new Error('Missing duplicate error');
  }
  expect(problem.path[0]).toBe('labels');
  await editor.removeInvalidConfiguration(problem);
  expect(editor.canSave.value).toBe(true);
  await editor.save(write);
  expect(editor.saveError.value).toBeUndefined();
  const resolved = await resolveProfile(file);
  expect(resolved.profile.rulesets).toEqual([{ name: 'Main' }]);
  expect(resolved.profile.labels).toEqual([{ name, color: 'abcdef' }]);
});

test('unknown fields alone can be saved away without changing known configuration', async () => {
  const text = '# Keep this comment\nunknown: true\nrepository: { has_wiki: true, has_wikki: false }\n';
  const editor = await opened(text);
  expect(await readFile(file, 'utf8')).toBe(text);
  expect(editor.dirty.value).toBe(false);
  expect(editor.canSave.value).toBe(true);
  await editor.openPreview();
  expect(editor.preview.value?.removedUnknownFields).toEqual(['unknown', 'repository.has_wikki']);
  await editor.save(write);
  expect(editor.saveError.value).toBeUndefined();
  expect(editor.canSave.value).toBe(false);
  const saved = await readFile(file, 'utf8');
  expect(saved).toContain('# Keep this comment');
  expect(saved).not.toContain('unknown');
  expect(saved).not.toContain('has_wikki');
  expect((await resolveProfile(file)).profile.repository).toEqual({ has_wiki: true });
});

test('invalid custom-property draft names remain counted and can be removed through their validation area', async () => {
  const editor = await opened('drafts: { custom_properties: { "a.b": wrong } }\n');
  expect(editor.draftCount.value).toBe(1);
  expect(editor.canDiscardDraft.value).toBe(true);
  const [problem] = editor.configurationProblems.value;
  if (problem === undefined) {
    throw new Error('Missing invalid custom property');
  }
  await editor.removeInvalidConfiguration(problem);
  expect(editor.canSave.value).toBe(true);
  await editor.save(write);
  expect(editor.saveError.value).toBeUndefined();
  expect((await resolveProfile(file)).drafts).toEqual({});
});

test('discarding an invalid property draft checks its literal name before overwriting a queued change', async () => {
  const editor = await opened('drafts: { custom_properties: { "a.b": wrong } }\n');
  const held = Promise.withResolvers<undefined>();
  const discarding = editor.discardDraft(async (work) => {
    await held.promise;
    await work();
  });
  const elsewhere = 'drafts: { custom_properties: { "a.b": changed } }\n';
  await writeFile(file, elsewhere);
  held.resolve(undefined);
  await discarding;
  expect(editor.saveError.value).toContain('draft changed elsewhere');
  expect(await readFile(file, 'utf8')).toBe(elsewhere);
});

test('saving unknown-key cleanup as a draft retains known invalid draft values', async () => {
  const editor = await opened('unknown: true\nlabels: [{ name: bug, draft: true, color: invalid, mystery: true }]\n');
  expect(editor.canSave.value).toBe(false);
  expect(editor.canSaveAsDraft.value).toBe(true);
  await editor.save(write, 'draft');
  expect(editor.saveError.value).toBeUndefined();
  expect((await resolveProfile(file)).drafts.labels).toEqual([{ name: 'bug', draft: true, color: 'invalid' }]);
  const text = await readFile(file, 'utf8');
  expect(text).not.toContain('unknown');
  expect(text).not.toContain('mystery');
});
