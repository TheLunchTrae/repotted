import { editProfile, previewProfile, profileFileJsonSchema, resolveProfile } from '@repotted/core';
import { afterEach, expect, test } from 'vitest';

import {
  deployKeysBypassActor,
  withBypassActorAdded,
  withBypassListManaged,
  withBypassMode,
} from '../../src/app/profile-editor/bypass-actors.js';
import type { EntryList, EntryRow } from '../../src/app/profile-editor/entry-edits.js';
import { nameOfPlace, ProfileEditor, type SettingRow } from '../../src/app/profile-editor/profile-editor.js';
import { type SettingField, settingSections } from '../../src/app/profile-editor/setting-fields.js';
import { mkdir, readFile, rm, writeFile } from '../../src/engine/files.js';

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

function section(editor: ProfileEditor, name: string) {
  return editor.sections.value.find((item) => item.section.section === name);
}

function group(editor: ProfileEditor, sectionName: string, title: string) {
  return section(editor, sectionName)?.groups.find((item) => item.group.title === title);
}

const labels = (fields: readonly SettingField[] | undefined) => fields?.map((item) => item.label);

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

  expect(editor.unsavedChangesProblem.value).toMatch(/merge/iu);
  expect(editor.canSave.value).toBe(false);
  expect(row(editor, 'merge.allow_rebase_merge')).toMatchObject({ value: false, unsaved: true });
  await editor.save(write);
  expect(await readFile('/profiles/web.yaml', 'utf8')).toBe(base);

  await editor.reset(field('merge.allow_rebase_merge'));
  expect(editor.unsavedChangesProblem.value).toBeUndefined();
  expect(editor.canSave.value).toBe(true);
});

test('typed text that cannot be a value stays as typed with why, until it can', async () => {
  const editor = await opened({ 'web.yaml': base });
  const days = field('actions.artifact_and_log_retention.days');

  await editor.type(days, '0');
  expect(row(editor, days.path.join('.'))).toMatchObject({
    textBeingTyped: '0',
    typedTextProblem: 'Type a whole number, 1 or more.',
  });
  expect(editor.dirty.value).toBe(true);
  expect(editor.canSave.value).toBe(false);

  await editor.type(days, ' 30 ');
  expect(row(editor, days.path.join('.'))).toMatchObject({
    value: 30,
    textBeingTyped: ' 30 ',
    typedTextProblem: undefined,
    unsaved: true,
  });
  editor.settle(days);
  expect(row(editor, days.path.join('.'))?.textBeingTyped).toBeUndefined();

  await editor.type(field('repository.default_branch'), '  ');
  expect(row(editor, 'repository.default_branch')?.typedTextProblem).toContain("can't be empty");
  editor.settle(field('repository.default_branch'));
  expect(row(editor, 'repository.default_branch')?.textBeingTyped).toBe('  ');
  await editor.reset(field('repository.default_branch'));
  expect(row(editor, 'repository.default_branch')?.typedTextProblem).toBeUndefined();

  await editor.type(field('repository.description'), '');
  expect(row(editor, 'repository.description')).toMatchObject({ value: '', unsaved: true });
  await editor.type(field('actions.selected_actions.patterns_allowed'), ' octo-org/* \n\n!octo-org/bad@*\n');
  expect(row(editor, 'actions.selected_actions.patterns_allowed')?.value).toEqual(['octo-org/*', '!octo-org/bad@*']);
});

test('a setting GitHub hides goes with the one it follows, and that one lists what the profile still names', async () => {
  const editor = await opened({
    'web.yaml': 'actions:\n  enabled: true\n  allowed_actions: selected\n  sha_pinning_required: true\n',
  });
  expect(row(editor, 'actions.allowed_actions')).toMatchObject({ value: 'selected' });
  expect(row(editor, 'actions.selected_actions.patterns_allowed')).toBeDefined();

  await editor.set(field('actions.enabled'), false);

  expect(row(editor, 'actions.allowed_actions')).toBeUndefined();
  expect(row(editor, 'actions.sha_pinning_required')).toBeUndefined();
  expect(labels(row(editor, 'actions.enabled')?.turnsOff)).toEqual([
    'Allowed actions',
    'Require pinning to a full commit SHA',
  ]);

  await editor.save(write);
  expect(await readFile('/profiles/web.yaml', 'utf8')).toBe('actions:\n  enabled: false\n');
  expect(row(editor, 'actions.enabled')?.turnsOff).toEqual([]);
});

test('a setting under one GitHub hides is hidden too, and the highest one lists what the profile still names', async () => {
  const editor = await opened({
    'web.yaml':
      'actions:\n  enabled: true\n  allowed_actions: selected\n  selected_actions:\n    github_owned_allowed: true\n',
  });
  expect(row(editor, 'actions.selected_actions.github_owned_allowed')).toBeDefined();

  await editor.set(field('actions.enabled'), false);

  expect(row(editor, 'actions.allowed_actions')).toBeUndefined();
  expect(row(editor, 'actions.selected_actions.github_owned_allowed')).toBeUndefined();
  expect(row(editor, 'actions.selected_actions.verified_allowed')).toBeUndefined();
  expect(row(editor, 'actions.selected_actions.patterns_allowed')).toBeUndefined();
  expect(labels(row(editor, 'actions.enabled')?.turnsOff)).toEqual(['Allowed actions', 'Actions by GitHub']);
});

test('a setting GitHub greys out stays in place, off, with the setting that turns it off', async () => {
  const editor = await opened({ 'web.yaml': 'security:\n  vulnerability_alerts: false\n' });

  expect(row(editor, 'security.automated_security_fixes')?.greyedOutOnGitHubWhile).toMatchObject({
    field: field('security.vulnerability_alerts'),
    value: false,
  });

  await editor.set(field('security.vulnerability_alerts'), true);
  expect(row(editor, 'security.automated_security_fixes')?.greyedOutOnGitHubWhile).toBeUndefined();
});

test('a setting under one GitHub hides is hidden, though its own setting would only grey it out', async () => {
  const editor = await opened({
    'web.yaml': 'security:\n  code_scanning_default_setup:\n    state: not-configured\n    runner_type: standard\n',
  });

  expect(row(editor, 'security.code_scanning_default_setup.runner_type')).toBeUndefined();
  expect(row(editor, 'security.code_scanning_default_setup.runner_label')).toBeUndefined();
  expect(labels(row(editor, 'security.code_scanning_default_setup.state')?.turnsOff)).toEqual(['Runner type']);
});

