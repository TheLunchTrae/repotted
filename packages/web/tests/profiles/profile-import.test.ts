import { readProfileImport, resolveProfile } from '@repotted/core';
import { afterEach, expect, test } from 'vitest';
import { parse } from 'yaml';

import { saveStagedImport, stageProfileImport } from '../../src/app/profiles/profile-import.js';
import * as files from '../../src/engine/files.js';

afterEach(async () => {
  await files.rm('/', { recursive: true });
});

const folder = '/profiles';
const staging = '/imports';
const exported = [
  'references:',
  '  rulesets:',
  '    - ../definitions/ruleset/main.yaml',
  'repository:',
  '  has_wiki: false',
  'bundled:',
  '  ../definitions/ruleset/main.yaml:',
  '    kind: ruleset',
  '    rulesets:',
  '      - name: Main',
  '        enforcement: active',
  '',
].join('\n');

async function write(file: string, text: string): Promise<void> {
  await files.mkdir(file.slice(0, file.lastIndexOf('/')), { recursive: true });
  await files.writeFile(file, text);
}

async function stage(choice: 'reusable' | 'inside', names?: Record<string, string>) {
  return stageProfileImport({
    folder,
    staging,
    destination: '/profiles/apps/service.yaml',
    imported: readProfileImport(exported),
    choice,
    ...(names === undefined ? {} : { names }),
  });
}

const expected = {
  repository: { has_wiki: false },
  rulesets: [{ name: 'Main', enforcement: 'active' }],
};

test('reusable definitions resolve while staged and are saved to their library with the profile', async () => {
  const staged = await stage('reusable');
  expect(staged.definitions.map((item) => item.state)).toEqual(['new']);
  expect((await resolveProfile(staged.file)).profile).toMatchObject(expected);
  await expect(files.readFile('/profiles/definitions/ruleset/main.yaml', 'utf8')).rejects.toThrow('ENOENT');

  await saveStagedImport(staged);
  const saved: unknown = parse(await files.readFile('/profiles/apps/service.yaml', 'utf8'));
  expect(saved).toEqual({
    references: { rulesets: ['../definitions/ruleset/main.yaml'] },
    repository: { has_wiki: false },
  });
  expect((await resolveProfile('/profiles/apps/service.yaml')).profile).toMatchObject(expected);
  await expect(files.readdir(staging, { withFileTypes: true })).rejects.toThrow('ENOENT');
});

test('a definition already there with the same settings is used rather than copied', async () => {
  await write(
    '/profiles/definitions/ruleset/Main.yaml',
    'kind: ruleset\nrulesets: [{ name: Main, enforcement: active }]\n',
  );
  const staged = await stage('reusable');
  expect(staged.definitions.map((item) => [item.state, item.file])).toEqual([
    ['same', '/profiles/definitions/ruleset/Main.yaml'],
  ]);
  await saveStagedImport(staged);
  expect(parse(await files.readFile('/profiles/apps/service.yaml', 'utf8'))).toMatchObject({
    references: { rulesets: ['../definitions/ruleset/Main.yaml'] },
  });
});

test('a taken name refuses to save until the definition is renamed', async () => {
  await write(
    '/profiles/definitions/ruleset/main.yaml',
    'kind: ruleset\nrulesets: [{ name: Main, enforcement: disabled }]\n',
  );
  const staged = await stage('reusable');
  expect(staged.definitions[0]?.state).toBe('taken');
  await expect(saveStagedImport(staged)).rejects.toThrow('Rename main');
  await expect(files.readFile('/profiles/apps/service.yaml', 'utf8')).rejects.toThrow('ENOENT');

  const renamed = await stage('reusable', { '../definitions/ruleset/main.yaml': 'imported main' });
  await saveStagedImport(renamed);
  expect(parse(await files.readFile('/profiles/definitions/ruleset/main.yaml', 'utf8'))).toMatchObject({
    rulesets: [{ enforcement: 'disabled' }],
  });
  expect((await resolveProfile('/profiles/apps/service.yaml')).profile).toMatchObject(expected);
});

test('definitions kept inside are written into the profile alone', async () => {
  const staged = await stage('inside');
  expect(staged.definitions).toEqual([]);
  await saveStagedImport(staged);
  const saved: unknown = parse(await files.readFile('/profiles/apps/service.yaml', 'utf8'));
  expect(saved).not.toHaveProperty('references');
  expect((await resolveProfile('/profiles/apps/service.yaml')).profile).toMatchObject(expected);
  await expect(files.readdir('/profiles/definitions', { withFileTypes: true })).rejects.toThrow('ENOENT');
});

test('a profile already at the destination is kept, and the definitions written for it are taken back', async () => {
  const staged = await stage('reusable');
  await write('/profiles/apps/service.yaml', 'repository: { has_issues: true }\n');
  await expect(saveStagedImport(staged)).rejects.toThrow('apps/service.yaml is already there.');
  expect(await files.readFile('/profiles/apps/service.yaml', 'utf8')).toBe('repository: { has_issues: true }\n');
  await expect(files.readFile('/profiles/definitions/ruleset/main.yaml', 'utf8')).rejects.toThrow('ENOENT');
});
