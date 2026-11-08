import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, test } from 'vitest';
import { parse } from 'yaml';

import {
  addToBatch,
  applyBatch,
  batchManifest,
  batchMemberFile,
  createBatch,
  discardBatch,
  discardBatchMember,
  editEverywhere,
  isBatchPlan,
  leaveOut,
  parseBatchPlan,
  planBatch,
  readBatch,
} from '../src/batch.js';
import { type GitHub, GitHubError } from '../src/github.js';
import { createStagedApply, editStagedApply, resolveStagedApply } from '../src/staged.js';
import { answered, FakeFleet, FakeGitHub } from './fake-github.js';

// The real path, because batches report real paths and macOS links its temporary folder.
const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'repotted-batch-')));

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

const profileText = 'repository: { has_wiki: false, has_issues: false }\n';

/** A fresh place with a profile, so tests never share files. */
async function place(text = profileText): Promise<{ root: string; profile: string; folder: string }> {
  const root = path.join(directory, randomUUID());
  await mkdir(root);
  const profile = path.join(root, 'profile.yaml');
  await writeFile(profile, text);
  return { root, profile, folder: path.join(root, 'batch') };
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

/** A plan document as `plan --staged <folder> --out` saves it, read back as apply reads it. */
function saved(document: unknown): ReturnType<typeof parseBatchPlan> {
  const data: unknown = JSON.parse(JSON.stringify(document));
  expect(isBatchPlan(data)).toBe(true);
  return parseBatchPlan(data);
}

function fleet(...names: string[]): { github: FakeFleet; fakes: FakeGitHub[] } {
  const fakes = names.map((name) => new FakeGitHub({}, name));
  return { github: new FakeFleet(fakes), fakes };
}

describe('starting a batch', () => {
  test('starts a staged apply for each repository from one profile, listed in a manifest', async () => {
    const { profile, folder } = await place();
    const batch = await createBatch(folder, { repositories: ['lunch/app', 'lunch/web'], profile });
    expect(batch.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(batch).toEqual({
      folder,
      id: batch.id,
      profile,
      members: [
        { repository: 'lunch/app', file: path.join(folder, 'lunch', 'app.yaml'), left_out: false, joined: false },
        { repository: 'lunch/web', file: path.join(folder, 'lunch', 'web.yaml'), left_out: false, joined: false },
      ],
    });
    // The manifest stores paths relative to the batch, so the folder can move as a whole.
    expect(parse(await readFile(path.join(folder, batchManifest), 'utf8'))).toEqual({
      id: batch.id,
      profile: '../profile.yaml',
      members: [
        { repository: 'lunch/app', file: 'lunch/app.yaml' },
        { repository: 'lunch/web', file: 'lunch/web.yaml' },
      ],
    });
    expect(await readBatch(folder)).toEqual(batch);
    expect((await resolveStagedApply(path.join(folder, 'lunch', 'web.yaml'))).base).toBe(profile);
  });

  test('refuses a repository that already has a staged apply, and leaves nothing behind', async () => {
    const { root, profile, folder } = await place();
    const existing = path.join(folder, 'lunch', 'web.yaml');
    await mkdir(path.dirname(existing), { recursive: true });
    await createStagedApply(existing, 'lunch/web', undefined);

    await expect(createBatch(folder, { repositories: ['lunch/app', 'lunch/web'], profile })).rejects.toThrow(
      /lunch\/web already has a staged apply .*--join/u,
    );
    expect(await exists(path.join(folder, 'lunch', 'app.yaml'))).toBe(false);
    expect(await exists(path.join(folder, batchManifest))).toBe(false);
    expect(await exists(existing)).toBe(true);
    // A folder the start made is removed again; the one with the staged apply in it stays.
    const fresh = path.join(root, 'fresh', 'batch');
    await expect(
      createBatch(fresh, { repositories: ['lunch/app'], profile: path.join(root, 'none.yaml') }),
    ).rejects.toThrow();
    expect(await exists(path.join(root, 'fresh'))).toBe(false);
    // A folder that was there before the start stays, even when the start fails.
    const kept = path.join(root, 'kept');
    await mkdir(kept);
    await expect(createBatch(kept, { repositories: ['lunch/app', 'lunch/app'], profile })).rejects.toThrow();
    expect(await exists(kept)).toBe(true);
  });

  test('keeps one staged apply for a repository however its name is written', async () => {
    const { profile, folder } = await place();
    const existing = path.join(folder, 'lunch', 'web.yaml');
    await mkdir(path.dirname(existing), { recursive: true });
    await createStagedApply(existing, 'lunch/web', undefined);
    await expect(createBatch(folder, { repositories: ['Lunch/Web'], profile })).rejects.toThrow(
      /already has a staged apply/u,
    );
    const batch = await createBatch(folder, { repositories: ['Lunch/App'], profile });
    expect(batch.members[0]).toMatchObject({ repository: 'Lunch/App', file: path.join(folder, 'lunch', 'app.yaml') });
  });

  test('joins a staged apply in progress as it is, which discarding the batch leaves', async () => {
    const { root, profile, folder } = await place();
    const existing = path.join(root, 'staged', 'lunch', 'web.yaml');
    await mkdir(path.dirname(existing), { recursive: true });
    await createStagedApply(existing, 'lunch/web', undefined);

    const batch = await createBatch(folder, {
      repositories: ['lunch/app'],
      join: [existing],
      profile,
      stagedFolder: path.join(root, 'staged'),
    });
    expect(batch.members).toEqual([
      { repository: 'lunch/web', file: existing, left_out: false, joined: true },
      { repository: 'lunch/app', file: path.join(root, 'staged', 'lunch', 'app.yaml'), left_out: false, joined: false },
    ]);
    expect(parse(await readFile(path.join(folder, batchManifest), 'utf8'))).toMatchObject({
      members: [{ file: '../staged/lunch/web.yaml', joined: true }, { file: '../staged/lunch/app.yaml' }],
    });

    await discardBatch(folder);
    expect(await exists(existing)).toBe(true);
    expect(await exists(path.join(root, 'staged', 'lunch', 'app.yaml'))).toBe(false);
    expect(await exists(folder)).toBe(false);
  });

  test('refuses a repository twice, a second batch in one folder, and a batch of none', async () => {
    const { profile, folder } = await place();
    await expect(createBatch(folder, { repositories: ['lunch/app', 'Lunch/App'], profile })).rejects.toThrow(
      /already in the batch/u,
    );
    await expect(createBatch(folder, { profile })).rejects.toThrow(/at least one repository/u);
    await createBatch(folder, { repositories: ['lunch/app'], profile });
    await expect(createBatch(folder, { repositories: ['lunch/web'], profile })).rejects.toThrow(
      /already holds a batch/u,
    );
    await expect(addToBatch(folder, { repositories: ['lunch/app'] })).rejects.toThrow(/already in the batch/u);
  });

  test('adds members from the batch profile, and takes one out with its staged apply', async () => {
    const { profile, folder } = await place();
    await createBatch(folder, { repositories: ['lunch/app'], profile });
    const added = await addToBatch(folder, { repositories: ['lunch/web'] });
    expect(added.members.map((member) => member.repository)).toEqual(['lunch/app', 'lunch/web']);
    const web = await batchMemberFile(folder, 'LUNCH/web');
    expect((await resolveStagedApply(web)).base).toBe(profile);

    const left = await discardBatchMember(folder, 'lunch/web');
    expect(left).toMatchObject({ file: web, kept: false });
    expect(left.batch?.members.map((member) => member.repository)).toEqual(['lunch/app']);
    expect(await exists(web)).toBe(false);
    expect(await discardBatchMember(folder, 'lunch/app')).toMatchObject({ kept: false, batch: null });
    expect(await exists(folder)).toBe(false);
  });

  test('takes a joined member out and keeps its staged apply', async () => {
    const { root, profile, folder } = await place();
    const existing = path.join(root, 'web.yaml');
    await createStagedApply(existing, 'lunch/web', undefined);
    await createBatch(folder, { repositories: ['lunch/app'], join: [existing], profile });
    expect(await discardBatchMember(folder, 'lunch/web')).toMatchObject({ file: existing, kept: true });
    expect(await exists(existing)).toBe(true);
  });

  test('removes no file that is not the staged apply the manifest says', async () => {
    const { profile, folder } = await place();
    await createBatch(folder, { repositories: ['lunch/app', 'lunch/web'], profile });
    const app = await batchMemberFile(folder, 'lunch/app');
    const web = await batchMemberFile(folder, 'lunch/web');
    await writeFile(web, 'apply_to: lunch/other\n');

    await expect(discardBatch(folder)).rejects.toThrow(/applies to lunch\/other, not lunch\/web/u);
    await expect(discardBatchMember(folder, 'lunch/web')).rejects.toThrow(/leaves it as it is/u);
    // Every file is checked before any goes, so the batch stays whole.
    expect(await exists(app)).toBe(true);
    expect(await exists(web)).toBe(true);
    expect((await readBatch(folder)).members).toHaveLength(2);
  });
});

describe('editing a batch', () => {
  test('excludes a value from every member whose profile sets it, and includes it again', async () => {
    const { profile, folder } = await place();
    await createBatch(folder, { repositories: ['lunch/app', 'lunch/web', 'lunch/api'], profile });
    const api = await batchMemberFile(folder, 'lunch/api');
    // An edit of the value in one member keeps that member as it is.
    await editStagedApply(api, [{ path: ['repository', 'has_wiki'], value: true }]);

    const excluded = await editEverywhere(folder, 'repository.has_wiki', true);
    expect(excluded.changed).toEqual(['lunch/app', 'lunch/web']);
    expect(excluded.refused.map((item) => item.repository)).toEqual(['lunch/api']);
    expect(excluded.refused[0]?.message).toMatch(/both excluded and edited/u);
    expect((await resolveStagedApply(await batchMemberFile(folder, 'lunch/web'))).exclude).toEqual([
      'repository.has_wiki',
    ]);

    const included = await editEverywhere(folder, 'repository.has_wiki', false);
    expect(included).toMatchObject({ changed: ['lunch/app', 'lunch/web'], refused: [] });
    await expect(editEverywhere(folder, 'repository.has_projects', true)).rejects.toThrow(/sets what it names/u);
    await expect(editEverywhere(folder, 'nothing', true)).rejects.toThrow(/names no section/u);
    await expect(editEverywhere(folder, 'repository.has_wiki', false)).rejects.toThrow(/No repository .* excludes/u);
  });

  test('says so when every member already excludes a value', async () => {
    const { profile, folder } = await place();
    await createBatch(folder, { repositories: ['lunch/app', 'lunch/web'], profile });
    await editEverywhere(folder, 'repository.has_wiki', true);
    await expect(editEverywhere(folder, 'repository.has_wiki', true)).rejects.toThrow(/already excludes/u);
  });

  test('leaves members out and puts them back, and plans only those in', async () => {
    const { profile, folder } = await place();
    await createBatch(folder, { repositories: ['lunch/app', 'lunch/web'], profile });
    expect((await leaveOut(folder, ['lunch/web'], true)).members[1]).toMatchObject({ left_out: true });
    await expect(leaveOut(folder, ['lunch/none'], true)).rejects.toThrow(/not in the batch/u);

    const { github } = fleet('lunch/app', 'lunch/web');
    const planned = await planBatch(github, folder);
    expect(planned.plans.map((member) => member.repository)).toEqual(['lunch/app']);
    expect(planned.left_out).toEqual([{ repository: 'lunch/web', file: path.join(folder, 'lunch', 'web.yaml') }]);

    await leaveOut(folder, ['lunch/web'], false);
    expect((await planBatch(github, folder)).plans).toHaveLength(2);
  });
});

describe('planning a batch', () => {
  test('plans each member with its access and locks, and reports one it cannot plan on its own', async () => {
    const { profile, folder } = await place();
    await createBatch(folder, { repositories: ['lunch/app', 'lunch/gone', 'lunch/web'], profile });
    const { github, fakes } = fleet('lunch/app', 'lunch/web');
    const web = fakes[1];
    if (web === undefined) {
      throw new Error('No fake for lunch/web');
    }
    web.state.viewer = { admin: false, maintain: false, push: true, triage: true, pull: true };

    const planned = await planBatch(github, folder);
    expect(planned).toMatchObject({ batch: folder, id: (await readBatch(folder)).id, profile, left_out: [] });
    expect(planned.plans.map((member) => member.repository)).toEqual(['lunch/app', 'lunch/web']);
    expect(planned.plans[0]).toMatchObject({
      file: path.join(folder, 'lunch', 'app.yaml'),
      locks: [],
      staged: { repository: 'lunch/app', base: profile, exclude: [] },
      exclusions: [
        { change: 0, field: 'has_issues', key: 'repository.has_issues', edited: false },
        { change: 0, field: 'has_wiki', key: 'repository.has_wiki', edited: false },
      ],
    });
    expect(planned.plans[0]?.changes).toHaveLength(1);
    expect(planned.plans[1]?.locks).toHaveLength(1);
    expect(planned.failures).toMatchObject([
      {
        repository: 'lunch/gone',
        file: path.join(folder, 'lunch', 'gone.yaml'),
        error: { kind: 'error', status: 404 },
      },
    ]);
    expect(planned.failures[0]?.error.message).toContain('Not Found');
    // Planning only reads.
    expect(fakes.flatMap((fake) => fake.writes)).toEqual([]);
  });

  test('reports a staged apply that no longer resolves as a failure of its member', async () => {
    const { folder, profile } = await place();
    await createBatch(folder, { repositories: ['lunch/app', 'lunch/web'], profile });
    await writeFile(await batchMemberFile(folder, 'lunch/web'), 'apply_to: lunch/other\n');
    const { github } = fleet('lunch/app', 'lunch/web');
    const planned = await planBatch(github, folder);
    expect(planned.plans.map((member) => member.repository)).toEqual(['lunch/app']);
    expect(planned.failures[0]).toMatchObject({ repository: 'lunch/web', error: { kind: 'error', status: null } });
    expect(planned.failures[0]?.error.message).toMatch(/applies to lunch\/other, not lunch\/web/u);
  });
});

test('plans at most four members at once', async () => {
  const { profile, folder } = await place();
  const names = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => `lunch/${name}`);
  await createBatch(folder, { repositories: names, profile });
  const { github } = fleet(...names);
  const inFlight = new Map<string, number>();
  let most = 0;
  // Holds each request open a moment, so members planned together overlap.
  const held: GitHub = {
    async request(method, requestPath, body) {
      const repository = /^\/repos\/([^/]+\/[^/?]+)/u.exec(requestPath)?.[1] ?? '';
      inFlight.set(repository, (inFlight.get(repository) ?? 0) + 1);
      most = Math.max(most, inFlight.size);
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return await github.request(method, requestPath, body);
      } finally {
        const count = (inFlight.get(repository) ?? 1) - 1;
        if (count === 0) {
          inFlight.delete(repository);
        } else {
          inFlight.set(repository, count);
        }
      }
    },
  };
  const planned = await planBatch(held, folder);
  expect(planned.plans.map((member) => member.repository)).toEqual(names);
  expect(most).toBe(4);
});

