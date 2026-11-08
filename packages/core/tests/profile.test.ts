import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';

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

// The real path, because profiles report real paths and macOS links its temporary folder.
const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'repotted-profile-')));

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
    const examples = path.join(import.meta.dirname, '../../../examples');
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

  test('validates the merged profile, so a base may need the profile that extends it', async () => {
    await write(
      'all-off.yaml',
      'merge: { allow_merge_commit: false, allow_squash_merge: false, allow_rebase_merge: false }\n',
    );

    const profile = await parseProfile('extends: all-off.yaml\nmerge: { allow_rebase_merge: true }\n', directory);

    expect(profile.merge?.allow_rebase_merge).toBe(true);
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
      security: {},
      custom_properties: {},
      pages: {},
      autolinks: {},
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

    for (const key of [
      ['rulesets', '0'],
      ['extends'],
      ['repository'],
      ['repository', 'has_wiki', 'x'],
      ['repository', 'has_wikki'],
      ['actions', 'selected_actions'],
    ]) {
      expect(String(await rejection(editProfile(file, [{ path: key, value: true }])))).toContain('Cannot edit');
    }
  });

  test('rejects a setting edited twice, since only one value can win', async () => {
    const file = await write('edit-twice.yaml', 'merge: { allow_rebase_merge: true }\n');

    const twice = rejection(
      editProfile(file, [
        { path: ['repository', 'has_wiki'], value: true },
        { path: ['repository', 'has_wiki'], value: undefined },
      ]),
    );

    expect(String(await twice)).toContain('more than once');
  });

  test('removing a setting the file does not name changes nothing', async () => {
    const text = 'repository: { has_wiki: false }\nmerge: {}\n';
    const file = await write('edit-unset-missing.yaml', text);

    await editProfile(file, [
      { path: ['actions', 'selected_actions', 'verified_allowed'], value: undefined },
      { path: ['merge', 'allow_rebase_merge'], value: undefined },
    ]);

    expect(await readFile(file, 'utf8')).toBe(text);
  });

  test('writes, replaces and drops rulesets and environments by name, and keeps the rest and its comments', async () => {
    await write('entries-base.yaml', 'environments: [{ name: Production, wait_timer: 5 }]\n');
    const file = await write(
      'entries.yaml',
      [
        'extends: entries-base.yaml',
        'rulesets:',
        '  # Kept as it is',
        '  - name: First',
        '    enforcement: active',
        '  - name: Second',
        '    target: tag # tags only',
        '    enforcement: evaluate # for now',
        '    bypass_actors: []',
        'environments:',
        '  - name: staging',
        '    wait_timer: 1',
        '',
      ].join('\n'),
    );

    const resolved = await editProfile(file, [
      { list: 'rulesets', name: 'Second', entry: { name: 'Second', target: 'tag', enforcement: 'disabled' } },
      { list: 'rulesets', name: 'Third', entry: { name: 'Third', rules: [{ type: 'deletion' }] } },
      { list: 'environments', name: 'Staging', entry: undefined },
      { list: 'environments', name: 'production', entry: { name: 'production', wait_timer: 10 } },
    ]);

    expect(await readFile(file, 'utf8')).toBe(
      [
        'extends: entries-base.yaml',
        'rulesets:',
        '  # Kept as it is',
        '  - name: First',
        '    enforcement: active',
        '  - name: Second',
        '    target: tag # tags only',
        '    enforcement: disabled # for now',
        '  - name: Third',
        '    rules:',
        '      - type: deletion',
        'environments:',
        '  - name: production',
        '    wait_timer: 10',
        '',
      ].join('\n'),
    );
    expect(resolved.profile.environments).toEqual([{ name: 'production', wait_timer: 10 }]);
    expect(resolved.sources.environments['production']).toBe(file);

    // Dropping the file's own entry lets the base's apply again, and an empty list goes.
    const dropped = await editProfile(file, [{ list: 'environments', name: 'PRODUCTION', entry: undefined }]);
    expect(await readFile(file, 'utf8')).not.toContain('environments');
    expect(dropped.profile.environments).toEqual([{ name: 'Production', wait_timer: 5 }]);
  });

  test('renames an entry in place, and keeps the comments of rules it still holds', async () => {
    const file = await write(
      'entries-rename.yaml',
      [
        'rulesets:',
        '  - name: A',
        '  - name: B # the main one',
        '    rules:',
        '      - type: deletion # never',
        '      - type: pull_request # reviews',
        '        parameters:',
        '          required_approving_review_count: 1 # one',
        '  - name: C',
        'environments:',
        '  - name: staging # shared',
        '    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }',
        '    branch_policies:',
        '      - name: v* # releases',
        '        type: tag',
        '      - name: nightly-* # nightly builds',
        '        type: tag',
        '',
      ].join('\n'),
    );

    await editProfile(file, [
      {
        list: 'rulesets',
        name: 'B',
        entry: {
          name: 'B2',
          rules: [
            { type: 'pull_request', parameters: { required_approving_review_count: 2 } },
            { type: 'non_fast_forward' },
          ],
        },
      },
      {
        list: 'environments',
        name: 'staging',
        entry: {
          name: 'Staging',
          deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
          branch_policies: [{ name: 'nightly-*', type: 'tag' }],
        },
      },
    ]);

    expect(await readFile(file, 'utf8')).toBe(
      [
        'rulesets:',
        '  - name: A',
        '  - name: B2 # the main one',
        '    rules:',
        '      - type: pull_request # reviews',
        '        parameters:',
        '          required_approving_review_count: 2 # one',
        '      - type: non_fast_forward',
        '  - name: C',
        'environments:',
        '  - name: Staging # shared',
        '    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }',
        '    branch_policies:',
        '      - name: nightly-* # nightly builds',
        '        type: tag',
        '',
      ].join('\n'),
    );
  });

  test('rejects an entry edited twice, renamed to a taken name, shared by an alias, or not valid', async () => {
    const text = 'rulesets: [{ name: Main }, { name: Other }]\n';
    const file = await write('entries-invalid.yaml', text);

    const twice = rejection(
      editProfile(file, [
        { list: 'environments', name: 'Staging', entry: undefined },
        { list: 'environments', name: 'staging', entry: { name: 'staging' } },
      ]),
    );
    const taken = rejection(editProfile(file, [{ list: 'rulesets', name: 'Main', entry: { name: 'Other' } }]));
    const shared = await write(
      'entries-alias.yaml',
      'rulesets:\n  - { name: A, bypass_actors: &admins [] }\n  - { name: B, bypass_actors: *admins }\n',
    );
    const invalid = rejection(
      editProfile(file, [{ list: 'rulesets', name: 'Main', entry: { name: 'Main', enforcement: 'sometimes' } }]),
    );

    expect(String(await twice)).toContain('more than once');
    expect(String(await taken)).toContain('already has a ruleset named Other');
    expect(
      String(await rejection(editProfile(shared, [{ list: 'rulesets', name: 'A', entry: { name: 'A' } }]))),
    ).toContain('anchors and aliases');
    expect(await invalid).toBeInstanceOf(ProfileError);
    expect(await readFile(file, 'utf8')).toBe(text);
  });

  test('keeps Windows line endings, the indent width and the file mode', async () => {
    const file = await write('edit-layout.yaml', 'repository:\r\n    has_wiki: false\r\n');
    await chmod(file, 0o664);

    await editProfile(file, [{ path: ['repository', 'has_issues'], value: true }]);

    expect(await readFile(file, 'utf8')).toBe('repository:\r\n    has_wiki: false\r\n    has_issues: true\r\n');
    expect((await stat(file)).mode & 0o777).toBe(0o664);
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
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

  test('reports real paths, matching the chain that resolveProfile reports for the same file', async () => {
    const linked = path.join(directory, 'listing-link');
    await symlink(path.join(directory, 'listing'), linked);

    const [app] = await listProfiles(linked);

    expect(app?.file).toBe(path.join(directory, 'listing', 'app.yml'));
    expect(app?.extends).toBe(path.join(directory, 'listing', 'base.yaml'));
    expect((await resolveProfile(path.join(linked, 'app.yml'))).chain[0]).toBe(app?.file);
  });
});
