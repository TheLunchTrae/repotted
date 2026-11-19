import { createPlan, type GitHub, parseRepo } from '@repotted/core';
import { afterEach, expect, test, vi } from 'vitest';

import { answered, FakeFleet, FakeGitHub } from '../../../core/tests/support/fake-github.js';
import { ApplyQueue, type ApplyQueueOptions, type ApplyRequest } from '../../src/app/apply/apply-queue.js';
import { assignmentKey, noAssignments, type ProfileAssignments } from '../../src/app/repositories/assignment-review.js';
import { mkdir, readdir, readFile, rm, writeFile } from '../../src/engine/files.js';

afterEach(async () => {
  await rm('/', { recursive: true });
});

const minute = 60_000;
const queuedAt = Date.UTC(2026, 0, 1, 12);
const desired = { repository: { has_wiki: false }, labels: [{ name: 'triage', color: 'ededed' }] };

function writes(fake: FakeGitHub): string[] {
  return fake.writes.map((call) => `${call.method} ${call.path}`);
}

async function keptFiles(): Promise<string[]> {
  return readdir('/queue', { withFileTypes: true }).then(
    (entries) => entries.map((entry) => entry.name),
    () => [],
  );
}

async function requestFor(fake: FakeGitHub, extra: Partial<ApplyRequest> = {}): Promise<ApplyRequest> {
  return {
    repository: fake.fullName,
    profileName: 'web',
    plan: await createPlan(fake, parseRepo(fake.fullName), desired),
    assignmentKey: undefined,
    record: undefined,
    ...extra,
  };
}

function queueFor(github: GitHub, options: Partial<ApplyQueueOptions> = {}) {
  const applied: number[] = [];
  const signedOut = vi.fn();
  const queue = new ApplyQueue({
    github,
    account: 'trae',
    onSignedOut: signedOut,
    assignments: noAssignments,
    now: () => queuedAt,
    filesKept: () => Promise.resolve(),
    assignmentsLoaded: Promise.resolve(),
    onApplied: (repositories) => applied.push(repositories),
    ...options,
  });
  return { queue, applied, signedOut };
}

function statuses(queue: ApplyQueue): string[] {
  return queue.applies.value.map((apply) => `${apply.repository} ${apply.status}`);
}

/**
 * A tab that queued an apply of each repository and closed while it wrote the
 * first: after `writesBeforeClosing` of its writes landed, no request of that
 * tab's is answered again. The second repository's apply never began.
 */
async function closedTab(
  fakes: readonly FakeGitHub[],
  writesBeforeClosing: number,
  requests?: readonly ApplyRequest[],
  assignments: ProfileAssignments = noAssignments,
) {
  const fleet = new FakeFleet(fakes);
  let written = 0;
  const closing: GitHub = {
    request: (method, path, body) => {
      if (method !== 'GET' && written >= writesBeforeClosing) {
        return new Promise(() => undefined);
      }
      written += method === 'GET' ? 0 : 1;
      return fleet.request(method, path, body);
    },
  };
  const { queue } = queueFor(closing, { assignments });
  for (const request of requests ?? (await Promise.all(fakes.map((fake) => requestFor(fake))))) {
    queue.add(request).catch(() => undefined);
  }
  await vi.waitFor(async () => {
    expect(fakes.flatMap(writes)).toHaveLength(writesBeforeClosing);
    expect(await keptFiles()).toHaveLength(fakes.length);
    expect(statuses(queue)[0]).toContain('writing');
  });
  return fleet;
}

class GitHubWithHeldRequests extends FakeGitHub {
  #gate: Promise<void> | undefined;
  #open: () => void = () => undefined;

  hold(): void {
    this.#gate = new Promise((resolve) => {
      this.#open = resolve;
    });
  }

  release(): void {
    this.#open();
    this.#gate = undefined;
  }

  override async request(...args: Parameters<FakeGitHub['request']>): Promise<unknown> {
    await this.#gate;
    return super.request(...args);
  }
}