describe('applying a batch', () => {
  test('applies each member in order, ends its staged apply, and ends the batch with the last', async () => {
    const { folder, profile } = await place();
    await createBatch(folder, { repositories: ['lunch/app', 'lunch/web'], profile });
    const { github, fakes } = fleet('lunch/app', 'lunch/web');
    const reviewed = saved(await planBatch(github, folder));
    const seen: string[] = [];

    const results = await applyBatch(github, reviewed, { onResult: (result) => seen.push(result.repository) });
    expect(results).toMatchObject([
      { repository: 'lunch/app', status: 'applied', ended: true },
      { repository: 'lunch/web', status: 'applied', ended: true },
    ]);
    expect(seen).toEqual(['lunch/app', 'lunch/web']);
    expect(fakes.map((fake) => fake.writes)).toEqual([
      [{ method: 'PATCH', path: '/repos/lunch/app', body: { has_wiki: false, has_issues: false } }],
      [{ method: 'PATCH', path: '/repos/lunch/web', body: { has_wiki: false, has_issues: false } }],
    ]);
    expect(await exists(folder)).toBe(false);
    expect(await readFile(profile, 'utf8')).toBe(profileText);
  });

  test('goes on past a member that fails, and keeps the members that did not finish', async () => {
    const { folder, profile } = await place();
    await createBatch(folder, { repositories: ['lunch/app', 'lunch/web', 'lunch/api'], profile });
    const { github, fakes } = fleet('lunch/app', 'lunch/web', 'lunch/api');
    const reviewed = saved(await planBatch(github, folder));
    const [app, web] = fakes;
    if (app === undefined || web === undefined) {
      throw new Error('No fakes');
    }
    // lunch/app changes after the review; lunch/web refuses the write.
    app.state.repository['has_wiki'] = true;
    app.state.repository['has_issues'] = false;
    web.fail('PATCH /repos/lunch/web', answered(403, 'Resource not accessible by integration'));

    const results = await applyBatch(github, reviewed);
    expect(results).toMatchObject([
      { repository: 'lunch/app', status: 'stale', ended: false },
      {
        repository: 'lunch/web',
        status: 'apply_failed',
        applied: [],
        reason: 'Needs Administration write',
        ended: false,
      },
      { repository: 'lunch/api', status: 'applied', ended: true },
    ]);
    expect(app.writes).toEqual([]);
    expect((await readBatch(folder)).members.map((member) => member.repository)).toEqual(['lunch/app', 'lunch/web']);
    expect(await exists(path.join(folder, 'lunch', 'api.yaml'))).toBe(false);
  });

  test('stops after a failure when asked, and applies only the members named', async () => {
    const { folder, profile } = await place();
    await createBatch(folder, { repositories: ['lunch/app', 'lunch/web', 'lunch/api'], profile });
    const { github, fakes } = fleet('lunch/app', 'lunch/web', 'lunch/api');
    const reviewed = saved(await planBatch(github, folder));
    fakes[0]?.fail('PATCH /repos/lunch/app', new GitHubError(500, 'Server error'));

    const stopped = await applyBatch(github, reviewed, { stopOnFailure: true });
    expect(stopped.map((result) => result.status)).toEqual(['apply_failed', 'stopped', 'stopped']);
    // Only the write that failed was tried.
    expect(fakes.map((fake) => fake.writes.length)).toEqual([1, 0, 0]);

    const one = await applyBatch(github, reviewed, { only: ['LUNCH/web'] });
    expect(one).toMatchObject([{ repository: 'lunch/web', status: 'applied', ended: true }]);
    await expect(applyBatch(github, reviewed, { only: ['lunch/none'] })).rejects.toThrow(/no plan for lunch\/none/u);
  });

  test('skips a locked member, one left out since the review, and ends one already in line', async () => {
    const { folder, profile } = await place();
    await createBatch(folder, { repositories: ['lunch/app', 'lunch/web', 'lunch/api'], profile });
    const { github, fakes } = fleet('lunch/app', 'lunch/web', 'lunch/api');
    const [app, web, api] = fakes;
    if (app === undefined || web === undefined || api === undefined) {
      throw new Error('No fakes');
    }
    app.state.viewer = { admin: false, maintain: false, push: true, triage: true, pull: true };
    api.state.repository['has_wiki'] = false;
    api.state.repository['has_issues'] = false;
    const reviewed = saved(await planBatch(github, folder));
    await leaveOut(folder, ['lunch/web'], true);

    const results = await applyBatch(github, reviewed);
    expect(results).toMatchObject([
      { repository: 'lunch/app', status: 'locked', ended: false },
      { repository: 'lunch/web', status: 'left_out', ended: false },
      { repository: 'lunch/api', status: 'in_line', ended: true },
    ]);
    expect(fakes.flatMap((fake) => fake.writes)).toEqual([]);
    expect((await readBatch(folder)).members.map((member) => member.repository)).toEqual(['lunch/app', 'lunch/web']);
  });

  test('applies no plan reviewed before an edit to its staged apply, and keeps the edit', async () => {
    const { folder, profile } = await place();
    await createBatch(folder, { repositories: ['lunch/app'], profile });
    const { github, fakes } = fleet('lunch/app');
    const reviewed = saved(await planBatch(github, folder));
    const file = await batchMemberFile(folder, 'lunch/app');
    await editStagedApply(file, [{ exclude: 'repository.has_wiki', excluded: true }]);

    const results = await applyBatch(github, reviewed);
    expect(results).toMatchObject([{ repository: 'lunch/app', status: 'changed', ended: false }]);
    expect(fakes[0]?.writes).toEqual([]);
    expect(await exists(file)).toBe(true);
    expect((await readBatch(folder)).members).toHaveLength(1);
  });

  test('plans again a member reviewed as in line, and keeps it when the repository changed since', async () => {
    const { folder, profile } = await place();
    await createBatch(folder, { repositories: ['lunch/app'], profile });
    const { github, fakes } = fleet('lunch/app');
    const [app] = fakes;
    if (app === undefined) {
      throw new Error('No fake');
    }
    app.state.repository['has_wiki'] = false;
    app.state.repository['has_issues'] = false;
    const reviewed = saved(await planBatch(github, folder));
    expect(reviewed.plans[0]?.plan.changes).toEqual([]);
    app.state.repository['has_wiki'] = true;

    expect(await applyBatch(github, reviewed)).toMatchObject([{ status: 'stale', ended: false }]);
    expect(app.writes).toEqual([]);
    expect(await exists(await batchMemberFile(folder, 'lunch/app'))).toBe(true);
  });

  test('applies nothing once the batch ended, or a member left it, or the folder holds a new batch', async () => {
    const { folder, profile } = await place();
    await createBatch(folder, { repositories: ['lunch/app', 'lunch/web'], profile });
    const { github, fakes } = fleet('lunch/app', 'lunch/web');
    const reviewed = saved(await planBatch(github, folder));
    await discardBatchMember(folder, 'lunch/web');
    expect(await applyBatch(github, reviewed, { only: ['lunch/web'] })).toMatchObject([{ status: 'left_out' }]);

    await discardBatch(folder);
    expect(await applyBatch(github, reviewed)).toMatchObject([{ status: 'left_out' }, { status: 'left_out' }]);
    // A batch started again in the folder, from the same profile, is still another batch.
    await createBatch(folder, { repositories: ['lunch/app', 'lunch/web'], profile });
    expect(await applyBatch(github, reviewed)).toMatchObject([{ status: 'left_out' }, { status: 'left_out' }]);
    expect(fakes.flatMap((fake) => fake.writes)).toEqual([]);
    expect((await readBatch(folder)).members).toHaveLength(2);
  });

  test('fails one member, and keeps the results so far, when the manifest breaks partway', async () => {
    const { folder, profile } = await place();
    await createBatch(folder, { repositories: ['lunch/app', 'lunch/web'], profile });
    const { github, fakes } = fleet('lunch/app', 'lunch/web');
    const reviewed = saved(await planBatch(github, folder));
    const manifest = path.join(folder, batchManifest);

    // Written at once, so the next member reads the broken manifest.
    const results = await applyBatch(github, reviewed, { onResult: () => writeFileSync(manifest, 'id: [\n') });
    expect(results).toMatchObject([
      { repository: 'lunch/app', status: 'applied', ended: true },
      { repository: 'lunch/web', status: 'failed', error: { kind: 'error' } },
    ]);
    expect(fakes[1]?.writes).toEqual([]);
  });
});
