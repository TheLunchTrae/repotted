import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  editProfile,
  listProfiles,
  loadProfile,
  parseProfile,
  ProfileError,
  resolveProfile,
  stringifyProfile,
} from '../src/profile.js';
import { commitPairs, mergeFields, mergeSettingsProblems } from '../src/schema.js';

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
    expect(profile.rulesets?.[1]).toEqual({ name: 'Replace', enforcement: 'evaluate' });
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

  test('rejects deployment patterns without custom branch policies', async () => {
    const file = await write(
      'patterns.yaml',
      "environments: [{ name: npm, branch_policies: [{ name: 'v*', type: tag }] }]\n",
    );

    expect(String(await rejection(loadProfile(file)))).toContain('branch_policies needs deployment_branch_policy');
  });

  test('rejects two environments whose names differ only in case, as GitHub treats them as one', async () => {
    const file = await write('environment-case.yaml', 'environments: [{ name: npm }, { name: NPM, absent: true }]\n');

    expect(String(await rejection(loadProfile(file)))).toContain('Environment "NPM" appears more than once');
  });

  test('rejects a deployment pattern listed twice', async () => {
    const file = await write(
      'patterns-twice.yaml',
      'environments: [{ name: npm, deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }, branch_policies: [{ name: main }, { name: main, type: branch }] }]\n',
    );

    expect(String(await rejection(loadProfile(file)))).toContain('Pattern "branch main" appears more than once');
  });

  test('replaces a base environment whose name differs only in case', async () => {
    await write('environment-base.yaml', 'environments: [{ name: npm, wait_timer: 5 }]\n');
    const file = await write(
      'environment-override.yaml',
      'extends: environment-base.yaml\nenvironments: [{ name: NPM, wait_timer: 10 }]\n',
    );

    expect((await loadProfile(file)).environments).toEqual([{ name: 'NPM', wait_timer: 10 }]);
  });

  test('rejects a profile that turns off every merge method', async () => {
    const file = await write(
      'no-merge.yaml',
      'merge: { allow_merge_commit: false, allow_squash_merge: false, allow_rebase_merge: false }\n',
    );

    expect(String(await rejection(loadProfile(file)))).toContain('Every merge method is off');
  });

  test('accepts exactly the commit title and message pairs the settings page offers', () => {
    const accepted = commitPairs.flatMap(({ title, message }) =>
      mergeFields[title].options.flatMap((titleValue) =>
        mergeFields[message].options
          .filter(
            (messageValue) => mergeSettingsProblems({ [title]: titleValue, [message]: messageValue }).length === 0,
          )
          .map((messageValue) => `${title}=${titleValue} ${messageValue}`),
      ),
    );

    expect(accepted).toEqual([
      'merge_commit_title=PR_TITLE PR_BODY',
      'merge_commit_title=PR_TITLE BLANK',
      'merge_commit_title=MERGE_MESSAGE PR_TITLE',
      'squash_merge_commit_title=PR_TITLE PR_BODY',
      'squash_merge_commit_title=PR_TITLE COMMIT_MESSAGES',
      'squash_merge_commit_title=PR_TITLE BLANK',
      'squash_merge_commit_title=COMMIT_OR_PR_TITLE COMMIT_MESSAGES',
    ]);
  });

  test('rejects a merge commit title and message pair that GitHub does not offer', async () => {
    const file = await write(
      'pair.yaml',
      'merge: { merge_commit_title: MERGE_MESSAGE, merge_commit_message: PR_BODY }\n',
    );

    expect(String(await rejection(loadProfile(file)))).toContain(
      'GitHub does not allow merge_commit_title: MERGE_MESSAGE with merge_commit_message: PR_BODY',
    );
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

describe('resolveProfile', () => {
  test('names the file that sets each value, so the app can tell own values from inherited ones', async () => {
    const folder = path.join(directory, 'sources');
    await mkdir(folder);
    const base = path.join(folder, 'base.yaml');
    const own = path.join(folder, 'own.yaml');
    await writeFile(
      base,
      `
repository: { has_wiki: false, has_issues: true }
actions: { enabled: true, selected_actions: { verified_allowed: true } }
rulesets: [{ name: Keep }, { name: Replace }]
environments: [{ name: npm }]
`,
    );
    await writeFile(
      own,
      `
extends: base.yaml
repository: { has_wiki: true }
actions: { selected_actions: { github_owned_allowed: true } }
rulesets: [{ name: Replace, enforcement: evaluate }]
environments: [{ name: NPM, wait_timer: 5 }]
`,
    );

    const resolved = await resolveProfile(own);

    expect(resolved.chain).toEqual([own, base]);
    expect(resolved.sources).toEqual({
      repository: { has_wiki: own, has_issues: base },
      merge: {},
      actions: {
        enabled: base,
        'selected_actions.verified_allowed': base,
        'selected_actions.github_owned_allowed': own,
      },
      rulesets: { Keep: base, Replace: own },
      environments: { NPM: own },
    });
  });
});

describe('editProfile', () => {
  test('changes settings and keeps the rest of the file, comments included', async () => {
    await write('edit-base.yaml', 'repository: { has_projects: false }\n');
    const file = await write(
      'edit.yaml',
      '# Shared with the team\nextends: edit-base.yaml\nrepository: { has_wiki: false } # wiki lives elsewhere\nmerge:\n  allow_rebase_merge: true\n',
    );

    const resolved = await editProfile(file, [
      { path: ['repository', 'has_issues'], value: true },
      { path: ['merge', 'allow_rebase_merge'], value: undefined },
      { path: ['actions', 'selected_actions', 'verified_allowed'], value: false },
    ]);

    expect(await readFile(file, 'utf8')).toBe(
      '# Shared with the team\nextends: edit-base.yaml\nrepository: { has_wiki: false, has_issues: true } # wiki lives elsewhere\nactions:\n  selected_actions:\n    verified_allowed: false\n',
    );
    expect(resolved.profile.repository).toEqual({ has_projects: false, has_wiki: false, has_issues: true });
    expect(resolved.sources.repository['has_issues']).toBe(file);
  });

  test('leaves the file as it was when the result is not a valid profile', async () => {
    const text = 'merge: { allow_merge_commit: false, allow_squash_merge: false }\n';
    const file = await write('edit-invalid.yaml', text);

    const turnOffLast = rejection(editProfile(file, [{ path: ['merge', 'allow_rebase_merge'], value: false }]));
    const wrongType = rejection(editProfile(file, [{ path: ['repository', 'has_wiki'], value: 'no' }]));

    expect(String(await turnOffLast)).toContain('Every merge method is off');
    expect(await wrongType).toBeInstanceOf(ProfileError);
    expect(await readFile(file, 'utf8')).toBe(text);
  });

  test('edits only repository, merge and actions settings', async () => {
    const file = await write('edit-rulesets.yaml', 'rulesets: [{ name: Keep }]\n');

    for (const key of [['rulesets', '0'], ['extends'], ['repository'], ['repository', 'has_wiki', 'x']]) {
      expect(String(await rejection(editProfile(file, [{ path: key, value: true }])))).toContain('Cannot edit');
    }
  });
});

describe('listProfiles', () => {
  test('lists the YAML files in a folder by name, with what each extends and why one cannot be used', async () => {
    const folder = path.join(directory, 'listing');
    await mkdir(folder);
    await writeFile(path.join(folder, 'base.yaml'), 'repository: { has_wiki: false }\n');
    await writeFile(path.join(folder, 'app.yml'), 'extends: base.yaml\n');
    await writeFile(path.join(folder, 'broken.yaml'), 'repository: { has_wikki: false }\n');
    await writeFile(path.join(folder, 'notes.md'), '# not a profile\n');

    const listings = await listProfiles(folder);

    expect(listings.map(({ name, extends: base }) => [name, base])).toEqual([
      ['app', path.join(folder, 'base.yaml')],
      ['base', null],
      ['broken', null],
    ]);
    expect(listings.map((listing) => listing.problem === null)).toEqual([true, true, false]);
    expect(listings[2]?.problem).toContain('has_wikki');
  });
});
