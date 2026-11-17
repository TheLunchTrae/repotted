import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, expect, test } from 'vitest';

import { parseRepo } from '../../src/github/client.js';
import { applyPlan, createPlan, parsePlan, StalePlanError } from '../../src/plan/plan.js';
import { captureDefinition } from '../../src/profiles/definitions.js';
import {
  editProfile,
  listProfiles,
  parseProfile,
  resolveProfile,
  resolveProfilesTogether,
} from '../../src/profiles/profile.js';
import { createStagedApply, planStagedApply } from '../../src/staging/staged.js';
import { FakeGitHub } from '../support/fake-github.js';

const folder = await realpath(await mkdtemp(path.join(tmpdir(), 'repotted-definitions-')));
afterAll(async () => rm(folder, { recursive: true, force: true }));
const repo = parseRepo('lunch/app');
async function write(name: string, text: string): Promise<string> {
  const file = path.join(folder, name);
  await writeFile(file, text);
  return file;
}

test('references resolve between bases and inline settings with original sources', async () => {
  const policy = await write(
    'trusted.yaml',
    'kind: actions-policy\nactions: { allowed_actions: selected, selected_actions: { github_owned_allowed: true } }\n',
  );
  const base = await write('base.yaml', 'actions: { allowed_actions: all, default_workflow_permissions: read }\n');
  const file = await write(
    'service.yaml',
    'extends: base.yaml\nreferences: { actions: trusted.yaml }\nactions: { selected_actions: { verified_allowed: true } }\n',
  );
  const resolved = await resolveProfile(file);
  expect(resolved.profile.actions).toEqual({
    allowed_actions: 'selected',
    default_workflow_permissions: 'read',
    selected_actions: { github_owned_allowed: true, verified_allowed: true },
  });
  expect(resolved.sources.actions).toEqual({
    allowed_actions: policy,
    default_workflow_permissions: base,
    'selected_actions.github_owned_allowed': policy,
    'selected_actions.verified_allowed': file,
  });
  await editProfile(file, [{ path: ['actions', 'selected_actions', 'verified_allowed'], value: false }]);
  expect(await readFile(file, 'utf8')).toContain('references: { actions: trusted.yaml }');
  expect((await listProfiles(folder)).find((listing) => listing.file === file)).toMatchObject({
    extends: base,
    references: [policy],
  });
});

test('direct, referenced, and inline-text policies yield identical Actions-only changes', async () => {
  const policy = await write(
    'standalone.yaml',
    'kind: actions-policy\nactions: { default_workflow_permissions: read }\n',
  );
  const consumer = await write('consumer.yaml', 'references: { actions: standalone.yaml }\n');
  const github = new FakeGitHub();
  const direct = await createPlan(github, repo, (await resolveProfile(policy)).profile);
  const referenced = await createPlan(github, repo, (await resolveProfile(consumer)).profile);
  const inline = await createPlan(
    github,
    repo,
    (await parseProfile('references: { actions: standalone.yaml }', folder)).profile,
  );
  expect(direct.changes.length).toBeGreaterThan(0);
  expect(referenced.changes).toEqual(direct.changes);
  expect(inline.changes).toEqual(direct.changes);
  await applyPlan(github, direct);
  expect(github.writes.every((call) => call.path.includes('/actions/'))).toBe(true);
});

test('an explicitly repeated reference in a later profile reapplies after earlier inline values', async () => {
  await write('shared.yaml', 'kind: actions-policy\nactions: { default_workflow_permissions: read }\n');
  const first = await write(
    'first.yaml',
    'references: { actions: shared.yaml }\nactions: { default_workflow_permissions: write }\n',
  );
  const second = await write('second.yaml', 'references: { actions: shared.yaml }\n');
  expect((await resolveProfilesTogether([first, second])).profile.actions?.default_workflow_permissions).toBe('read');
});

