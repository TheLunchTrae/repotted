import { afterEach, expect, test } from 'vitest';

import { ProfileEditor, type SettingRow } from '../src/app/profile-editor.js';
import { type SettingField, settingSections } from '../src/app/setting-fields.js';
import { mkdir, readFile, rm, writeFile } from '../src/engine/files.js';

afterEach(async () => {
  await rm('/', { recursive: true });
});

const base = '# Every repository starts here.\nrepository:\n  has_wiki: false\nmerge:\n  allow_squash_merge: true\n';

async function opened(files: Record<string, string>, name = 'web.yaml'): Promise<ProfileEditor> {
  await mkdir('/profiles', { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    await writeFile(`/profiles/${file}`, text);
  }
  const editor = new ProfileEditor(`/profiles/${name}`);
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

/** Runs a save straight away, as the profiles' queue does when nothing is ahead of it. */
const write = (work: () => Promise<void>): Promise<void> => work();

test('shows each setting with the profile that sets it, and nothing for one no profile sets', async () => {
  const editor = await opened({
    'base.yaml': base,
    'web.yaml': 'extends: base.yaml\nrepository:\n  has_issues: false\n',
  });

  expect(row(editor, 'repository.has_issues')).toMatchObject({ value: false, source: 'here', unsaved: false });
  expect(row(editor, 'repository.has_wiki')).toMatchObject({ value: false, source: 'base.yaml' });
  expect(row(editor, 'repository.has_projects')).toMatchObject({ value: undefined, source: undefined });
  expect(editor.dirty.value).toBe(false);
});

test('a change shows at once, saves only what changed, and keeps the rest of the file', async () => {
  const editor = await opened({ 'web.yaml': base });

  await editor.set(field('repository.has_wiki'), true);
  await editor.set(field('actions.selected_actions.verified_allowed'), true);
  expect(row(editor, 'repository.has_wiki')).toMatchObject({ value: true, source: 'here', unsaved: true });
  expect(editor.canSave.value).toBe(true);
  expect(await readFile('/profiles/web.yaml', 'utf8')).toBe(base);

  await editor.save(write);

  expect(editor.dirty.value).toBe(false);
  const text = await readFile('/profiles/web.yaml', 'utf8');
  expect(text).toContain('# Every repository starts here.');
  expect(text).toContain('has_wiki: true');
  expect(text).toContain('verified_allowed: true');
  expect(row(editor, 'repository.has_wiki')).toMatchObject({ value: true, unsaved: false });
});

test("removing a setting here lets the base profile's value apply again", async () => {
  const editor = await opened({ 'base.yaml': base, 'web.yaml': 'extends: base.yaml\nrepository:\n  has_wiki: true\n' });

  await editor.set(field('repository.has_wiki'), undefined);
  expect(row(editor, 'repository.has_wiki')).toMatchObject({ value: false, source: 'base.yaml', unsaved: true });

  await editor.save(write);
  expect(await readFile('/profiles/web.yaml', 'utf8')).not.toContain('has_wiki');
});

test('a change back to what is saved is no change, and reset puts one setting or all back', async () => {
  const editor = await opened({ 'web.yaml': base });

  await editor.set(field('repository.has_wiki'), true);
  await editor.set(field('repository.has_wiki'), false);
  expect(editor.dirty.value).toBe(false);

  await editor.set(field('repository.has_wiki'), true);
  await editor.set(field('merge.allow_rebase_merge'), false);
  await editor.reset(field('repository.has_wiki'));
  expect(row(editor, 'repository.has_wiki')).toMatchObject({ value: false, unsaved: false });
  expect(row(editor, 'merge.allow_rebase_merge')).toMatchObject({ value: false, unsaved: true });

  await editor.resetAll();
  expect(editor.dirty.value).toBe(false);
  expect(row(editor, 'merge.allow_rebase_merge')?.value).toBeUndefined();
});

test('a change the engine refuses says why, holds the save back, and writes nothing', async () => {
  const editor = await opened({ 'web.yaml': base });

  // GitHub needs at least one merge method.
  await editor.set(field('merge.allow_squash_merge'), false);
  await editor.set(field('merge.allow_merge_commit'), false);
  await editor.set(field('merge.allow_rebase_merge'), false);

  expect(editor.problem.value).toMatch(/merge/iu);
  expect(editor.canSave.value).toBe(false);
  expect(row(editor, 'merge.allow_rebase_merge')).toMatchObject({ value: false, unsaved: true });
  await editor.save(write);
  expect(await readFile('/profiles/web.yaml', 'utf8')).toBe(base);

  await editor.reset(field('merge.allow_rebase_merge'));
  expect(editor.problem.value).toBeUndefined();
  expect(editor.canSave.value).toBe(true);
});

test('typed text that cannot be a value stays as typed with why, until it can', async () => {
  const editor = await opened({ 'web.yaml': base });
  const days = field('actions.artifact_and_log_retention.days');

  await editor.type(days, '0');
  expect(row(editor, days.path.join('.'))).toMatchObject({ text: '0', invalid: 'Type a whole number, 1 or more.' });
  expect(editor.dirty.value).toBe(true);
  expect(editor.canSave.value).toBe(false);

  await editor.type(days, ' 30 ');
  expect(row(editor, days.path.join('.'))).toMatchObject({
    value: 30,
    text: ' 30 ',
    invalid: undefined,
    unsaved: true,
  });
  editor.settle(days);
  expect(row(editor, days.path.join('.'))?.text).toBeUndefined();

  await editor.type(field('repository.default_branch'), '  ');
  expect(row(editor, 'repository.default_branch')?.invalid).toContain("can't be empty");
  editor.settle(field('repository.default_branch'));
  expect(row(editor, 'repository.default_branch')?.text).toBe('  ');
  await editor.reset(field('repository.default_branch'));
  expect(row(editor, 'repository.default_branch')?.invalid).toBeUndefined();

  await editor.type(field('repository.description'), '');
  expect(row(editor, 'repository.description')).toMatchObject({ value: '', unsaved: true });
  await editor.type(field('actions.selected_actions.patterns_allowed'), ' octo-org/* \n\n!octo-org/bad@*\n');
  expect(row(editor, 'actions.selected_actions.patterns_allowed')?.value).toEqual(['octo-org/*', '!octo-org/bad@*']);
});

test('a setting GitHub hides goes with the one it follows, and that one counts what the profile still names', async () => {
  const editor = await opened({
    'web.yaml': 'actions:\n  enabled: true\n  allowed_actions: selected\n  sha_pinning_required: true\n',
  });
  expect(row(editor, 'actions.allowed_actions')).toMatchObject({ value: 'selected' });
  expect(row(editor, 'actions.selected_actions.patterns_allowed')).toBeDefined();

  await editor.set(field('actions.enabled'), false);

  expect(row(editor, 'actions.allowed_actions')).toBeUndefined();
  expect(row(editor, 'actions.sha_pinning_required')).toBeUndefined();
  expect(row(editor, 'actions.enabled')?.hiddenNamed).toBe(2);

  await editor.save(write);
  expect(await readFile('/profiles/web.yaml', 'utf8')).toContain('allowed_actions: selected');
});

test('a setting GitHub greys out stays in place and is marked off', async () => {
  const editor = await opened({ 'web.yaml': 'security:\n  vulnerability_alerts: false\n' });

  expect(row(editor, 'security.automated_security_fixes')).toMatchObject({ off: true });

  await editor.set(field('security.vulnerability_alerts'), true);
  expect(row(editor, 'security.automated_security_fixes')).toMatchObject({ off: false });
});

test('taking the Pages site down and describing one take each other out', async () => {
  const editor = await opened({ 'web.yaml': 'pages:\n  build_type: workflow\n  https_enforced: true\n' });

  await editor.set(field('pages.absent'), true);
  expect(row(editor, 'pages.build_type')?.value).toBeUndefined();
  expect(row(editor, 'pages.https_enforced')?.value).toBeUndefined();
  expect(editor.problem.value).toBeUndefined();

  await editor.save(write);
  expect(await readFile('/profiles/web.yaml', 'utf8')).toBe('pages:\n  absent: true\n');

  await editor.set(field('pages.build_type'), 'legacy');
  expect(row(editor, 'pages.absent')?.value).toBeUndefined();
});

test('a save that fails keeps the changes and says why', async () => {
  const editor = await opened({ 'web.yaml': base });
  await editor.set(field('repository.has_wiki'), true);

  await editor.save(() => Promise.reject(new Error('The file is gone.')));

  expect(editor.saveError.value).toBe('The file is gone.');
  expect(editor.saving.value).toBe(false);
  expect(row(editor, 'repository.has_wiki')).toMatchObject({ value: true, unsaved: true });

  // The same changes can be saved again.
  expect(editor.canSave.value).toBe(true);
  await editor.save(write);
  expect(editor.saveError.value).toBeUndefined();
  expect(await readFile('/profiles/web.yaml', 'utf8')).toContain('has_wiki: true');
});

test('a setting toggled back during a save that then fails keeps its change', async () => {
  const editor = await opened({ 'web.yaml': base });
  const wiki = field('repository.has_wiki');
  await editor.set(wiki, true);
  const held = Promise.withResolvers<undefined>();

  const saving = editor.save(async () => {
    await held.promise;
    throw new Error('The file is gone.');
  });
  await editor.set(wiki, false);
  await editor.set(wiki, true);
  held.resolve(undefined);
  await saving;

  expect(row(editor, 'repository.has_wiki')).toMatchObject({ value: true, unsaved: true });
  expect(editor.dirty.value).toBe(true);
});

test('settings with no change show as saved while another change is refused, and follow what is chosen', async () => {
  const editor = await opened({
    'web.yaml': 'repository:\n  has_wiki: true\nmerge:\n  allow_merge_commit: false\n  allow_rebase_merge: false\n',
  });

  await editor.set(field('repository.has_wiki'), false);
  await editor.set(field('merge.allow_squash_merge'), false);
  expect(editor.problem.value).toBeDefined();
  await editor.reset(field('repository.has_wiki'));
  expect(row(editor, 'repository.has_wiki')).toMatchObject({ value: true, source: 'here', unsaved: false });

  // A setting GitHub hides goes with the one it follows, refused change or not.
  await editor.set(field('repository.has_pull_requests'), false);
  expect(editor.problem.value).toBeDefined();
  expect(row(editor, 'repository.pull_request_creation_policy')).toBeUndefined();
});

test('a profile that stops reading keeps its changes for when it reads again, and counts as nothing unsaved meanwhile', async () => {
  const editor = await opened({ 'base.yaml': base, 'web.yaml': 'extends: base.yaml\n' });
  await editor.set(field('repository.has_issues'), false);
  expect(editor.dirty.value).toBe(true);

  await rm('/profiles/base.yaml');
  await editor.load();
  expect(editor.loadError.value).toContain('base.yaml');
  expect(editor.dirty.value).toBe(false);
  expect(editor.canSave.value).toBe(false);

  await writeFile('/profiles/base.yaml', base);
  await editor.load();
  expect(editor.dirty.value).toBe(true);
  expect(row(editor, 'repository.has_issues')).toMatchObject({ value: false, unsaved: true });
});

test('a change made while the profile is still being read is laid over it once it is', async () => {
  await mkdir('/profiles', { recursive: true });
  await writeFile('/profiles/web.yaml', base);
  const editor = new ProfileEditor('/profiles/web.yaml');

  const loading = editor.load();
  await editor.set(field('repository.has_wiki'), true);
  await loading;

  expect(row(editor, 'repository.has_wiki')).toMatchObject({ value: true, unsaved: true });
  expect(editor.canSave.value).toBe(true);
});

test('a change made while a save runs stays unsaved, and a change to the file meanwhile is kept', async () => {
  const editor = await opened({ 'web.yaml': base });
  await editor.set(field('repository.has_wiki'), true);
  const held = Promise.withResolvers<undefined>();

  const saving = editor.save(async (work) => {
    await held.promise;
    // A sync brings in a change to another setting before the save's turn.
    await writeFile('/profiles/web.yaml', base.replace('allow_squash_merge: true', 'allow_squash_merge: false'));
    await work();
  });
  expect(editor.saving.value).toBe(true);
  await editor.set(field('repository.has_issues'), false);
  // The setting being saved is changed again, to what the file had.
  await editor.set(field('repository.has_wiki'), false);
  held.resolve(undefined);
  await saving;

  const text = await readFile('/profiles/web.yaml', 'utf8');
  expect(text).toContain('has_wiki: true');
  expect(text).toContain('allow_squash_merge: false');
  expect(text).not.toContain('has_issues');
  expect(row(editor, 'repository.has_issues')).toMatchObject({ value: false, unsaved: true });
  expect(row(editor, 'repository.has_wiki')).toMatchObject({ value: false, unsaved: true });
});

test('a profile that cannot be read says why and shows no settings', async () => {
  const editor = await opened({ 'web.yaml': 'repository:\n  has_wikis: maybe\n' });

  expect(editor.loadError.value).toContain('has_wikis');
  expect(editor.loaded.value).toBe(false);
  expect(editor.sections.value.flatMap((section) => section.groups.flatMap((group) => group.rows))).toEqual([]);
});

test('every setting the editor offers, with every choice it gives, is one the engine takes', async () => {
  const fields = settingSections.flatMap((section) => section.groups.flatMap((group) => group.fields));
  for (const item of fields) {
    const values =
      item.kind === 'choice'
        ? item.options.map((option) => option.value)
        : [item.kind === 'number' ? 5 : item.kind === 'list' ? ['octo-org/*'] : 'main'];
    for (const value of values) {
      const editor = await opened({ 'probe.yaml': '' }, 'probe.yaml');
      await editor.set(item, value);
      expect(editor.problem.value, `${item.path.join('.')}: ${JSON.stringify(value)}`).toBeUndefined();
      expect(row(editor, item.path.join('.')), item.path.join('.')).toMatchObject({ value, unsaved: true });
    }
  }
});
