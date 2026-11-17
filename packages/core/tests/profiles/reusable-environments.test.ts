import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';
import { parse } from 'yaml';

import { GitHubError, parseRepo } from '../../src/github/client.js';
import { applyPlan, createPlan, parsePlan, StalePlanError } from '../../src/plan/plan.js';
import { captureDefinition } from '../../src/profiles/definitions.js';
import { editProfile, resolveProfile } from '../../src/profiles/profile.js';
import { createStagedApply, planStagedApply } from '../../src/staging/staged.js';
import { FakeGitHub } from '../support/fake-github.js';

const folders: string[] = [];
const repo = parseRepo('lunch/app');

afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

async function files(contents: Record<string, string>): Promise<string> {
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), 'repotted-environment-')));
  folders.push(folder);
  await Promise.all(Object.entries(contents).map(([name, text]) => writeFile(path.join(folder, name), text)));
  return folder;
}

const production = 'kind: environment\nenvironments: [{ name: production, wait_timer: 15 }]\n';

test('direct and referenced environments update the same target and preserve omitted live protection', async () => {
  const folder = await files({
    'production.yaml': production,
    'service.yaml': 'references: { environments: [./production.yaml] }\n',
  });
  const github = new FakeGitHub({
    environments: [
      {
        name: 'Production',
        wait_timer: 5,
        prevent_self_review: true,
        reviewers: [{ type: 'User', id: 12 }],
        deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
        branch_policies: [{ id: 3, name: 'release/*', type: 'branch' }],
      },
      {
        name: 'preview',
        wait_timer: 0,
        prevent_self_review: false,
        reviewers: [],
        deployment_branch_policy: null,
        branch_policies: [],
      },
    ],
  });
  const direct = await resolveProfile(path.join(folder, 'production.yaml'));
  const consumer = await resolveProfile(path.join(folder, 'service.yaml'));
  const directPlan = await createPlan(github, repo, direct.profile);
  const referencedPlan = await createPlan(github, repo, consumer.profile);
  expect(referencedPlan.changes).toEqual(directPlan.changes);
  expect(referencedPlan.changes.map((change) => change.request)).toEqual([
    {
      method: 'PUT',
      path: '/repos/lunch/app/environments/Production',
      body: {
        wait_timer: 15,
        prevent_self_review: true,
        reviewers: [{ type: 'User', id: 12 }],
        deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
      },
    },
  ]);
  await applyPlan(github, referencedPlan);
  expect(github.state.environments.map((entry) => entry.name)).toEqual(['preview', 'Production']);
  expect(github.state.environments.find((entry) => entry.name === 'Production')?.branch_policies).toEqual([
    { id: 3, name: 'release/*', type: 'branch' },
  ]);
  expect((await createPlan(github, repo, consumer.profile)).changes).toEqual([]);
});

test('rejects referenced environment names that differ only in case', async () => {
  const folder = await files({
    'first.yaml': production,
    'second.yaml': 'kind: environment\nenvironments: [{ name: PRODUCTION, wait_timer: 30 }]\n',
    'service.yaml': 'references: { environments: [./first.yaml, ./second.yaml] }\n',
  });
  await expect(resolveProfile(path.join(folder, 'service.yaml'))).rejects.toThrow(/production|PRODUCTION/u);
});

test('inline environment overrides replace a referenced target without changing its definition', async () => {
  const folder = await files({
    'production.yaml': production,
    'service.yaml':
      'references: { environments: [./production.yaml] }\nenvironments: [{ name: PRODUCTION, wait_timer: 30 }]\n',
  });
  const file = path.join(folder, 'service.yaml');
  expect((await resolveProfile(file)).profile.environments).toEqual([{ name: 'PRODUCTION', wait_timer: 30 }]);
  await editProfile(file, [
    { list: 'environments', name: 'PRODUCTION', entry: { name: 'Production', wait_timer: 45 } },
  ]);
  const saved: unknown = parse(await readFile(file, 'utf8'));
  expect(saved).toMatchObject({ references: { environments: ['./production.yaml'] } });
  expect(await readFile(path.join(folder, 'production.yaml'), 'utf8')).toBe(production);
  expect((await resolveProfile(file)).profile.environments).toEqual([{ name: 'Production', wait_timer: 45 }]);
});