test('a value picked that turns off settings the profile names waits for a yes, and Cancel keeps the value', async () => {
  const editor = await opened({
    'web.yaml': 'actions:\n  enabled: true\n  allowed_actions: selected\n  sha_pinning_required: true\n',
  });

  await editor.choose(field('actions.enabled'), false);

  expect(row(editor, 'actions.enabled')).toMatchObject({ value: true, unsaved: false });
  expect(labels(row(editor, 'actions.enabled')?.choiceToConfirm?.turnsOff)).toEqual([
    'Allowed actions',
    'Require pinning to a full commit SHA',
  ]);
  expect(row(editor, 'actions.allowed_actions')?.turnedOffByChoiceToConfirm).toBe(true);
  expect(row(editor, 'actions.default_workflow_permissions')?.turnedOffByChoiceToConfirm).toBe(false);

  editor.cancelChoice();
  expect(row(editor, 'actions.enabled')).toMatchObject({ value: true, choiceToConfirm: undefined });
  expect(row(editor, 'actions.allowed_actions')).toMatchObject({
    value: 'selected',
    turnedOffByChoiceToConfirm: false,
  });
});

test('a yes to a value that turns off settings sets it, and a save removes them', async () => {
  const editor = await opened({
    'web.yaml': 'actions:\n  enabled: true\n  allowed_actions: selected\n  sha_pinning_required: true\n',
  });

  await editor.choose(field('actions.enabled'), false);
  await editor.confirmChoice();

  expect(row(editor, 'actions.enabled')).toMatchObject({ value: false, unsaved: true, choiceToConfirm: undefined });
  expect(row(editor, 'actions.allowed_actions')).toBeUndefined();
  await editor.save(write);
  expect(await readFile('/profiles/web.yaml', 'utf8')).toBe('actions:\n  enabled: false\n');
});

test('a value picked that turns off nothing the profile names is set at once', async () => {
  const editor = await opened({
    'base.yaml': 'actions:\n  allowed_actions: selected\n',
    'web.yaml': 'extends: base.yaml\nactions:\n  enabled: true\n',
  });

  // A base profile's setting stays in its own file, so a save here removes nothing.
  await editor.choose(field('actions.enabled'), false);

  expect(row(editor, 'actions.enabled')).toMatchObject({ value: false, unsaved: true, choiceToConfirm: undefined });
});

test('a change while a value waits for a yes withdraws it', async () => {
  const editor = await opened({ 'web.yaml': 'actions:\n  enabled: true\n  allowed_actions: selected\n' });

  await editor.choose(field('actions.enabled'), false);
  await editor.set(field('actions.default_workflow_permissions'), 'read');

  expect(row(editor, 'actions.enabled')?.choiceToConfirm).toBeUndefined();
  await editor.confirmChoice();
  expect(row(editor, 'actions.enabled')?.value).toBe(true);
});

test('taking the Pages site down and describing one take each other out', async () => {
  const editor = await opened({ 'web.yaml': 'pages:\n  build_type: workflow\n  https_enforced: true\n' });

  await editor.set(field('pages.absent'), true);
  expect(row(editor, 'pages.build_type')?.value).toBeUndefined();
  expect(row(editor, 'pages.https_enforced')?.value).toBeUndefined();
  expect(editor.unsavedChangesProblem.value).toBeUndefined();

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
  expect(editor.unsavedChangesProblem.value).toBeDefined();
  await editor.reset(field('repository.has_wiki'));
  expect(row(editor, 'repository.has_wiki')).toMatchObject({ value: true, source: 'here', unsaved: false });

  // A setting GitHub hides goes with the one it follows, refused change or not.
  await editor.set(field('repository.has_pull_requests'), false);
  expect(editor.unsavedChangesProblem.value).toBeDefined();
  expect(row(editor, 'repository.pull_request_creation_policy')).toBeUndefined();
});

test('a profile that stops reading keeps its changes unsaved until it reads again', async () => {
  const editor = await opened({ 'base.yaml': base, 'web.yaml': 'extends: base.yaml\n' });
  await editor.set(field('repository.has_issues'), false);
  expect(editor.dirty.value).toBe(true);

  await rm('/profiles/base.yaml');
  await editor.load();
  expect(editor.loaded.value).toBe(true);
  expect(editor.unsavedChangesProblem.value).toContain('base.yaml');
  expect(editor.dirty.value).toBe(true);
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

test('invalid YAML says why and shows no settings', async () => {
  const editor = await opened({ 'web.yaml': 'repository: [\n' });

  expect(editor.loadError.value).toContain('YAML');
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
      expect(editor.unsavedChangesProblem.value, `${item.path.join('.')}: ${JSON.stringify(value)}`).toBeUndefined();
      expect(row(editor, item.path.join('.')), item.path.join('.')).toMatchObject({ value, unsaved: true });
    }
  }
});

