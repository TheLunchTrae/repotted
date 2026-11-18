import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, expect, test } from 'vitest';

import { type GitHub, parseRepo } from '../../src/github/client.js';
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
const policyText = (enforcement = 'active', name = 'Release'): string =>
  `kind: actions-policy\nactions_policies: [{ name: ${name}, enforcement: ${enforcement}, rules: [{ type: restrict_action_events, parameters: { allowed_events: [release, workflow_dispatch] } }] }]\n`;

test('several referenced policies compose with bases and whole inline overrides, retaining sources', async () => {
  const release = await write('release.yaml', policyText());
  const quality = await write('quality.yaml', policyText('active', 'Quality'));
  const base = await write(
    'base.yaml',
    'actions: { default_workflow_permissions: read }\nactions_policies: [{ name: Release, enforcement: disabled }]\n',
  );
  const file = await write(
    'service.yaml',
    'extends: base.yaml\nreferences: { actions_policies: [release.yaml, quality.yaml] }\n',
  );
  const resolved = await resolveProfile(file);
  expect(resolved.profile.actions_policies?.map((item) => item.name)).toEqual(['Release', 'Quality']);
  expect(resolved.sources.actions_policies).toEqual({ Release: release, Quality: quality });
  expect(resolved.sources.actions).toEqual({ default_workflow_permissions: base });
  await editProfile(file, [
    { list: 'actions_policies', name: 'Release', entry: { name: 'Release', enforcement: 'evaluate' } },
  ]);
  expect((await resolveProfile(file)).profile.actions_policies?.[0]).toEqual({
    name: 'Release',
    enforcement: 'evaluate',
  });
  expect((await resolveProfile(file)).references).toEqual({ actions_policies: ['release.yaml', 'quality.yaml'] });
  expect((await listProfiles(folder)).find((item) => item.file === file)).toMatchObject({
    extends: base,
    references: [release, quality],
  });
});

test('direct, referenced, and inline-text definitions produce the same reviewed policy writes', async () => {
  const file = await write('standalone.yaml', policyText());
  const consumer = await write('consumer.yaml', 'references: { actions_policies: [standalone.yaml] }');
  const github = new FakeGitHub();
  const direct = await createPlan(github, repo, (await resolveProfile(file)).profile);
  expect((await createPlan(github, repo, (await resolveProfile(consumer)).profile)).changes).toEqual(direct.changes);
  expect(
    (
      await createPlan(
        github,
        repo,
        (await parseProfile('references: { actions_policies: [standalone.yaml] }', folder)).profile,
      )
    ).changes,
  ).toEqual(direct.changes);
  await applyPlan(github, parsePlan(JSON.parse(JSON.stringify(direct))));
  expect(github.writes).toEqual([
    {
      method: 'POST',
      path: '/repos/lunch/app/actions/policies',
      body: {
        name: 'Release',
        enforcement: 'active',
        rules: [{ type: 'restrict_action_events', parameters: { allowed_events: ['release', 'workflow_dispatch'] } }],
      },
    },
  ]);
  expect((await createPlan(github, repo, direct.desired)).changes).toEqual([]);
});

test('an explicitly repeated reference reapplies after an earlier inline override', async () => {
  await write('shared.yaml', policyText());
  const first = await write(
    'first.yaml',
    'references: { actions_policies: [shared.yaml] }\nactions_policies: [{ name: Release, enforcement: disabled }]',
  );
  const second = await write('second.yaml', 'references: { actions_policies: [shared.yaml] }');
  expect((await resolveProfilesTogether([first, second])).profile.actions_policies?.[0]).toMatchObject({
    enforcement: 'active',
  });
});

test('missing, wrong-kind, duplicate-target, cross-section, and inherited definitions block resolution', async () => {
  await expect(parseProfile('references: { actions_policies: [nonexistent.yaml] }', folder)).rejects.toThrow(
    'Cannot read reusable definition',
  );
  await write('ordinary.yaml', 'actions_policies: [{ name: Release }]');
  await expect(parseProfile('references: { actions_policies: [ordinary.yaml] }', folder)).rejects.toThrow(
    'not a reusable actions_policies definition',
  );
  await expect(parseProfile('kind: actions-policy\nactions: { enabled: true }', folder)).rejects.toThrow(
    'may only set that section',
  );
  await expect(
    parseProfile('kind: actions-policy\nactions_policies: [{ name: Release }, { name: Quality }]', folder),
  ).rejects.toThrow('exactly one target');
  await write('same-a.yaml', policyText());
  await write('same-b.yaml', policyText());
  await expect(parseProfile('references: { actions_policies: [same-a.yaml, same-b.yaml] }', folder)).rejects.toThrow(
    'supplied by both',
  );
  const inherited = await write('inherited.yaml', 'extends: same-a.yaml');
  await expect(resolveProfilesTogether([inherited])).rejects.toThrow('use references instead of extends');
  await expect(resolveProfile(inherited)).rejects.toThrow('use references instead of extends');
  await expect(parseProfile('references: { action: missing.yaml }', folder)).rejects.toThrow('Unrecognized key');
});

