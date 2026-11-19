import { afterEach, expect, test, vi } from 'vitest';

import { answered, FakeGitHub } from '../../../core/tests/support/fake-github.js';
import { Apply } from '../../src/app/apply/apply.js';
import { type SettingField, settingSections } from '../../src/app/profile-editor/setting-fields.js';
import { mkdir, readFile, readdir, rm, writeFile } from '../../src/engine/files.js';

afterEach(async () => {
  await rm('/', { recursive: true });
});

function neverField(): SettingField {
  throw new Error('The editor has no such setting.');
}

const profile = { file: '/profiles/web.yaml', name: 'web', folder: '/profiles' };
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
        section.rows.map((row) => `${row.key}${row.lockReason === undefined ? '' : ' (locked)'}`),
      )
    : [`not reviewed: ${state.kind}`];
}

function writes(github: FakeGitHub): string[] {
  return github.calls.filter((call) => call.method !== 'GET').map((call) => `${call.method} ${call.path}`);
}

async function pending(): Promise<string[]> {
  return readdir('/apply', { withFileTypes: true }).then(
    (entries) => entries.map((entry) => entry.name),
    () => [],
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
  expect(await pending()).toHaveLength(1);

  expect(apply.counts.value).toEqual({ changes: 2, locked: 0 });
  await apply.apply();

  expect(apply.state.value).toEqual({ kind: 'applied', repository: 'lunch/app', profileName: 'web', changes: 2 });
  expect(writes(github)).toEqual(['PATCH /repos/lunch/app', 'POST /repos/lunch/app/labels']);
  expect(github.state.repository).toMatchObject({ has_wiki: false, has_projects: false });
  expect(await pending()).toEqual([]);
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

test('a change GitHub refuses partway leaves the ones before it written and shows what remains', async () => {
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
  expect(await pending()).toHaveLength(1);
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
  await apply.close();

  // A profile that can't be read starts no apply; a retry opens its edits once it reads.
  await saved('repository:\n  has_wiki: 5\n');
  await apply.start('lunch/app', profile);
  await apply.review();
  expect(apply.state.value).toMatchObject({ kind: 'failed' });
  expect(await pending()).toEqual([]);
  await saved();
  await apply.reviewAgain();
  expect(apply.state.value).toMatchObject({ kind: 'editing' });
  await apply.review();
  expect(rows(apply)).toEqual(['repository.has_projects', 'repository.has_wiki', 'new label']);
});

class GitHubWithHeldReads extends FakeGitHub {
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

function fleet(app: FakeGitHub, other: FakeGitHub): FakeGitHub['request'] {
  // What isn't about a repository, such as the account's installations, is never held.
  return (method, path, body) => (path.startsWith('/repos/lunch/app') ? app : other).request(method, path, body);
}

test('a review that lands late changes nothing: apply writes the plan on the page, to its repository', async () => {
  await saved('repository:\n  has_wiki: false\n');
  await writeFile('/profiles/other.yaml', 'repository:\n  has_issues: false\n');
  const app = new GitHubWithHeldReads();
  const other = new FakeGitHub({}, 'lunch/other');
  const apply = new Apply({ request: fleet(app, other) }, () => undefined);

  await apply.start('lunch/app', profile);
  await apply.review();
  app.hold();
  const late = apply.reviewAgain();
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  await apply.close();
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

test('another apply started while one writes takes the page, and the first ends in the queue', async () => {
  await saved();
  await writeFile('/profiles/other.yaml', 'repository:\n  has_issues: false\n');
  const app = new GitHubWithHeldReads();
  const other = new FakeGitHub({}, 'lunch/other');
  const applied = vi.fn();
  const apply = new Apply({ request: fleet(app, other) }, () => undefined, undefined, undefined, undefined, applied);
  await apply.start('lunch/app', profile);
  await apply.review();

  app.hold();
  const writing = apply.apply();
  // Leaving the page changes nothing while the apply is queued.
  await apply.close();
  expect(apply.state.value).toMatchObject({ kind: 'applying', repository: 'lunch/app' });

  await apply.start('lunch/other', { file: '/profiles/other.yaml', name: 'other', folder: '/profiles' });
  await apply.review();
  expect(apply.state.value).toMatchObject({ kind: 'reviewed', repository: 'lunch/other' });
  await app.release();
  await writing;

  // The first apply was written, and neither its outcome nor its files reach the page that moved on.
  expect(app.state.repository).toMatchObject({ has_wiki: false });
  expect(apply.state.value).toMatchObject({ kind: 'reviewed', repository: 'lunch/other' });
  expect(applied).not.toHaveBeenCalled();
  expect(await pending()).toHaveLength(1);

  await apply.apply();
  expect(apply.state.value).toMatchObject({ kind: 'applied', repository: 'lunch/other' });
  expect(applied).toHaveBeenCalledOnce();
});

test('a failed review can be edited or tried again while its page is open', async () => {
  await saved('owner_type: user\nrepository:\n  has_wiki: false\n');
  const github = new FakeGitHub({ ownerType: 'Organization' });
  const apply = new Apply(github, () => undefined);
  await apply.start('lunch/app', profile);
  await apply.review();

  const state = apply.state.value;
  expect(state.kind === 'failed' ? state.message : '').toContain('make a copy of the profile');
  expect(await pending()).toHaveLength(1);

  await apply.backToEdits();
  expect(apply.state.value).toMatchObject({ kind: 'editing' });

  github.fail('GET /repos/lunch/app', answered(500, 'Server Error'), 1);
  await apply.review();
  expect(apply.state.value).toMatchObject({ kind: 'failed', message: 'Server Error' });
  expect(await pending()).toHaveLength(1);
  github.state.ownerType = 'User';
  await apply.reviewAgain();
  expect(apply.state.value).toMatchObject({ kind: 'reviewed' });
});

test('a failure names a profile kept on GitHub by its path there, not by where the browser keeps it', async () => {
  const kept = '/profiles/github/lunch/config/@profiles';
  await mkdir(kept, { recursive: true });
  await writeFile(`${kept}/web.yaml`, text);
  const apply = new Apply(new FakeGitHub(), () => undefined);
  await apply.start('lunch/app', { file: `${kept}/web.yaml`, name: 'web', folder: kept });
  await apply.review();
  await rm(`${kept}/web.yaml`);
  await apply.reviewAgain();

  const state = apply.state.value;
  expect(state.kind === 'failed' ? state.message : '').toContain('web.yaml');
  expect(state.kind === 'failed' ? state.message : '').not.toContain('github/lunch');
});

test('an apply opens on its one-off edits, which change this apply only and can be saved to the profile', async () => {
  await saved();
  const github = new FakeGitHub();
  const apply = new Apply(github, () => undefined);

  await apply.start('lunch/app', profile);
  expect(apply.state.value).toEqual({
    kind: 'editing',
    authoritative: [],
    repository: 'lunch/app',
    profileName: 'web',
    fromProfile: true,
    builtIn: false,
    leftOut: [],
  });
  const editor = apply.editor.value;
  expect(editor?.canHoldDrafts).toBe(false);
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
  expect(apply.state.value).toEqual({
    kind: 'editing',
    authoritative: [],
    repository: 'lunch/app',
    profileName: '',
    fromProfile: false,
    builtIn: false,
    leftOut: [],
  });
  const wiki = settingSections
    .flatMap((section) => section.groups.flatMap((group) => group.fields))
    .find((field) => field.path.join('.') === 'repository.has_wiki');
  await apply.editor.value?.set(wiki ?? neverField(), false);
  // With no profile to save to, the edits stay in the apply.
  await apply.saveToProfile();
  expect(apply.editor.value?.dirty.value).toBe(true);
  await apply.review();
  await apply.apply();

  expect(apply.state.value).toMatchObject({ kind: 'applied', changes: 1 });
  expect(github.state.repository).toMatchObject({ has_wiki: false });
});

function setting(path: string): SettingField {
  return (
    settingSections
      .flatMap((section) => section.groups.flatMap((group) => group.fields))
      .find((field) => field.path.join('.') === path) ?? neverField()
  );
}

test('edits saved to the profile take a turn among its syncs, and a refusal says why and keeps them in the apply', async () => {
  await saved();
  const turns: string[] = [];
  const apply = new Apply(
    new FakeGitHub(),
    () => undefined,
    async (work) => {
      turns.push('sync');
      await work();
      turns.push('sync');
    },
  );
  await apply.start('lunch/app', profile);
  await apply.editor.value?.set(setting('repository.has_issues'), false);

  await apply.saveToProfile();

  expect(turns).toEqual(['sync', 'sync']);
  expect(await readFile(profile.file, 'utf8')).toContain('has_issues: false');
  expect(apply.editError.value).toBeUndefined();

  // The profile becomes unreadable under the apply: the edit can't be saved to it, and stays in the apply.
  await apply.editor.value?.set(setting('repository.has_projects'), true);
  await apply.review();
  await apply.backToEdits();
  const file = apply.editor.value?.file ?? '';
  const before = await readFile(file, 'utf8');
  await writeFile(profile.file, 'repository: 5\n');
  await apply.saveToProfile();
  expect(apply.editError.value).toBeDefined();
  expect(await readFile(file, 'utf8')).toBe(before);
});

test('what an apply leaves out is named on its edits, and put back there to be edited', async () => {
  await saved();
  const apply = new Apply(new FakeGitHub(), () => undefined);
  await apply.start('lunch/app', profile);
  await apply.review();
  await apply.leaveOut('repository.has_wiki', true);
  await apply.backToEdits();
  expect(apply.state.value).toMatchObject({ kind: 'editing', leftOut: ['repository.has_wiki'] });

  await apply.leaveOut('repository.has_wiki', false);

  expect(apply.state.value).toMatchObject({ kind: 'editing', leftOut: [] });
  await apply.editor.value?.set(setting('repository.has_wiki'), true);
  expect(apply.editor.value?.unsavedChangesProblem.value).toBeUndefined();
});

const installedWithoutPages = {
  login: 'lunch',
  name: null,
  installations: [
    {
      id: 1,
      selection: 'all' as const,
      permissions: { administration: 'write', contents: 'write', metadata: 'read', actions: 'write', issues: 'write' },
      repositories: [{ full_name: 'lunch/app', private: true, permissions: { admin: true } }],
    },
  ],
  repositories: [],
};

function pagesTurnedOff(apply: Apply): boolean {
  const pages = apply.editor.value?.sections.value.find((section) => section.section.section === 'pages');
  return pages?.missingPermissionsEverySettingShares.includes('Pages') === true;
}

test("one-off edits turn off what the repository's installation was not given, once its access is read", async () => {
  await saved();
  const github = new FakeGitHub({ account: installedWithoutPages });
  const apply = new Apply(github, () => undefined);

  await apply.start('lunch/app', profile);
  await vi.waitFor(() => {
    expect(pagesTurnedOff(apply)).toBe(true);
  });
  expect(apply.editor.value?.entryListMissingPermissions.value.labels).toEqual([]);
  expect(apply.editor.value?.installationSettingsUrl.value).toBe('https://github.com/settings/installations/1');
});

test('one-off edits open without waiting for what the installation was given', async () => {
  await saved();
  const github = new GitHubWithHeldReads({ account: installedWithoutPages });
  const apply = new Apply(github, () => undefined);
  github.hold();

  await apply.startWithoutProfile('lunch/app');

  expect(apply.state.value).toMatchObject({ kind: 'editing' });
  expect(pagesTurnedOff(apply)).toBe(false);
  await github.release();
  expect(pagesTurnedOff(apply)).toBe(true);
});

test('an access read that lands after its editor was left changes neither that editor nor the one open now', async () => {
  await saved();
  const github = new GitHubWithHeldReads({ account: installedWithoutPages });
  const apply = new Apply(github, () => undefined);
  github.hold();
  await apply.startWithoutProfile('lunch/app');
  const left = apply.editor.value;

  await apply.close();
  github.state.account = {
    ...installedWithoutPages,
    installations: installedWithoutPages.installations.map((installation) => ({
      ...installation,
      permissions: { ...installation.permissions, pages: 'write' },
    })),
  };
  await apply.startWithoutProfile('lunch/app');
  await github.release();

  expect(left?.installationSettingsUrl.value).toBeNull();
  expect(apply.editor.value).not.toBe(left);
  expect(apply.editor.value?.installationSettingsUrl.value).toBe('https://github.com/settings/installations/1');
  expect(pagesTurnedOff(apply)).toBe(false);
});

test('an access read that fails turns nothing off, and one refused for a lost sign-in signs out', async () => {
  await saved();
  const failing = new FakeGitHub({ account: installedWithoutPages }).fail(
    'GET /user/installations',
    answered(500, 'Server Error'),
  );
  const signedOut = vi.fn();
  const apply = new Apply(failing, signedOut);
  await apply.startWithoutProfile('lunch/app');
  await vi.waitFor(() => {
    expect(failing.calls.some((call) => call.path.startsWith('/user/installations'))).toBe(true);
  });
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  expect(apply.state.value).toMatchObject({ kind: 'editing' });
  expect(pagesTurnedOff(apply)).toBe(false);
  expect(signedOut).not.toHaveBeenCalled();
  await apply.close();

  const lost = new FakeGitHub({ account: installedWithoutPages }).fail(
    'GET /repos/lunch/app',
    answered(401, 'Bad credentials'),
  );
  const lostApply = new Apply(lost, signedOut);
  await lostApply.startWithoutProfile('lunch/app');
  await vi.waitFor(() => {
    expect(signedOut).toHaveBeenCalledOnce();
  });
});

test('going back to edits after a review turns off what that review read, without reading it again', async () => {
  await saved();
  const github = new FakeGitHub({ account: installedWithoutPages });
  const apply = new Apply(github, () => undefined);
  await apply.start('lunch/app', profile);
  await apply.review();
  const readsBefore = github.calls.filter((call) => call.path.startsWith('/user/installations')).length;

  await apply.backToEdits();

  expect(pagesTurnedOff(apply)).toBe(true);
  expect(github.calls.filter((call) => call.path.startsWith('/user/installations')).length).toBe(readsBefore);
});

test.each([
  { fromProfile: true, reviewed: false },
  { fromProfile: true, reviewed: true },
  { fromProfile: false, reviewed: false },
  { fromProfile: false, reviewed: true },
])(
  'backing out discards the changes, with fromProfile=$fromProfile and reviewed=$reviewed',
  async ({ fromProfile, reviewed }) => {
    await saved();
    const github = new FakeGitHub();
    const apply = new Apply(github, () => undefined);
    if (fromProfile) {
      await apply.start('lunch/app', profile);
    } else {
      await apply.startWithoutProfile('lunch/app');
    }
    await apply.editor.value?.set(setting('repository.has_issues'), false);
    if (reviewed) {
      await apply.review();
      if (fromProfile) {
        await apply.leaveOut('labels/bug', true);
      }
    }

    await apply.close();

    expect(apply.state.value).toEqual({ kind: 'idle' });
    expect(apply.editor.value).toBeUndefined();
    expect(await pending()).toEqual([]);
    expect(await readFile(profile.file, 'utf8')).toBe(text);
    expect(writes(github)).toEqual([]);

    if (fromProfile) {
      await apply.start('lunch/app', profile);
    } else {
      await apply.startWithoutProfile('lunch/app');
    }
    expect(apply.state.value).toMatchObject({ kind: 'editing', leftOut: [] });
    await apply.review();
    expect(rows(apply)).toEqual(fromProfile ? ['repository.has_projects', 'repository.has_wiki', 'new label'] : []);
    expect(writes(github)).toEqual([]);
  },
);

test('leaving while an apply starts cleans up even when its file is created later', async () => {
  await saved();
  const github = new FakeGitHub();
  const apply = new Apply(github, () => undefined);
  const starting = apply.start('lunch/app', profile);
  await apply.close();
  await starting;

  expect(apply.state.value).toEqual({ kind: 'idle' });
  expect(apply.editor.value).toBeUndefined();
  expect(await pending()).toEqual([]);
  expect(writes(github)).toEqual([]);
});

test('a late review cannot replace or delete a new apply to the same repository', async () => {
  await saved();
  const github = new GitHubWithHeldReads();
  const apply = new Apply(github, () => undefined);
  await apply.start('lunch/app', profile);
  await apply.review();
  github.hold();
  const late = apply.reviewAgain();
  await apply.close();
  const starting = apply.start('lunch/app', profile);
  await github.release();
  await Promise.all([late, starting]);
  await apply.review();
  await apply.leaveOut('repository.has_wiki', true);

  expect(await pending()).toHaveLength(1);
  expect(apply.state.value).toMatchObject({ kind: 'reviewed', leftOut: ['repository.has_wiki'] });
  await apply.apply();
  expect(github.state.repository).toMatchObject({ has_wiki: true, has_projects: false });
  expect(await pending()).toEqual([]);
});

test('a failed review retried as another apply starts cannot take over that new apply', async () => {
  await saved();
  await writeFile('/profiles/other.yaml', 'repository: { has_issues: false }\n');
  const app = new FakeGitHub().fail('GET /repos/lunch/app/labels', answered(500, 'Server Error'), 1);
  const other = new FakeGitHub({}, 'lunch/other');
  const apply = new Apply({ request: fleet(app, other) }, () => undefined);
  await apply.start('lunch/app', profile);
  await apply.review();
  expect(apply.state.value).toMatchObject({ kind: 'failed' });

  const retry = apply.reviewAgain();
  const starting = apply.start('lunch/other', { file: '/profiles/other.yaml', name: 'other', folder: '/profiles' });
  await Promise.all([retry, starting]);

  expect(apply.state.value).toMatchObject({ kind: 'editing', repository: 'lunch/other', profileName: 'other' });
  await apply.review();
  await apply.apply();
  expect(writes(app)).toEqual([]);
  expect(writes(other)).toEqual(['PATCH /repos/lunch/other']);
});

test('one-time ownership is reviewed, can exclude pruning, and stays out of the source profile', async () => {
  await saved('labels: []\n');
  const github = new FakeGitHub({
    labels: [{ id: 1, name: 'legacy', color: 'ffffff', description: null, default: false }],
  });
  const apply = new Apply(github, () => undefined);
  await apply.start('lunch/app', profile);
  await apply.setAuthoritative(['labels']);
  await apply.review();
  expect(apply.state.value).toMatchObject({
    kind: 'reviewed',
    plan: { authoritative: ['labels'], changes: [{ action: 'delete', target: 'legacy' }] },
  });
  expect(github.writes).toEqual([]);
  await apply.leaveOut('labels/legacy', true);
  expect(apply.counts.value.changes).toBe(0);
  await apply.leaveOut('labels/legacy', false);
  await apply.backToEdits();
  await apply.setAuthoritative([]);
  await apply.review();
  expect(apply.counts.value.changes).toBe(0);
  expect(await readFile(profile.file, 'utf8')).toBe('labels: []\n');
  expect(github.writes).toEqual([]);
});

test('one-off edits are held, saved to the apply or not, until they are saved to the profile or the apply is left', async () => {
  await saved();
  const apply = new Apply(new FakeGitHub(), () => undefined);
  await apply.start('lunch/app', profile);
  expect(apply.holdsOneOffEdits.value).toBe(false);

  const issues = settingSections
    .flatMap((section) => section.groups.flatMap((group) => group.fields))
    .find((field) => field.path.join('.') === 'repository.has_issues');
  await apply.editor.value?.set(issues ?? neverField(), false);
  expect(apply.holdsOneOffEdits.value).toBe(true);

  await apply.review();
  expect(apply.holdsOneOffEdits.value).toBe(true);

  await apply.backToEdits();
  await apply.saveToProfile();
  expect(apply.holdsOneOffEdits.value).toBe(false);

  await apply.editor.value?.set(issues ?? neverField(), true);
  await apply.close();
  expect(apply.holdsOneOffEdits.value).toBe(false);
});
