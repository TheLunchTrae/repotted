// The engine on the page's in-memory files: each test runs one of its file
// flows end to end, so a file function the engine needs and the page lacks,
// or one that answers differently from Node's, fails here.

import {
  applyBatch,
  createBatch,
  createStagedApply,
  discardBatch,
  editProfile,
  editStagedApply,
  listProfiles,
  parseBatchPlan,
  planBatch,
  planStagedApply,
} from '@repotted/core';
import { afterEach, expect, test } from 'vitest';

import { FakeFleet, FakeGitHub } from '../../core/tests/fake-github.js';
import { mkdir, readdir, readFile, rm, rmdir, watchFiles, writeFile } from '../src/engine/files.js';

afterEach(async () => {
  await rm('/', { recursive: true });
});

async function names(folder: string): Promise<string[]> {
  return (await readdir(folder, { withFileTypes: true })).map((entry) => entry.name).sort();
}

test('resolves, lists and edits profiles that extend one another across folders', async () => {
  await mkdir('/profiles/teams', { recursive: true });
  await writeFile('/profiles/base.yaml', 'repository: { has_wiki: false }\nmerge: { allow_squash_merge: true }\n');
  await writeFile('/profiles/teams/web.yaml', '# Web team\nextends: ../base.yaml\nrepository: { has_wiki: true }\n');

  const listed = await listProfiles('/profiles');
  expect(listed.map((profile) => profile.file)).toEqual(['/profiles/base.yaml', '/profiles/teams/web.yaml']);

  const edited = await editProfile('/profiles/teams/web.yaml', [
    { path: ['merge', 'allow_squash_merge'], value: false },
  ]);

  expect(edited.profile).toMatchObject({ repository: { has_wiki: true }, merge: { allow_squash_merge: false } });
  expect(edited.chain).toEqual(['/profiles/teams/web.yaml', '/profiles/base.yaml']);
  expect(await readFile('/profiles/teams/web.yaml', 'utf8')).toContain('# Web team');
  // The edit replaces the file through a temporary one beside it, which must not stay.
  expect(await names('/profiles/teams')).toEqual(['web.yaml']);
});

test('stages an apply over a profile, plans it and refuses to stage over a file that exists', async () => {
  await mkdir('/profiles', { recursive: true });
  await mkdir('/staged', { recursive: true });
  await writeFile('/profiles/base.yaml', 'repository: { has_wiki: false }\n');
  const github = new FakeGitHub({ repository: { has_wiki: true, has_issues: true } });

  await createStagedApply('/staged/app.yaml', 'lunch/app', '/profiles/base.yaml');
  await editStagedApply('/staged/app.yaml', [{ path: ['repository', 'has_issues'], value: false }]);
  const { plan } = await planStagedApply(github, '/staged/app.yaml');

  expect(plan.changes.flatMap((change) => change.fields.map((field) => field.field)).sort()).toEqual([
    'has_issues',
    'has_wiki',
  ]);
  await expect(createStagedApply('/staged/app.yaml', 'lunch/app', '/profiles/base.yaml')).rejects.toMatchObject({
    cause: { code: 'EEXIST' },
  });
});

test('plans and applies a batch, then leaves no file or folder of it behind', async () => {
  await mkdir('/profiles', { recursive: true });
  await writeFile('/profiles/base.yaml', 'repository: { has_wiki: false }\n');
  const fleet = new FakeFleet([
    new FakeGitHub({ repository: { has_wiki: true } }, 'lunch/app'),
    new FakeGitHub({ repository: { has_wiki: true } }, 'lunch/site'),
  ]);

  await createBatch('/batch', { profile: '/profiles/base.yaml', repositories: ['lunch/app', 'lunch/site'] });
  expect(await names('/batch')).toEqual(['batch.yaml', 'lunch']);
  const plan = await planBatch(fleet, '/batch');
  const results = await applyBatch(fleet, parseBatchPlan(JSON.parse(JSON.stringify(plan))));

  expect(results.map((result) => result.status)).toEqual(['applied', 'applied']);
  // Each applied member's staged apply goes, then its owner's folder, then the batch itself.
  await expect(readdir('/batch', { withFileTypes: true })).rejects.toMatchObject({ code: 'ENOENT' });

  await createBatch('/batch', { profile: '/profiles/base.yaml', repositories: ['lunch/app'] });
  await discardBatch('/batch');
  await expect(readdir('/batch', { withFileTypes: true })).rejects.toMatchObject({ code: 'ENOENT' });
});

test('tells watchers of each file written, replaced, moved and removed, by its absolute path', async () => {
  const seen: [string, string | undefined][] = [];
  const stop = watchFiles((file, content) => {
    seen.push([file, content === undefined ? undefined : new TextDecoder().decode(content)]);
  });
  await mkdir('/profiles/teams', { recursive: true });

  await writeFile('/profiles/teams/../a.yaml', 'one');
  await writeFile('/profiles/teams/b.yaml', 'two');
  await rm('/profiles/teams', { recursive: true });
  stop();
  await writeFile('/profiles/c.yaml', 'three');

  expect(seen).toEqual([
    ['/profiles/a.yaml', 'one'],
    ['/profiles/teams/b.yaml', 'two'],
    ['/profiles/teams/b.yaml', undefined],
  ]);
});

test('keeps a folder that holds something when asked to remove it empty', async () => {
  await mkdir('/batch/lunch', { recursive: true });
  await writeFile('/batch/lunch/app.yaml', '');

  await expect(rmdir('/batch/lunch')).rejects.toMatchObject({ code: 'ENOTEMPTY' });
  await expect(rm('/batch/lunch')).rejects.toMatchObject({ code: 'EISDIR' });
  expect(await names('/batch')).toEqual(['lunch']);
});
