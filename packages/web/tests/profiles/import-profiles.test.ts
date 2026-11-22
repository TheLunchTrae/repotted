import { resolveProfile } from '@repotted/core';
import { afterEach, expect, test } from 'vitest';
import { parse } from 'yaml';

import { FakeGitRepository } from '../../../core/tests/support/fake-git.js';
import { settingSections } from '../../src/app/profile-editor/setting-fields.js';
import { Profiles } from '../../src/app/profiles/profiles.js';
import * as files from '../../src/engine/files.js';

afterEach(async () => {
  await files.rm('/', { recursive: true });
});

async function setup(): Promise<Profiles> {
  const profiles = new Profiles(
    new FakeGitRepository(),
    { read: () => undefined, write: () => undefined },
    () => undefined,
  );
  await profiles.refresh();
  return profiles;
}

const exported = [
  'references:',
  '  environments:',
  '    - ../definitions/environment/production.yaml',
  'repository:',
  '  has_issues: true',
  'bundled:',
  '  ../definitions/environment/production.yaml:',
  '    kind: environment',
  '    environments:',
  '      - name: production',
  '        wait_timer: 15',
  '',
].join('\n');

const hasWiki = settingSections
  .flatMap((section) => section.groups.flatMap((group) => group.fields))
  .find((field) => field.path.join('.') === 'repository.has_wiki')!;

test('an imported profile is added only on save, with its definitions saved as reusable', async () => {
  const profiles = await setup();
  expect(await profiles.startImport('service.yaml', exported)).toBeUndefined();
  expect(profiles.importing.value?.editor).toBeUndefined();
  expect((await profiles.importedDefinitions()).map((item) => item.state)).toEqual(['new']);

  expect(await profiles.chooseImport('reusable')).toBeUndefined();
  const editor = profiles.importing.value!.editor!;
  expect(editor.loaded.value).toBe(true);
  await editor.set(hasWiki, false);
  expect(profiles.listings.value).toEqual([]);

  expect(await profiles.saveImport('service', '')).toBeUndefined();
  expect(profiles.importing.value).toBeUndefined();
  const saved = profiles.listings.value.find((listing) => listing.name === 'service')!;
  expect(parse(await files.readFile(saved.file, 'utf8'))).toEqual({
    references: { environments: ['definitions/environment/production.yaml'] },
    repository: { has_issues: true, has_wiki: false },
  });
  expect((await resolveProfile(saved.file)).profile.environments).toEqual([{ name: 'production', wait_timer: 15 }]);
  expect(profiles.definitions.value.map((listing) => listing.name)).toEqual(['production']);
});

test('an import saved as a draft keeps its changes in the draft', async () => {
  const profiles = await setup();
  await profiles.startImport('service.yaml', exported);
  await profiles.chooseImport('inside');
  await profiles.importing.value!.editor!.set(hasWiki, false);
  expect(await profiles.saveImport('service', '', 'draft')).toBeUndefined();
  const saved = profiles.listings.value.find((listing) => listing.name === 'service')!;
  const resolved = await resolveProfile(saved.file);
  expect(resolved.drafts.repository).toEqual({ has_wiki: false });
  expect(resolved.profile.environments).toEqual([{ name: 'production', wait_timer: 15 }]);
  expect(profiles.definitions.value).toEqual([]);
});

test('an import keeps the profile already there and stays open to be renamed', async () => {
  const profiles = await setup();
  await profiles.create({ name: 'service', folder: '', start: { kind: 'empty' }, ownerType: undefined });
  await profiles.startImport('service.yaml', exported);
  await profiles.chooseImport('inside');
  expect(await profiles.saveImport('service', '')).toBe('service.yaml is already in the profiles folder.');
  expect(profiles.importing.value?.editor).toBeDefined();
  expect(await profiles.saveImport('service copy', '')).toBeUndefined();
});

test('a library takes only its own kind of file', async () => {
  const profiles = await setup();
  expect(await profiles.startImport('service.yaml', exported, 'ruleset')).toBe('Import a ruleset here.');
  expect(await profiles.startImport('prod.yaml', 'kind: environment\nenvironments: [{ name: prod }]\n')).toBe(
    'This is a reusable definition. Import it from its own page.',
  );
  expect(profiles.importing.value).toBeUndefined();
});
