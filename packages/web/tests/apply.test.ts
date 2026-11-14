import { afterEach, expect, test } from 'vitest';

import { answered, FakeGitHub } from '../../core/tests/fake-github.js';
import { Apply } from '../src/app/apply.js';
import { type SettingField, settingSections } from '../src/app/setting-fields.js';
import { mkdir, readFile, rm, writeFile } from '../src/engine/files.js';

afterEach(async () => {
  await rm('/', { recursive: true });
});

function neverField(): SettingField {
  throw new Error('The editor has no such setting.');
}

const profile = { file: '/profiles/web.yaml', name: 'web', folder: '/profiles' };
const staged = '/staged/lunch/app.yaml';
const text = `repository:
  has_wiki: false
  has_projects: false
labels:
  - name: bug
    color: d73a4a
`;

async function saved(content = text): Promise<void> {
  await mkdir('/profiles', { recursive: true });
  await writeFile(profile.file, content);
}

function rows(apply: Apply): string[] {
  const state = apply.state.value;
  return state.kind === 'reviewed'
    ? state.sections.flatMap((section) =>
        section.rows.map((row) => `${row.key}${row.lock === undefined ? '' : ' (locked)'}`),
      )
    : [`not reviewed: ${state.kind}`];
}

function writes(github: FakeGitHub): string[] {
  return github.calls.filter((call) => call.method !== 'GET').map((call) => `${call.method} ${call.path}`);
}

function exists(file: string): Promise<boolean> {
  return readFile(file, 'utf8').then(
    () => true,
    () => false,
  );
}

test('an apply is reviewed first, writes nothing until asked, and then writes what was reviewed', async () => {
  await saved();
  const github = new FakeGitHub();
  const apply = new Apply(github, () => undefined);

  await apply.start('lunch/app', profile);

  await apply.review();

  expect(rows(apply)).toEqual(['repository.has_projects', 'repository.has_wiki', 'new label']);
  expect(apply.canApply.value).toBe(true);
  expect(writes(github)).toEqual([]);
  expect(await apply.unfinished('lunch/app')).toBe(true);

  expect(apply.counts.value).toEqual({ changes: 2, locked: 0 });
  await apply.apply();

  expect(apply.state.value).toEqual({ kind: 'applied', repository: 'lunch/app', profile: 'web', changes: 2 });
  expect(writes(github)).toEqual(['PATCH /repos/lunch/app', 'POST /repos/lunch/app/labels']);
  expect(github.state.repository).toMatchObject({ has_wiki: false, has_projects: false });
  // A finished apply is no longer there to pick up.
  expect(await apply.unfinished('lunch/app')).toBe(false);
});

test('a change left out stays out of this apply, and the profile keeps it', async () => {
  await saved();
  const github = new FakeGitHub();
  const apply = new Apply(github, () => undefined);
  await apply.start('lunch/app', profile);
  await apply.review();
  const state = apply.state.value;
  const wiki =
    state.kind === 'reviewed' ? state.sections[0]?.rows.find((row) => row.key === 'repository.has_wiki') : undefined;

  await apply.leaveOut(wiki?.leaveOut ?? '', true);
  await apply.leaveOut('labels/bug', true);

  expect(rows(apply)).toEqual(['repository.has_projects']);
  expect(apply.state.value).toMatchObject({ leftOut: ['repository.has_wiki', 'labels/bug'] });
  expect(await readFile(profile.file, 'utf8')).toBe(text);

  await apply.leaveOut('labels/bug', false);
  expect(rows(apply)).toEqual(['repository.has_projects', 'new label']);

  await apply.apply();
  expect(github.state.repository).toMatchObject({ has_wiki: true, has_projects: false });
});

test('an apply waits while GitHub would refuse a change, since it would stop there', async () => {
  await saved();
  const github = new FakeGitHub({
    account: {
      login: 'lunch',
      name: null,
      repositories: [],
      installations: [
        { id: 1, permissions: { administration: 'write' }, repositories: [{ full_name: 'lunch/app', private: true }] },
      ],
    },
  });
  const apply = new Apply(github, () => undefined);

  await apply.start('lunch/app', profile);

  await apply.review();
  expect(rows(apply)).toEqual(['repository.has_projects', 'repository.has_wiki', 'new label (locked)']);
  expect(apply.canApply.value).toBe(false);
  await apply.apply();
  expect(writes(github)).toEqual([]);

  await apply.leaveOut('labels/bug', true);
  expect(apply.canApply.value).toBe(true);
});