test('missing, wrong-kind, cross-section, inherited, and dependency conflicts block resolution', async () => {
  await expect(parseProfile('references: { actions: nonexistent.yaml }', folder)).rejects.toThrow(
    'Cannot read reusable definition',
  );
  await write('ordinary.yaml', 'actions: { enabled: false }');
  await expect(parseProfile('references: { actions: ordinary.yaml }', folder)).rejects.toThrow(
    'not a reusable actions definition',
  );
  await expect(
    parseProfile('kind: actions-policy\nactions: {}\nrepository: { has_wiki: false }', folder),
  ).rejects.toThrow('may only set that section');
  await write('disabled.yaml', 'kind: actions-policy\nactions: { enabled: false }');
  await expect(
    parseProfile(
      'references: { actions: disabled.yaml }\nsecurity: { code_scanning_default_setup: { state: configured } }',
      folder,
    ),
  ).rejects.toThrow('Enable Actions');
  const inherited = await write('inherited.yaml', 'extends: disabled.yaml');
  await expect(resolveProfilesTogether([inherited])).rejects.toThrow('use references instead of extends');
  await expect(resolveProfile(inherited)).rejects.toThrow('use references instead of extends');
  await expect(parseProfile('extends: disabled.yaml', folder)).rejects.toThrow('use references instead of extends');
});

test('a saved source-aware plan refuses changed and missing shared policy before writes', async () => {
  const policy = await write('changing.yaml', 'kind: actions-policy\nactions: { default_workflow_permissions: read }');
  const file = await write('changing-profile.yaml', 'references: { actions: changing.yaml }');
  const github = new FakeGitHub();
  const plan = parsePlan(
    JSON.parse(
      JSON.stringify({
        ...(await createPlan(github, repo, (await resolveProfile(file)).profile)),
        source: { profile: file },
      }),
    ),
  );
  await writeFile(policy, 'kind: actions-policy\nactions: { default_workflow_permissions: write }');
  await expect(applyPlan(github, plan)).rejects.toBeInstanceOf(StalePlanError);
  expect(github.writes).toEqual([]);
  await rm(policy);
  await expect(applyPlan(github, plan)).rejects.toThrow('Cannot read reusable definition');
  expect(github.writes).toEqual([]);
});

test('staged apply re-resolves shared policies without silently changing reviewed writes', async () => {
  const policy = await write(
    'staged-policy.yaml',
    'kind: actions-policy\nactions: { default_workflow_permissions: read }',
  );
  const stagedFile = path.join(folder, 'apply.yaml');
  await createStagedApply(stagedFile, 'lunch/app', [policy]);
  const github = new FakeGitHub();
  const { plan } = await planStagedApply(github, stagedFile);
  await writeFile(policy, 'kind: actions-policy\nactions: { default_workflow_permissions: write }');
  await expect(applyPlan(github, plan)).rejects.toBeInstanceOf(StalePlanError);
  expect(github.writes).toEqual([]);
});

test('capturing a policy reads Actions and owner metadata without reading unrelated sections', async () => {
  const github = new FakeGitHub();
  const { definition } = await captureDefinition(github, repo, 'actions-policy');
  expect(definition.kind).toBe('actions-policy');
  expect(definition.actions?.enabled).toBe(true);
  expect(github.calls.every((call) => call.path === '/repos/lunch/app' || call.path.includes('/actions/'))).toBe(true);
  expect(github.writes).toEqual([]);
});

test('policy editor can draft removing settings and remove the last managed setting', async () => {
  const file = await write(
    'empty-policy.yaml',
    'kind: actions-policy\nactions: { default_workflow_permissions: read }',
  );
  await editProfile(file, [{ path: ['drafts', 'unset'], value: ['actions.default_workflow_permissions'] }]);
  expect((await resolveProfile(file)).drafts.unset).toEqual(['actions.default_workflow_permissions']);
  await editProfile(file, [
    { path: ['drafts', 'unset'], value: undefined },
    { path: ['actions', 'default_workflow_permissions'], value: undefined },
  ]);
  expect((await resolveProfile(file)).profile.actions).toBeUndefined();
  await expect(editProfile(file, [{ path: ['drafts', 'unset'], value: ['repository.has_wiki'] }])).rejects.toThrow(
    'may only set that section',
  );
});

test('discovery retains dependencies when an unrelated field prevents resolution', async () => {
  const policy = await write('referenced-by-invalid.yaml', 'kind: actions-policy\nactions: {}');
  const consumer = await write(
    'invalid-consumer.yaml',
    'references: { actions: referenced-by-invalid.yaml }\nrepository: { has_wiki: broken }',
  );
  const listing = (await listProfiles(folder)).find((item) => item.file === consumer);
  expect(listing?.problem).not.toBeNull();
  expect(listing?.references).toEqual([policy]);
});

test('unknown reference kinds are errors rather than silently empty profiles', async () => {
  await expect(parseProfile('references: { action: missing.yaml }', folder)).rejects.toThrow('Unrecognized key');
});
