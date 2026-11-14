import { afterEach, expect, test } from 'vitest';

import { answered, FakeGitHub } from '../../core/tests/fake-github.js';
import { Apply } from '../src/app/apply.js';
import { mkdir, readFile, rm, writeFile } from '../src/engine/files.js';

afterEach(async () => {
  await rm('/', { recursive: true });
});

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

  expect(rows(apply)).toEqual(['repository.has_projects', 'repository.has_wiki', 'new label']);
  expect(apply.canApply.value).toBe(true);
  expect(writes(github)).toEqual([]);
  expect(await apply.unfinished('lunch/app')).toBe(true);

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
  await apply.leaveOut('labels/bug', true);
  apply.close();
  expect(apply.state.value).toEqual({ kind: 'idle' });
  expect(await exists(staged)).toBe(true);

  await apply.start('lunch/app', profile);
  expect(apply.state.value).toEqual({ kind: 'unfinished', repository: 'lunch/app', profile: 'web' });
  await apply.resume();
  expect(rows(apply)).toEqual(['repository.has_projects', 'repository.has_wiki']);

  apply.close();
  await apply.start('lunch/app', profile);
  await apply.startOver();
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
  expect(apply.state.value).toMatchObject({ kind: 'failed', message: 'Server Error' });
  expect(apply.canApply.value).toBe(false);
  await apply.reviewAgain();
  expect(apply.state.value).toMatchObject({ kind: 'reviewed' });
  await apply.discard();

  // A profile that can't be read starts no apply, so there is none to pick up until it reads.
  await saved('repository:\n  has_wikis: 5\n');
  await apply.start('lunch/app', profile);
  expect(apply.state.value).toMatchObject({ kind: 'failed' });
  expect(await apply.unfinished('lunch/app')).toBe(false);
  await saved();
  await apply.reviewAgain();
  expect(rows(apply)).toEqual(['repository.has_projects', 'repository.has_wiki', 'new label']);
});