test('queued plans are kept as files, written one repository at a time in order, and gone once written', async () => {
  const app = new GitHubWithHeldRequests({}, 'lunch/app');
  const api = new FakeGitHub({}, 'lunch/api');
  const { queue, applied } = queueFor(new FakeFleet([app, api]));
  const [first, second] = [await requestFor(app), await requestFor(api)];

  app.hold();
  const outcomes = [queue.add(first), queue.add(second)];
  await vi.waitFor(async () => {
    expect(await keptFiles()).toHaveLength(2);
    expect(statuses(queue)).toEqual(['lunch/app writing', 'lunch/api waiting']);
  });
  expect(queue.progress.value).toEqual({ finished: 0, total: 2, repository: 'lunch/app' });
  expect(writes(api)).toEqual([]);
  app.release();

  expect((await Promise.all(outcomes)).map((outcome) => outcome.applied.length)).toEqual([2, 2]);
  expect(writes(app)).toEqual(['PATCH /repos/lunch/app', 'POST /repos/lunch/app/labels']);
  expect(writes(api)).toEqual(['PATCH /repos/lunch/api', 'POST /repos/lunch/api/labels']);
  await vi.waitFor(async () => {
    expect(await keptFiles()).toEqual([]);
    expect(queue.running.value).toBe(false);
  });
  expect(queue.progress.value).toBeUndefined();
  // The pages that added them say so themselves.
  expect(applied).toEqual([]);
});

test('an entry is kept as begun before GitHub is asked for anything', async () => {
  const app = new FakeGitHub();
  const kept = Promise.withResolvers<undefined>();
  const { queue } = queueFor(app, { filesKept: () => kept.promise });
  const request = await requestFor(app);
  const readsToPlan = app.calls.length;

  const outcome = queue.add(request);
  await vi.waitFor(async () => {
    const [file = ''] = await keptFiles();
    expect(JSON.parse(await readFile(`/queue/${file}`, 'utf8'))).toMatchObject({ hasBegun: true });
  });
  expect(app.calls).toHaveLength(readsToPlan);
  kept.resolve(undefined);

  expect((await outcome).applied).toHaveLength(2);
});

test('a reload within the hour carries on by itself: a cut-off apply writes only what is left, and one never begun is written as reviewed', async () => {
  const app = new FakeGitHub({}, 'lunch/app');
  const api = new FakeGitHub({}, 'lunch/api');
  const fleet = await closedTab([app, api], 1);
  expect(writes(app)).toEqual(['PATCH /repos/lunch/app']);

  const { queue, applied } = queueFor(fleet, { now: () => queuedAt + 60 * minute });
  await queue.load();

  await vi.waitFor(() => {
    expect(applied).toEqual([2]);
  });
  expect(writes(app)).toEqual(['PATCH /repos/lunch/app', 'POST /repos/lunch/app/labels']);
  expect(writes(api)).toEqual(['PATCH /repos/lunch/api', 'POST /repos/lunch/api/labels']);
  expect(queue.applies.value).toEqual([]);
  await vi.waitFor(async () => {
    expect(await keptFiles()).toEqual([]);
  });
});

test('after an hour nothing is written until it is continued', async () => {
  const app = new FakeGitHub({}, 'lunch/app');
  const api = new FakeGitHub({}, 'lunch/api');
  const fleet = await closedTab([app, api], 0);

  const { queue, applied } = queueFor(fleet, { now: () => queuedAt + 61 * minute });
  await queue.load();
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

  expect(statuses(queue)).toEqual(['lunch/app held', 'lunch/api held']);
  expect(queue.held.value).toEqual({ repositories: 2, changes: 4, since: queuedAt, signInLost: false });
  expect(queue.running.value).toBe(false);
  expect([...writes(app), ...writes(api)]).toEqual([]);

  await queue.continueHeld();

  await vi.waitFor(() => {
    expect(applied).toEqual([2]);
  });
  expect(queue.held.value).toBeUndefined();
  expect(writes(api)).toEqual(['PATCH /repos/lunch/api', 'POST /repos/lunch/api/labels']);
});

test('what waits to be continued can be discarded, and a clock set back since asks too', async () => {
  const app = new FakeGitHub({}, 'lunch/app');
  const fleet = await closedTab([app], 0);

  const { queue } = queueFor(fleet, { now: () => queuedAt - minute });
  await queue.load();
  expect(statuses(queue)).toEqual(['lunch/app held']);
  await queue.discardHeld();

  expect(queue.applies.value).toEqual([]);
  expect(await keptFiles()).toEqual([]);
  expect(writes(app)).toEqual([]);
});

