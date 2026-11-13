import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { parse } from 'yaml';

import { applyPlan, captureProfile, createPlan, OwnerMismatchError } from '../src/plan.js';
import { changeOwnerType, ProfileError, resolveProfile } from '../src/profile.js';
import { profile, profileFileJsonSchema } from '../src/schema.js';
import { createStagedApply } from '../src/staged.js';
import { FakeGitHub } from './fake-github.js';

const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'repotted-owner-')));
const repo = { owner: 'lunch', name: 'app' };

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

function problems(value: unknown): string[] {
  return (profile.safeParse(value).error?.issues ?? []).map((issue) => `${issue.path.join('.')}: ${issue.message}`);
}

describe('a profile for one kind of owner', () => {
  test('takes only what that owner has', () => {
    expect(problems({ owner_type: 'user', repository: { allow_forking: true } })).toEqual([
      'repository.allow_forking: repository.allow_forking is something only organizations have, and this profile is for personal accounts',
    ]);
    expect(problems({ owner_type: 'organization', repository: { allow_forking: true } })).toEqual([]);
    expect(problems({ repository: { allow_forking: true }, actions: { access_level: 'user' } })).toEqual([]);
  });

  test('checks a value only some owners have', () => {
    expect(problems({ owner_type: 'organization', actions: { access_level: 'user' } })).toHaveLength(1);
    expect(problems({ owner_type: 'user', actions: { access_level: 'user' } })).toEqual([]);
    expect(problems({ owner_type: 'user', actions: { access_level: 'organization' } })).toHaveLength(1);
    expect(problems({ owner_type: 'user', actions: { access_level: 'none' } })).toEqual([]);
  });

  test('takes settings only GitHub Enterprise Cloud has on an organization profile', () => {
    expect(problems({ owner_type: 'organization', pages: { public: false } })).toEqual([]);
    expect(problems({ owner_type: 'user', pages: { public: false } })).toEqual([
      'pages.public: pages.public is something only organizations on GitHub Enterprise Cloud have, and this profile is for personal accounts',
    ]);
  });

  test('names each custom property on a personal profile', () => {
    expect(problems({ owner_type: 'user', custom_properties: { team: 'web', tier: 'one' } })).toHaveLength(2);
  });

  test('keeps rulesets and environments to what personal accounts have', () => {
    const found = problems({
      owner_type: 'user',
      rulesets: [
        { name: 'Pushes', target: 'push', rules: [{ type: 'max_file_size', parameters: { max_file_size: 10 } }] },
        {
          name: 'Main',
          target: 'branch',
          rules: [{ type: 'deletion' }, { type: 'merge_queue' }],
          bypass_actors: [
            { actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' },
            { actor_id: 7, actor_type: 'Team', bypass_mode: 'always' },
          ],
        },
        { name: 'Gone', absent: true },
      ],
      environments: [{ name: 'production', reviewers: [{ type: 'Team', id: 3 }] }],
    });
    expect(found).toEqual([
      'rulesets.0.target: Ruleset "Pushes" is a push ruleset, which only organizations have',
      'rulesets.1.rules.1: Ruleset "Main" has a merge_queue rule, which only organizations have',
      'rulesets.1.bypass_actors.1: Ruleset "Main" lets Team bypass it, which only organizations have',
      'environments.0.reviewers.0: Environment "production" has a team as a reviewer, which only organizations have',
    ]);
  });
});

describe('the owner type of a chain', () => {
  test('comes from the nearest file that names one', async () => {
    const base = await write('any-base.yaml', 'repository: { has_wiki: false }\n');
    const typed = await write('typed.yaml', `extends: ${base}\nowner_type: user\n`);
    const below = await write('below.yaml', `extends: ${typed}\nrepository: { has_issues: true }\n`);

    const resolved = await resolveProfile(below);

    expect(resolved.profile.owner_type).toBe('user');
    expect(resolved.owner_source).toBe(typed);
    expect((await resolveProfile(base)).owner_source).toBeNull();
  });

  test('may not mix types', async () => {
    const base = await write('org-base.yaml', 'owner_type: organization\n');
    const child = await write('mixed.yaml', `extends: ${base}\nowner_type: user\n`);

    const error = await rejection(resolveProfile(child));

    expect(error).toBeInstanceOf(ProfileError);
    expect(String(error)).toContain('is for personal accounts, but it builds on');
  });

  test('checks draft settings against the type', async () => {
    const file = await write('draft-user.yaml', 'owner_type: user\ndrafts: { pages: { public: false } }\n');

    const error = await rejection(resolveProfile(file));

    expect(error).toBeInstanceOf(ProfileError);
    expect(String(error)).toContain('at drafts.pages.public');
  });

  test('checks what the chain sets against the type', async () => {
    const base = await write('forks.yaml', 'repository: { allow_forking: true }\n');
    const child = await write('forks-user.yaml', `extends: ${base}\nowner_type: user\n`);

    expect(String(await rejection(resolveProfile(child)))).toContain('allow_forking');
  });
});

describe('changing the owner type', () => {
  const organization = `owner_type: organization
repository: { allow_forking: true, has_wiki: false }
pages: { public: false, https_enforced: true }
actions: { access_level: organization }
rulesets:
  - name: Pushes
    target: push
  - name: Main
    target: branch
    rules: [{ type: deletion }, { type: merge_queue }]
    bypass_actors: [{ actor_id: 7, actor_type: Team, bypass_mode: always }]
environments:
  - name: production
    reviewers: [{ type: User, id: 1 }, { type: Team, id: 3 }]
drafts:
  repository: { allow_forking: false }
`;

  test('says beforehand what it leaves not managed', async () => {
    const file = await write('org.yaml', organization);

    const resolved = await resolveProfile(file);

    expect(resolved.owner_changes.organization).toEqual([]);
    expect(resolved.owner_changes.user.toSorted()).toEqual(
      [
        'actions.access_level',
        'drafts.repository.allow_forking',
        'environments/production',
        'pages.public',
        'repository.allow_forking',
        'rulesets/Main',
        'rulesets/Pushes',
      ].toSorted(),
    );
  });

  test('leaves what the new type does not have not managed', async () => {
    const file = await write('org-to-user.yaml', organization);

    const resolved = await changeOwnerType(file, 'user');
    const saved: unknown = parse(await readFile(file, 'utf8'));

    expect(resolved.profile.owner_type).toBe('user');
    expect(saved).toEqual({
      owner_type: 'user',
      repository: { has_wiki: false },
      pages: { https_enforced: true },
      rulesets: [{ name: 'Main', target: 'branch', rules: [{ type: 'deletion' }] }],
      environments: [{ name: 'production', reviewers: [{ type: 'User', id: 1 }] }],
    });
  });

  test('puts the type at the top, after extends', async () => {
    const base = await write('top-base.yaml', 'repository: { has_wiki: false }\n');
    const file = await write('top.yaml', `extends: ${base}\nmerge: { allow_squash_merge: true }\n`);

    await changeOwnerType(file, 'user');

    expect(await readFile(file, 'utf8')).toBe(
      `extends: ${base}\nowner_type: user\nmerge: { allow_squash_merge: true }\n`,
    );
  });

  test('drops self review with the last reviewer', async () => {
    const file = await write(
      'self-review.yaml',
      'environments:\n  - name: production\n    prevent_self_review: true\n    reviewers: [{ type: Team, id: 3 }]\n',
    );

    await changeOwnerType(file, 'user');

    expect(parse(await readFile(file, 'utf8'))).toEqual({
      owner_type: 'user',
      environments: [{ name: 'production' }],
    });
  });

  test('changes draft rulesets and environments too', async () => {
    const file = await write(
      'draft-entries.yaml',
      `rulesets:
  - name: Pushes
    draft: true
    target: push
  - name: Main
    draft: true
    rules: [{ type: merge_queue }, { type: deletion }]
environments:
  - name: staging
    draft: true
    reviewers: [{ type: Team, id: 3 }]
`,
    );

    const before = await resolveProfile(file);
    await changeOwnerType(file, 'user');
    const after = await resolveProfile(file);

    expect(before.owner_changes.user.toSorted()).toEqual(
      ['drafts.environments/staging', 'drafts.rulesets/Main', 'drafts.rulesets/Pushes'].toSorted(),
    );
    expect(parse(await readFile(file, 'utf8'))).toEqual({
      owner_type: 'user',
      rulesets: [{ name: 'Main', draft: true, rules: [{ type: 'deletion' }] }],
      environments: [{ name: 'staging', draft: true }],
    });
    expect(after.warnings).toEqual([]);
  });

  test('warns of a draft entry the type lacks', async () => {
    const file = await write(
      'draft-push.yaml',
      'owner_type: user\nrulesets: [{ name: Pushes, draft: true, target: push }]\n',
    );

    expect((await resolveProfile(file)).warnings).toContain(
      'Draft ruleset "Pushes" is a push ruleset, which only organizations have',
    );
  });

  test('to any owner keeps every setting', async () => {
    const file = await write('org-to-any.yaml', organization);

    await changeOwnerType(file, undefined);
    const saved: unknown = parse(await readFile(file, 'utf8'));

    expect(saved).not.toHaveProperty('owner_type');
    expect(saved).toHaveProperty('repository', { allow_forking: true, has_wiki: false });
  });

  test('stops when a base profile sets what the type does not have', async () => {
    const base = await write('base-forks.yaml', 'repository: { allow_forking: true }\n');
    const file = await write('child-forks.yaml', `extends: ${base}\nrepository: { has_wiki: false }\n`);

    const error = await rejection(changeOwnerType(file, 'user'));

    expect(error).toBeInstanceOf(ProfileError);
    expect(String(error)).toContain(`because ${base}, which it builds on, sets repository.allow_forking`);
    expect(await readFile(file, 'utf8')).toBe(`extends: ${base}\nrepository: { has_wiki: false }\n`);
  });

  test('goes ahead when the file overrides what a base sets', async () => {
    const base = await write(
      'base-org-parts.yaml',
      'actions: { access_level: organization }\nrulesets: [{ name: Pushes, target: push }, { name: Tags, target: push }]\n',
    );
    const file = await write(
      'child-overrides.yaml',
      `extends: ${base}\nactions: { access_level: none }\nrulesets: [{ name: Pushes, absent: true }, { name: Tags, target: tag }]\n`,
    );

    const resolved = await changeOwnerType(file, 'user');

    expect(resolved.profile.owner_type).toBe('user');
  });

  test('names the base when the file sets the same thing as it', async () => {
    const base = await write('base-same.yaml', 'repository: { allow_forking: true }\n');
    const file = await write('child-same.yaml', `extends: ${base}\nrepository: { allow_forking: false }\n`);

    expect(String(await rejection(changeOwnerType(file, 'user')))).toContain(`because ${base}, which it builds on`);
  });

  test('fixes a child that a base made invalid by changing it to any owner', async () => {
    const base = await write('base-forking.yaml', 'repository: { allow_forking: true }\n');
    const file = await write(
      'child-invalid.yaml',
      `owner_type: user\nextends: ${base}\nrepository: { has_wiki: false }\n`,
    );
    expect(String(await rejection(resolveProfile(file)))).toContain('allow_forking');

    const resolved = await changeOwnerType(file, undefined);

    expect(resolved.profile.owner_type).toBeUndefined();
    expect(await readFile(file, 'utf8')).toBe(`extends: ${base}\nrepository: { has_wiki: false }\n`);
  });

  test('drops a drafts.unset key that names what the change takes out', async () => {
    const file = await write(
      'unset-taken.yaml',
      [
        'owner_type: organization',
        'repository: { allow_forking: true, has_wiki: false }',
        'rulesets: [{ name: Pushes, target: push }, { name: Main, target: branch }]',
        'drafts: { unset: [repository.allow_forking, rulesets/Pushes, rulesets/Main] }',
        '',
      ].join('\n'),
    );

    const resolved = await changeOwnerType(file, 'user');

    expect(resolved.warnings).toEqual([]);
    expect(parse(await readFile(file, 'utf8'))).toMatchObject({ drafts: { unset: ['rulesets/Main'] } });
  });

  test('keeps a comment over the first key at the top, and gives it back', async () => {
    const text = '# Profiles\n\n# Personal repositories\nrepository: { has_wiki: false }\n';
    const file = await write('commented.yaml', text);

    await changeOwnerType(file, 'user');
    const typed = await readFile(file, 'utf8');
    await changeOwnerType(file, undefined);

    expect(typed).toBe('# Profiles\n\n# Personal repositories\nowner_type: user\nrepository: { has_wiki: false }\n');
    expect(await readFile(file, 'utf8')).toBe(text);
  });

  test("keeps the next key's own comment when the type goes", async () => {
    const file = await write(
      'two-comments.yaml',
      '# About this profile\nowner_type: user\n# Repository settings\nrepository: { has_wiki: false }\n',
    );

    await changeOwnerType(file, undefined);

    expect(await readFile(file, 'utf8')).toBe(
      '# About this profile\n# Repository settings\nrepository: { has_wiki: false }\n',
    );
  });
});

describe('planning a typed profile', () => {
  test('refuses a repository of the other kind before it reads anything else', async () => {
    const github = new FakeGitHub({ ownerType: 'User' });

    const error = await rejection(
      createPlan(github, repo, { owner_type: 'organization', repository: { has_wiki: false } }),
    );

    expect(error).toBeInstanceOf(OwnerMismatchError);
    expect(String(error)).toContain("make a copy of the profile and change the copy's type to personal accounts");
    expect(github.calls).toEqual([{ method: 'GET', path: '/repos/lunch/app' }]);
  });

  test('plans for a repository of the same kind', async () => {
    const github = new FakeGitHub({ ownerType: 'User' });

    const plan = await createPlan(github, repo, { owner_type: 'user', repository: { has_wiki: false } });

    expect(plan.changes).toHaveLength(1);
  });

  test('refuses to apply once the repository belongs to the other kind of owner', async () => {
    const github = new FakeGitHub();
    const plan = await createPlan(github, repo, { owner_type: 'organization', repository: { has_wiki: false } });
    github.state.ownerType = 'User';

    expect(await rejection(applyPlan(github, plan))).toBeInstanceOf(OwnerMismatchError);
    expect(github.writes).toEqual([]);
  });

  test('keeps the type of the profile a staged apply starts from', async () => {
    const base = await write('staged-base.yaml', 'owner_type: organization\nrepository: { has_wiki: false }\n');
    const staged = await createStagedApply(path.join(directory, 'staged.yaml'), 'lunch/app', base);
    const github = new FakeGitHub({ ownerType: 'User' });

    expect(staged.profile.owner_type).toBe('organization');
    expect(await rejection(createPlan(github, repo, staged.profile))).toBeInstanceOf(OwnerMismatchError);
  });

  test('captures a personal repository without what personal accounts lack', async () => {
    const github = new FakeGitHub({ ownerType: 'User' });
    github.state.repository = {
      ...github.state.repository,
      allow_forking: true,
      security_and_analysis: {
        secret_scanning: { status: 'enabled' },
        secret_scanning_non_provider_patterns: { status: 'disabled' },
        secret_scanning_validity_checks: { status: 'disabled' },
      },
    };

    const { profile: captured, warnings } = await captureProfile(github, repo);

    expect(captured.repository).not.toHaveProperty('allow_forking');
    expect(captured.security?.security_and_analysis).toEqual({ secret_scanning: { status: 'enabled' } });
    expect(problems(captured)).toEqual([]);
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ section: 'repository', key: 'allow_forking', cause: 'unloadable' }),
        expect.objectContaining({
          section: 'security',
          key: 'security_and_analysis',
          field: 'secret_scanning_validity_checks',
        }),
      ]),
    );
  });

  test('captures the owner type', async () => {
    expect((await captureProfile(new FakeGitHub({ ownerType: 'User' }), repo)).profile.owner_type).toBe('user');
    expect((await captureProfile(new FakeGitHub(), repo)).profile.owner_type).toBe('organization');
  });
});

describe('the JSON Schema', () => {
  test('marks what only some owners have', () => {
    const schema = JSON.stringify(profileFileJsonSchema());

    expect(schema).toContain('"x-repotted-owner":"organization"');
    expect(schema).toContain('"x-repotted-owner":"enterprise"');
    expect(schema).toContain('"x-repotted-owner-values":{"user":"user","organization":"organization"}');
  });
});
