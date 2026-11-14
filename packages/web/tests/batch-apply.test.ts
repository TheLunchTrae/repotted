import { afterEach, expect, test } from 'vitest';

import { answered, FakeFleet, FakeGitHub } from '../../core/tests/fake-github.js';
import { Apply } from '../src/app/apply.js';
import { BatchApply } from '../src/app/batch-apply.js';
import { mkdir, readFile, rm, writeFile } from '../src/engine/files.js';

afterEach(async () => {
  await rm('/', { recursive: true });
});

const profile = { file: '/profiles/web.yaml', name: 'web', folder: '/profiles' };
const text = 'repository:\n  has_wiki: false\n  has_projects: false\n';

async function saved(content = text): Promise<void> {
  await mkdir('/profiles', { recursive: true });
  await writeFile(profile.file, content);
}

function fleet(...names: string[]): { github: FakeFleet; of: (name: string) => FakeGitHub } {
  const fakes = names.map((name) => new FakeGitHub({}, name));
  return {
    github: new FakeFleet(fakes),
    of: (name) => fakes.find((fake) => fake.fullName === name) ?? new FakeGitHub(),
  };
}

function writes(fake: FakeGitHub): string[] {
  return fake.calls.filter((call) => call.method !== 'GET').map((call) => `${call.method} ${call.path}`);
}

function statuses(batch: BatchApply): string[] {
  const state = batch.state.value;
  return state.kind === 'reviewed'
    ? state.members.map((member) => `${member.repository} ${member.status} ${member.changes}`)
    : [`not reviewed: ${state.kind}`];
}

test('a batch reviews each repository, writes nothing until asked, and then writes each one', async () => {
  await saved();
  const { github, of } = fleet('lunch/app', 'lunch/api');
  of('lunch/api').state.repository['has_wiki'] = false;
  of('lunch/api').state.repository['has_projects'] = false;
  const batch = new BatchApply(github, () => undefined);

  await batch.start(['lunch/app', 'lunch/api'], profile);

  expect(statuses(batch)).toEqual(['lunch/app changes 1', 'lunch/api in-line 0']);
  expect(batch.changes.value).toEqual([
    { key: 'repository.has_projects', repositories: 1 },
    { key: 'repository.has_wiki', repositories: 1 },
  ]);
  expect(writes(of('lunch/app'))).toEqual([]);
  expect(await batch.unfinished()).toBe(true);

  await batch.apply();

  expect(batch.state.value).toMatchObject({
    kind: 'applied',
    left: 0,
    results: [
      { repository: 'lunch/app', finished: true, said: '1 change written.' },
      { repository: 'lunch/api', finished: true },
    ],
  });
  expect(writes(of('lunch/app'))).toEqual(['PATCH /repos/lunch/app']);
  expect(writes(of('lunch/api'))).toEqual([]);
  expect(of('lunch/app').state.repository).toMatchObject({ has_wiki: false, has_projects: false });
  // Every repository finished, so the batch has ended.
  expect(await batch.unfinished()).toBe(false);
});

test('a change left out everywhere, in one repository, or a repository left out, stays unwritten', async () => {
  await saved();
  const { github, of } = fleet('lunch/app', 'lunch/api', 'lunch/web');
  const batch = new BatchApply(github, () => undefined);
  await batch.start(['lunch/app', 'lunch/api', 'lunch/web'], profile);

  await batch.everywhere('repository.has_wiki', true);
  await batch.leaveOut('lunch/api', 'repository.has_projects', true);
  await batch.leaveOutRepository('lunch/web', true);

  expect(statuses(batch)).toEqual(['lunch/app changes 1', 'lunch/api in-line 0', 'lunch/web left-out 0']);
  expect(batch.leftOut.value).toEqual(['repository.has_wiki', 'repository.has_projects']);
  expect(await readFile(profile.file, 'utf8')).toBe(text);

  await batch.apply();

  expect(of('lunch/app').state.repository).toMatchObject({ has_wiki: true, has_projects: false });
  expect(of('lunch/api').state.repository).toMatchObject({ has_wiki: true, has_projects: true });
  expect(writes(of('lunch/web'))).toEqual([]);
  // The one left out is still in the batch, to put back or discard.
  expect(batch.state.value).toMatchObject({ kind: 'applied', left: 1 });

  await batch.reviewAgain();
  await batch.leaveOutRepository('lunch/web', false);
  await batch.everywhere('repository.has_wiki', false);
  expect(statuses(batch)).toEqual(['lunch/web changes 1']);
});

