import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { type ActionPatternCheck, ActionPatternChecks, patternNote } from '../src/app/action-pattern-checks.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function match(pattern: string): ActionPatternCheck {
  return { pattern, status: 'match', blocks: false, repository: pattern.split('@')[0] ?? pattern, archived: false };
}

/** A check that answers when told to, and remembers what each run asked. */
function held(): {
  readonly runs: string[][];
  readonly check: (patterns: readonly string[]) => Promise<ActionPatternCheck[]>;
  readonly land: (answer?: (pattern: string) => ActionPatternCheck) => Promise<void>;
  readonly fail: (error: Error) => Promise<void>;
} {
  const runs: string[][] = [];
  const waiting: {
    patterns: readonly string[];
    resolve: (checks: ActionPatternCheck[]) => void;
    reject: (error: Error) => void;
  }[] = [];
  return {
    runs,
    check: (patterns) =>
      new Promise((resolve, reject) => {
        runs.push([...patterns]);
        waiting.push({ patterns, resolve, reject });
      }),
    land: async (answer = match) => {
      const run = waiting.shift();
      run?.resolve(run.patterns.map(answer));
      await Promise.resolve();
      await Promise.resolve();
    },
    fail: async (error) => {
      waiting.shift()?.reject(error);
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

function kinds(checks: ActionPatternChecks): (string | undefined)[] {
  return checks.lines.value.map((line) => line.state?.kind);
}

test('the patterns a profile opens with are checked at once, and one typed later waits for typing to stop', async () => {
  const github = held();
  const checks = new ActionPatternChecks(github.check);

  checks.follow(['actions/*', '', '  docker/build-push-action@v6  ', 'a/b, c/d']);
  expect(github.runs).toEqual([['actions/*', 'docker/build-push-action@v6']]);
  expect(kinds(checks)).toEqual(['checking', undefined, 'checking', 'several']);
  expect(checks.canCheckAgain.value).toBe(false);

  await github.land();
  expect(kinds(checks)).toEqual(['checked', undefined, 'checked', 'several']);
  expect(checks.summary.value).toBe("2 match, 1 can't be checked");

  checks.follow(['actions/*', 'octo-org/dep']);
  checks.follow(['actions/*', 'octo-org/deploy']);
  expect(kinds(checks)).toEqual(['checked', 'waiting']);
  vi.advanceTimersByTime(599);
  expect(github.runs).toHaveLength(1);
  vi.advanceTimersByTime(1);
  // The text typed on the way was never asked about.
  expect(github.runs[1]).toEqual(['octo-org/deploy']);
  expect(kinds(checks)).toEqual(['checked', 'checking']);
});

test('a check that lands after its line changed shows on no other line, and is there when the text comes back', async () => {
  const github = held();
  const checks = new ActionPatternChecks(github.check);
  checks.follow(['actions/checkout@v4']);

  checks.follow(['actions/checkout@v5']);
  await github.land();
  expect(kinds(checks)).toEqual(['waiting']);

  checks.follow(['actions/checkout@v4']);
  expect(kinds(checks)).toEqual(['checked']);
  vi.advanceTimersByTime(600);
  // Nothing in the list waits any more, so the pause ended without a run.
  expect(github.runs).toHaveLength(1);
});

test("GitHub's error for a pattern and a run that fails are failures, which typing doesn't try again", async () => {
  const github = held();
  const checks = new ActionPatternChecks(github.check);
  checks.follow(['a/b', 'c/d']);
  await github.land((pattern) =>
    pattern === 'a/b'
      ? { pattern, status: 'error', blocks: false, message: 'API rate limit exceeded', rate_limited: true }
      : { pattern, status: 'not_found', blocks: false, missing: 'repository', name: 'c/d' },
  );

  expect(checks.lines.value[0]?.state).toEqual({
    kind: 'failed',
    message: "GitHub's limit is reached. Check again in a while.",
  });
  expect(checks.summary.value).toBe('1 matches nothing, 1 could not be checked');

  checks.follow(['a/b', 'c/d', 'e/f']);
  vi.advanceTimersByTime(600);
  expect(github.runs[1]).toEqual(['e/f']);
  await github.fail(new Error('Failed to fetch'));
  expect(checks.lines.value[2]?.state).toEqual({ kind: 'failed', message: 'Failed to fetch' });

  checks.checkAgain();
  expect(github.runs[2]).toEqual(['a/b', 'c/d', 'e/f']);
  expect(kinds(checks)).toEqual(['checking', 'checking', 'checking']);
  // Asking again waits for the run under way.
  checks.checkAgain();
  expect(github.runs).toHaveLength(3);
});

test('nothing is asked while the list is hidden, and it is checked at once when it first shows', () => {
  const github = held();
  const checks = new ActionPatternChecks(github.check);

  checks.follow(undefined);
  expect(github.runs).toEqual([]);
  expect(checks.canCheckAgain.value).toBe(false);

  checks.follow(['actions/*']);
  expect(github.runs).toEqual([['actions/*']]);

  // Hidden while a pattern waits: the pause is dropped, and starts again when the list shows.
  checks.follow(['actions/*', 'x/y']);
  checks.follow(undefined);
  vi.advanceTimersByTime(600);
  expect(github.runs).toHaveLength(1);
  checks.follow(['actions/*', 'x/y']);
  vi.advanceTimersByTime(600);
  expect(github.runs[1]).toEqual(['x/y']);
});

test('a long list is asked about a hundred patterns a run, one run after another', async () => {
  const github = held();
  const checks = new ActionPatternChecks(github.check);

  checks.follow(Array.from({ length: 150 }, (_, index) => `owner/repo-${index}`));
  expect(github.runs.map((run) => run.length)).toEqual([100]);
  expect(kinds(checks).every((kind) => kind === 'checking')).toBe(true);

  await github.land();
  expect(github.runs.map((run) => run.length)).toEqual([100, 50]);
  await github.land();
  expect(kinds(checks).every((kind) => kind === 'checked')).toBe(true);
});

test('a run that fails as a whole fails the runs after it without asking', async () => {
  const github = held();
  const checks = new ActionPatternChecks(github.check);
  checks.follow(Array.from({ length: 150 }, (_, index) => `owner/repo-${index}`));

  await github.fail(new Error('Bad credentials'));

  expect(github.runs).toHaveLength(1);
  expect(kinds(checks).every((kind) => kind === 'failed')).toBe(true);
});

test('a change to another setting hands the same list over and starts no pause again', () => {
  const github = held();
  const checks = new ActionPatternChecks(github.check);
  checks.follow(['a/b']);

  checks.follow(['a/b', 'c/d']);
  for (let turn = 0; turn < 5; turn += 1) {
    vi.advanceTimersByTime(500);
    checks.follow(['a/b', 'c/d']);
  }

  expect(github.runs[1]).toEqual(['c/d']);
});

test('check again during a pause asks about every line at once, the waiting one too', async () => {
  const github = held();
  const checks = new ActionPatternChecks(github.check);
  checks.follow(['a/b']);
  await github.land();
  checks.follow(['a/b', 'c/d']);

  checks.checkAgain();

  expect(github.runs[1]).toEqual(['a/b', 'c/d']);
  vi.advanceTimersByTime(600);
  expect(github.runs).toHaveLength(2);
});

test('a note starts with a capital, but for a repository, which keeps its name', () => {
  const note = (check: ActionPatternCheck): string => patternNote({ kind: 'checked', check }).text;
  const found = {
    status: 'match',
    repository: 'actions/checkout',
    archived: false,
    ref: 'v4',
    ref_kind: 'tag',
  } as const;

  expect(note({ pattern: 'actions/checkout@v4', blocks: false, ...found })).toBe('actions/checkout, tag v4.');
  expect(note({ pattern: '!actions/checkout@v4', blocks: true, ...found })).toBe('Blocks actions/checkout, tag v4.');
  expect(
    patternNote({
      kind: 'checked',
      check: { pattern: 'x/y', blocks: false, status: 'not_found', missing: 'repository', name: 'x/y' },
    }),
  ).toEqual({ tone: 'warning', text: 'No repository x/y you can see.' });
  expect(patternNote({ kind: 'failed', message: 'Failed to fetch' }).text).toBe(
    'Could not be checked: Failed to fetch',
  );
});

test("an editor's list is followed as it is typed, and only while GitHub shows it", async () => {
  const { ProfileEditor } = await import('../src/app/profile-editor.js');
  const { settingSections } = await import('../src/app/setting-fields.js');
  const { mkdir, rm, writeFile } = await import('../src/engine/files.js');
  const field = (path: string): (typeof settingSections)[number]['groups'][number]['fields'][number] => {
    const found = settingSections
      .flatMap((section) => section.groups.flatMap((group) => group.fields))
      .find((item) => item.path.join('.') === path);
    if (found === undefined) {
      throw new Error(`The editor has no setting ${path}.`);
    }
    return found;
  };
  await mkdir('/profiles', { recursive: true });
  await writeFile(
    '/profiles/web.yaml',
    'actions:\n  allowed_actions: selected\n  selected_actions:\n    patterns_allowed:\n      - actions/*\n',
  );
  const github = held();
  const editor = new ProfileEditor('/profiles/web.yaml', new ActionPatternChecks(github.check));

  await editor.load();
  expect(github.runs).toEqual([['actions/*']]);

  // The lines are the box's as typed, so a line being typed is where its check will show.
  await editor.type(field('actions.selected_actions.patterns_allowed'), 'actions/*\n\nocto-org/deploy@v1 ');
  expect(editor.patterns?.lines.value.map((line) => line.text)).toEqual(['actions/*', '', 'octo-org/deploy@v1 ']);
  vi.advanceTimersByTime(600);
  expect(github.runs[1]).toEqual(['octo-org/deploy@v1']);

  await editor.set(field('actions.allowed_actions'), 'all');
  expect(editor.patterns?.lines.value).toEqual([]);

  // A profile that stops reading has no list to ask about.
  await editor.resetAll();
  await editor.type(field('actions.selected_actions.patterns_allowed'), 'actions/*\nnew/one');
  await writeFile('/profiles/web.yaml', 'actions: 5\n');
  await editor.load();
  vi.advanceTimersByTime(600);
  expect(github.runs).toHaveLength(2);

  await rm('/', { recursive: true });
});
