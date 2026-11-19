import { afterEach, expect, test, vi } from 'vitest';

import { answered, FakeFleet, FakeGitHub } from '../../../core/tests/support/fake-github.js';
import { ApplyQueue } from '../../src/app/apply/apply-queue.js';
import { BatchApply } from '../../src/app/apply/batch-apply.js';
import { type SettingField, settingSections } from '../../src/app/profile-editor/setting-fields.js';
import { noAssignments } from '../../src/app/repositories/assignment-review.js';
import { mkdir, readFile, readdir, rm, writeFile } from '../../src/engine/files.js';

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

async function pending(): Promise<string[]> {
  return readdir('/apply', { withFileTypes: true }).then(
    (entries) => entries.map((entry) => entry.name),
    () => [],
  );
}

function memberFile(batch: BatchApply, repository: string): string {
  const state = batch.state.value;
  const file =
    state.kind === 'reviewed' ? state.plan.plans.find((member) => member.repository === repository)?.file : undefined;
  if (file === undefined) {
    throw new Error('The repository has a reviewed apply.');
  }
  return file;
}

test('a batch reviews each repository, writes nothing until asked, and then writes each one', async () => {
  await saved();
  const { github, of } = fleet('lunch/app', 'lunch/api');
  of('lunch/api').state.repository['has_wiki'] = false;
  of('lunch/api').state.repository['has_projects'] = false;
  const confirm = vi.fn();
  const batch = new BatchApply(github, () => undefined, undefined, confirm);

  await batch.start(['lunch/app', 'lunch/api'], profile);

  expect(statuses(batch)).toEqual(['lunch/app changes 1', 'lunch/api in-line 0']);
  expect(batch.changes.value).toEqual([
    { key: 'repository.has_projects', label: 'Projects', repositories: ['lunch/app'] },
    { key: 'repository.has_wiki', label: 'Wiki', repositories: ['lunch/app'] },
  ]);
  expect(writes(of('lunch/app'))).toEqual([]);
  expect(await pending()).toHaveLength(1);

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
  expect(await pending()).toEqual([]);
  expect(confirm).toHaveBeenCalledExactlyOnceWith(2);
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
  expect(batch.changes.value).toEqual([
    { key: 'repository.has_projects', label: 'Projects', repositories: ['lunch/app'] },
  ]);
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

test('a batch names every repository affected by a change once, including those that need access', async () => {
  await saved(`pages:
  build_type: workflow
  https_enforced: true
labels:
  - name: bug
    color: d73a4a
`);
  const { github, of } = fleet('lunch/app', 'lunch/api');
  of('lunch/app').state.account = {
    login: 'lunch',
    name: null,
    repositories: [],
    installations: [
      {
        id: 1,
        permissions: { administration: 'write', pages: 'write', issues: 'write' },
        repositories: [{ full_name: 'lunch/app', private: true }],
      },
    ],
  };
  const batch = new BatchApply(github, () => undefined);

  await batch.start(['lunch/app', 'lunch/api'], profile);

  expect(batch.changes.value).toEqual([
    { key: 'pages', label: 'GitHub Pages site', repositories: ['lunch/app', 'lunch/api'] },
    { key: 'labels/bug', label: 'Label: bug', repositories: ['lunch/app', 'lunch/api'] },
  ]);
  expect(batch.ready.value.map((member) => member.repository)).toEqual(['lunch/app']);
});

test('a repository that changed since the review, or that GitHub refuses, is not written and stays in the batch', async () => {
  await saved();
  const { github, of } = fleet('lunch/app', 'lunch/api', 'lunch/web');
  const confirm = vi.fn();
  const batch = new BatchApply(github, () => undefined, undefined, confirm);
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
  expect(confirm).not.toHaveBeenCalled();

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

test('a batch that cannot start says why and leaves nothing behind', async () => {
  await saved('repository:\n  has_wiki: 5\n');
  const { github } = fleet('lunch/app');
  const batch = new BatchApply(github, () => undefined);

  await batch.start(['lunch/app'], profile);

  const state = batch.state.value;
  expect(state.kind === 'failed' ? state.message : '').toContain('web.yaml is not a valid profile');
  expect(await pending()).toEqual([]);
});

test('a repository GitHub would refuse a change in needs access, and is not written', async () => {
  await saved('labels:\n  - name: new label\n    color: ffffff\n');
  const app = new FakeGitHub(
    {
      account: {
        login: 'lunch',
        name: null,
        repositories: [],
        installations: [
          {
            id: 1,
            permissions: { administration: 'write' },
            repositories: [{ full_name: 'lunch/app', private: true }],
          },
        ],
      },
    },
    'lunch/app',
  );
  const batch = new BatchApply(new FakeFleet([app]), () => undefined);

  await batch.start(['lunch/app'], profile);

  expect(statuses(batch)).toEqual(['lunch/app needs-access 1']);
  await batch.apply();
  expect(batch.state.value).toMatchObject({ kind: 'reviewed' });
  expect(writes(app)).toEqual([]);

  // The batch ends with its last repository, and the apply it started goes with it.
  await batch.remove('lunch/app');
  expect(batch.state.value).toEqual({ kind: 'idle' });
  expect(await pending()).toEqual([]);
});

test('a sign-in lost while writing signs out once and tries no other repository, and a batch that ended has nothing to review again', async () => {
  await saved();
  const { github, of } = fleet('lunch/app', 'lunch/api');
  let signedOut = 0;
  const batch = new BatchApply(github, () => {
    signedOut += 1;
  });
  await batch.start(['lunch/app', 'lunch/api'], profile);
  of('lunch/app').fail('PATCH /repos/lunch/app', answered(401, 'Bad credentials'), 1);

  await batch.apply();

  expect(signedOut).toBe(1);
  expect(writes(of('lunch/api'))).toEqual([]);
  expect(batch.state.value).toMatchObject({ kind: 'applied', left: 2 });
  await batch.reviewAgain();
  await batch.apply();
  expect(batch.state.value).toMatchObject({ kind: 'applied', left: 0 });
  expect(batch.canReviewAgain.value).toBe(false);
  await batch.reviewAgain();
  expect(batch.state.value).toMatchObject({ kind: 'applied', left: 0 });
});

test('a repository whose apply is gone or unreadable is named, and one that is gone can be removed', async () => {
  await saved();
  const { github } = fleet('lunch/app', 'lunch/api', 'lunch/web');
  const batch = new BatchApply(github, () => undefined);
  await batch.start(['lunch/app', 'lunch/api', 'lunch/web'], profile);
  await rm(memberFile(batch, 'lunch/app'));
  await writeFile(memberFile(batch, 'lunch/api'), 'not: [a staged apply');

  await batch.everywhere('repository.has_wiki', true);

  const state = batch.state.value;
  expect(state.kind === 'reviewed' ? state.refused.map((item) => item.split(':')[0]) : []).toEqual([
    'lunch/app',
    'lunch/api',
  ]);
  const gone =
    state.kind === 'reviewed' ? state.members.find((member) => member.repository === 'lunch/app') : undefined;
  expect(gone).toMatchObject({
    status: 'failed',
    comparisonFailureMessage: expect.stringContaining('Its apply is gone') as unknown,
  });

  await batch.remove('lunch/app');
  expect(statuses(batch)).toEqual(['lunch/web changes 1', 'lunch/api failed 0']);
});

test('nothing is applied from a batch that is being discarded', async () => {
  await saved();
  const { github, of } = fleet('lunch/app');
  const batch = new BatchApply(github, () => undefined);
  await batch.start(['lunch/app'], profile);

  const discarding = batch.close();
  await batch.apply();
  await discarding;

  expect(batch.state.value).toEqual({ kind: 'idle' });
  expect(writes(of('lunch/app'))).toEqual([]);
});

class GitHubWithHeldRequests extends FakeGitHub {
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

test('a late review changes nothing, and a batch started while one writes takes the page', async () => {
  await saved();
  const app = new GitHubWithHeldRequests({}, 'lunch/app');
  const api = new FakeGitHub({}, 'lunch/api');
  const batch = new BatchApply(new FakeFleet([api, app]), () => undefined);
  await batch.start(['lunch/app', 'lunch/api'], profile);

  // A review held open, then left behind by leaving a change out, never replaces what is shown.
  app.hold();
  const late = batch.reviewAgain();
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  await batch.close();
  const restarted = batch.start(['lunch/app', 'lunch/api'], profile);
  await app.release();
  await Promise.all([late, restarted]);
  await batch.everywhere('repository.has_wiki', true);
  expect(batch.leftOut.value).toEqual(['repository.has_wiki']);

  app.hold();
  const writing = batch.apply();
  // Leaving the page changes nothing while the batch is queued.
  await batch.close();
  expect(batch.state.value).toMatchObject({ kind: 'applying' });

  await batch.start(['lunch/api'], profile);
  expect(batch.state.value).toMatchObject({ kind: 'reviewed' });
  await app.release();
  await writing;

  // The first batch was written whole, and its outcome doesn't reach the page that moved on.
  expect(batch.state.value).toMatchObject({ kind: 'reviewed' });
  expect(batch.members.value.map((member) => member.repository)).toEqual(['lunch/api']);
  // What was left out everywhere was written nowhere.
  expect(app.state.repository).toMatchObject({ has_wiki: true, has_projects: false });
  expect(api.state.repository).toMatchObject({ has_wiki: true, has_projects: false });
});

test('a batch that moves on leaves the queue to say which repositories failed and which were written', async () => {
  await saved();
  const api = new FakeGitHub({}, 'lunch/api');
  const app = new GitHubWithHeldRequests({}, 'lunch/app');
  const web = new FakeGitHub({}, 'lunch/web');
  api.fail('PATCH /repos/lunch/api', answered(422, 'Validation Failed'), 1);
  const github = new FakeFleet([api, app, web]);
  const confirmed: number[] = [];
  const queue = new ApplyQueue({
    github,
    account: 'trae',
    onSignedOut: () => undefined,
    assignments: noAssignments,
    now: Date.now,
    filesKept: () => Promise.resolve(),
    assignmentsLoaded: Promise.resolve(),
    onApplied: (repositories) => confirmed.push(repositories),
  });
  const queued = (): string[] => queue.applies.value.map((apply) => `${apply.repository} ${apply.status}`);
  const batch = new BatchApply(github, () => undefined, undefined, undefined, queue);
  await batch.start(['lunch/api', 'lunch/app'], profile);

  app.hold();
  const writing = batch.apply();
  await vi.waitFor(() => {
    expect(queue.progress.value?.repository).toBe('lunch/app');
  });
  // The failure is the batch's to say while its page waits.
  expect(queued()).toEqual(['lunch/app writing']);

  await batch.start(['lunch/web'], profile);
  expect(queued()).toEqual(['lunch/api failed', 'lunch/app writing']);
  await app.release();
  await writing;

  expect(queued()).toEqual(['lunch/api failed']);
  expect(confirmed).toEqual([1]);
  expect(statuses(batch)).toEqual(['lunch/web changes 1']);
  expect(await pending()).toHaveLength(1);
});

test('leaving discards the batch and its exclusions, so another batch starts fresh', async () => {
  await saved();
  const { github, of } = fleet('lunch/app', 'lunch/api');
  const batch = new BatchApply(github, () => undefined);
  await batch.start(['lunch/app', 'lunch/api'], profile);
  await batch.everywhere('repository.has_wiki', true);
  await batch.leaveOutRepository('lunch/api', true);

  await batch.close();

  expect(batch.state.value).toEqual({ kind: 'idle' });
  expect(await pending()).toEqual([]);
  expect(writes(of('lunch/app'))).toEqual([]);
  expect(writes(of('lunch/api'))).toEqual([]);
  await batch.start(['lunch/app', 'lunch/api'], profile);
  expect(statuses(batch)).toEqual(['lunch/app changes 1', 'lunch/api changes 1']);
  expect(batch.leftOut.value).toEqual([]);
});

test('leaving while a batch starts cleans up even when its files are created later', async () => {
  await saved();
  const { github, of } = fleet('lunch/app');
  const batch = new BatchApply(github, () => undefined);
  const starting = batch.start(['lunch/app'], profile);
  await batch.close();
  await starting;

  expect(batch.state.value).toEqual({ kind: 'idle' });
  expect(await pending()).toEqual([]);
  expect(writes(of('lunch/app'))).toEqual([]);
});

function setting(path: string): SettingField {
  const field = settingSections
    .flatMap((section) => section.groups.flatMap((group) => group.fields))
    .find((candidate) => candidate.path.join('.') === path);
  if (field === undefined) {
    throw new Error('The editor has no such setting.');
  }
  return field;
}

function oneOffRows(batch: BatchApply): string[] {
  return batch.members.value.map(
    (member) =>
      `${member.repository}: ${member.sections
        .flatMap((section) => section.rows.map((row) => `${row.key}${row.oneOff === true ? ' (one-off)' : ''}`))
        .join(', ')}`,
  );
}

test('a batch that changes settings once gives every repository the same edits and writes only them', async () => {
  const { github, of } = fleet('lunch/app', 'lunch/api');
  of('lunch/api').state.repository['has_wiki'] = false;
  const batch = new BatchApply(github, () => undefined);

  await batch.startWithoutProfile(['lunch/app', 'lunch/api']);
  expect(batch.state.value).toEqual({ kind: 'editing', profileName: '', repositories: ['lunch/app', 'lunch/api'] });
  await batch.editor.value?.set(setting('repository.has_wiki'), false);
  await batch.editor.value?.set(setting('repository.has_projects'), false);
  await batch.review();

  expect(statuses(batch)).toEqual(['lunch/app changes 1', 'lunch/api changes 1']);
  expect(oneOffRows(batch)).toEqual([
    'lunch/app: repository.has_projects (one-off), repository.has_wiki (one-off)',
    'lunch/api: repository.has_projects (one-off)',
  ]);
  expect(writes(of('lunch/app'))).toEqual([]);

  await batch.apply();

  expect(batch.state.value).toMatchObject({ kind: 'applied', left: 0 });
  expect(batch.editor.value).toBeUndefined();
  expect(of('lunch/app').state.repository).toMatchObject({ has_wiki: false, has_projects: false });
  expect(of('lunch/api').state.repository).toMatchObject({ has_wiki: false, has_projects: false });
  expect(await pending()).toEqual([]);
});

test('going back to the edits and changing them replaces what every repository gets', async () => {
  const { github, of } = fleet('lunch/app', 'lunch/api');
  const batch = new BatchApply(github, () => undefined);
  await batch.startWithoutProfile(['lunch/app', 'lunch/api']);
  await batch.editor.value?.set(setting('repository.has_wiki'), false);
  await batch.review();
  expect(batch.canEdit.value).toBe(true);

  await batch.backToEdits();
  expect(batch.state.value).toMatchObject({ kind: 'editing', repositories: ['lunch/app', 'lunch/api'] });
  await batch.editor.value?.set(setting('repository.has_wiki'), undefined);
  await batch.editor.value?.set(setting('repository.has_issues'), false);
  await batch.review();

  expect(oneOffRows(batch)).toEqual([
    'lunch/app: repository.has_issues (one-off)',
    'lunch/api: repository.has_issues (one-off)',
  ]);
  await batch.apply();
  expect(of('lunch/app').state.repository).toMatchObject({ has_wiki: true, has_issues: false });
});

test('an edit that is not valid keeps the batch on its edits, and leaving discards edits and batch alike', async () => {
  const { github } = fleet('lunch/app', 'lunch/api');
  const batch = new BatchApply(github, () => undefined);
  await batch.startWithoutProfile(['lunch/app', 'lunch/api']);
  const editor = batch.editor.value;
  await editor?.type(setting('repository.default_branch'), 'main dev');
  expect(editor?.canSave.value).toBe(false);

  await batch.review();
  expect(batch.state.value).toMatchObject({ kind: 'editing' });

  await batch.close();
  expect(batch.state.value).toEqual({ kind: 'idle' });
  expect(batch.editor.value).toBeUndefined();
  expect(await pending()).toEqual([]);
});

test('a batch of a profile has no edits to go back to', async () => {
  await saved();
  const { github } = fleet('lunch/app');
  const batch = new BatchApply(github, () => undefined);
  await batch.start(['lunch/app'], profile);

  expect(batch.canEdit.value).toBe(false);
  await batch.backToEdits();
  expect(batch.state.value).toMatchObject({ kind: 'reviewed' });
});

test('a repository that refuses the edits is named and left out, so it is not applied with others', async () => {
  const { github, of } = fleet('lunch/app', 'lunch/api');
  const batch = new BatchApply(github, () => undefined);
  await batch.startWithoutProfile(['lunch/app', 'lunch/api']);
  await batch.editor.value?.set(setting('repository.has_wiki'), false);
  await batch.review();
  const api = memberFile(batch, 'lunch/api');
  await batch.backToEdits();
  await writeFile(api, 'not: [a staged apply');
  await batch.editor.value?.set(setting('repository.has_issues'), false);

  await batch.review();

  const state = batch.state.value;
  expect(state.kind === 'reviewed' ? state.refused.map((item) => item.split(':')[0]) : []).toEqual(['lunch/api']);
  expect(statuses(batch)).toEqual(['lunch/app changes 1', 'lunch/api left-out 0']);
  await batch.apply();
  expect(writes(of('lunch/api'))).toEqual([]);
});

test('removing the last repository ends the batch and its edits', async () => {
  const { github } = fleet('lunch/app');
  const batch = new BatchApply(github, () => undefined);
  await batch.startWithoutProfile(['lunch/app']);
  await batch.review();
  await batch.leaveOutRepository('lunch/app', true);

  await batch.remove('lunch/app');

  expect(batch.state.value).toEqual({ kind: 'idle' });
  expect(batch.editor.value).toBeUndefined();
  expect(await pending()).toEqual([]);
});

test('leaving while a batch that changes settings once starts leaves no editor or files behind', async () => {
  const { github } = fleet('lunch/app', 'lunch/api');
  const batch = new BatchApply(github, () => undefined);
  const starting = batch.startWithoutProfile(['lunch/app', 'lunch/api']);
  await batch.close();
  await starting;

  expect(batch.state.value).toEqual({ kind: 'idle' });
  expect(batch.editor.value).toBeUndefined();
  expect(await pending()).toEqual([]);
});

test("a batch holds its one-off edits through the review, and lets go of them once they're written or left", async () => {
  const { github } = fleet('lunch/app', 'lunch/api');
  const batch = new BatchApply(github, () => undefined);

  await batch.startWithoutProfile(['lunch/app', 'lunch/api']);
  expect(batch.holdsOneOffEdits.value).toBe(false);
  await batch.editor.value?.set(setting('repository.has_wiki'), false);
  expect(batch.holdsOneOffEdits.value).toBe(true);
  await batch.review();
  expect(batch.holdsOneOffEdits.value).toBe(true);

  await batch.apply();
  expect(batch.holdsOneOffEdits.value).toBe(false);
});