test('saved and staged plans refuse changed or missing shared policies before writes', async () => {
  const policy = await write('changing.yaml', policyText());
  const file = await write('changing-profile.yaml', 'references: { actions_policies: [changing.yaml] }');
  const github = new FakeGitHub();
  const plan = parsePlan(
    JSON.parse(
      JSON.stringify({
        ...(await createPlan(github, repo, (await resolveProfile(file)).profile)),
        source: { profile: file },
      }),
    ),
  );
  const stagedFile = path.join(folder, 'apply.yaml');
  await createStagedApply(stagedFile, 'lunch/app', [policy]);
  const staged = (await planStagedApply(github, stagedFile)).plan;
  await writeFile(policy, policyText('disabled'));
  await expect(applyPlan(github, plan)).rejects.toBeInstanceOf(StalePlanError);
  await expect(applyPlan(github, staged)).rejects.toBeInstanceOf(StalePlanError);
  await rm(policy);
  await expect(applyPlan(github, plan)).rejects.toThrow('Cannot read reusable definition');
  expect(github.writes).toEqual([]);
});

test('capture selects exactly one repository policy and reads only policy endpoints and owner metadata', async () => {
  const github = new FakeGitHub({
    policies: [
      {
        id: 1,
        name: 'Release',
        enforcement: 'active',
        target: 'actions',
        rules: [{ type: 'restrict_action_events', parameters: { allowed_events: ['release'] } }],
      },
      { id: 2, name: 'Release', enforcement: 'active', target: 'actions', source_type: 'Organization', rules: [] },
    ],
  });
  const { definition } = await captureDefinition(github, repo, 'actions-policy', 'Release');
  expect(definition).toEqual({
    kind: 'actions-policy',
    owner_type: 'organization',
    actions_policies: [
      {
        name: 'Release',
        enforcement: 'active',
        rules: [{ type: 'restrict_action_events', parameters: { allowed_events: ['release'] } }],
      },
    ],
  });
  expect(github.calls.map((call) => call.path)).toEqual([
    '/repos/lunch/app',
    '/repos/lunch/app/actions/policies?has_parents=false&per_page=100&page=1',
    '/repos/lunch/app/actions/policies/1',
  ]);
  await expect(captureDefinition(github, repo, 'actions-policy', 'missing')).rejects.toThrow('found 0');
  expect(github.writes).toEqual([]);
});

test('policy drafts retain a named target while staying outside the applying profile', async () => {
  const file = await write('draft-policy.yaml', policyText());
  await editProfile(file, [
    { list: 'actions_policies', name: 'Release', entry: { name: 'Release', draft: true, enforcement: 'unfinished' } },
  ]);
  const resolved = await resolveProfile(file);
  expect(resolved.profile.actions_policies).toBeUndefined();
  expect(resolved.drafts.actions_policies).toEqual([{ name: 'Release', draft: true, enforcement: 'unfinished' }]);
  await editProfile(file, [
    { list: 'actions_policies', name: 'Release', draft: true, entry: { name: 'Release', enforcement: 'active' } },
  ]);
  expect((await resolveProfile(file)).profile.actions_policies).toEqual([{ name: 'Release', enforcement: 'active' }]);
});

test('discovery retains references when unrelated invalid configuration prevents resolution', async () => {
  const policy = await write('referenced-by-invalid.yaml', policyText());
  const consumer = await write(
    'invalid-consumer.yaml',
    'references: { actions_policies: [referenced-by-invalid.yaml] }\nrepository: { has_wiki: broken }',
  );
  const listing = (await listProfiles(folder)).find((item) => item.file === consumer);
  expect(listing?.problem).not.toBeNull();
  expect(listing?.references).toEqual([policy]);
});

test.each(['profile', 'staged'] as const)('a policy edit during %s revalidation refuses stale writes', async (kind) => {
  const file = await write(`race-${kind}.yaml`, policyText());
  const staged = path.join(folder, `race-${kind}-apply.yaml`);
  await createStagedApply(staged, 'lunch/app', [file]);
  const fake = new FakeGitHub();
  const planned = (await planStagedApply(fake, staged)).plan;
  const reviewed = kind === 'staged' ? planned : { ...planned, source: { profile: file } };
  const held = Promise.withResolvers<undefined>();
  const reading = Promise.withResolvers<undefined>();
  const github: GitHub = {
    request: async (...args) => {
      if (args[0] === 'GET') {
        reading.resolve(undefined);
        await held.promise;
      }
      return fake.request(...args);
    },
  };
  const applying = applyPlan(github, reviewed);
  await reading.promise;
  await writeFile(file, policyText('disabled'));
  held.resolve(undefined);
  await expect(applying).rejects.toThrow('changed while');
  expect(fake.writes).toEqual([]);
});

test('a later profile deleting an earlier policy is visible in staged warnings', async () => {
  const first = await write('protect-workflows.yaml', policyText());
  const later = await write('remove-workflow-policy.yaml', 'actions_policies: [{ name: Release, absent: true }]');
  const staged = await createStagedApply(path.join(folder, 'policy-override.yaml'), 'lunch/app', [first, later]);
  expect(staged.warnings).toEqual([
    'remove-workflow-policy.yaml removes the Actions policy "Release" that protect-workflows.yaml adds, since later profiles override earlier ones',
  ]);
});