test('every setting another depends on comes before it in its section, with the values it depends on among its choices', () => {
  for (const section of settingSections) {
    const fields = section.groups.flatMap((group) => group.fields);
    fields.forEach((item, index) => {
      const condition = item.dependsOn;
      if (condition === undefined) {
        return;
      }
      const above = fields.slice(0, index).find((other) => other.key === condition.otherSettingKeyInSameSection);
      expect(above, item.path.join('.')).toBeDefined();
      const choices = above?.options.map((option) => JSON.stringify(option.value));
      for (const value of condition.values) {
        expect(choices, item.path.join('.')).toContain(JSON.stringify(value));
      }
    });
  }
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every setting under a node of the profile's JSON Schema, by path: the properties that have none of their own. */
function schemaSettings(node: unknown, path: string): string[] {
  const branches = isRecord(node) ? [node, ...['anyOf', 'oneOf', 'allOf'].flatMap((key) => node[key] ?? [])] : [];
  const properties = branches.flatMap((branch) =>
    isRecord(branch) && isRecord(branch['properties']) ? Object.entries(branch['properties']) : [],
  );
  return properties.length === 0
    ? [path]
    : properties.flatMap(([key, value]) => schemaSettings(value, `${path}.${key}`));
}

test('every setting a profile can hold is one the editor offers, or one it leaves to the YAML', () => {
  const schema = profileFileJsonSchema()['properties'];
  const held = new Set(
    ['repository', 'merge', 'security', 'actions', 'pages'].flatMap((section) =>
      schemaSettings(isRecord(schema) ? schema[section] : undefined, section),
    ),
  );
  const offered = new Set(
    settingSections.flatMap((section) =>
      section.groups.flatMap((group) => group.fields.map((item) => item.path.join('.'))),
    ),
  );

  // The editor offers a setting by its own path, or as a part of one it shows whole, such as a feature's status.
  const offers = (setting: string): boolean =>
    [...offered].some((field) => setting === field || setting.startsWith(`${field}.`));

  // A setting new to the schema fails here until the editor offers it or this list names it.
  expect([...held].filter((setting) => !offers(setting)).sort()).toEqual([
    'actions.oidc_customization_sub.include_claim_keys',
    'repository.topics',
    'security.code_quality_setup.languages',
    'security.code_scanning_default_setup.languages',
    'security.dependabot_runner_settings.runner_labels',
    'security.security_and_analysis.secret_scanning_delegated_bypass_options.reviewers',
  ]);
  expect(
    [...offered].filter((field) => ![...held].some((setting) => setting === field || setting.startsWith(`${field}.`))),
  ).toEqual([]);
});

const entries = `rulesets:
  # Protects the default branch.
  - name: Main
    target: branch
    enforcement: active
    rules:
      - type: deletion
labels:
  - name: bug
    color: d73a4a
`;

function entry(editor: ProfileEditor, list: EntryList, name: string): EntryRow {
  const found = editor.entries.value[list].find((row) => row.entry?.['name'] === name || row.savedName === name);
  if (found === undefined) {
    throw new Error(`The editor has no ${list} entry ${name}.`);
  }
  return found;
}

test('lists each ruleset, environment, and label with the profile that sets it', async () => {
  const editor = await opened({
    'base.yaml': entries,
    'web.yaml': 'extends: base.yaml\nenvironments:\n  - name: production\n    wait_timer: 5\n',
  });

  expect(entry(editor, 'rulesets', 'Main')).toMatchObject({
    source: 'base.yaml',
    unsaved: false,
    applyProblem: undefined,
  });
  expect(entry(editor, 'environments', 'production')).toMatchObject({ source: 'here', savedName: 'production' });
  expect(editor.entries.value.labels.map((row) => row.entry?.['name'])).toEqual(['bug']);
});

test('an entry is written whole, keeps what the editor did not touch, and renames in place', async () => {
  const editor = await opened({ 'web.yaml': entries });
  const main = entry(editor, 'rulesets', 'Main');

  await editor.changeEntry(main, { ...main.entry, name: 'Default', enforcement: 'evaluate' });
  expect(entry(editor, 'rulesets', 'Default')).toMatchObject({ savedName: 'Main', unsaved: true });
  expect(editor.canSave.value).toBe(true);
  await editor.save(write);

  const text = await readFile('/profiles/web.yaml', 'utf8');
  expect(text).toContain('name: Default');
  expect(text).toContain('enforcement: evaluate');
  expect(text).toContain('type: deletion');
  expect(text).not.toContain('name: Main');
  expect(editor.dirty.value).toBe(false);
  expect(entry(editor, 'rulesets', 'Default')).toMatchObject({ savedName: 'Default', unsaved: false });
});

test('a bypass list is written as set, and a mode GitHub would refuse holds the save', async () => {
  const editor = await opened({ 'web.yaml': entries });
  const main = entry(editor, 'rulesets', 'Main');
  const listed = withBypassActorAdded(withBypassListManaged(main.entry ?? {}, true, main.saved), deployKeysBypassActor);

  await editor.changeEntry(main, withBypassMode(listed, new Set(['DeployKey']), 'exempt'));
  expect(entry(editor, 'rulesets', 'Main').applyProblem).toBeUndefined();
  await editor.save(write);
  expect(await readFile('/profiles/web.yaml', 'utf8')).toMatch(
    /bypass_actors:\n\s+- actor_id: null\n\s+actor_type: DeployKey\n\s+bypass_mode: exempt/u,
  );

  const saved = entry(editor, 'rulesets', 'Main');
  await editor.changeEntry(saved, {
    ...saved.entry,
    bypass_actors: [{ actor_id: null, actor_type: 'DeployKey', bypass_mode: 'pull_request' }],
  });
  expect(entry(editor, 'rulesets', 'Main').applyProblem).toBe(
    'A bypass is set to Pull requests only where GitHub doesn’t allow it.',
  );
  expect(editor.canSave.value).toBe(false);
});

test('a new entry needs a name no other has, in any case, before it can be saved', async () => {
  const editor = await opened({ 'web.yaml': entries });

  const key = await editor.addEntry('labels', { name: '' });
  const added = (): EntryRow => {
    const found = editor.entries.value.labels.find((row) => row.key === key);
    if (found === undefined) {
      throw new Error('The new label should be listed.');
    }
    return found;
  };
  expect(added()).toMatchObject({ applyProblem: 'Give it a name.', savedName: undefined, source: undefined });
  expect(editor.canSave.value).toBe(false);

  await editor.changeEntry(added(), { name: 'BUG' });
  expect(added().applyProblem).toBe('The profile already has a label named BUG.');

  await editor.changeEntry(added(), { name: ' docs ', color: '0075ca' });
  expect(added().applyProblem).toBeUndefined();
  await editor.save(write);
  expect(await readFile('/profiles/web.yaml', 'utf8')).toMatch(/- name: docs\n\s+color: 0075ca/u);
  expect(editor.entries.value.labels.map((row) => row.savedName)).toEqual(['bug', 'docs']);
});

test('an entry taken out stops being named here, and can be put back before the save', async () => {
  const editor = await opened({ 'web.yaml': entries });

  await editor.takeOut(entry(editor, 'labels', 'bug'));
  expect(entry(editor, 'labels', 'bug')).toMatchObject({ entry: undefined, unsaved: true });
  await editor.resetEntry(entry(editor, 'labels', 'bug'));
  expect(editor.dirty.value).toBe(false);

  await editor.takeOut(entry(editor, 'labels', 'bug'));
  await editor.save(write);
  expect(await readFile('/profiles/web.yaml', 'utf8')).not.toContain('bug');
  expect(editor.entries.value.labels).toEqual([]);

  // A new entry taken out is simply let go.
  await editor.addEntry('labels', { name: 'later' });
  await editor.takeOut(entry(editor, 'labels', 'later'));
  expect(editor.dirty.value).toBe(false);
});

test('a pending entry removal and setting change survive an invalid file and its YAML repair', async () => {
  const editor = await opened({ 'web.yaml': entries });
  await editor.takeOut(entry(editor, 'labels', 'bug'));
  await editor.set(field('repository.has_issues'), false);
  await writeFile('/profiles/web.yaml', `${entries}repository: [\n`);
  await editor.load();
  const repair = editor.repair.value;
  if (repair === undefined) {
    throw new Error('An invalid profile should offer its YAML for repair.');
  }
  await repair.type(entries);
  await editor.save(write);
  expect(editor.loaded.value).toBe(true);
  expect(editor.dirty.value).toBe(true);
  expect(entry(editor, 'labels', 'bug')).toMatchObject({ entry: undefined, unsaved: true });
  expect(row(editor, 'repository.has_issues')).toMatchObject({ value: false, unsaved: true });
  await editor.save(write);
  expect(await readFile('/profiles/web.yaml', 'utf8')).not.toContain('name: bug');
  expect(await readFile('/profiles/web.yaml', 'utf8')).toContain('has_issues: false');
});

test('an entry the engine refuses says why and holds the save back', async () => {
  const editor = await opened({ 'web.yaml': entries });
  const bug = entry(editor, 'labels', 'bug');

  await editor.changeEntry(bug, { ...bug.entry, description: 5 });

  expect(entry(editor, 'labels', 'bug').applyProblem).toBeDefined();
  expect(editor.canSave.value).toBe(false);
  expect(editor.problemsBlockingSave.value).toEqual([
    expect.objectContaining({
      name: 'bug',
      where: 'Labels',
      place: { kind: 'entry', row: entry(editor, 'labels', 'bug'), field: 'entry' },
    }),
  ]);
  await editor.changeEntry(entry(editor, 'labels', 'bug'), { ...bug.entry });
  expect(editor.dirty.value).toBe(false);
});

test("changing a base profile's entry writes it here, over the base's", async () => {
  const editor = await opened({ 'base.yaml': entries, 'web.yaml': 'extends: base.yaml\n' });
  const main = entry(editor, 'rulesets', 'Main');

  await editor.changeEntry(main, { ...main.entry, enforcement: 'disabled' });
  await editor.save(write);

  expect(await readFile('/profiles/web.yaml', 'utf8')).toContain('enforcement: disabled');
  expect(await readFile('/profiles/base.yaml', 'utf8')).toBe(entries);
  expect(entry(editor, 'rulesets', 'Main')).toMatchObject({ source: 'here', unsaved: false });
});

test('an entry changed again while a save runs stays unsaved under its new name', async () => {
  const editor = await opened({ 'web.yaml': entries });
  const main = entry(editor, 'rulesets', 'Main');
  await editor.changeEntry(main, { ...main.entry, name: 'Default' });
  const held = Promise.withResolvers<undefined>();

  const saving = editor.save(async (work) => {
    await held.promise;
    await work();
  });
  await editor.changeEntry(entry(editor, 'rulesets', 'Default'), {
    ...main.entry,
    name: 'Default',
    enforcement: 'evaluate',
  });
  held.resolve(undefined);
  await saving;

  expect(await readFile('/profiles/web.yaml', 'utf8')).toContain('enforcement: active');
  expect(editor.dirty.value).toBe(true);
  expect(entry(editor, 'rulesets', 'Default')).toMatchObject({ savedName: 'Default', unsaved: true });
  expect(entry(editor, 'rulesets', 'Default').entry?.['enforcement']).toBe('evaluate');
  await editor.save(write);
  const text = await readFile('/profiles/web.yaml', 'utf8');
  expect(text).toContain('enforcement: evaluate');
  expect(text.match(/- name:/gu)).toHaveLength(2);
});

test('a ruleset that requires status checks and names none is held back', async () => {
  const editor = await opened({ 'web.yaml': entries });
  const main = entry(editor, 'rulesets', 'Main');

  await editor.changeEntry(main, { ...main.entry, rules: [{ type: 'required_status_checks' }] });
  expect(entry(editor, 'rulesets', 'Main').applyProblem).toBe('Name at least one status check that must pass.');
  expect(editor.canSave.value).toBe(false);

  await editor.changeEntry(entry(editor, 'rulesets', 'Main'), {
    ...main.entry,
    rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'quality' }] } }],
  });
  expect(entry(editor, 'rulesets', 'Main').applyProblem).toBeUndefined();
  expect(editor.canSave.value).toBe(true);
});