test('a repository that changed since the review gets nothing written, and a fresh review', async () => {
  await saved();
  const github = new FakeGitHub();
  const apply = new Apply(github, () => undefined);
  await apply.start('lunch/app', profile);
  await apply.review();

  github.state.repository['has_wiki'] = false;
  await apply.apply();

  expect(writes(github)).toEqual([]);
  expect(apply.state.value).toMatchObject({ kind: 'reviewed' });
  const state = apply.state.value;
  expect(state.kind === 'reviewed' ? state.notice : '').toContain('nothing was written');
  expect(rows(apply)).toEqual(['repository.has_projects', 'new label']);

  await apply.apply();
  expect(apply.state.value).toMatchObject({ kind: 'applied' });
});

test('a change GitHub refuses partway leaves the ones before it written and the apply to pick up', async () => {
  await saved();
  const github = new FakeGitHub();
  const apply = new Apply(github, () => undefined);
  await apply.start('lunch/app', profile);
  await apply.review();

  github.fail('POST /repos/lunch/app/labels', answered(422, 'Validation Failed'), 1);
  await apply.apply();

  const state = apply.state.value;
  expect(state.kind === 'reviewed' ? state.notice : '').toContain('stays written');
  expect(rows(apply)).toEqual(['new label']);
  expect(github.state.repository).toMatchObject({ has_wiki: false });
  expect(await apply.unfinished('lunch/app')).toBe(true);
});

test('an unfinished apply is picked up as it was left, or started over, and a discarded one is gone', async () => {
  await saved();
  const github = new FakeGitHub();
  const apply = new Apply(github, () => undefined);
  await apply.start('lunch/app', profile);
  await apply.review();
  await apply.leaveOut('labels/bug', true);
  apply.close();
  expect(apply.state.value).toEqual({ kind: 'idle' });
  expect(await exists(staged)).toBe(true);

  await apply.start('lunch/app', profile);
  expect(apply.state.value).toEqual({ kind: 'unfinished', repository: 'lunch/app', profile: 'web' });
  await apply.resume();
  await apply.review();
  expect(rows(apply)).toEqual(['repository.has_projects', 'repository.has_wiki']);

  apply.close();
  await apply.start('lunch/app', profile);
  await apply.review();
  await apply.startOver();
  await apply.review();
  expect(rows(apply)).toEqual(['repository.has_projects', 'repository.has_wiki', 'new label']);

  await apply.discard();
  expect(apply.state.value).toEqual({ kind: 'idle' });
  expect(await exists(staged)).toBe(false);
  expect(writes(github)).toEqual([]);
  expect(await readFile(profile.file, 'utf8')).toBe(text);
});

test('an apply that cannot be reviewed says why and can be tried again, from the start when it never began', async () => {
  await saved();
  const github = new FakeGitHub();
  github.fail('GET /repos/lunch/app/labels', answered(500, 'Server Error'), 1);
  const apply = new Apply(github, () => undefined);

  await apply.start('lunch/app', profile);

  await apply.review();
  expect(apply.state.value).toMatchObject({ kind: 'failed', message: 'Server Error' });
  expect(apply.canApply.value).toBe(false);
  await apply.reviewAgain();
  expect(apply.state.value).toMatchObject({ kind: 'reviewed' });
  await apply.discard();

  // A profile that can't be read starts no apply, so there is none to pick up until it reads.
  await saved('repository:\n  has_wikis: 5\n');
  await apply.start('lunch/app', profile);
  await apply.review();
  expect(apply.state.value).toMatchObject({ kind: 'failed' });
  expect(await apply.unfinished('lunch/app')).toBe(false);
  await saved();
  await apply.reviewAgain();
  expect(rows(apply)).toEqual(['repository.has_projects', 'repository.has_wiki', 'new label']);
});

/** A GitHub whose reads of one repository wait until they are let go, so work on it can be held open. */
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
    // What waited lands over a few turns of the engine's own awaits.
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

/** Two repositories behind one sign-in, each its own in-memory GitHub. */
function fleet(app: FakeGitHub, other: FakeGitHub): FakeGitHub['request'] {
  // What isn't about a repository, such as the account's installations, is never held.
  return (method, path, body) => (path.startsWith('/repos/lunch/app') ? app : other).request(method, path, body);
}

