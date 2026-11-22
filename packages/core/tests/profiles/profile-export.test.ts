import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, test } from 'vitest';

import { exportProfile, readProfileImport, withBundledInside } from '../../src/profiles/profile-export.js';
import { parseProfile, resolveProfile } from '../../src/profiles/profile.js';

const folder = await realpath(await mkdtemp(path.join(tmpdir(), 'repotted-export-')));
afterAll(async () => rm(folder, { recursive: true, force: true }));
async function write(name: string, text: string): Promise<string> {
  const file = path.join(folder, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  return file;
}

await write(
  'definitions/ruleset/main.yaml',
  'kind: ruleset\nrulesets:\n  - name: Main\n    enforcement: active\n  - name: Main\n    draft: true\n    enforcement: evaluate\n',
);
await write(
  'definitions/ruleset/tags.yaml',
  'kind: ruleset\nrulesets: [{ name: Tags, enforcement: active, target: tag }]\n',
);
await write(
  'definitions/environment/production.yaml',
  'kind: environment\nenvironments: [{ name: production, wait_timer: 15 }]\n',
);
await write(
  'definitions/actions-policy/release.yaml',
  'kind: actions-policy\nactions_policies: [{ name: Release, enforcement: active, rules: [{ type: restrict_action_events, parameters: { allowed_events: [release] } }] }]\n',
);
const consumer = await write(
  'apps/service.yaml',
  [
    '# Service defaults',
    'references:',
    '  rulesets:',
    '    - ../definitions/ruleset/main.yaml',
    '    - ../definitions/ruleset/tags.yaml',
    '  environments:',
    '    - ../definitions/environment/production.yaml',
    '  actions_policies:',
    '    - ../definitions/actions-policy/release.yaml',
    'repository:',
    '  delete_branch_on_merge: true',
    'rulesets:',
    '  - name: Extra',
    '    enforcement: disabled',
    '  - name: Tags',
    '    enforcement: disabled',
    '  - name: Main',
    '    draft: true',
    '    enforcement: disabled',
    'environments:',
    '  - name: Staging',
    '',
  ].join('\n'),
);

describe('an exported profile', () => {
  test('imports somewhere without its definitions and resolves as it did', async () => {
    const exported = await exportProfile(consumer);
    const imported = readProfileImport(exported);
    expect(imported.bundled.map((item) => [item.name, item.kind])).toEqual([
      ['main', 'ruleset'],
      ['tags', 'ruleset'],
      ['production', 'environment'],
      ['release', 'actions-policy'],
    ]);
    const before = await resolveProfile(consumer);
    const elsewhere = await realpath(await mkdtemp(path.join(tmpdir(), 'repotted-import-')));
    try {
      const after = await parseProfile(withBundledInside(imported), elsewhere);
      expect(after.profile).toEqual(before.profile);
      expect(after.drafts).toEqual(before.drafts);
      expect(after.references).toBeUndefined();
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  test('keeps its own text, with its references, when the definitions stay reusable', async () => {
    const imported = readProfileImport(await exportProfile(consumer));
    expect(imported.text).toContain('# Service defaults');
    const elsewhere = path.join(folder, 'apps');
    expect((await parseProfile(imported.text, elsewhere)).profile).toEqual((await resolveProfile(consumer)).profile);
  });

  test('without references is the file as saved', async () => {
    const text = '# Plain\nrepository: { has_wiki: false }\n';
    expect(await exportProfile(await write('plain.yaml', text))).toBe(text);
  });

  test('refuses a reference that cannot be read', async () => {
    const broken = await write('broken.yaml', 'references: { rulesets: [./missing.yaml] }\n');
    await expect(exportProfile(broken)).rejects.toThrow('Cannot read reusable definition ./missing.yaml');
  });
});

describe('an imported file', () => {
  test('refuses a carried definition the profile does not reference', () => {
    expect(() =>
      readProfileImport('bundled:\n  ./main.yaml: { kind: ruleset, rulesets: [{ name: Main }] }\n'),
    ).toThrow("which the profile doesn't reference");
  });

  test('refuses a carried definition of another kind than its reference', () => {
    expect(() =>
      readProfileImport(
        'references: { rulesets: [./prod.yaml] }\nbundled:\n  ./prod.yaml: { kind: environment, environments: [{ name: prod }] }\n',
      ),
    ).toThrow('./prod.yaml is not a reusable rulesets definition');
  });

  test('refuses a definition that carries others', () => {
    expect(() => readProfileImport('kind: ruleset\nrulesets: []\nbundled: {}\n')).toThrow('cannot carry others');
  });

  test('reads a definition by its kind', () => {
    expect(readProfileImport('kind: environment\nenvironments: [{ name: prod }]\n').kind).toBe('environment');
  });
});