test('an entry that changed elsewhere since its change is held back until the user keeps theirs or resets', async () => {
  const editor = await opened({ 'web.yaml': entries });
  const main = entry(editor, 'rulesets', 'Main');
  await editor.changeEntry(main, { ...main.entry, enforcement: 'evaluate' });

  // A sync brings in a teammate's change to the same ruleset.
  const theirs = entries.replace('      - type: deletion', '      - type: deletion\n      - type: non_fast_forward');
  await writeFile('/profiles/web.yaml', theirs);
  await editor.load();

  expect(entry(editor, 'rulesets', 'Main')).toMatchObject({ outOfDate: true, unsaved: true });
  expect(entry(editor, 'rulesets', 'Main').applyProblem).toContain('changed elsewhere');
  expect(editor.canSave.value).toBe(false);

  await editor.keepEntry(entry(editor, 'rulesets', 'Main'));
  expect(entry(editor, 'rulesets', 'Main')).toMatchObject({ outOfDate: false, applyProblem: undefined });
  await editor.save(write);
  const text = await readFile('/profiles/web.yaml', 'utf8');
  expect(text).toContain('enforcement: evaluate');
  expect(text).not.toContain('non_fast_forward');
});

test("a save stops when the file's entry changed after the editor last read it, and writes nothing", async () => {
  const editor = await opened({ 'web.yaml': entries });
  const main = entry(editor, 'rulesets', 'Main');
  await editor.changeEntry(main, { ...main.entry, enforcement: 'evaluate' });
  await editor.set(field('repository.has_wiki'), true);
  const theirs = entries.replace('enforcement: active', 'enforcement: disabled');

  await editor.save(async (work) => {
    // The sync that runs before the save's write brings the change in.
    await writeFile('/profiles/web.yaml', theirs);
    await work();
  });

  expect(await readFile('/profiles/web.yaml', 'utf8')).toBe(theirs);
  expect(editor.saveError.value).toContain('changed elsewhere');
  expect(entry(editor, 'rulesets', 'Main')).toMatchObject({ outOfDate: true });

  await editor.resetEntry(entry(editor, 'rulesets', 'Main'));
  expect(entry(editor, 'rulesets', 'Main').entry?.['enforcement']).toBe('disabled');
  await editor.save(write);
  expect(await readFile('/profiles/web.yaml', 'utf8')).toContain('has_wiki: true');
});

