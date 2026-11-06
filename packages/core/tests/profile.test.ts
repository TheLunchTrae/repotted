import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadProfile, parseProfile, ProfileError, stringifyProfile } from '../src/profile.js';

const directory = await mkdtemp(path.join(tmpdir(), 'repotted-profile-'));

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function write(name: string, text: string): Promise<string> {
  const file = path.join(directory, name);
  await writeFile(file, text);
  return file;
}

function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('loadProfile', () => {
  test('lays a repository profile over the profile it extends', async () => {
    await write(
      'base.yaml',
      `
repository: { has_wiki: false, delete_branch_on_merge: true }
actions: { allowed_actions: selected, selected_actions: { github_owned_allowed: true } }
rulesets:
  - name: Keep
    rules: [{ type: deletion }]
  - name: Replace
    rules: [{ type: creation }]
  - name: Drop
    rules: [{ type: non_fast_forward }]
`,
    );
    const file = await write(
      'app.yaml',
      `
extends: base.yaml
repository: { has_wiki: true }
actions: { selected_actions: { patterns_allowed: ['oven-sh/*'] } }
rulesets:
  - name: Replace
    enforcement: evaluate
  - name: Drop
    absent: true
  - name: Add
`,
    );

    const profile = await loadProfile(file);

    expect(profile.repository).toEqual({ has_wiki: true, delete_branch_on_merge: true });
    expect(profile.actions).toEqual({
      allowed_actions: 'selected',
      selected_actions: { github_owned_allowed: true, patterns_allowed: ['oven-sh/*'] },
    });
    expect(profile.rulesets?.map((entry) => ('absent' in entry ? `-${entry.name}` : entry.name))).toEqual([
      'Keep',
      'Replace',
      '-Drop',
      'Add',
    ]);
    // A ruleset in the override replaces the base one whole; its rules do not carry over.
    expect(profile.rulesets?.[1]).toEqual({
      name: 'Replace',
      target: 'branch',
      enforcement: 'evaluate',
      bypass_actors: [],
      rules: [],
    });
  });

  test('rejects a profile that extends itself', async () => {
    await write('loop-a.yaml', 'extends: loop-b.yaml\n');
    const file = await write('loop-b.yaml', 'extends: loop-a.yaml\n');

    const error = await rejection(loadProfile(file));
    expect(error).toBeInstanceOf(ProfileError);
    expect(String(error)).toContain('extends itself');
  });

  test('names unknown keys, so a misspelled setting is never silently ignored', async () => {
    const file = await write('typo.yaml', 'repository: { delete_branch_on_marge: true }\n');

    const error = await rejection(loadProfile(file));
    expect(error).toBeInstanceOf(ProfileError);
    expect(String(error)).toContain('delete_branch_on_marge');
  });

  test('rejects two rulesets with the same name', async () => {
    const file = await write('twice.yaml', 'rulesets: [{ name: Same }, { name: Same }]\n');

    expect(String(await rejection(loadProfile(file)))).toContain('Ruleset "Same" appears more than once');
  });

  test('loads the example profiles', async () => {
    const examples = path.join(import.meta.dir, '../../../examples');
    const profile = await loadProfile(path.join(examples, 'repotted.yaml'));

    expect(profile.merge).toEqual({ allow_merge_commit: false, allow_squash_merge: false, allow_rebase_merge: true });
    expect(profile.rulesets?.map((entry) => entry.name)).toContain('Main: Require Status Checks');
  });
});

describe('parseProfile', () => {
  test('resolves extends from the given directory and round-trips through YAML', async () => {
    await write('shared.yaml', 'merge: { allow_rebase_merge: true }\n');

    const profile = await parseProfile('extends: shared.yaml\nmerge: { allow_squash_merge: false }\n', directory);

    expect(profile).toEqual({ merge: { allow_rebase_merge: true, allow_squash_merge: false } });
    expect(await parseProfile(stringifyProfile(profile), directory)).toEqual(profile);
  });
});
