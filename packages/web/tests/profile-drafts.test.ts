import { resolveProfile } from '@repotted/core';
import { afterEach, expect, test } from 'vitest';

import type { EntryList, EntryRow } from '../src/app/entry-edits.js';
import { ProfileEditor, type SettingRow } from '../src/app/profile-editor.js';
import { type SettingField, settingSections } from '../src/app/setting-fields.js';
import { mkdir, readFile, rm, writeFile } from '../src/engine/files.js';

afterEach(async () => {
  await rm('/', { recursive: true });
});

const file = '/profiles/web.yaml';

async function opened(files: Record<string, string>): Promise<ProfileEditor> {
  await mkdir('/profiles', { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    await writeFile(`/profiles/${name}`, text);
  }
  const editor = new ProfileEditor(file);
  await editor.load();
  return editor;
}

function field(path: string): SettingField {
  const found = settingSections
    .flatMap((section) => section.groups.flatMap((group) => group.fields))
    .find((item) => item.path.join('.') === path);
  if (found === undefined) {
    throw new Error(`The editor has no setting ${path}.`);
  }
  return found;
}

function row(editor: ProfileEditor, path: string): SettingRow | undefined {
  return editor.sections.value
    .flatMap((section) => section.groups.flatMap((group) => group.rows))
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

const ruleset = (name: string, extra = ''): string =>
  `  - name: ${name}\n    target: branch\n    enforcement: active\n    conditions:\n      ref_name:\n        include: ["~DEFAULT_BRANCH"]\n        exclude: []\n    rules:\n      - type: deletion\n${extra}`;

const drafted = `# Kept.
repository:
  has_wiki: false
  has_issues: true
merge:
  allow_squash_merge: true
rulesets:
${ruleset('Main')}${ruleset('Main', '      - type: non_fast_forward\n    draft: true\n')}${ruleset('Next', '    draft: true\n')}${ruleset('Legacy')}labels:
  - name: bug
    color: d73a4a
drafts:
  repository:
    has_wiki: true
  unset:
    - repository.has_issues
    - rulesets/Legacy
    - autolinks/JIRA-
autolinks:
  - key_prefix: JIRA-
    url_template: https://example.com/<num>
`;

test('a profile with a draft opens on it, and shows what applies beside it', async () => {
  const editor = await opened({ 'web.yaml': drafted });

  expect(row(editor, 'repository.has_wiki')).toMatchObject({ value: true, inDraft: true, applied: false });
  expect(row(editor, 'repository.has_issues')).toMatchObject({ value: undefined, inDraft: true, applied: true });
  expect(row(editor, 'merge.allow_squash_merge')).toMatchObject({ value: true, inDraft: false });
  expect(entry(editor, 'rulesets', 'Main')).toMatchObject({ inDraft: 'changed', unsaved: false, source: 'here' });
  expect(entry(editor, 'rulesets', 'Main').entry?.['rules']).toHaveLength(2);
  expect(entry(editor, 'rulesets', 'Main').applied?.['rules']).toHaveLength(1);
  expect(entry(editor, 'rulesets', 'Next')).toMatchObject({ inDraft: 'new', applied: undefined });
  expect(entry(editor, 'rulesets', 'Legacy')).toMatchObject({ inDraft: 'taken-out', entry: undefined });
  expect(entry(editor, 'labels', 'bug').inDraft).toBeUndefined();
  // Two settings, three rulesets; the autolink is not the editor's to count.
  expect(editor.draftCount.value).toBe(5);
  expect(editor.dirty.value).toBe(false);
  expect(editor.canSave.value).toBe(true);
  expect(editor.canSaveAsDraft.value).toBe(false);
});

test('save finishes the whole draft with the unsaved changes, and keeps what the editor does not show', async () => {
  const editor = await opened({ 'web.yaml': drafted });
  await editor.set(field('merge.allow_squash_merge'), false);

  await editor.save(write);

  expect(editor.saveError.value).toBeUndefined();
  expect(editor.draftCount.value).toBe(0);
  expect(editor.dirty.value).toBe(false);
  const saved = await resolveProfile(file);
  expect(saved.profile.repository).toEqual({ has_wiki: true });
  expect(saved.profile.merge).toEqual({ allow_squash_merge: false });
  expect(saved.profile.rulesets?.map((item) => [item.name, 'rules' in item ? item.rules?.length : 0])).toEqual([
    ['Main', 2],
    ['Next', 1],
  ]);
  expect(saved.drafts).toEqual({ unset: ['autolinks/JIRA-'] });
  expect(await readFile(file, 'utf8')).toContain('# Kept.');
});

test('save as draft keeps the changes out of what applies, and a later save applies them', async () => {
  const text = `repository:\n  has_wiki: false\n  has_issues: true\nrulesets:\n${ruleset('Main')}labels:\n  - name: bug\n    color: d73a4a\n`;
  const editor = await opened({ 'web.yaml': text });
  const applied = (await resolveProfile(file)).profile;

  await editor.set(field('repository.has_wiki'), true);
  await editor.set(field('repository.has_issues'), undefined);
  await editor.set(field('repository.has_projects'), false);
  await editor.changeEntry(entry(editor, 'rulesets', 'Main'), {
    ...entry(editor, 'rulesets', 'Main').entry,
    enforcement: 'disabled',
  });
  await editor.takeOut(entry(editor, 'labels', 'bug'));
  // A draft may be unfinished: this label is renamed from itself, which a save that applies refuses.
  await editor.addEntry('labels', { name: 'later', renamed_from: ['later'] });
  expect(editor.canSave.value).toBe(false);
  expect(editor.canSaveAsDraft.value).toBe(true);

  await editor.save(write, 'draft');

  expect(editor.saveError.value).toBeUndefined();
  expect(editor.dirty.value).toBe(false);
  const saved = await resolveProfile(file);
  expect(saved.profile).toEqual(applied);
  expect(saved.drafts.repository).toEqual({ has_wiki: true, has_projects: false });
  expect(saved.drafts.unset).toEqual(['repository.has_issues', 'labels/bug']);
  expect(saved.drafts.rulesets).toMatchObject([{ name: 'Main', enforcement: 'disabled', draft: true }]);
  expect(saved.drafts.labels).toEqual([{ name: 'later', renamed_from: ['later'], draft: true }]);
  expect(editor.draftCount.value).toBe(6);
  expect(row(editor, 'repository.has_wiki')).toMatchObject({ value: true, inDraft: true, unsaved: false });
  expect(entry(editor, 'labels', 'bug').inDraft).toBe('taken-out');
  // The unfinished label holds Save back, and says so on its row.
  expect(entry(editor, 'labels', 'later').problem).toBeDefined();
  expect(editor.canSave.value).toBe(false);

  await editor.changeEntry(entry(editor, 'labels', 'later'), { name: 'later', color: '00ff00' });
  await editor.save(write);

  expect(editor.saveError.value).toBeUndefined();
  const finished = await resolveProfile(file);
  expect(finished.drafts).toEqual({});
  expect(finished.profile.repository).toEqual({ has_wiki: true, has_projects: false });
  expect(finished.profile.rulesets).toMatchObject([{ name: 'Main', enforcement: 'disabled' }]);
  expect(finished.profile.labels).toEqual([{ name: 'later', color: '00ff00' }]);
});

test('a change back to what applies takes the setting or entry out of the draft', async () => {
  const editor = await opened({ 'web.yaml': drafted });

  await editor.set(field('repository.has_wiki'), false);
  await editor.set(field('repository.has_issues'), true);
  await editor.changeEntry(entry(editor, 'rulesets', 'Main'), entry(editor, 'rulesets', 'Main').applied ?? {});
  await editor.putBack(entry(editor, 'rulesets', 'Legacy'));
  await editor.takeOut(entry(editor, 'rulesets', 'Next'));
  await editor.save(write, 'draft');

  expect(editor.saveError.value).toBeUndefined();
  const saved = await resolveProfile(file);
  expect(saved.drafts).toEqual({ unset: ['autolinks/JIRA-'] });
  expect(saved.profile.rulesets?.map((item) => item.name)).toEqual(['Main', 'Legacy']);
  expect(editor.draftCount.value).toBe(0);
});

test('a ruleset renamed in a draft leaves the one that applies until the draft is finished', async () => {
  const editor = await opened({ 'web.yaml': `rulesets:\n${ruleset('Main')}` });

  await editor.changeEntry(entry(editor, 'rulesets', 'Main'), {
    ...entry(editor, 'rulesets', 'Main').entry,
    name: 'Trunk',
  });
  await editor.save(write, 'draft');

  expect(entry(editor, 'rulesets', 'Main').inDraft).toBe('taken-out');
  expect(entry(editor, 'rulesets', 'Trunk').inDraft).toBe('new');
  expect((await resolveProfile(file)).profile.rulesets?.map((item) => item.name)).toEqual(['Main']);

  await editor.save(write);

  const saved = await resolveProfile(file);
  expect(saved.profile.rulesets?.map((item) => item.name)).toEqual(['Trunk']);
  expect(saved.drafts).toEqual({});
});

test('discarding the draft leaves only what applies, and waits while a change is unsaved', async () => {
  const editor = await opened({ 'web.yaml': drafted });
  const applied = (await resolveProfile(file)).profile;

  await editor.set(field('merge.allow_squash_merge'), false);
  expect(editor.canDiscardDraft.value).toBe(false);
  await editor.discardDraft(write);
  expect(editor.draftCount.value).toBe(5);

  await editor.resetAll();
  await editor.discardDraft(write);

  expect(editor.saveError.value).toBeUndefined();
  const saved = await resolveProfile(file);
  expect(saved.profile).toEqual(applied);
  expect(saved.drafts).toEqual({ unset: ['autolinks/JIRA-'] });
  expect(editor.draftCount.value).toBe(0);
  expect(row(editor, 'repository.has_wiki')).toMatchObject({ value: false, inDraft: false });
});

test("a base profile's draft is left to that profile", async () => {
  const editor = await opened({
    'base.yaml': `repository:\n  has_wiki: false\ndrafts:\n  repository:\n    has_wiki: true\nrulesets:\n${ruleset('Main', '    draft: true\n')}`,
    'web.yaml': 'extends: base.yaml\nrepository:\n  has_issues: true\n',
  });

  expect(row(editor, 'repository.has_wiki')).toMatchObject({ value: false, inDraft: false, source: 'base.yaml' });
  expect(editor.entries.value.rulesets).toEqual([]);
  expect(editor.draftCount.value).toBe(0);
  expect(editor.canSave.value).toBe(false);
});

test('a draft the profile cannot apply yet holds Save back with the reason, and can still be added to', async () => {
  const editor = await opened({
    'web.yaml':
      'merge:\n  allow_squash_merge: true\n  allow_merge_commit: false\n  allow_rebase_merge: false\ndrafts:\n  merge:\n    allow_squash_merge: false\n',
  });

  expect(editor.problem.value).toContain('Every merge method is off');
  expect(editor.canSave.value).toBe(false);

  await editor.set(field('repository.has_wiki'), true);
  expect(editor.canSaveAsDraft.value).toBe(true);
  await editor.save(write, 'draft');

  expect(editor.saveError.value).toBeUndefined();
  expect((await resolveProfile(file)).drafts).toEqual({
    merge: { allow_squash_merge: false },
    repository: { has_wiki: true },
  });
});

test('a value a draft cannot hold, and an entry with no name, wait for a save that applies or a reset', async () => {
  const editor = await opened({ 'web.yaml': 'repository:\n  has_wiki: true\n' });

  await editor.set(field('security.code_scanning_default_setup.runner_label'), null);
  expect(editor.problem.value).toBeUndefined();
  expect(editor.draftProblem.value).toContain('empty value');
  expect(editor.canSaveAsDraft.value).toBe(false);
  expect(editor.canSave.value).toBe(true);

  await editor.resetAll();
  await editor.addEntry('labels', { name: '' });
  expect(editor.draftProblem.value).toContain('name');
  expect(editor.canSaveAsDraft.value).toBe(false);
});

test('a draft that changed elsewhere under a change to its entry is not written over', async () => {
  const editor = await opened({ 'web.yaml': drafted });
  const main = entry(editor, 'rulesets', 'Main');
  await editor.changeEntry(main, { ...main.entry, enforcement: 'evaluate' });

  await writeFile(file, drafted.replace('      - type: non_fast_forward\n', '      - type: creation\n'));
  await editor.save(write, 'draft');

  expect(editor.saveError.value).toContain('changed elsewhere');
  expect(await readFile(file, 'utf8')).toContain('type: creation');
  expect(entry(editor, 'rulesets', 'Main').outOfDate).toBe(true);
});

test('the name of an entry the draft takes out waits until that one is put back', async () => {
  const editor = await opened({
    'web.yaml': `rulesets:\n${ruleset('Main')}${ruleset('Trunk', '    draft: true\n')}drafts:\n  unset:\n    - rulesets/Main\n`,
  });

  await editor.changeEntry(entry(editor, 'rulesets', 'Trunk'), {
    ...entry(editor, 'rulesets', 'Trunk').entry,
    name: 'Main',
  });

  const renamed = editor.entries.value.rulesets.find((item) => item.unsaved);
  expect(renamed?.problem).toContain('Put that one back');
  expect(renamed?.draftProblem).toContain('Put that one back');
  expect(editor.canSave.value).toBe(false);
  expect(editor.canSaveAsDraft.value).toBe(false);
});

test('a draft that changed elsewhere is shown before any save acts on it', async () => {
  const text = 'repository:\n  has_wiki: false\n  has_issues: true\n';
  const editor = await opened({ 'web.yaml': text });
  await editor.set(field('repository.has_wiki'), true);
  const elsewhere = `${text}drafts:\n  repository:\n    has_issues: false\n`;
  await writeFile(file, elsewhere);

  await editor.save(write);

  expect(editor.saveError.value).toContain('draft changed elsewhere');
  expect(await readFile(file, 'utf8')).toBe(elsewhere);
  expect(row(editor, 'repository.has_issues')).toMatchObject({ value: false, inDraft: true });
  expect(row(editor, 'repository.has_wiki')).toMatchObject({ value: true, unsaved: true });

  await editor.save(write);

  expect(editor.saveError.value).toBeUndefined();
  expect((await resolveProfile(file)).profile.repository).toEqual({ has_wiki: true, has_issues: false });
});

const topics = 'repository:\n  has_wiki: false\ndrafts:\n  repository:\n    topics:\n      - infra\n    made_up: 1\n';

test('a draft setting the tabs leave to the file is counted, finished, and discarded with the rest', async () => {
  const editor = await opened({ 'web.yaml': topics });
  // The key no section has is not the editor's: it stays, with the profile's warning.
  expect(editor.draftCount.value).toBe(1);
  expect(editor.warnings.value.join('\n')).toContain('made_up');

  await editor.save(write);

  expect(editor.saveError.value).toBeUndefined();
  const saved = await resolveProfile(file);
  expect(saved.profile.repository).toEqual({ has_wiki: false, topics: ['infra'] });
  expect(saved.drafts).toEqual({ repository: { made_up: 1 } });

  await writeFile(file, topics);
  await editor.load();
  await editor.discardDraft(write);

  expect((await resolveProfile(file)).drafts).toEqual({ repository: { made_up: 1 } });
  expect(editor.draftCount.value).toBe(0);
});

test('managing an entry again, after its draft removes it, brings back what applies', async () => {
  const editor = await opened({
    'web.yaml': 'environments:\n  - name: Prod\n    wait_timer: 5\n  - name: Prod\n    absent: true\n    draft: true\n',
  });
  expect(entry(editor, 'environments', 'Prod').entry).toEqual({ name: 'Prod', absent: true });

  await editor.setAbsent(entry(editor, 'environments', 'Prod'), false);

  expect(entry(editor, 'environments', 'Prod').entry).toEqual({ name: 'Prod', wait_timer: 5 });
});

test('a change made while a draft is being saved stays unsaved, on the draft as written', async () => {
  const editor = await opened({ 'web.yaml': `repository:\n  has_wiki: false\nrulesets:\n${ruleset('Main')}` });
  await editor.set(field('repository.has_wiki'), true);
  const main = entry(editor, 'rulesets', 'Main');
  await editor.changeEntry(main, { ...main.entry, enforcement: 'disabled' });
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  const saving = editor.save(async (work) => {
    await held;
    await work();
  }, 'draft');
  await editor.set(field('repository.has_issues'), false);
  await editor.changeEntry(entry(editor, 'rulesets', 'Main'), { ...main.entry, enforcement: 'evaluate' });
  release();
  await saving;

  expect(editor.saveError.value).toBeUndefined();
  const saved = await resolveProfile(file);
  expect(saved.drafts.repository).toEqual({ has_wiki: true });
  expect(saved.drafts.rulesets).toMatchObject([{ name: 'Main', enforcement: 'disabled' }]);
  expect(row(editor, 'repository.has_wiki')).toMatchObject({ inDraft: true, unsaved: false });
  expect(row(editor, 'repository.has_issues')).toMatchObject({ value: false, unsaved: true });
  expect(entry(editor, 'rulesets', 'Main')).toMatchObject({ unsaved: true, outOfDate: false });
  expect(entry(editor, 'rulesets', 'Main').entry?.['enforcement']).toBe('evaluate');
  expect(entry(editor, 'rulesets', 'Main').saved?.['enforcement']).toBe('disabled');
});

test('a discard that fails leaves the draft, with why', async () => {
  const editor = await opened({ 'web.yaml': drafted });

  await editor.discardDraft(() => Promise.reject(new Error('GitHub is not answering.')));

  expect(editor.saveError.value).toBe('GitHub is not answering.');
  expect(editor.draftCount.value).toBe(5);
  expect(await readFile(file, 'utf8')).toBe(drafted);
  expect(editor.saving.value).toBe(false);
});

test("a change to a base profile's draft, in a group this profile drafts too, holds no save back", async () => {
  const base = (allowed: boolean): string =>
    `drafts:\n  actions:\n    selected_actions:\n      github_owned_allowed: ${String(allowed)}\n`;
  const editor = await opened({
    'base.yaml': base(true),
    'web.yaml': 'extends: base.yaml\ndrafts:\n  actions:\n    selected_actions:\n      verified_allowed: true\n',
  });
  await editor.set(field('repository.has_wiki'), true);
  await writeFile('/profiles/base.yaml', base(false));

  await editor.save(write, 'draft');

  expect(editor.saveError.value).toBeUndefined();
  expect(editor.dirty.value).toBe(false);
});

test('a preview shows what a save would change in what applies, the draft with the unsaved, and writes nothing', async () => {
  const text = 'repository:\n  has_wiki: false\n  has_issues: true\ndrafts:\n  repository:\n    has_wiki: true\n';
  const editor = await opened({ 'web.yaml': text });
  await editor.set(field('repository.has_issues'), false);

  await editor.openPreview();

  const lines = editor.preview.value?.lines.map((line) =>
    line.kind === 'fold' ? 'fold' : `${line.kind} ${line.text}`,
  );
  expect(lines).toEqual([
    'same repository:',
    'removed   has_issues: true',
    'removed   has_wiki: false',
    'added   has_issues: false',
    'added   has_wiki: true',
  ]);
  expect(editor.preview.value).toMatchObject({ changes: 4, drafted: 1, unsaved: 1 });
  expect(await readFile(file, 'utf8')).toBe(text);

  editor.closePreview();
  expect(editor.preview.value).toBeUndefined();
});

test('a preview of a save that applies nothing new says so, and one Save could not make is not opened', async () => {
  const editor = await opened({
    'base.yaml': 'repository:\n  has_wiki: false\n',
    'web.yaml': 'extends: base.yaml\nrepository:\n  has_wiki: false\n',
  });
  await editor.set(field('repository.has_wiki'), undefined);

  await editor.openPreview();
  expect(editor.preview.value).toMatchObject({ changes: 0, drafted: 0, unsaved: 1 });

  editor.closePreview();
  await editor.addEntry('labels', { name: '' });
  await editor.openPreview();
  expect(editor.preview.value).toBeUndefined();
});
