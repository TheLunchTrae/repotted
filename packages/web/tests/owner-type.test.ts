import { resolveProfile } from '@repotted/core';
import { afterEach, expect, test } from 'vitest';

import { ProfileEditor, type SettingRow } from '../src/app/profile-editor.js';
import { type SettingField, settingSections } from '../src/app/setting-fields.js';
import { mkdir, readFile, rm, writeFile } from '../src/engine/files.js';

afterEach(async () => {
  await rm('/', { recursive: true });
});

const file = '/profiles/web.yaml';
const write = (work: () => Promise<void>): Promise<void> => work();

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

const organization = `owner_type: organization
repository:
  allow_forking: true
  has_wiki: false
actions:
  access_level: organization
rulesets:
  - name: Pushes
    target: push
    enforcement: active
    rules:
      - type: file_path_restriction
        parameters:
          restricted_file_paths: [".github/**"]
drafts:
  pages:
    public: true
`;

test('a profile shows only the settings and choices owners of its type have, and marks who alone has the rest', async () => {
  const personal = await opened({ 'web.yaml': 'owner_type: user\nrepository:\n  has_wiki: false\n' });
  expect(personal.ownerType.value).toBe('user');
  expect(row(personal, 'repository.allow_forking')).toBeUndefined();
  expect(row(personal, 'pages.public')).toBeUndefined();
  expect(row(personal, 'actions.access_level')?.options.map((option) => option.value)).toEqual(['none', 'user']);
  expect(personal.ownerHidden.value).toBeGreaterThan(5);

  const org = await opened({ 'web.yaml': organization });
  expect(row(org, 'repository.allow_forking')).toMatchObject({ value: true, ownerTag: undefined });
  expect(row(org, 'pages.public')).toMatchObject({ ownerTag: 'Enterprise Cloud' });
  expect(row(org, 'actions.access_level')?.options.map((option) => option.value)).toEqual(['none', 'organization']);
  expect(org.ownerHidden.value).toBe(0);

  const any = await opened({ 'web.yaml': 'repository:\n  has_wiki: false\n' });
  expect(any.ownerType.value).toBeUndefined();
  expect(row(any, 'repository.allow_forking')).toMatchObject({ ownerTag: 'Organizations' });
  expect(row(any, 'repository.has_wiki')).toMatchObject({ ownerTag: undefined });
  expect(row(any, 'actions.access_level')?.options).toHaveLength(3);
});

test('changing the type says what it leaves not managed, then leaves exactly that', async () => {
  const editor = await opened({ 'web.yaml': organization });

  expect(editor.ownerLeaving('user')).toEqual([
    'Allow forking',
    'Accessible from',
    'Ruleset Pushes',
    'Who can see the site (draft)',
  ]);
  expect(editor.ownerLeaving('any')).toEqual([]);

  await editor.changeOwnerType(write, 'user');

  expect(editor.saveError.value).toBeUndefined();
  const saved = await resolveProfile(file);
  expect(saved.profile).toEqual({ owner_type: 'user', repository: { has_wiki: false } });
  expect(saved.drafts).toEqual({});
  expect(editor.ownerType.value).toBe('user');
  expect(row(editor, 'repository.allow_forking')).toBeUndefined();

  await editor.changeOwnerType(write, 'any');
  expect((await resolveProfile(file)).profile).toEqual({ repository: { has_wiki: false } });
});

test('the type waits for unsaved changes, and for a file that changed since it was shown', async () => {
  const editor = await opened({ 'web.yaml': organization });

  await editor.set(field('repository.has_wiki'), true);
  expect(editor.canChangeOwnerType.value).toBe(false);
  await editor.changeOwnerType(write, 'user');
  expect(await readFile(file, 'utf8')).toBe(organization);

  await editor.resetAll();
  const elsewhere = organization.replace(
    '  has_wiki: false\n',
    '  has_wiki: false\nsecurity:\n  code_quality_setup:\n    state: configured\n',
  );
  await writeFile(file, elsewhere);
  await editor.changeOwnerType(write, 'user');

  expect(editor.saveError.value).toContain('changed since it was shown');
  expect(await readFile(file, 'utf8')).toBe(elsewhere);
  // The editor shows the file as it is now, so the list is right for the next try.
  expect(editor.ownerLeaving('user')).toHaveLength(5);
});

test("a type from a base profile is that profile's to change, and a base that sets what a type lacks stops the change", async () => {
  const typed = await opened({
    'base.yaml': 'owner_type: organization\n',
    'web.yaml': 'extends: base.yaml\nrepository:\n  has_wiki: false\n',
  });
  expect(typed.ownerType.value).toBe('organization');
  expect(typed.ownerTypeFrom.value).toBe('base.yaml');

  const text = 'extends: base.yaml\nrepository:\n  has_wiki: false\n';
  const editor = await opened({ 'base.yaml': 'repository:\n  allow_forking: true\n', 'web.yaml': text });
  expect(editor.ownerTypeFrom.value).toBeUndefined();

  await editor.changeOwnerType(write, 'user');

  expect(editor.saveError.value).toContain('base.yaml');
  expect(await readFile(file, 'utf8')).toBe(text);
  expect(editor.ownerType.value).toBeUndefined();
});