test('a repository that changed while the tab was closed gets nothing written, and a new apply of it replaces the entry', async () => {
  const app = new FakeGitHub({}, 'lunch/app');
  const api = new FakeGitHub({}, 'lunch/api');
  const fleet = await closedTab([app, api], 0);
  // Never begun, so it is written only if the repository still needs exactly the reviewed changes.
  api.state.repository['has_wiki'] = false;

  const { queue, applied } = queueFor(fleet);
  await queue.load();
  await vi.waitFor(() => {
    expect(statuses(queue)).toEqual(['lunch/api stale']);
  });

  expect(queue.applies.value[0]?.message).toContain('lunch/api changed since you reviewed this apply');
  expect(writes(api)).toEqual([]);
  expect(applied).toEqual([1]);
  expect(await keptFiles()).toHaveLength(1);

  const fresh = queue.add(await requestFor(api));
  expect(statuses(queue)).toEqual(['lunch/api waiting']);
  expect((await fresh).applied).toHaveLength(1);
  await vi.waitFor(async () => {
    expect(await keptFiles()).toEqual([]);
  });
});

test('an apply GitHub refuses partway says what stays written, and trying again writes only the rest', async () => {
  const app = new FakeGitHub({}, 'lunch/app');
  const fleet = await closedTab([app], 0);
  app.fail('POST /repos/lunch/app/labels', answered(422, 'Validation Failed'), 1);

  const { queue, applied } = queueFor(fleet);
  await queue.load();
  await vi.waitFor(() => {
    expect(statuses(queue)).toEqual(['lunch/app failed']);
  });
  expect(queue.applies.value[0]?.message).toContain('1 change before it stays written');
  expect(queue.running.value).toBe(false);

  await queue.tryAgain(queue.applies.value[0]?.id ?? '');

  await vi.waitFor(() => {
    expect(applied).toEqual([1]);
  });
  expect(writes(app)).toEqual([
    'PATCH /repos/lunch/app',
    'POST /repos/lunch/app/labels',
    'POST /repos/lunch/app/labels',
  ]);
  expect(app.state.labels.map((label) => label.name)).toContain('triage');
});

test("another account's entries and unreadable ones are removed without being run", async () => {
  const app = new FakeGitHub({}, 'lunch/app');
  const fleet = await closedTab([app], 0);
  await mkdir('/queue', { recursive: true });
  await writeFile('/queue/broken.json', '{ not json');

  const { queue } = queueFor(fleet, { account: 'someone-else' });
  await queue.load();

  expect(queue.applies.value).toEqual([]);
  expect(await keptFiles()).toEqual([]);
  expect(writes(app)).toEqual([]);
});

test('a lost sign-in stops the queue once, and what is left stays kept and waits to be continued', async () => {
  const app = new FakeGitHub({}, 'lunch/app');
  const api = new FakeGitHub({}, 'lunch/api');
  const fleet = await closedTab([app, api], 0);
  app.fail('PATCH /repos/lunch/app', answered(401, 'Bad credentials'), 1);

  const { queue, signedOut } = queueFor(fleet);
  await queue.load();
  await vi.waitFor(() => {
    expect(signedOut).toHaveBeenCalledOnce();
  });

  expect(statuses(queue)).toEqual(['lunch/app held', 'lunch/api held']);
  expect(await keptFiles()).toHaveLength(2);
  expect(writes(api)).toEqual([]);

  // The next sign-in, minutes later, opens the app afresh, and still writes nothing unasked.
  const requestsBefore = [...writes(app), ...writes(api)];
  const next = queueFor(fleet, { now: () => queuedAt + 5 * minute });
  await vi.waitFor(async () => {
    await next.queue.load();
    expect(statuses(next.queue)).toEqual(['lunch/app held', 'lunch/api held']);
  });
  expect(next.queue.held.value?.signInLost).toBe(true);
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  expect([...writes(app), ...writes(api)]).toEqual(requestsBefore);

  // An apply of one of them reviewed since replaces the one that waits.
  const fresh = next.queue.add(await requestFor(api));
  expect(statuses(next.queue)).toEqual(['lunch/app held', 'lunch/api waiting']);
  expect((await fresh).applied).toHaveLength(2);
  expect(writes(app)).toEqual(requestsBefore);
});

