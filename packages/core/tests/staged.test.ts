import { randomUUID } from 'node:crypto';
import type * as FileSystem from 'node:fs/promises';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, test, vi } from 'vitest';
import { stringify } from 'yaml';

import { ApplyError, applyPlan, parsePlan, StalePlanError } from '../src/plan.js';
import { ProfileError } from '../src/profile.js';
import {
  createStagedApply,
  discardStagedApply,
  editStagedApply,
  planStagedApply,
  previewStagedApply,
  resolveStagedApply,
  saveStagedEdits,
} from '../src/staged.js';
import { FakeGitHub } from './fake-github.js';

// By name rather than by import, since a typed mock takes only one signature of the overloaded readFile.
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof FileSystem>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

// The real path, because staged applies report real paths and macOS links its temporary folder.
const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'repotted-staged-')));

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** A fresh folder with a profile, so tests never share files. */
async function folder(profileText: string): Promise<{ profile: string; staged: string }> {
  const name = randomUUID();
  const profile = path.join(directory, `profile-${name}.yaml`);
  await writeFile(profile, profileText);
  return { profile, staged: path.join(directory, `staged-${name}.yaml`) };
}

const base = `
repository: { has_wiki: false, delete_branch_on_merge: true }
rulesets:
  - name: Main
    target: branch
    enforcement: active
    bypass_actors: []
    rules: [{ type: deletion }]
`;

/** A repository that offers every setting the wide profile names, at GitHub's defaults. */
const offered = {
  settings: {
    '/immutable-releases': { enabled: false, enforced_by_owner: false },
    '/interaction-limits/pulls/creation-cap': { enabled: false, max_open_pull_requests: 10, include_drafts: true },
    '/vulnerability-alerts': false,
    '/code-scanning/default-setup': { state: 'not-configured', query_suite: 'default', languages: [] },
    '/actions/permissions/artifact-and-log-retention': { days: 90, maximum_allowed_days: 400 },
    '/actions/cache/storage-limit': { max_cache_size_gb: 10 },
    '/actions/oidc/customization/sub': { use_default: true },
    '/properties/values': [{ property_name: 'team', value: null }],
    '/pages': null,
  },
};

/** A profile that changes something in every section, so its plan has every kind of change. */
const wide = {
  repository: {
    has_wiki: false,
    topics: ['tools'],
    immutable_releases: true,
    pull_request_creation_cap: { enabled: true, max_open_pull_requests: 3 },
  },
  security: {
    vulnerability_alerts: true,
    code_scanning_default_setup: { state: 'configured', query_suite: 'extended' },
  },
  actions: {
    allowed_actions: 'selected',
    selected_actions: { github_owned_allowed: true },
    default_workflow_permissions: 'read',
    artifact_and_log_retention: { days: 30 },
    max_cache_size_gb: 5,
    oidc_customization_sub: { use_default: false, include_claim_keys: ['repo'] },
  },
  custom_properties: { team: 'platform' },
  pages: { build_type: 'workflow' },
  autolinks: [{ key_prefix: 'JIRA-', url_template: 'https://jira.example.com/browse/<num>' }],
  rulesets: [
    { name: 'Main', target: 'branch', enforcement: 'active', bypass_actors: [], rules: [{ type: 'deletion' }] },
  ],
  environments: [
    {
      name: 'Prod',
      wait_timer: 5,
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
      branch_policies: [{ name: 'main', type: 'branch' }],
    },
  ],
};

function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

function targets(changes: readonly { action: string; target: string }[]): string[] {
  return changes.map((change) => `${change.action} ${change.target}`);
}

/** Makes the next read of `file` give its text as it is now, and then gives the file `next`, as another program might. */
async function replacedAfterNextRead(file: string, next: string): Promise<void> {
  const text = await readFile(file, 'utf8');
  vi.mocked(readFile).mockImplementationOnce(async (read) => {
    expect(read).toBe(file);
    await writeFile(file, next);
    return text;
  });
}

