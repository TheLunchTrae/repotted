import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';

import {
  editProfile,
  listProfiles,
  parseProfile,
  ProfileError,
  resolveProfile,
  stringifyProfile,
} from '../src/profile.js';
import {
  commitPairs,
  draftSettings,
  mergeFields,
  mergeSettingsProblems,
  profile,
  type Profile,
} from '../src/schema.js';

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

async function loadProfile(file: string): Promise<Profile> {
  return (await resolveProfile(file)).profile;
}

function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('the profile that applies', () => {
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

  test('names the field that fails in a ruleset, environment, autolink or Pages entry', async () => {
    const problems = {
      'rulesets: [{ name: Main, enforcement: on }]':
        'expected one of "active"|"evaluate"|"disabled"\n  → at rulesets[0].enforcement',
      'environments: [{ name: npm, wait_timer: soon }]':
        'expected number, received string\n  → at environments[0].wait_timer',
      'autolinks: [{ key_prefix: X-, absent: true, url_template: "x/<num>" }]':
        'Unrecognized key: "url_template"\n  → at autolinks[0]',
      'pages: { build_type: sometimes }': 'expected one of "legacy"|"workflow"\n  → at pages.build_type',
      'rulesets: [{ name: Main, absent: false }]': 'absent is true or left out\n  → at rulesets[0].absent',
      'rulesets: [{ name: Main, draft: false }]': 'draft is true or left out\n  → at rulesets[0].draft',
    };
    for (const [text, problem] of Object.entries(problems)) {
      const file = await write('entry-field.yaml', `${text}\n`);
      expect(String(await rejection(loadProfile(file)))).toContain(problem);
    }
  });

  test('rejects a custom property name GitHub does not allow, such as one with a dot', async () => {
    const file = await write('property-dot.yaml', 'custom_properties: { "team.name": platform }\n');
    const error = await rejection(resolveProfile(file));
    expect(error).toBeInstanceOf(ProfileError);
    expect(String(error)).toContain('A custom property name is 1 to 75 letters, digits, _, -, $ or #');
  });

  test('rejects a profile that turns off every merge method', async () => {
    const file = await write(
      'no-merge.yaml',
      'merge: { allow_merge_commit: false, allow_squash_merge: false, allow_rebase_merge: false }\n',
    );

    expect(String(await rejection(loadProfile(file)))).toContain('Every merge method is off');
  });

  test('checks the rule parameters GitHub documents, and leaves other parameters and rule types open', async () => {
    const empty = await write(
      'no-pull-request-merge.yaml',
      'rulesets: [{ name: Main, rules: [{ type: pull_request, parameters: { allowed_merge_methods: [] } }] }]\n',
    );
    expect(String(await rejection(loadProfile(empty)))).toContain(
      'allowed_merge_methods needs at least one merge method\n  → at rulesets[0].rules[0].parameters.allowed_merge_methods',
    );
    const paths = (rules: unknown[]): string[] =>
      (profile.safeParse({ rulesets: [{ name: 'Main', rules }] }).error?.issues ?? []).map((issue) =>
        issue.path.join('.'),
      );
    expect(
      paths([
        { type: 'pull_request', parameters: { allowed_merge_methods: ['fast_forward'] } },
        { type: 'pull_request', parameters: { required_approving_review_count: 11 } },
        { type: 'merge_queue', parameters: { merge_method: 'squash' } },
        { type: 'branch_name_pattern', parameters: { operator: 'matches' } },
        { type: 'max_file_size', parameters: { max_file_size: 0 } },
      ]),
    ).toEqual([
      'rulesets.0.rules.0.parameters.allowed_merge_methods.0',
      'rulesets.0.rules.1.parameters.required_approving_review_count',
      'rulesets.0.rules.2.parameters.merge_method',
      'rulesets.0.rules.3.parameters.operator',
      'rulesets.0.rules.4.parameters.max_file_size',
    ]);
    expect(
      paths([
        { type: 'pull_request', parameters: { allowed_merge_methods: ['squash'], required_reviewers: [] } },
        { type: 'required_status_checks', parameters: { required_status_checks: [] } },
        { type: 'made_up', parameters: { allowed_merge_methods: [] } },
        { type: 'constructor' },
      ]),
    ).toEqual([]);
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

    const { profile } = await parseProfile('extends: shared.yaml\nmerge: { allow_squash_merge: false }\n', directory);

    expect(profile).toEqual({ merge: { allow_rebase_merge: true, allow_squash_merge: false } });
    expect((await parseProfile(stringifyProfile(profile), directory)).profile).toEqual(profile);
  });

  test('validates the merged profile, so a base may need the profile that extends it', async () => {
    await write(
      'all-off.yaml',
      'merge: { allow_merge_commit: false, allow_squash_merge: false, allow_rebase_merge: false }\n',
    );

    const { profile } = await parseProfile('extends: all-off.yaml\nmerge: { allow_rebase_merge: true }\n', directory);

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
      drafts: {
        repository: {},
        merge: {},
        actions: {},
        security: {},
        custom_properties: {},
        pages: {},
        autolinks: {},
        rulesets: {},
        environments: {},
      },
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
    const folder = path.join(directory, 'real-paths');
    await mkdir(folder);
    await writeFile(path.join(folder, 'base.yaml'), 'repository: { has_wiki: false }\n');
    await writeFile(path.join(folder, 'app.yml'), 'extends: base.yaml\n');
    const linked = path.join(directory, 'real-paths-link');
    await symlink(folder, linked);

    const [app] = await listProfiles(linked);

    expect(app?.file).toBe(path.join(folder, 'app.yml'));
    expect(app?.extends).toBe(path.join(folder, 'base.yaml'));
    expect((await resolveProfile(path.join(linked, 'app.yml'))).chain[0]).toBe(app?.file);
  });
});