test('a try that fails before it writes leaves the entry as never begun, so trying again still needs the reviewed plan exactly', async () => {
  const app = new FakeGitHub({}, 'lunch/app');
  const api = new FakeGitHub({}, 'lunch/api');
  const fleet = await closedTab([app, api], 0);
  api.fail(/^GET /u, new Error('Failed to fetch'), 1);

  const { queue } = queueFor(fleet);
  await queue.load();
  await vi.waitFor(() => {
    expect(statuses(queue)).toEqual(['lunch/api failed']);
  });
  expect(writes(api)).toEqual([]);
  api.state.repository['has_wiki'] = false;

  await queue.tryAgain(queue.applies.value[0]?.id ?? '');

  await vi.waitFor(() => {
    expect(statuses(queue)).toEqual(['lunch/api stale']);
  });
  expect(writes(api)).toEqual([]);
});

test("nothing is written until the repositories' profiles are read", async () => {
  const app = new FakeGitHub({}, 'lunch/app');
  const loaded = Promise.withResolvers<undefined>();
  const { queue } = queueFor(app, { assignmentsLoaded: loaded.promise });
  const request = await requestFor(app);
  const readsToPlan = app.calls.length;

  const outcome = queue.add(request);
  await vi.waitFor(() => {
    expect(queue.running.value).toBe(true);
  });
  expect(app.calls).toHaveLength(readsToPlan);
  loaded.resolve(undefined);

  expect((await outcome).applied).toHaveLength(2);
});

test('an apply finished after a reload records it, and one whose repository profiles changed since is refused', async () => {
  const app = new FakeGitHub({}, 'lunch/app');
  const api = new FakeGitHub({}, 'lunch/api');
  const profilesByRepository: Record<string, string[]> = { 'lunch/app': ['web.yaml'], 'lunch/api': ['web.yaml'] };
  const recordApplied = vi.fn<ProfileAssignments['recordApplied']>(() => Promise.resolve(true));
  const assignments: ProfileAssignments = {
    ...noAssignments,
    profilesOf: (repository) => profilesByRepository[repository] ?? [],
    recordApplied,
  };
  const versions = [{ profile: 'web.yaml', version: 'reviewed' }];
  const fleet = await closedTab(
    [app, api],
    0,
    await Promise.all(
      [app, api].map((fake) =>
        requestFor(fake, {
          assignmentKey: assignmentKey(assignments, fake.fullName),
          record: { kind: 'applied', versions, notify: false },
        }),
      ),
    ),
    assignments,
  );
  profilesByRepository['lunch/api'] = ['web.yaml', 'added-since.yaml'];

  const { queue, applied } = queueFor(fleet, { assignments });
  await queue.load();
  await vi.waitFor(() => {
    expect(applied).toEqual([1]);
  });

  expect(recordApplied.mock.calls).toEqual([['lunch/app', versions, [], false]]);
  expect(statuses(queue)).toEqual(['lunch/api failed']);
  expect(queue.applies.value[0]?.message).toContain('assignment changed since review');
  expect(writes(api)).toEqual([]);

  await queue.dismiss(queue.applies.value[0]?.id ?? '');
  expect(queue.applies.value).toEqual([]);
  await vi.waitFor(async () => {
    expect(await keptFiles()).toEqual([]);
  });
});

test('signing out discards everything the queue holds', async () => {
  const app = new FakeGitHub({}, 'lunch/app');
  const fleet = await closedTab([app], 0);
  const { queue } = queueFor(fleet, { now: () => queuedAt + 61 * minute });
  await queue.load();

  await queue.discardAll();

  expect(queue.applies.value).toEqual([]);
  expect(await keptFiles()).toEqual([]);
});