test('a repository that changed since the review, or that GitHub refuses, is not written and stays in the batch', async () => {
  await saved();
  const { github, of } = fleet('lunch/app', 'lunch/api', 'lunch/web');
  const batch = new BatchApply(github, () => undefined);
  await batch.start(['lunch/app', 'lunch/api', 'lunch/web'], profile);

  of('lunch/app').state.repository['has_wiki'] = false;
  of('lunch/api').fail('PATCH /repos/lunch/api', answered(422, 'Validation Failed'), 1);
  await batch.apply();

  const state = batch.state.value;
  expect(state).toMatchObject({ kind: 'applied', left: 2 });
  const said =
    state.kind === 'applied' ? state.results.map((result) => `${result.repository} ${String(result.finished)}`) : [];
  // Those that didn't finish come first.
  expect(said).toEqual(['lunch/app false', 'lunch/api false', 'lunch/web true']);
  expect(writes(of('lunch/app'))).toEqual([]);
  expect(of('lunch/web').state.repository).toMatchObject({ has_wiki: false, has_projects: false });

  await batch.reviewAgain();
  expect(statuses(batch)).toEqual(['lunch/app changes 1', 'lunch/api changes 1']);
});

test('a repository that could not be compared is its own failure, and the rest are reviewed', async () => {
  await saved();
  const { github, of } = fleet('lunch/app', 'lunch/api');
  of('lunch/api').fail('GET /repos/lunch/api', answered(500, 'Server Error'));
  const batch = new BatchApply(github, () => undefined);

  await batch.start(['lunch/app', 'lunch/api'], profile);

  expect(statuses(batch)).toEqual(['lunch/app changes 1', 'lunch/api failed 0']);
  expect(batch.ready.value.map((member) => member.repository)).toEqual(['lunch/app']);
});

test('an apply in progress joins a batch as it is, and stays when the batch is discarded', async () => {
  await saved();
  const { github } = fleet('lunch/app', 'lunch/api');
  const apply = new Apply(github, () => undefined);
  await apply.start('lunch/app', profile);
  await apply.review();
  await apply.leaveOut('repository.has_wiki', true);
  apply.close();
  const batch = new BatchApply(github, () => undefined);

  await batch.start(['lunch/app', 'lunch/api'], profile);
  expect(statuses(batch)).toEqual(['lunch/app changes 1', 'lunch/api changes 1']);
  const state = batch.state.value;
  expect(state.kind === 'reviewed' ? state.members[0]?.leftOut : []).toEqual(['repository.has_wiki']);

  batch.close();
  expect(batch.state.value).toEqual({ kind: 'idle' });
  await batch.resume();
  expect(batch.state.value).toMatchObject({ kind: 'reviewed', profile: 'web' });

  await batch.discard();
  expect(await batch.unfinished()).toBe(false);
  expect(await apply.unfinished('lunch/app')).toBe(true);
  expect(await apply.unfinished('lunch/api')).toBe(false);
});

test('a batch that cannot start says why and leaves nothing behind', async () => {
  await saved('repository:\n  has_wikis: 5\n');
  const { github } = fleet('lunch/app');
  const batch = new BatchApply(github, () => undefined);

  await batch.start(['lunch/app'], profile);

  const state = batch.state.value;
  expect(state.kind === 'failed' ? state.message : '').toContain('web.yaml is not a valid profile');
  expect(await batch.unfinished()).toBe(false);
});

/** A GitHub whose requests wait until they are let go, so work on it can be held open. */
class Held extends FakeGitHub {
  #gate: Promise<void> | undefined;
  #open: () => void = () => undefined;

  hold(): void {
    this.#gate = new Promise((resolve) => {
      this.#open = resolve;
    });
  }

  async release(): Promise<void> {
    this.#open();
    this.#gate = undefined;
    for (let turn = 0; turn < 50; turn += 1) {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  }

  override async request(...args: Parameters<FakeGitHub['request']>): Promise<unknown> {
    await this.#gate;
    return super.request(...args);
  }
}

test('a batch that is writing is neither replaced, resumed, nor discarded, and a late review changes nothing', async () => {
  await saved();
  const app = new Held({}, 'lunch/app');
  const api = new FakeGitHub({}, 'lunch/api');
  const batch = new BatchApply(new FakeFleet([api, app]), () => undefined);
  await batch.start(['lunch/app', 'lunch/api'], profile);

  // A review held open, then left behind by leaving a change out, never replaces what is shown.
  app.hold();
  const late = batch.reviewAgain();
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  batch.close();
  const resumed = batch.resume();
  await app.release();
  await Promise.all([late, resumed]);
  await batch.everywhere('repository.has_wiki', true);
  expect(batch.leftOut.value).toEqual(['repository.has_wiki']);

  app.hold();
  const writing = batch.apply();
  batch.close();
  await batch.start(['lunch/app'], profile);
  await batch.resume();
  await batch.discard();
  expect(batch.state.value).toMatchObject({ kind: 'applying' });
  await app.release();
  await writing;

  expect(batch.state.value).toMatchObject({ kind: 'applied', left: 0 });
  // What was left out everywhere was written nowhere.
  expect(app.state.repository).toMatchObject({ has_wiki: true, has_projects: false });
  expect(api.state.repository).toMatchObject({ has_wiki: true, has_projects: false });
});