test('a change to an entry that was removed elsewhere stays in view, to add it again or let it go', async () => {
  const editor = await opened({ 'web.yaml': entries });
  const bug = entry(editor, 'labels', 'bug');
  await editor.changeEntry(bug, { ...bug.entry, color: '5319e7' });
  await editor.takeOut(entry(editor, 'rulesets', 'Main'));

  await writeFile('/profiles/web.yaml', 'repository:\n  has_wiki: false\n');
  await editor.load();

  // Taking out what is already gone has nothing left to do.
  expect(editor.entries.value.rulesets).toEqual([]);
  const orphan = entry(editor, 'labels', 'bug');
  expect(orphan).toMatchObject({ outOfDate: true, saved: undefined, savedName: 'bug' });
  expect(orphan.applyProblem).toContain('removed elsewhere');
  expect(editor.canSave.value).toBe(false);

  await editor.keepEntry(orphan);
  expect(entry(editor, 'labels', 'bug')).toMatchObject({
    outOfDate: false,
    savedName: undefined,
    applyProblem: undefined,
  });
  await editor.save(write);
  expect(await readFile('/profiles/web.yaml', 'utf8')).toMatch(/color: "?5319e7/u);
});

test('only a changed entry is checked, so a profile the engine takes can always be saved', async () => {
  const editor = await opened({
    'web.yaml':
      'rulesets:\n  - name: CI\n    rules:\n      - type: required_status_checks\n  - name: ci\n    target: tag\n',
  });

  expect(editor.entries.value.rulesets.map((row) => row.applyProblem)).toEqual([undefined, undefined]);
  await editor.set(field('repository.has_wiki'), true);
  expect(editor.canSave.value).toBe(true);

  // Rulesets are told apart by case, so each can change without the other in its way.
  const lower = entry(editor, 'rulesets', 'ci');
  await editor.changeEntry(lower, { ...lower.entry, target: 'branch' });
  expect(entry(editor, 'rulesets', 'ci').applyProblem).toBeUndefined();
  await editor.save(write);
  expect(await readFile('/profiles/web.yaml', 'utf8')).toContain('target: branch');
});

test('removing an entry from repositories keeps what it had for managing it again', async () => {
  const editor = await opened({ 'web.yaml': entries });
  const main = entry(editor, 'rulesets', 'Main');

  await editor.setAbsent(main, true);
  expect(entry(editor, 'rulesets', 'Main').entry).toEqual({ name: 'Main', absent: true });
  await editor.setAbsent(entry(editor, 'rulesets', 'Main'), false);
  expect(editor.dirty.value).toBe(false);

  // One that is new keeps what was filled in, too.
  const key = await editor.addEntry('labels', { name: 'docs', color: '0075ca' });
  const added = (): EntryRow => entry(editor, 'labels', 'docs');
  expect(added().key).toBe(key);
  await editor.setAbsent(added(), true);
  await editor.changeEntry(added(), { name: 'guides', absent: true });
  await editor.setAbsent(entry(editor, 'labels', 'guides'), false);
  expect(entry(editor, 'labels', 'guides').entry).toEqual({ name: 'guides', color: '0075ca' });
});

test('a name typed and put back is no change, and a saved name in use by an unsaved change is not free', async () => {
  const editor = await opened({ 'web.yaml': entries });
  const bug = entry(editor, 'labels', 'bug');

  await editor.changeEntry(bug, { ...bug.entry, name: 'bug ' });
  expect(editor.dirty.value).toBe(false);

  await editor.takeOut(entry(editor, 'labels', 'bug'));
  await editor.addEntry('labels', { name: 'Bug' });
  expect(editor.entries.value.labels.find((row) => row.savedName === undefined)?.applyProblem).toContain(
    'is the saved name of one you renamed or took out',
  );
  expect(editor.canSave.value).toBe(false);
});

test('an entry with a problem holds the save back, while the other changes are still previewed', async () => {
  const editor = await opened({ 'web.yaml': entries });
  await editor.addEntry('labels', { name: '' });

  for (const name of ['merge.allow_merge_commit', 'merge.allow_squash_merge', 'merge.allow_rebase_merge']) {
    await editor.set(field(name), false);
  }

  expect(editor.unsavedChangesProblem.value).toMatch(/merge/iu);
  expect(editor.canSave.value).toBe(false);
});

test('an entry put back to what it was while a save writes it stays changed, and a failed save keeps every change', async () => {
  const editor = await opened({ 'web.yaml': entries });
  const main = entry(editor, 'rulesets', 'Main');
  await editor.changeEntry(main, { ...main.entry, enforcement: 'evaluate' });
  const held = Promise.withResolvers<undefined>();

  const saving = editor.save(async (work) => {
    await held.promise;
    await work();
  });
  await editor.changeEntry(entry(editor, 'rulesets', 'Main'), { ...main.entry });
  held.resolve(undefined);
  await saving;

  expect(await readFile('/profiles/web.yaml', 'utf8')).toContain('enforcement: evaluate');
  expect(entry(editor, 'rulesets', 'Main')).toMatchObject({ unsaved: true, outOfDate: false });
  expect(entry(editor, 'rulesets', 'Main').entry?.['enforcement']).toBe('active');

  await editor.save(() => Promise.reject(new Error('The file is gone.')));
  expect(editor.saveError.value).toBe('The file is gone.');
  expect(entry(editor, 'rulesets', 'Main')).toMatchObject({ unsaved: true });
  expect(editor.canSave.value).toBe(true);

  await editor.resetAll();
  expect(editor.dirty.value).toBe(false);
});

test('a save writes nothing over an entry that changed in its turn, even when its change was reset meanwhile', async () => {
  const editor = await opened({ 'web.yaml': entries });
  const main = entry(editor, 'rulesets', 'Main');
  await editor.changeEntry(main, { ...main.entry, enforcement: 'evaluate' });
  const theirs = entries.replace('enforcement: active', 'enforcement: disabled');
  const held = Promise.withResolvers<undefined>();

  const saving = editor.save(async (work) => {
    await held.promise;
    await writeFile('/profiles/web.yaml', theirs);
    await work();
  });
  await editor.resetEntry(entry(editor, 'rulesets', 'Main'));
  held.resolve(undefined);
  await saving;

  expect(await readFile('/profiles/web.yaml', 'utf8')).toBe(theirs);
  expect(editor.saveError.value).toContain('changed elsewhere');
});

test('an entry taken out and put back while the save runs is still there to put back afterwards', async () => {
  const editor = await opened({ 'web.yaml': entries });
  await editor.takeOut(entry(editor, 'labels', 'bug'));
  const held = Promise.withResolvers<undefined>();

  const saving = editor.save(async (work) => {
    await held.promise;
    await work();
  });
  await editor.resetEntry(entry(editor, 'labels', 'bug'));
  held.resolve(undefined);
  await saving;

  expect(await readFile('/profiles/web.yaml', 'utf8')).not.toContain('bug');
  expect(editor.dirty.value).toBe(true);
  await editor.save(write);
  expect(await readFile('/profiles/web.yaml', 'utf8')).toMatch(/- name: bug\n\s+color: d73a4a/u);
});

test("the order a form leaves an entry's keys in never reads as a change, here or elsewhere", async () => {
  const editor = await opened({ 'web.yaml': entries });
  const main = entry(editor, 'rulesets', 'Main');
  const { enforcement, ...rest } = main.entry ?? {};

  // A form writes a changed key last. Changed and changed back, the entry is as saved.
  await editor.changeEntry(main, { ...rest, enforcement: 'evaluate' });
  await editor.changeEntry(entry(editor, 'rulesets', 'Main'), { ...rest, enforcement });
  expect(editor.dirty.value).toBe(false);

  await editor.changeEntry(main, { ...rest, enforcement: 'evaluate' });
  const held = Promise.withResolvers<undefined>();
  const saving = editor.save(async (work) => {
    await held.promise;
    await work();
  });
  await editor.changeEntry(entry(editor, 'rulesets', 'Main'), { ...rest, enforcement: 'evaluate', target: 'tag' });
  held.resolve(undefined);
  await saving;

  expect(entry(editor, 'rulesets', 'Main')).toMatchObject({ unsaved: true, outOfDate: false, applyProblem: undefined });
  expect(editor.canSave.value).toBe(true);
});

test('a new entry is not written over one of its name that arrived while the save waited', async () => {
  const editor = await opened({ 'web.yaml': entries });
  await editor.addEntry('labels', { name: 'docs', color: '0075ca' });
  const theirs = `${entries}  - name: Docs\n    color: ffffff\n`;
  const held = Promise.withResolvers<undefined>();

  const saving = editor.save(async (work) => {
    await held.promise;
    await writeFile('/profiles/web.yaml', theirs);
    await work();
  });
  // Taken out while the save waits, so only the save's own copy still names it.
  await editor.takeOut(entry(editor, 'labels', 'docs'));
  held.resolve(undefined);
  await saving;

  expect(await readFile('/profiles/web.yaml', 'utf8')).toBe(theirs);
  expect(editor.saveError.value).toContain('changed elsewhere');
});

test('what the installation was not given is turned off, and said once where it covers the most', async () => {
  const editor = await opened({ 'web.yaml': base });
  editor.useInstallation({
    status: 'installed',
    permissions: { administration: 'write', contents: 'write', metadata: 'read', security_events: 'read' },
    settings_url: 'https://github.com/settings/installations/1',
  });

  // All of a section needs it, so the section says it and its rows don't.
  expect(section(editor, 'pages')?.missingPermissionsEverySettingShares).toEqual(['Pages']);
  expect(section(editor, 'pages')?.groups.every((item) => item.missingPermissions.length === 0)).toBe(true);
  expect(row(editor, 'pages.build_type')).toMatchObject({
    missingPermissions: ['Pages'],
    missingPermissionsItsGroupAndSectionDoNotName: [],
  });

  // A group's every row needs it, so the group says it.
  expect(section(editor, 'actions')?.missingPermissionsEverySettingShares).toEqual([]);
  expect(group(editor, 'actions', 'OpenID Connect')?.missingPermissions).toEqual(['Actions']);
  expect(
    row(editor, 'actions.oidc_customization_sub.use_default')?.missingPermissionsItsGroupAndSectionDoNotName,
  ).toEqual([]);

  // One row among others that need nothing more says it itself.
  expect(group(editor, 'actions', 'Artifacts and caches')?.missingPermissions).toEqual([]);
  expect(row(editor, 'actions.max_cache_size_gb')).toMatchObject({
    missingPermissions: ['Actions'],
    missingPermissionsItsGroupAndSectionDoNotName: ['Actions'],
  });
  expect(row(editor, 'actions.artifact_and_log_retention.days')?.missingPermissions).toEqual([]);
  expect(row(editor, 'repository.has_wiki')?.missingPermissions).toEqual([]);

  expect(editor.entryListMissingPermissions.value).toEqual({
    actions_policies: [],
    rulesets: [],
    environments: ['Actions'],
    labels: ['Issues'],
  });
  expect(editor.installationSettingsUrl.value).toBe('https://github.com/settings/installations/1');

  editor.search('OIDC');
  expect(editor.found.value.find((item) => item.group.title === 'OpenID Connect')?.missingPermissions).toEqual([
    'Actions',
  ]);
});

test('what every setting lacks is said above them, and only the rest on a setting', async () => {
  const editor = await opened({ 'web.yaml': base });
  editor.useInstallation({ status: 'installed', permissions: { metadata: 'read' }, settings_url: null });

  expect(section(editor, 'pages')?.missingPermissionsEverySettingShares).toEqual(['Pages', 'Administration']);
  // OIDC needs only Actions, so Administration is named by each group that needs it.
  expect(section(editor, 'actions')?.missingPermissionsEverySettingShares).toEqual([]);
  expect(group(editor, 'actions', 'OpenID Connect')?.missingPermissions).toEqual(['Actions']);
  expect(group(editor, 'actions', 'Artifacts and caches')?.missingPermissions).toEqual(['Administration']);
  expect(row(editor, 'actions.max_cache_size_gb')).toMatchObject({
    missingPermissions: ['Actions', 'Administration'],
    missingPermissionsItsGroupAndSectionDoNotName: ['Actions'],
  });
  expect(row(editor, 'actions.artifact_and_log_retention.days')?.missingPermissionsItsGroupAndSectionDoNotName).toEqual(
    [],
  );

  editor.search('Build from');
  expect(
    editor.found.value.find((item) => item.tab === section(editor, 'pages')?.section.name)?.missingPermissions,
  ).toEqual(['Pages', 'Administration']);
});

test('an editor with no installation to go by turns nothing off', async () => {
  const editor = await opened({ 'web.yaml': base });

  expect(editor.sections.value.every((item) => item.missingPermissionsEverySettingShares.length === 0)).toBe(true);
  expect(row(editor, 'pages.build_type')?.missingPermissions).toEqual([]);
  expect(editor.installationSettingsUrl.value).toBeNull();
});

test('lists each thing that holds the save back, by tab, with where it is', async () => {
  const editor = await opened({ 'web.yaml': `${base}${entries}` });
  const bug = entry(editor, 'labels', 'bug');

  await editor.type(field('repository.default_branch'), 'main dev');
  await editor.changeEntry(bug, { ...bug.entry, color: 'not-a-color' });

  expect(editor.canSave.value).toBe(false);
  expect(
    editor.problemsBlockingSave.value.map(({ name, where, tab, message, place }) => ({
      name,
      where,
      tab,
      message,
      kind: place.kind,
    })),
  ).toEqual([
    {
      name: 'Default branch',
      where: 'Repository › About',
      tab: 'repository',
      message: "A branch name can't have spaces.",
      kind: 'setting',
    },
    {
      name: 'bug',
      where: 'Labels',
      tab: 'labels',
      message: 'The color is six hex digits, such as a2eeef, with or without #.',
      kind: 'entry',
    },
  ]);
  expect(editor.problemCountByTab.value).toEqual(
    new Map([
      ['repository', 1],
      ['labels', 1],
    ]),
  );
  expect(entry(editor, 'labels', 'bug').applyProblemField).toBe('color');

  await editor.resetEverythingBlockingSave();

  expect(editor.problemsBlockingSave.value).toEqual([]);
  expect(editor.dirty.value).toBe(false);
});

test("text that can't be saved in a setting GitHub hides is listed, and named under the one that hides it", async () => {
  const editor = await opened({ 'web.yaml': 'repository:\n  has_pull_requests: true\n' });
  const cap = field('repository.pull_request_creation_cap.max_open_pull_requests');

  await editor.type(cap, 'abc');
  await editor.set(field('repository.has_pull_requests'), false);

  const [problem] = editor.problemsBlockingSave.value;
  expect(problem?.place).toMatchObject({
    kind: 'setting',
    field: cap,
    hiddenWhile: { field: field('repository.has_pull_requests'), value: false },
  });
  expect(row(editor, 'repository.has_pull_requests')?.hiddenWithTextThatCannotBeSaved).toEqual([cap]);
  expect(editor.canSave.value).toBe(false);

  await editor.reset(cap);

  expect(row(editor, 'repository.has_pull_requests')?.hiddenWithTextThatCannotBeSaved).toEqual([]);
  expect(editor.canSave.value).toBe(true);
});

test("typed text is checked by the engine's own rule, in its words", async () => {
  const editor = await opened({ 'web.yaml': base });

  await editor.type(field('repository.default_branch'), 'main');
  expect(row(editor, 'repository.default_branch')?.typedTextProblem).toBeUndefined();
  await editor.type(field('repository.default_branch'), 'release..1');
  expect(row(editor, 'repository.default_branch')?.typedTextProblem).toBe(
    "A branch name can't have two dots in a row.",
  );
});

test("an entry's problem names the field of its form it is in", async () => {
  const editor = await opened({ 'web.yaml': entries });
  const key = await editor.addEntry('environments', { name: 'production' });
  const production = (): EntryRow => {
    const found = editor.entries.value.environments.find((item) => item.key === key);
    if (found === undefined) {
      throw new Error('The new environment is gone.');
    }
    return found;
  };

  await editor.changeEntry(production(), {
    name: 'production',
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    branch_policies: [{ name: 'main' }, { name: 'v 1', type: 'tag' }],
  });
  expect(production()).toMatchObject({
    applyProblem: "v 1: a pattern can't have spaces.",
    applyProblemField: 'tag-patterns',
  });

  await editor.changeEntry(production(), { ...production().entry, name: '' });
  expect(production()).toMatchObject({ applyProblem: 'Give it a name.', applyProblemField: 'name' });

  const main = entry(editor, 'rulesets', 'Main');
  await editor.changeEntry(main, {
    ...main.entry,
    rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [] } }],
  });
  expect(entry(editor, 'rulesets', 'Main')).toMatchObject({ applyProblemField: 'status-checks' });
  expect(editor.problemCountByTab.value).toEqual(
    new Map([
      ['rulesets', 1],
      ['environments', 1],
    ]),
  );
});