test('a review that lands late changes nothing: apply writes the plan on the page, to its repository', async () => {
  await saved('repository:\n  has_wiki: false\n');
  await writeFile('/profiles/other.yaml', 'repository:\n  has_issues: false\n');
  const app = new Held();
  const other = new FakeGitHub({}, 'lunch/other');
  const apply = new Apply({ request: fleet(app, other) }, () => undefined);

  await apply.start('lunch/app', profile);
  app.hold();
  const late = apply.review();
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  apply.close();
  await apply.start('lunch/other', { file: '/profiles/other.yaml', name: 'other', folder: '/profiles' });
  await apply.review();
  expect(apply.state.value).toMatchObject({ kind: 'reviewed', repository: 'lunch/other' });
  await app.release();
  await late;

  expect(apply.state.value).toMatchObject({ kind: 'reviewed', repository: 'lunch/other' });
  await apply.apply();

  expect(writes(app)).toEqual([]);
  expect(writes(other)).toEqual(['PATCH /repos/lunch/other']);
  expect(other.state.repository).toMatchObject({ has_issues: false });
  expect(app.state.repository).toMatchObject({ has_wiki: true });
});

test('a review held open while a change is left out never brings that change back into the apply', async () => {
  await saved();
  const github = new Held();
  const apply = new Apply(github, () => undefined);
  await apply.start('lunch/app', profile);
  await apply.review();

  github.hold();
  const late = apply.reviewAgain();
  apply.close();
  await apply.pickUp('lunch/app');
  const picked = apply.review();
  await github.release();
  await Promise.all([late, picked]);
  await apply.leaveOut('repository.has_wiki', true);
  expect(apply.state.value).toMatchObject({ leftOut: ['repository.has_wiki'] });

  await apply.apply();

  expect(github.state.repository).toMatchObject({ has_wiki: true, has_projects: false });
});

test('an apply that is writing is neither replaced nor joined, and its outcome shows when it ends', async () => {
  await saved();
  await writeFile('/profiles/other.yaml', 'repository:\n  has_issues: false\n');
  const app = new Held();
  const other = new FakeGitHub({}, 'lunch/other');
  const apply = new Apply({ request: fleet(app, other) }, () => undefined);
  await apply.start('lunch/app', profile);
  await apply.review();
  app.fail('POST /repos/lunch/app/labels', answered(422, 'Validation Failed'), 1);

  app.hold();
  const writing = apply.apply();
  // The page is left, and another apply is asked for, while the first one writes.
  apply.close();
  await apply.start('lunch/other', { file: '/profiles/other.yaml', name: 'other', folder: '/profiles' });
  await apply.review();
  await apply.pickUp('lunch/app');
  await apply.review();
  await apply.discard();
  expect(apply.state.value).toMatchObject({ kind: 'applying', repository: 'lunch/app' });
  await app.release();
  await writing;

  const state = apply.state.value;
  expect(state).toMatchObject({ kind: 'reviewed', repository: 'lunch/app' });
  expect(state.kind === 'reviewed' ? state.notice : '').toContain('stays written');
  expect(writes(other)).toEqual([]);
  expect(await apply.unfinished('lunch/app')).toBe(true);
});

test('an apply that could not be reviewed even once is not left to pick up', async () => {
  await saved('owner_type: user\nrepository:\n  has_wiki: false\n');
  const apply = new Apply(new FakeGitHub({ ownerType: 'Organization' }), () => undefined);

  await apply.start('lunch/app', profile);

  await apply.review();

  const state = apply.state.value;
  expect(state.kind === 'failed' ? state.message : '').toContain('make a copy of the profile');
  expect(await apply.unfinished('lunch/app')).toBe(false);
});

test('an apply whose profile is gone says so by its name, and one whose file is gone says to start again', async () => {
  await saved();
  const signedOut = (): void => undefined;
  const apply = new Apply(new FakeGitHub(), signedOut);
  await apply.start('lunch/app', profile);
  await apply.review();
  apply.close();

  await rm(profile.file);
  await apply.pickUp('lunch/app');
  await apply.review();
  const missing = apply.state.value;
  expect(missing.kind === 'failed' ? missing.message : '').toContain('web.yaml');
  expect(missing.kind === 'failed' ? missing.message : '').not.toContain('/profiles');

  await rm(staged);
  await apply.reviewAgain();
  expect(apply.state.value).toMatchObject({
    kind: 'failed',
    message: 'This apply is no longer in this browser. Start it again from its repository.',
  });
});