describe('staged apply', () => {
  test('starts from a profile and resolves to it until edited', async () => {
    const files = await folder(base);
    const staged = await createStagedApply(files.staged, 'lunch/app', files.profile);

    expect(staged.repository).toBe('lunch/app');
    expect(staged.base).toBe(files.profile);
    expect(staged.chain).toEqual([files.staged, files.profile]);
    expect(staged.profile.repository).toEqual({ has_wiki: false, delete_branch_on_merge: true });
    expect(staged.sources['repository']).toEqual({ has_wiki: files.profile, delete_branch_on_merge: files.profile });
  });

  test('never replaces a staged apply that already exists', async () => {
    const files = await folder(base);
    await createStagedApply(files.staged, 'lunch/app', files.profile);
    await editStagedApply(files.staged, [{ path: ['repository', 'has_wiki'], value: true }]);

    expect(await rejection(createStagedApply(files.staged, 'lunch/app', undefined))).toBeInstanceOf(ProfileError);
    expect((await resolveStagedApply(files.staged)).profile.repository?.has_wiki).toBe(true);
  });

  test('writes nothing when the profile it would start from does not resolve', async () => {
    const files = await folder('repository: { no_such_setting: true }\n');

    expect(await rejection(createStagedApply(files.staged, 'lunch/app', files.profile))).toBeInstanceOf(ProfileError);
    expect(await rejection(readFile(files.staged))).toBeInstanceOf(Error);
  });

  test('starts from the repository as it is when it names no profile', async () => {
    const files = await folder(base);
    await createStagedApply(files.staged, 'lunch/app', undefined);
    const github = new FakeGitHub();

    expect((await planStagedApply(github, files.staged)).plan.changes).toEqual([]);

    await editStagedApply(files.staged, [{ path: ['repository', 'has_issues'], value: false }]);
    const { staged, plan } = await planStagedApply(github, files.staged);
    expect(staged.base).toBeNull();
    expect(plan.changes.flatMap((change) => change.fields)).toEqual([{ field: 'has_issues', from: true, to: false }]);
  });

  test('lays one-off edits over the profile and leaves the profile file as it is', async () => {
    const files = await folder(base);
    await createStagedApply(files.staged, 'lunch/app', files.profile);
    await editStagedApply(files.staged, [
      {
        list: 'rulesets',
        name: 'Main',
        entry: {
          name: 'Main',
          target: 'branch',
          enforcement: 'disabled',
          bypass_actors: [],
          rules: [{ type: 'deletion' }],
        },
      },
    ]);
    const github = new FakeGitHub();
    const { staged, plan } = await planStagedApply(github, files.staged);

    expect(staged.sources['rulesets']).toEqual({ Main: files.staged });
    expect(plan.desired.rulesets).toEqual([
      { name: 'Main', target: 'branch', enforcement: 'disabled', bypass_actors: [], rules: [{ type: 'deletion' }] },
    ]);
    expect(await readFile(files.profile, 'utf8')).toBe(base);

    await applyPlan(github, plan);
    expect(github.state.rulesets.map((ruleset) => `${ruleset.name} ${ruleset.enforcement}`)).toEqual(['Main disabled']);
  });

  test('previews one-off edits without writing them, and refuses what an edit would', async () => {
    const { profile, staged } = await folder('repository:\n  has_wiki: true\n');
    await createStagedApply(staged, 'lunch/app', profile);
    const text = await readFile(staged, 'utf8');

    const preview = await previewStagedApply(staged, [{ path: ['repository', 'has_wiki'], value: false }]);

    expect(preview.before.profile.repository).toEqual({ has_wiki: true });
    expect(preview.after.profile.repository).toEqual({ has_wiki: false });
    expect(preview.after.sources.repository['has_wiki']).toBe(staged);
    expect(await readFile(staged, 'utf8')).toBe(text);
    await expect(previewStagedApply(staged, [{ path: ['repository', 'has_wiki'], value: 'maybe' }])).rejects.toThrow(
      ProfileError,
    );
  });

  test('leaves out what it excludes, and stops excluding it again', async () => {
    const files = await folder(base);
    await createStagedApply(files.staged, 'lunch/app', files.profile);
    const excluded = await editStagedApply(files.staged, [
      { exclude: 'repository.has_wiki', excluded: true },
      { exclude: 'rulesets/Main', excluded: true },
    ]);

    expect(excluded.exclude).toEqual(['repository.has_wiki', 'rulesets/Main']);
    expect(excluded.profile).toEqual({ repository: { delete_branch_on_merge: true }, rulesets: [] });
    expect(excluded.sources['repository']).toEqual({ delete_branch_on_merge: files.profile });
    expect(excluded.sources['rulesets']).toEqual({});
    expect(targets((await planStagedApply(new FakeGitHub(), files.staged)).plan.changes)).toEqual([
      'update repository settings',
    ]);

    const restored = await editStagedApply(files.staged, [{ exclude: 'rulesets/Main', excluded: false }]);
    expect(restored.exclude).toEqual(['repository.has_wiki']);
    expect(restored.profile.rulesets?.map((entry) => entry.name)).toEqual(['Main']);
  });

  test('excludes a whole section, a group of settings, and a list entry by its key', async () => {
    const files = await folder(`
actions: { allowed_actions: selected, selected_actions: { github_owned_allowed: true, verified_allowed: false } }
environments: [{ name: Production }]
merge: { allow_rebase_merge: false }
`);
    await createStagedApply(files.staged, 'lunch/app', files.profile);
    const staged = await editStagedApply(files.staged, [
      { exclude: 'merge', excluded: true },
      { exclude: 'actions.selected_actions', excluded: true },
      // GitHub treats environment names as case-insensitive.
      { exclude: 'environments/production', excluded: true },
    ]);

    expect(staged.profile).toEqual({ actions: { allowed_actions: 'selected' }, environments: [] });
    expect(staged.sources['actions']).toEqual({ allowed_actions: files.profile });
  });

  test('refuses an exclusion that names nothing, or that clashes with an edit, and keeps the file', async () => {
    const files = await folder(base);
    await createStagedApply(files.staged, 'lunch/app', files.profile);
    await editStagedApply(files.staged, [{ path: ['repository', 'has_wiki'], value: true }]);
    const before = await readFile(files.staged, 'utf8');

    const unknown = await rejection(editStagedApply(files.staged, [{ exclude: 'repository.no_such', excluded: true }]));
    expect(unknown).toBeInstanceOf(ProfileError);
    const clash = await rejection(editStagedApply(files.staged, [{ exclude: 'repository.has_wiki', excluded: true }]));
    expect(clash instanceof ProfileError ? clash.message : '').toContain('both excluded and edited');
    expect(await readFile(files.staged, 'utf8')).toBe(before);
  });

  test('refuses an edit that the profile it starts from makes invalid', async () => {
    const files = await folder(
      'merge: { squash_merge_commit_title: PR_TITLE, squash_merge_commit_message: PR_BODY }\n',
    );
    await createStagedApply(files.staged, 'lunch/app', files.profile);
    const before = await readFile(files.staged, 'utf8');

    // COMMIT_OR_PR_TITLE goes only with COMMIT_MESSAGES, which the profile does not set.
    const failure = await rejection(
      editStagedApply(files.staged, [{ path: ['merge', 'squash_merge_commit_title'], value: 'COMMIT_OR_PR_TITLE' }]),
    );
    expect(failure instanceof ProfileError ? failure.message : '').toContain('GitHub does not allow');
    expect(await readFile(files.staged, 'utf8')).toBe(before);
  });

  test('refuses its plan when the repository changed after review', async () => {
    const files = await folder(base);
    await createStagedApply(files.staged, 'lunch/app', files.profile);
    const github = new FakeGitHub();
    const { plan } = await planStagedApply(github, files.staged);
    github.state.repository['has_wiki'] = false;

    const failure = await rejection(applyPlan(github, parsePlan(JSON.parse(JSON.stringify(plan)))));
    expect(failure).toBeInstanceOf(StalePlanError);
    expect(github.writes).toEqual([]);
  });

  test('applies what was reviewed even when the profile changes after review', async () => {
    const files = await folder(base);
    await createStagedApply(files.staged, 'lunch/app', files.profile);
    const github = new FakeGitHub();
    const { plan } = await planStagedApply(github, files.staged);
    await writeFile(files.profile, 'repository: { has_issues: false }\n');

    await applyPlan(github, plan);
    expect(github.state.repository['has_issues']).toBe(true);
    expect(github.state.repository['has_wiki']).toBe(false);
  });

  test('reports what was applied when a write fails partway', async () => {
    const files = await folder(base);
    await createStagedApply(files.staged, 'lunch/app', files.profile);
    const github = new FakeGitHub();
    const { plan } = await planStagedApply(github, files.staged);
    github.fail(/^POST /u, new Error('boom'), 1);

    const failure = await rejection(applyPlan(github, plan));
    expect(failure instanceof ApplyError ? failure.applied.map((change) => change.target) : []).toEqual([
      'repository settings',
    ]);
    // The staged apply is untouched, so planning it again shows what is left.
    expect(targets((await planStagedApply(github, files.staged)).plan.changes)).toEqual(['create Main']);
  });

  test('saves its edits to the profile and then resolves the same', async () => {
    const files = await folder(base);
    await createStagedApply(files.staged, 'lunch/app', files.profile);
    const edited = await editStagedApply(files.staged, [
      { path: ['repository', 'has_wiki'], value: true },
      { exclude: 'repository.delete_branch_on_merge', excluded: true },
    ]);

    const saved = await saveStagedEdits(files.staged);
    expect(saved.profile).toEqual(edited.profile);
    expect(saved.sources['repository']).toEqual({ has_wiki: files.profile });
    expect(saved.exclude).toEqual(['repository.delete_branch_on_merge']);
    const profile = await readFile(files.profile, 'utf8');
    expect(profile).toContain('has_wiki: true');
    expect(profile).toContain('delete_branch_on_merge: true');
  });

  test('keeps a change made while its edits are saved, and says the edits were not cleared', async () => {
    const files = await folder(base);
    await createStagedApply(files.staged, 'lunch/app', files.profile);
    await editStagedApply(files.staged, [{ path: ['repository', 'has_wiki'], value: true }]);
    const changed = `apply_to: lunch/app\nextends: ${path.basename(files.profile)}\nrepository: { has_wiki: false }\n`;
    await replacedAfterNextRead(files.staged, changed);

    const error = await rejection(saveStagedEdits(files.staged));

    expect(error).toBeInstanceOf(ProfileError);
    expect(String(error)).toContain('not cleared');
    expect(await readFile(files.profile, 'utf8')).toContain('has_wiki: true');
    expect(await readFile(files.staged, 'utf8')).toBe(changed);
  });

  test('has no profile to save edits to when it starts from the repository', async () => {
    const files = await folder(base);
    await createStagedApply(files.staged, 'lunch/app', undefined);
    await editStagedApply(files.staged, [{ path: ['repository', 'has_wiki'], value: true }]);

    const before = await readFile(files.staged, 'utf8');

    expect(await rejection(saveStagedEdits(files.staged))).toBeInstanceOf(ProfileError);
    expect(await readFile(files.staged, 'utf8')).toBe(before);
    expect(await readFile(files.profile, 'utf8')).toBe(base);
  });

  test('saves a group of settings and a new ruleset to the profile', async () => {
    const files =
      await folder(`${base}actions: { allowed_actions: selected, selected_actions: { github_owned_allowed: true } }
`);
    await createStagedApply(files.staged, 'lunch/app', files.profile);
    const release = { name: 'Release', target: 'tag', enforcement: 'active', bypass_actors: [], rules: [] };
    const edited = await editStagedApply(files.staged, [
      { path: ['actions', 'selected_actions', 'verified_allowed'], value: true },
      { list: 'rulesets', name: 'Release', entry: release },
    ]);

    const saved = await saveStagedEdits(files.staged);
    expect(saved.profile).toEqual(edited.profile);
    expect(saved.sources['rulesets']).toEqual({ Main: files.profile, Release: files.profile });
    expect(saved.sources['actions']).toMatchObject({ 'selected_actions.verified_allowed': files.profile });
    expect(await readFile(files.staged, 'utf8')).not.toContain('Release');
  });

  test('refuses to save autolinks, or a change between a Pages site and none, and changes neither file', async () => {
    const files = await folder(`${base}pages: { build_type: workflow }
`);
    const profileText = await readFile(files.profile, 'utf8');
    await createStagedApply(files.staged, 'lunch/app', files.profile);
    await editStagedApply(files.staged, [{ path: ['pages', 'absent'], value: true }]);
    const withoutPages = await readFile(files.staged, 'utf8');

    const pages = await rejection(saveStagedEdits(files.staged));
    expect(pages instanceof ProfileError ? pages.message : '').toContain('Pages site');
    expect(await readFile(files.staged, 'utf8')).toBe(withoutPages);

    await writeFile(
      files.staged,
      stringify({
        apply_to: 'lunch/app',
        extends: path.basename(files.profile),
        autolinks: [{ key_prefix: 'JIRA-', url_template: 'https://jira.example.com/browse/<num>' }],
      }),
    );
    const withAutolinks = await readFile(files.staged, 'utf8');
    expect(await rejection(saveStagedEdits(files.staged))).toBeInstanceOf(ProfileError);
    expect(await readFile(files.staged, 'utf8')).toBe(withAutolinks);
    expect(await readFile(files.profile, 'utf8')).toBe(profileText);
  });

  test('checks the profile only once its exclusions are left out', async () => {
    const files = await folder('security: { vulnerability_alerts: true, automated_security_fixes: true }\n');
    await createStagedApply(files.staged, 'lunch/app', files.profile);

    const staged = await editStagedApply(files.staged, [
      { path: ['security', 'vulnerability_alerts'], value: false },
      { exclude: 'security.automated_security_fixes', excluded: true },
    ]);
    expect(staged.profile).toEqual({ security: { vulnerability_alerts: false } });
    expect((await resolveStagedApply(files.staged)).profile).toEqual(staged.profile);
  });

  test('refuses an exclusion that leaves nothing out, and knows an environment by any case', async () => {
    const files = await folder(`${base}environments: [{ name: Prod }]
`);
    await createStagedApply(files.staged, 'lunch/app', files.profile);
    const before = await readFile(files.staged, 'utf8');

    // Ruleset names keep their case, so this names no ruleset of the profile.
    const typo = await rejection(editStagedApply(files.staged, [{ exclude: 'rulesets/main', excluded: true }]));
    expect(typo instanceof ProfileError ? typo.message : '').toContain('sets nothing it names');
    expect(await readFile(files.staged, 'utf8')).toBe(before);

    await editStagedApply(files.staged, [{ exclude: 'environments/Prod', excluded: true }]);
    const again = await editStagedApply(files.staged, [{ exclude: 'environments/prod', excluded: true }]);
    expect(again.exclude).toEqual(['environments/Prod']);
    const included = await editStagedApply(files.staged, [{ exclude: 'environments/PROD', excluded: false }]);
    expect(included.exclude).toEqual([]);
    expect(included.profile.environments?.map((entry) => entry.name)).toEqual(['Prod']);
  });

  test("leaves a change out with its own environment, though its target reads as another's", async () => {
    // The branch policy's target, "Prod: branch main", is also the second environment's name.
    const files = await folder(`environments:
  - name: Prod
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }
    branch_policies: [{ name: main }]
  - name: 'Prod: branch main'
`);
    await createStagedApply(files.staged, 'lunch/app', files.profile);
    const { plan, exclusions } = await planStagedApply(new FakeGitHub(), files.staged);

    expect(plan.changes.map((change) => `${change.action} ${change.target}`)).toEqual([
      'create Prod',
      'create Prod: branch main',
      'create Prod: branch main',
    ]);
    expect(exclusions.map((exclusion) => exclusion.key)).toEqual([
      'environments/Prod',
      'environments/Prod: branch main',
      'environments/Prod',
    ]);
  });

  test('warns when its profile changes so that an exclusion leaves nothing out', async () => {
    const files = await folder(base);
    await createStagedApply(files.staged, 'lunch/app', files.profile);
    await editStagedApply(files.staged, [{ exclude: 'rulesets/Main', excluded: true }]);
    await writeFile(files.profile, 'repository: { has_wiki: false }\n');

    const warning = 'Excluding rulesets/Main leaves nothing out, since the profile sets nothing it names';
    expect((await resolveStagedApply(files.staged)).warnings).toEqual([warning]);
    expect((await planStagedApply(new FakeGitHub(), files.staged)).plan.warnings).toContainEqual({
      exclusion: 'rulesets/Main',
      message: warning,
    });
  });

  test('names what leaves out every change and field of its plan, each of which then leaves the plan', async () => {
    const files = await folder(stringify(wide));
    await createStagedApply(files.staged, 'lunch/app', files.profile);
    await editStagedApply(files.staged, [{ path: ['merge', 'allow_squash_merge'], value: false }]);
    const { plan, exclusions } = await planStagedApply(new FakeGitHub(offered), files.staged);

    // Every field of a settings change, and every change to an entry, has its exclusion.
    const entries = new Set(['rulesets', 'environments', 'autolinks', 'pages']);
    for (const [index, change] of plan.changes.entries()) {
      const named = exclusions.filter((exclusion) => exclusion.change === index);
      expect(named.map((exclusion) => exclusion.field)).toEqual(
        entries.has(change.section) ? [null] : change.fields.map((field) => field.field),
      );
    }
    expect(exclusions.filter((exclusion) => exclusion.edited).map((exclusion) => exclusion.key)).toEqual([
      'merge.allow_squash_merge',
    ]);
    expect(exclusions.find((exclusion) => exclusion.key.startsWith('environments/'))?.key).toBe('environments/Prod');

    for (const exclusion of exclusions.filter((each) => !each.edited)) {
      const change = plan.changes[exclusion.change];
      const copy = path.join(directory, `staged-${randomUUID()}.yaml`);
      await writeFile(copy, await readFile(files.staged, 'utf8'));
      await editStagedApply(copy, [{ exclude: exclusion.key, excluded: true }]);
      const left = (await planStagedApply(new FakeGitHub(offered), copy)).plan.changes.filter(
        (other) => other.section === change?.section && other.target.startsWith(change.target),
      );
      expect(
        exclusion.field === null
          ? left
          : left.filter((other) => other.fields.some((field) => field.field === exclusion.field)),
      ).toEqual([]);
    }
  });

  test.each([
    ['shows', (file: string) => resolveStagedApply(file)],
    ['plans', async (file: string) => (await planStagedApply(new FakeGitHub(), file)).staged],
  ])('%s its file as one read found it, though the file changes meanwhile', async (_, read) => {
    const files = await folder(base);
    await createStagedApply(files.staged, 'lunch/app', files.profile);
    await editStagedApply(files.staged, [
      { path: ['repository', 'has_wiki'], value: true },
      { exclude: 'repository.delete_branch_on_merge', excluded: true },
    ]);
    await replacedAfterNextRead(
      files.staged,
      `apply_to: lunch/app\nextends: ${path.basename(files.profile)}\nrepository: { has_issues: false }\n`,
    );

    const staged = await read(files.staged);

    expect(staged.exclude).toEqual(['repository.delete_branch_on_merge']);
    expect(staged.profile.repository).toEqual({ has_wiki: true });
  });

  test('edits its file as one read found it, though the file changes meanwhile', async () => {
    const files = await folder(base);
    await createStagedApply(files.staged, 'lunch/app', files.profile);
    await editStagedApply(files.staged, [{ exclude: 'repository.delete_branch_on_merge', excluded: true }]);
    await replacedAfterNextRead(
      files.staged,
      `apply_to: lunch/app\nextends: ${path.basename(files.profile)}\nrepository: { has_issues: false }\n`,
    );

    const edited = await editStagedApply(files.staged, [{ path: ['repository', 'has_wiki'], value: true }]);

    expect(edited.exclude).toEqual(['repository.delete_branch_on_merge']);
    expect(edited.profile.repository).toEqual({ has_wiki: true });
    expect(await readFile(files.staged, 'utf8')).toContain('- repository.delete_branch_on_merge');
  });

  test('discards only a staged apply file', async () => {
    const files = await folder(base);
    await createStagedApply(files.staged, 'lunch/app', files.profile);

    expect(await rejection(discardStagedApply(files.profile))).toBeInstanceOf(ProfileError);
    expect(await readFile(files.profile, 'utf8')).toBe(base);
    await discardStagedApply(files.staged);
    expect(await rejection(readFile(files.staged))).toBeInstanceOf(Error);
  });

  test('leaves the drafts of the profile it starts from out of its plan, and lists them', async () => {
    const files = await folder(`${base}  - name: Release
    target: tag
    draft: true
drafts:
  repository: { has_projects: false }
`);
    const staged = await createStagedApply(files.staged, 'lunch/app', files.profile);

    expect(staged.drafts).toEqual({
      repository: { has_projects: false },
      rulesets: [{ name: 'Release', target: 'tag', draft: true }],
    });
    expect(staged.sources.drafts['rulesets']).toEqual({ Release: files.profile });
    const { plan } = await planStagedApply(new FakeGitHub(), files.staged);
    expect(plan.skipped).toEqual([
      { section: 'repository', target: 'has_projects' },
      { section: 'rulesets', target: 'Release' },
    ]);
    expect(targets(plan.changes)).not.toContain('create Release');
  });

  test('holds no drafts of its own, and cannot exclude the drafts of its profile', async () => {
    const files = await folder(base);
    await createStagedApply(files.staged, 'lunch/app', files.profile);
    const before = await readFile(files.staged, 'utf8');

    const setting = await rejection(
      editStagedApply(files.staged, [{ path: ['drafts', 'repository', 'has_wiki'], value: true }]),
    );
    expect(setting instanceof ProfileError ? setting.message : '').toContain('cannot hold drafts');
    const entry = await rejection(
      editStagedApply(files.staged, [
        { list: 'rulesets', name: 'Release', entry: { name: 'Release', target: 'tag', draft: true } },
      ]),
    );
    expect(entry instanceof ProfileError ? entry.message : '').toContain('cannot hold drafts');
    expect(await rejection(editStagedApply(files.staged, [{ exclude: 'drafts', excluded: true }]))).toBeInstanceOf(
      ProfileError,
    );
    expect(await readFile(files.staged, 'utf8')).toBe(before);
  });
});