test("entries a page lets go stay queued and end as no page's: a failure is kept, and the rest are confirmed", async () => {
  const app = new FakeGitHub({}, 'lunch/app');
  const api = new FakeGitHub({}, 'lunch/api');
  app.fail('POST /repos/lunch/app/labels', answered(422, 'Validation Failed'), 1);
  const { queue, applied } = queueFor(new FakeFleet([app, api]));

  const requests = [await requestFor(app), await requestFor(api)] as const;
  const page = {};
  const first = queue.add(requests[0], page);
  const second = queue.add(requests[1], page);
  queue.letGo(page);

  // The page is told at once, since neither had its turn yet.
  await expect(first).rejects.toThrow('The page moved on');
  await expect(second).rejects.toThrow('The page moved on');
  await vi.waitFor(() => {
    expect(statuses(queue)).toEqual(['lunch/app failed']);
  });
  expect(applied).toEqual([1]);
  expect(writes(api)).toHaveLength(2);
});

test('an entry let go while it is written tells its page how it ended, and keeps its failure', async () => {
  const app = new FakeGitHub({}, 'lunch/app');
  app.fail('POST /repos/lunch/app/labels', answered(422, 'Validation Failed'), 1);
  let entered = (): void => undefined;
  let release = (): void => undefined;
  const writingBegan = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { queue } = queueFor({
    request: async (method, path, body) => {
      if (method !== 'GET') {
        entered();
        await held;
      }
      return app.request(method, path, body);
    },
  });

  const page = {};
  const outcome = queue.add(await requestFor(app), page);
  await writingBegan;
  queue.letGo(page);
  release();

  await expect(outcome).rejects.toThrow('Failed to create triage');
  expect(statuses(queue)).toEqual(['lunch/app failed']);
});

test('each page is told how many applies are written before its own', async () => {
  const app = new FakeGitHub({}, 'lunch/app');
  const api = new FakeGitHub({}, 'lunch/api');
  const { queue } = queueFor(new FakeFleet([app, api]));
  const [onePage, otherPage] = [{}, {}];
  const requests = [await requestFor(app), await requestFor(api)] as const;

  const earlier = queue.add(requests[0], onePage);
  const later = queue.add(requests[1], otherPage);
  expect(queue.earlierThan(onePage)).toBe(0);
  expect(queue.earlierThan(otherPage)).toBe(1);

  await earlier;
  await later;
  expect(queue.earlierThan(otherPage)).toBe(0);
});

test("a page that lets go leaves another page's apply of the same repository alone", async () => {
  const app = new FakeGitHub({}, 'lunch/app');
  const { queue } = queueFor(app);
  const [movesOn, stays] = [{}, {}];
  const request = await requestFor(app);

  const letGo = queue.add(request, movesOn);
  const waitedFor = queue.add(request, stays);
  queue.letGo(movesOn);

  await expect(letGo).rejects.toThrow('The page moved on');
  // The apply let go is still written first, so the one waited for finds the repository changed.
  await expect(waitedFor).rejects.toThrow('changed since');
  expect(statuses(queue)).toEqual([]);
});

test('a failure is its page’s to say until the page moves on, and then the queue’s', async () => {
  const app = new FakeGitHub({}, 'lunch/app');
  app.fail('POST /repos/lunch/app/labels', answered(422, 'Validation Failed'), 2);
  const { queue } = queueFor(app);
  const [shows, movesOn] = [{}, {}];

  await expect(queue.add(await requestFor(app), shows)).rejects.toThrow('Failed to create triage');
  expect(statuses(queue)).toEqual([]);
  await queue.shownBy(shows);
  queue.letGo(shows);
  expect(statuses(queue)).toEqual([]);
  expect(await keptFiles()).toEqual([]);

  await expect(queue.add(await requestFor(app), movesOn)).rejects.toThrow('Failed to create triage');
  queue.letGo(movesOn);
  expect(statuses(queue)).toEqual(['lunch/app failed']);
});

test('an apply written for a page that moves on before showing it is confirmed by the queue', async () => {
  const app = new FakeGitHub({}, 'lunch/app');
  const api = new FakeGitHub({}, 'lunch/api');
  const { queue, applied } = queueFor(new FakeFleet([app, api]));
  const [shows, movesOn] = [{}, {}];
  const requests = [await requestFor(app), await requestFor(api)] as const;

  await queue.add(requests[0], shows);
  await queue.shownBy(shows);
  queue.letGo(shows);
  expect(applied).toEqual([]);

  await queue.add(requests[1], movesOn);
  await vi.waitFor(() => {
    expect(queue.running.value).toBe(false);
  });
  queue.letGo(movesOn);
  expect(applied).toEqual([1]);
});