test('a first review that fails late leaves an apply the page has since picked up again', async () => {
  await saved();
  const github = new Held();
  const apply = new Apply(github, () => undefined);
  await apply.start('lunch/app', profile);

  github.hold();
  github.fail('GET /repos/lunch/app/labels', answered(500, 'Server Error'), 1);
  const first = apply.review();
  // The review is under way, reading GitHub, when the page is left and the apply picked up again.
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  apply.close();
  await apply.pickUp('lunch/app');
  await github.release();
  await first;

  expect(apply.state.value).toMatchObject({ kind: 'editing' });
  expect(await apply.unfinished('lunch/app')).toBe(true);
});

test('a failure names a profile kept on GitHub by its path there, not by where the browser keeps it', async () => {
  const kept = '/profiles/github/lunch/config/@profiles';
  await mkdir(kept, { recursive: true });
  await writeFile(`${kept}/web.yaml`, text);
  const apply = new Apply(new FakeGitHub(), () => undefined);
  await apply.start('lunch/app', { file: `${kept}/web.yaml`, name: 'web', folder: kept });
  await apply.review();
  apply.close();

  await rm(`${kept}/web.yaml`);
  await apply.pickUp('lunch/app');
  await apply.review();

  const state = apply.state.value;
  expect(state.kind === 'failed' ? state.message : '').toContain('web.yaml');
  expect(state.kind === 'failed' ? state.message : '').not.toContain('github/lunch');
});

test('an apply opens on its one-off edits, which change this apply only and show as such in the review', async () => {
  await saved();
  const github = new FakeGitHub();
  const apply = new Apply(github, () => undefined);

  await apply.start('lunch/app', profile);
  expect(apply.state.value).toEqual({ kind: 'editing', repository: 'lunch/app', profile: 'web', fromProfile: true });
  const editor = apply.editor.value;
  expect(editor?.drafts).toBe(false);
  expect(writes(github)).toEqual([]);

  // An edit that isn't saved is saved to the apply on the way to the review, never to the profile.
  const issues = settingSections
    .flatMap((section) => section.groups.flatMap((group) => group.fields))
    .find((field) => field.path.join('.') === 'repository.has_issues');
  await editor?.set(issues ?? neverField(), false);
  await apply.review();

  expect(await readFile(profile.file, 'utf8')).toBe(text);
  const state = apply.state.value;
  const row =
    state.kind === 'reviewed'
      ? state.sections[0]?.rows.find((item) => item.key === 'repository.has_issues')
      : undefined;
  expect(row).toMatchObject({ now: 'On', wanted: 'Off', oneOff: true });
  expect(row?.leaveOut).toBeUndefined();

  await apply.backToEdits();
  expect(apply.state.value).toMatchObject({ kind: 'editing' });
  expect(apply.editor.value?.dirty.value).toBe(false);

  await apply.saveToProfile();
  expect(apply.editError.value).toBeUndefined();
  expect(await readFile(profile.file, 'utf8')).toContain('has_issues: false');
});

test('an edit that is not valid keeps the apply on its edits', async () => {
  await saved();
  const apply = new Apply(new FakeGitHub(), () => undefined);
  await apply.start('lunch/app', profile);

  await apply.editor.value?.addEntry('labels', { name: '' });
  await apply.review();

  expect(apply.state.value).toMatchObject({ kind: 'editing' });
});

test('settings are changed once, with no profile, from the repository as it is', async () => {
  const github = new FakeGitHub();
  const apply = new Apply(github, () => undefined);

  await apply.startWithoutProfile('lunch/app');
  expect(apply.state.value).toEqual({ kind: 'editing', repository: 'lunch/app', profile: '', fromProfile: false });
  const wiki = settingSections
    .flatMap((section) => section.groups.flatMap((group) => group.fields))
    .find((field) => field.path.join('.') === 'repository.has_wiki');
  await apply.editor.value?.set(wiki ?? neverField(), false);
  await apply.saveToProfile();
  expect(await exists(staged)).toBe(true);
  await apply.review();
  await apply.apply();

  expect(apply.state.value).toMatchObject({ kind: 'applied', changes: 1 });
  expect(github.state.repository).toMatchObject({ has_wiki: false });
});