test('rejects a missing or wrong-kind environment reference rather than resolving to an empty profile', async () => {
  const folder = await files({
    'wrong.yaml': 'actions: { enabled: false }\n',
    'missing.yaml': 'references: { environments: [./missing-definition.yaml] }\n',
    'service.yaml': 'references: { environments: [./wrong.yaml] }\n',
  });
  await expect(resolveProfile(path.join(folder, 'missing.yaml'))).rejects.toThrow(/missing-definition/u);
  await expect(resolveProfile(path.join(folder, 'service.yaml'))).rejects.toThrow(/environment/u);
});

test('validates reviewers against the consumer owner type after resolving references', async () => {
  const folder = await files({
    'production.yaml': 'kind: environment\nenvironments: [{ name: production, reviewers: [{ type: Team, id: 12 }] }]\n',
    'service.yaml': 'owner_type: user\nreferences: { environments: [./production.yaml] }\n',
  });
  await expect(resolveProfile(path.join(folder, 'service.yaml'))).rejects.toThrow(/Team|organization/u);
});

test('a saved environment contains exactly one target and no unrelated sections', async () => {
  const folder = await files({
    'empty.yaml': 'kind: environment\nenvironments: []\n',
    'several.yaml': 'kind: environment\nenvironments: [{ name: production }, { name: preview }]\n',
    'unrelated.yaml': `${production}repository: { has_wiki: false }\n`,
  });
  for (const name of ['empty.yaml', 'several.yaml', 'unrelated.yaml']) {
    await expect(resolveProfile(path.join(folder, name))).rejects.toThrow();
  }
});

test('a referenced environment change requires fresh review before a saved staged plan writes', async () => {
  const folder = await files({
    'production.yaml': production,
    'service.yaml': 'references: { environments: [./production.yaml] }\n',
  });
  const staged = path.join(folder, 'apply.yaml');
  const github = new FakeGitHub();
  await createStagedApply(staged, 'lunch/app', [path.join(folder, 'service.yaml')]);
  const reviewed = parsePlan(JSON.parse(JSON.stringify((await planStagedApply(github, staged)).plan)));
  await writeFile(path.join(folder, 'production.yaml'), production.replace('15', '30'));

  await expect(applyPlan(github, reviewed)).rejects.toBeInstanceOf(StalePlanError);
  expect(github.writes).toEqual([]);
});

test('captures one environment by case-insensitive name without reading unrelated sections', async () => {
  const github = new FakeGitHub({
    environments: [
      {
        name: 'Production',
        wait_timer: 15,
        prevent_self_review: true,
        reviewers: [{ type: 'User', id: 7 }],
        deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
        branch_policies: [{ id: 2, name: 'v*', type: 'tag' }],
      },
    ],
  }).fail('GET /repos/lunch/app/actions/permissions', new GitHubError(403, 'No Actions access'));
  const captured = await captureDefinition(github, repo, 'environment', 'production');
  expect(captured).toEqual({
    definition: {
      kind: 'environment',
      owner_type: 'organization',
      environments: [
        {
          name: 'Production',
          wait_timer: 15,
          prevent_self_review: true,
          reviewers: [{ type: 'User', id: 7 }],
          deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
          branch_policies: [{ name: 'v*', type: 'tag' }],
        },
      ],
    },
    warnings: [],
  });
  expect(github.writes).toEqual([]);
});

test('refuses captures with missing targets or unreadable protection instead of saving an empty definition', async () => {
  const github = new FakeGitHub();
  await expect(captureDefinition(github, repo, 'environment', 'missing')).rejects.toThrow(/missing/u);
  github.fail('GET /repos/lunch/app/environments', new GitHubError(403, 'No environment access'));
  await expect(captureDefinition(github, repo, 'environment', 'production')).rejects.toThrow(/permission|access/iu);
  expect(github.writes).toEqual([]);
});