describe('drafts', () => {
  test('stay out of the profile that applies, and their problems are warnings', async () => {
    const file = await write(
      'drafts.yaml',
      `
repository: { has_wiki: false }
rulesets:
  - name: Main
  - name: Unfinished
    draft: true
    enforcement: sometimes
environments:
  - name: npm
    draft: true
    wait_timer: 5
drafts:
  repository: { has_wiki: true, has_wikis: true }
  actions: { allowed_actions: none }
`,
    );

    const resolved = await resolveProfile(file);

    expect(resolved.profile).toEqual({ repository: { has_wiki: false }, rulesets: [{ name: 'Main' }] });
    expect(resolved.drafts).toEqual({
      repository: { has_wiki: true, has_wikis: true },
      actions: { allowed_actions: 'none' },
      rulesets: [{ name: 'Unfinished', draft: true, enforcement: 'sometimes' }],
      environments: [{ name: 'npm', draft: true, wait_timer: 5 }],
    });
    expect(resolved.warnings).toHaveLength(3);
    expect(resolved.warnings.join('\n')).toContain('Draft repository.has_wikis: repository has no setting has_wikis');
    expect(resolved.warnings.join('\n')).toContain('Draft actions.allowed_actions:');
    expect(resolved.warnings.join('\n')).toContain('Draft ruleset "Unfinished":');
    expect(resolved.sources.drafts).toEqual({
      repository: { has_wiki: file, has_wikis: file },
      merge: {},
      actions: { allowed_actions: file },
      security: {},
      custom_properties: {},
      pages: {},
      autolinks: {},
      rulesets: { Unfinished: file },
      environments: { npm: file },
    });
  });

  test('cover the security, custom property, Pages and autolink settings', async () => {
    const file = await write(
      'drafts-sections.yaml',
      `
actions:
  selected_actions: { github_owned_allowed: true }
autolinks:
  - key_prefix: JIRA-
    url_template: https://jira.example.com/browse/JIRA-<num>
  - key_prefix: TICKET-
    draft: true
drafts:
  actions:
    selected_actions: { verified_allowed: true }
  security:
    vulnerability_alerts: true
    code_scanning_default_setup: { state: sometimes }
  custom_properties: { team: platform, cost_center: 12 }
  pages:
    build_type: workflow
`,
    );

    const resolved = await resolveProfile(file);

    expect(resolved.profile).toEqual({
      actions: { selected_actions: { github_owned_allowed: true } },
      autolinks: [{ key_prefix: 'JIRA-', url_template: 'https://jira.example.com/browse/JIRA-<num>' }],
    });
    expect(resolved.drafts).toEqual({
      actions: { selected_actions: { verified_allowed: true } },
      security: { vulnerability_alerts: true, code_scanning_default_setup: { state: 'sometimes' } },
      custom_properties: { team: 'platform', cost_center: 12 },
      pages: { build_type: 'workflow' },
      autolinks: [{ key_prefix: 'TICKET-', draft: true }],
    });
    expect(resolved.warnings).toHaveLength(3);
    expect(resolved.warnings.join('\n')).toContain('Draft security.code_scanning_default_setup:');
    expect(resolved.warnings.join('\n')).toContain('Draft custom_properties.cost_center:');
    expect(resolved.warnings.join('\n')).toContain('Draft autolink "TICKET-":');
    expect(resolved.sources.drafts.actions).toEqual({ 'selected_actions.verified_allowed': file });
    expect(resolved.sources.drafts.autolinks).toEqual({ 'TICKET-': file });
  });

  test('refuse two draft autolinks with the same prefix', async () => {
    const file = await write(
      'drafts-autolinks.yaml',
      'autolinks: [{ key_prefix: A-, draft: true }, { key_prefix: A-, draft: true }]\n',
    );
    expect(String(await rejection(resolveProfile(file)))).toContain('Draft autolink "A-" appears more than once');
  });

  test('never replace an entry or setting of a base profile', async () => {
    const base = await write(
      'draft-base.yaml',
      'repository: { has_wiki: false }\nrulesets: [{ name: Main, enforcement: active }]\n',
    );
    const own = await write(
      'draft-own.yaml',
      'extends: draft-base.yaml\nrulesets: [{ name: Main, draft: true, enforcement: evaluate }]\ndrafts: { repository: { has_wiki: true } }\n',
    );

    const resolved = await resolveProfile(own);

    expect(resolved.profile).toEqual({
      repository: { has_wiki: false },
      rulesets: [{ name: 'Main', enforcement: 'active' }],
    });
    expect(resolved.sources.rulesets).toEqual({ Main: base });
    expect(resolved.sources.drafts['rulesets']).toEqual({ Main: own });
  });

  test('merge with the drafts of a base profile, as settings and entries merge', async () => {
    const base = await write(
      'drafts-merge-base.yaml',
      `
autolinks: [{ key_prefix: JIRA-, draft: true, url_template: "https://old/<num>" }, { key_prefix: KEPT-, draft: true }]
rulesets: [{ name: Main, draft: true, target: tag }, { name: Kept, draft: true }]
environments: [{ name: npm, draft: true, wait_timer: 1 }]
drafts:
  repository: { has_wiki: true, has_issues: true }
  actions: { selected_actions: { github_owned_allowed: true } }
`,
    );
    const own = await write(
      'drafts-merge-own.yaml',
      `
extends: drafts-merge-base.yaml
autolinks: [{ key_prefix: JIRA-, draft: true, url_template: "https://new/<num>" }]
rulesets: [{ name: Main, draft: true, target: branch }]
environments: [{ name: NPM, draft: true, wait_timer: 2 }]
drafts:
  repository: { has_wiki: false }
  actions: { selected_actions: { verified_allowed: true } }
`,
    );

    const resolved = await resolveProfile(own);

    expect(resolved.profile).toEqual({});
    expect(resolved.drafts).toEqual({
      repository: { has_wiki: false, has_issues: true },
      actions: { selected_actions: { github_owned_allowed: true, verified_allowed: true } },
      autolinks: [
        { key_prefix: 'JIRA-', draft: true, url_template: 'https://new/<num>' },
        { key_prefix: 'KEPT-', draft: true },
      ],
      rulesets: [
        { name: 'Main', draft: true, target: 'branch' },
        { name: 'Kept', draft: true },
      ],
      environments: [{ name: 'NPM', draft: true, wait_timer: 2 }],
    });
    expect(resolved.sources.drafts.repository).toEqual({ has_wiki: own, has_issues: base });
    expect(resolved.sources.drafts.actions).toEqual({
      'selected_actions.github_owned_allowed': base,
      'selected_actions.verified_allowed': own,
    });
    expect(resolved.sources.drafts.autolinks).toEqual({ 'JIRA-': own, 'KEPT-': base });
    expect(resolved.sources.drafts.rulesets).toEqual({ Main: own, Kept: base });
    expect(resolved.sources.drafts.environments).toEqual({ NPM: own });
  });

  test('replace a base draft group whole with a value that is not one, and the reverse', async () => {
    const base = await write(
      'drafts-group-base.yaml',
      'drafts:\n  actions: { selected_actions: { github_owned_allowed: true } }\n  pages: { source: oops }\n',
    );
    const own = await write(
      'drafts-group-own.yaml',
      'extends: drafts-group-base.yaml\ndrafts:\n  actions: { selected_actions: oops }\n  pages: { source: { branch: main } }\n',
    );
    const resolved = await resolveProfile(own);
    expect(resolved.drafts.actions).toEqual({ selected_actions: 'oops' });
    expect(resolved.drafts.pages).toEqual({ source: { branch: 'main' } });
    expect(resolved.sources.drafts.actions).toEqual({ selected_actions: own });
    expect(resolved.sources.drafts.pages).toEqual({ 'source.branch': own });
    expect(base).not.toBe(own);
  });

  test('replace a base draft value that is not a group with a group that sets nothing', async () => {
    await write('drafts-empty-group-base.yaml', 'drafts:\n  security: { code_scanning_default_setup: oops }\n');
    const own = await write(
      'drafts-empty-group-own.yaml',
      'extends: drafts-empty-group-base.yaml\ndrafts:\n  security: { code_scanning_default_setup: {} }\n',
    );
    const resolved = await resolveProfile(own);
    expect(resolved.drafts.security).toBeUndefined();
    expect(resolved.sources.drafts.security).toEqual({});
  });

  test('refuse a draft setting whose name holds a dot', async () => {
    const file = await write('drafts-dot.yaml', 'drafts:\n  repository: { "has.wiki": true }\n');
    const error = await rejection(resolveProfile(file));
    expect(error).toBeInstanceOf(ProfileError);
    expect(String(error)).toContain('A draft setting name cannot contain a dot');

    const inner = await write('drafts-dot-inner.yaml', 'drafts:\n  actions: { selected_actions: { "a.b": true } }\n');
    expect(String(await rejection(resolveProfile(inner)))).toContain('A draft setting name cannot contain a dot');
  });

  test('warn when a Pages draft turns the site off beside other keys', async () => {
    const file = await write('drafts-pages-absent.yaml', 'drafts:\n  pages: { absent: true, build_type: nope }\n');
    const resolved = await resolveProfile(file);
    expect(resolved.drafts.pages).toEqual({ absent: true });
    expect(resolved.warnings).toEqual([
      'Draft pages in drafts-pages-absent.yaml: absent turns the Pages site off, so build_type is left out',
    ]);
  });

  test('warn about an empty custom property name without a trailing place', async () => {
    const file = await write('drafts-empty-key.yaml', 'drafts:\n  custom_properties: { "": x }\n');
    const { warnings } = await resolveProfile(file);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toMatch(/ at $/u);
  });

  test('warn with the field of a draft ruleset that would not apply', async () => {
    const file = await write(
      'drafts-ruleset-field.yaml',
      'rulesets: [{ name: Main, draft: true, enforcement: maybe }, { name: Gone, draft: true, absent: true, target: tag }]\n',
    );
    const { warnings } = await resolveProfile(file);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/^Draft ruleset "Main": .* at enforcement$/u);
    expect(warnings[1]).toMatch(/^Draft ruleset "Gone": /u);
    expect(warnings[1]).toContain('target');
  });

  test('keep an empty list as written, and leave out a list of only drafts', async () => {
    const empty = await write('drafts-empty-list.yaml', 'rulesets: []\ndrafts: { repository: {} }\n');
    const resolved = await resolveProfile(empty);
    expect(resolved.profile).toEqual({ rulesets: [] });
    expect(resolved.drafts).toEqual({});

    const only = await write('drafts-only.yaml', 'rulesets: [{ name: Later, draft: true }]\n');
    expect((await resolveProfile(only)).profile).toEqual({});
  });

  test('refuse two drafts of the same name in an override, though a base has that name', async () => {
    await write('drafts-dup-base.yaml', 'rulesets: [{ name: Main, draft: true }]\n');
    const own = await write(
      'drafts-dup-own.yaml',
      'extends: drafts-dup-base.yaml\nrulesets: [{ name: Main, draft: true }, { name: Main, draft: true }]\n',
    );
    expect(String(await rejection(resolveProfile(own)))).toContain('Draft ruleset "Main" appears more than once');
  });

  test('may share a name with an entry in the same file, but not with another draft', async () => {
    const file = await write('draft-twins.yaml', 'rulesets: [{ name: Main }, { name: Main, draft: true }]\n');
    expect((await resolveProfile(file)).drafts.rulesets).toEqual([{ name: 'Main', draft: true }]);

    const twice = await write(
      'draft-twice.yaml',
      'environments: [{ name: npm, draft: true }, { name: NPM, draft: true }]\n',
    );
    expect(String(await rejection(resolveProfile(twice)))).toContain('Draft environment "NPM" appears more than once');
  });

  test('need a name, and drafts holds only settings sections', async () => {
    const nameless = await write('draft-nameless.yaml', 'rulesets: [{ draft: true, enforcement: active }]\n');
    const listed = await write('draft-list.yaml', 'drafts: { rulesets: [{ name: Main }] }\n');

    expect(await rejection(resolveProfile(nameless))).toBeInstanceOf(ProfileError);
    expect(String(await rejection(resolveProfile(listed)))).toContain('rulesets');
  });

  test('cover every settings section', () => {
    // Every section of a profile holds settings, except its lists of entries.
    const sections = Object.keys(profile.shape).filter(
      (key) => !['autolinks', 'rulesets', 'environments'].includes(key),
    );
    expect(Object.keys(draftSettings.shape).toSorted()).toEqual(sections.toSorted());
  });
});