test.each([
  [{ conditions: { ref_name: { include: ['release/*'], exclude: [] } } }, 'include-patterns'],
  [{ conditions: { ref_name: { include: [], exclude: ['release/*'] } } }, 'exclude-patterns'],
  [{ target: 'tag', conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } } }, 'include-targets'],
  [{ conditions: { ref_name: { include: [], exclude: ['~ALL'] } } }, 'exclude-targets'],
  [
    { target: 'tag', bypass_actors: [{ actor_type: 'RepositoryRole', actor_id: 5, bypass_mode: 'pull_request' }] },
    'bypass-list',
  ],
])('routes a ruleset problem to its own field: %j', async (changed, expectedField) => {
  const editor = await opened({ 'web.yaml': entries });
  const main = entry(editor, 'rulesets', 'Main');

  await editor.changeEntry(main, { ...main.entry, ...changed });

  expect(entry(editor, 'rulesets', 'Main')).toMatchObject({ applyProblemField: expectedField });
  expect(editor.problemsBlockingSave.value[0]?.place).toMatchObject({ kind: 'entry', field: expectedField });
  expect(editor.canSave.value).toBe(false);
});

test('invalid typed text leaves a pending save preview behind', async () => {
  await mkdir('/profiles', { recursive: true });
  await writeFile('/profiles/web.yaml', 'repository:\n  default_branch: main\n');
  const held = Promise.withResolvers<undefined>();
  let holdPreview = false;
  const editor = new ProfileEditor('/profiles/web.yaml', undefined, {
    canHoldDrafts: true,
    resolve: resolveProfile,
    edit: editProfile,
    preview: async (file, changes) => {
      const result = await previewProfile(file, changes);
      if (holdPreview) {
        await held.promise;
      }
      return result;
    },
  });
  await editor.load();
  await editor.type(field('repository.default_branch'), 'develop');
  holdPreview = true;
  const opening = editor.openPreview();

  await editor.type(field('repository.default_branch'), 'main dev');
  held.resolve(undefined);
  await opening;

  expect(editor.canSave.value).toBe(false);
  expect(editor.preview.value).toBeUndefined();
});

test('a saved invalid draft offers no reset until it has an unsaved change', async () => {
  const editor = await opened({ 'web.yaml': 'labels:\n  - name: unfinished\n    draft: true\n    color: invalid\n' });
  expect(editor.problemsBlockingSave.value[0]).toMatchObject({ canReset: false });

  const label = entry(editor, 'labels', 'unfinished');
  await editor.changeEntry(label, { ...label.entry, color: 'still-invalid' });
  expect(editor.problemsBlockingSave.value[0]).toMatchObject({ canReset: true });

  await editor.resetEverythingBlockingSave();
  expect(editor.problemsBlockingSave.value[0]).toMatchObject({ canReset: false });
  expect(entry(editor, 'labels', 'unfinished').entry?.['color']).toBe('invalid');
});

test.each([
  ['merge', 'merge: { allow_merge_commit: false }', 'merge.merge_commit_title', 'PR_TITLE'],
  ['squash', 'merge: { allow_squash_merge: false }', 'merge.squash_merge_commit_message', 'PR_BODY'],
])('omits %s settings disabled by a base when saving', async (_name, baseText, key, value) => {
  const original = 'extends: base.yaml\n';
  const editor = await opened({ 'base.yaml': baseText, 'web.yaml': original });

  await editor.set(field(key), value);

  expect(editor.unsavedChangesProblem.value).toBeUndefined();
  expect(editor.canSave.value).toBe(true);
  await editor.save(write);
  expect(await readFile('/profiles/web.yaml', 'utf8')).toBe(original);
  expect(await readFile('/profiles/base.yaml', 'utf8')).toBe(baseText);
  expect(editor.dirty.value).toBe(false);
});