describe('editProfile with drafts', () => {
  test('saves an unfinished draft, then finishes it in place once it is valid', async () => {
    const file = await write('edit-draft.yaml', 'rulesets:\n  - name: Main # protects main\n');

    const drafted = await editProfile(file, [
      { list: 'rulesets', name: 'Tags', draft: true, entry: { name: 'Tags', draft: true, target: 'tags' } },
      { path: ['drafts', 'repository', 'has_wiki'], value: 'later' },
    ]);
    expect(drafted.profile.rulesets).toEqual([{ name: 'Main' }]);
    expect(drafted.warnings).toHaveLength(2);

    const unfinished = rejection(
      editProfile(file, [{ list: 'rulesets', name: 'Tags', draft: true, entry: { name: 'Tags', target: 'tags' } }]),
    );
    expect(await unfinished).toBeInstanceOf(ProfileError);

    const finished = await editProfile(file, [
      { list: 'rulesets', name: 'Tags', draft: true, entry: { name: 'Tags', target: 'tag' } },
      { path: ['drafts', 'repository', 'has_wiki'], value: undefined },
    ]);
    expect(finished.profile.rulesets).toEqual([{ name: 'Main' }, { name: 'Tags', target: 'tag' }]);
    expect(finished.drafts).toEqual({});
    expect(await readFile(file, 'utf8')).toBe(
      'rulesets:\n  - name: Main # protects main\n  - name: Tags\n    target: tag\n',
    );
  });

  test('edits a draft setting inside a group, as settings are edited', async () => {
    const file = await write('edit-draft-group.yaml', 'actions:\n  selected_actions: { github_owned_allowed: true }\n');

    const drafted = await editProfile(file, [
      { path: ['drafts', 'actions', 'selected_actions', 'verified_allowed'], value: true },
      { path: ['drafts', 'security', 'vulnerability_alerts'], value: true },
    ]);
    expect(drafted.profile).toEqual({ actions: { selected_actions: { github_owned_allowed: true } } });
    expect(drafted.drafts).toEqual({
      actions: { selected_actions: { verified_allowed: true } },
      security: { vulnerability_alerts: true },
    });

    const outside = rejection(editProfile(file, [{ path: ['drafts', 'actions', 'enabled', 'inner'], value: true }]));
    expect(String(await outside)).toContain('Cannot edit drafts.actions.enabled.inner');
  });

  test('makes an entry a draft in place, unless the file has a draft of that name', async () => {
    const file = await write('edit-make-draft.yaml', 'rulesets:\n  - name: Main # protects main\n    target: branch\n');

    const drafted = await editProfile(file, [
      { list: 'rulesets', name: 'Main', entry: { name: 'Main', draft: true, target: 'branch' } },
    ]);
    expect(drafted.profile).toEqual({});
    expect(await readFile(file, 'utf8')).toBe(
      'rulesets:\n  - name: Main # protects main\n    target: branch\n    draft: true\n',
    );

    await writeFile(file, 'rulesets: [{ name: Main }, { name: Main, draft: true }]\n');
    const refused = rejection(
      editProfile(file, [{ list: 'rulesets', name: 'Main', entry: { name: 'Main', draft: true } }]),
    );
    expect(String(await refused)).toContain(
      'Cannot make Main a draft: the file already has a draft ruleset named Main',
    );
  });

  test('tells a draft from the entry of the same name', async () => {
    const file = await write(
      'edit-twins.yaml',
      'rulesets: [{ name: Main }, { name: Main, draft: true, target: tag }]\n',
    );

    const clash = rejection(
      editProfile(file, [{ list: 'rulesets', name: 'Main', draft: true, entry: { name: 'Main' } }]),
    );
    expect(String(await clash)).toContain('Cannot finish the draft Main: the file already has a ruleset named Main');

    const replaced = await editProfile(file, [
      { list: 'rulesets', name: 'Main', entry: { name: 'Main', target: 'tag' } },
      { list: 'rulesets', name: 'Main', draft: true, entry: undefined },
    ]);
    expect(replaced.profile.rulesets).toEqual([{ name: 'Main', target: 'tag' }]);
    expect(replaced.drafts).toEqual({});
  });

  test('edits draft keys only under a settings section', async () => {
    const file = await write('edit-draft-keys.yaml', 'repository: { has_wiki: false }\n');

    for (const key of [['drafts'], ['drafts', 'repository'], ['drafts', 'rulesets', 'x']]) {
      expect(String(await rejection(editProfile(file, [{ path: key, value: true }])))).toContain('Cannot edit');
    }
  });
});