test.each(['code_scanning_default_setup', 'code_quality_setup'])(
  'validates configured %s with Actions disabled by a base before saving',
  async (key) => {
    const original = 'extends: base.yaml\n';
    const editor = await opened({ 'base.yaml': 'actions: { enabled: false }', 'web.yaml': original });
    const setup = field(`security.${key}.state`);

    await editor.set(setup, 'configured');

    expect(editor.unsavedChangesProblem.value).toContain('Actions');
    expect(editor.problemsBlockingSave.value.some((problem) => problem.message.includes('Actions'))).toBe(true);
    expect(editor.canSave.value).toBe(false);
    expect(editor.canSaveAsDraft.value).toBe(true);
    await editor.save(write);
    expect(await readFile('/profiles/web.yaml', 'utf8')).toBe(original);

    await editor.reset(setup);
    expect(editor.unsavedChangesProblem.value).toBeUndefined();
  },
);

test('a setting or entry named by its section and key leads to where the editor shows it', async () => {
  const editor = await opened({
    'web.yaml':
      'merge:\n  allow_merge_commit: false\n  merge_commit_title: PR_TITLE\nactions:\n  allowed_actions: selected\nlabels:\n  - name: Bug\n    color: d73a4a\nenvironments:\n  - name: Production\n',
  });

  // A hidden setting leads to the one whose value hides it, since that is what brings it back.
  expect(editor.placeOf('merge', 'merge_commit_title')).toEqual({
    kind: 'setting',
    tab: 'merge',
    field: field('merge.allow_merge_commit'),
  });
  expect(editor.placeOf('actions', 'selected_actions.patterns_allowed.0')).toEqual({
    kind: 'setting',
    tab: 'actions',
    field: field('actions.selected_actions.patterns_allowed'),
  });
  expect(editor.placeOf('security', 'security_and_analysis.secret_scanning.status')).toEqual({
    kind: 'setting',
    tab: 'security',
    field: field('security.security_and_analysis.secret_scanning'),
  });
  expect(editor.placeOf('labels', 'Bug')).toMatchObject({ kind: 'entry', tab: 'labels', row: { savedName: 'Bug' } });
  expect(editor.placeOf('environments', 'production')).toMatchObject({
    kind: 'entry',
    row: { savedName: 'Production' },
  });
  expect(editor.placeOf('labels', 'gone')).toEqual({ kind: 'tab', tab: 'labels' });
  expect(editor.placeOf('nothing', 'here')).toBeUndefined();
});

test('a problem in the profile file leads to its setting, its entry, or its own notice', async () => {
  const names = (editor: ProfileEditor) =>
    editor.configurationProblems.value.map((problem) => {
      const place = editor.placeOfConfigurationProblem(problem);
      return [place.kind, nameOfPlace(place)];
    });

  const named = await opened({ 'web.yaml': 'repository:\n  has_wiki: broken\nlabels: [{ name: bug, color: nope }]\n' });
  expect(names(named)).toEqual([
    ['setting', 'Wiki in Repository'],
    ['entry', 'Label "bug"'],
  ]);
  const unreadable = await opened({ 'other.yaml': 'labels: [42]\n' }, 'other.yaml');
  expect(names(unreadable)).toEqual([['configuration', 'labels.0']]);
  // A base profile's entry is not the entry at the same position here.
  const extending = await opened(
    {
      'base.yaml': 'labels: [{ name: x, color: nope }]\n',
      'web.yaml': 'extends: base.yaml\nlabels: [{ name: bug, color: d73a4a }]\n',
    },
    'web.yaml',
  );
  expect(names(extending)[0]).toEqual(['configuration', 'labels.0.color']);
});
