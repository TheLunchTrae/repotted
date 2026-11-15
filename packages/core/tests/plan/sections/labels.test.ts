import { randomInt, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, test } from 'vitest';

import { parseRepo } from '../src/github.js';
import { lockChanges } from '../src/permissions.js';
import { applyPlan, captureProfile, createPlan, formatPlan, skippedDrafts, StalePlanError } from '../src/plan.js';
import { editProfile, resolveProfile } from '../src/profile.js';
import { type LabelEntry, profileFileJsonSchema } from '../src/schema.js';
import { createStagedApply, editStagedApply, planStagedApply } from '../src/staged.js';
import { answered, FakeGitHub } from './fake-github.js';

const repo = parseRepo('lunch/app');
const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'repotted-labels-')));

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function write(text: string): Promise<string> {
  const file = path.join(directory, `${randomUUID()}.yaml`);
  await writeFile(file, text);
  return file;
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('Expected a rejection');
}

function stored(name: string, color = 'ededed', description: string | null = null) {
  return { id: randomInt(1, 1_000_000), name, color, description, default: false };
}

function plan(github: FakeGitHub, labels: LabelEntry[]) {
  return createPlan(github, repo, { labels });
}

describe('label plans', () => {
  test('create, update and leave alone the labels a profile names, and no others', async () => {
    const github = new FakeGitHub({ labels: [stored('bug', 'd73a4a', 'Something is wrong'), stored('question')] });

    const result = await plan(github, [
      { name: 'Bug', color: '#D73A4A', description: 'Something is wrong' },
      { name: 'question', color: 'ededed' },
      { name: 'priority: high', color: 'b60205' },
    ]);
    await applyPlan(github, result);

    // The case-only rename is an update; the matching color in another spelling is not a change.
    expect(github.writes).toEqual([
      {
        method: 'PATCH',
        path: '/repos/lunch/app/labels/bug',
        body: { new_name: 'Bug' },
      },
      {
        method: 'POST',
        path: '/repos/lunch/app/labels',
        body: { name: 'priority: high', color: 'b60205' },
      },
    ]);
    expect(github.state.labels.map((label) => label.name)).toEqual(['Bug', 'question', 'priority: high']);
    expect((await plan(github, result.desired.labels ?? [])).changes).toEqual([]);
  });

  test('keep the color or description a profile leaves out, and clear a description set to empty', async () => {
    const github = new FakeGitHub({ labels: [stored('docs', '0075ca', 'Documentation')] });

    await applyPlan(github, await plan(github, [{ name: 'docs', description: '' }]));

    expect(github.writes).toEqual([
      { method: 'PATCH', path: '/repos/lunch/app/labels/docs', body: { description: '' } },
    ]);
    expect(github.state.labels[0]).toMatchObject({ color: '0075ca', description: null });
    expect((await plan(github, [{ name: 'docs', description: '' }])).changes).toEqual([]);
  });

  test('rename an old label, so issues keep it, and plan nothing once it is renamed', async () => {
    const github = new FakeGitHub({ labels: [stored('enhancement', 'a2eeef')] });
    const labels: LabelEntry[] = [
      {
        name: 'type: feature',
        color: 'a2eeef',
        description: 'New feature',
        renamed_from: ['feature request', 'enhancement'],
      },
    ];

    const result = await plan(github, labels);
    expect(result.warnings).toEqual([]);
    expect(formatPlan(result)).toContain('label "type: feature"');
    await applyPlan(github, result);

    expect(github.writes).toEqual([
      {
        method: 'PATCH',
        path: '/repos/lunch/app/labels/enhancement',
        body: { new_name: 'type: feature', description: 'New feature' },
      },
    ]);
    expect(github.state.labels).toEqual([
      expect.objectContaining({ name: 'type: feature', description: 'New feature' }),
    ]);
    expect((await plan(github, labels)).changes).toEqual([]);
  });

  test('name each change by the label the profile names', async () => {
    const github = new FakeGitHub({ labels: [stored('enhancement'), stored('WontFix')] });

    const result = await plan(github, [
      { name: 'feature', color: 'a2eeef', renamed_from: ['enhancement'] },
      { name: 'wontfix', absent: true },
    ]);

    expect(result.changes.map((change) => [`${change.action} ${change.target}`, change.entry])).toEqual([
      ['delete wontfix', { name: 'wontfix' }],
      ['update feature', { name: 'feature' }],
    ]);
  });

  test('leave an old label as it is, with a warning, when the repository has the new one too', async () => {
    const github = new FakeGitHub({ labels: [stored('enhancement'), stored('Feature', 'ededed')] });

    const result = await plan(github, [{ name: 'feature', color: 'a2eeef', renamed_from: ['enhancement'] }]);

    expect(result.changes.map((change) => change.request)).toEqual([
      { method: 'PATCH', path: '/repos/lunch/app/labels/Feature', body: { new_name: 'feature', color: 'a2eeef' } },
    ]);
    expect(result.warnings).toMatchObject([{ section: 'labels', key: 'feature' }]);
    expect(result.warnings[0]?.message).toContain('left "enhancement" as it is');
  });

  test('rename the first old name the repository has and warn about the rest', async () => {
    const github = new FakeGitHub({ labels: [stored('wip'), stored('in progress')] });

    const result = await plan(github, [{ name: 'status: doing', renamed_from: ['in progress', 'wip'] }]);

    expect(result.changes.map((change) => change.request.path)).toEqual(['/repos/lunch/app/labels/in%20progress']);
    expect(result.warnings).toMatchObject([{ section: 'labels', key: 'status: doing' }]);
    expect(result.warnings[0]?.message).toContain('leaves "wip"');
  });

  test('order deletes, then renames, then updates, then creates', async () => {
    const github = new FakeGitHub({ labels: [stored('wontfix'), stored('old'), stored('triage')] });
    const labels: LabelEntry[] = [
      { name: 'later', color: 'ffffff' },
      { name: 'triage', color: '000000' },
      { name: 'renamed', renamed_from: ['old'] },
      { name: 'wontfix', absent: true },
      { name: 'gone', absent: true },
    ];

    const result = await plan(github, labels);

    expect(result.changes.map((change) => `${change.request.method} ${change.target}`)).toEqual([
      'DELETE wontfix',
      'PATCH renamed',
      'PATCH triage',
      'POST later',
    ]);
    await applyPlan(github, result);
    expect(github.state.labels.map((label) => label.name)).toEqual(['renamed', 'triage', 'later']);
  });

  test('encode names in paths', async () => {
    const github = new FakeGitHub({ labels: [stored('good first issue'), stored('a/b'), stored('🐛 bug')] });

    const result = await plan(github, [
      { name: 'good first issue', absent: true },
      { name: 'a/b', color: '000000' },
      { name: '🐛 bug', description: 'Bug' },
    ]);
    await applyPlan(github, result);

    expect(github.writes.map((call) => call.path)).toEqual([
      '/repos/lunch/app/labels/good%20first%20issue',
      '/repos/lunch/app/labels/a%2Fb',
      '/repos/lunch/app/labels/%F0%9F%90%9B%20bug',
    ]);
    expect(github.state.labels.map((label) => label.name)).toEqual(['a/b', '🐛 bug']);
  });

  test('read labels past the first page, so a label on page two is never created again', async () => {
    const github = new FakeGitHub({
      labels: Array.from({ length: 150 }, (_, index) => stored(`label-${String(index).padStart(3, '0')}`)),
    });

    expect((await plan(github, [{ name: 'LABEL-149', color: 'ededed' }])).changes).toEqual([
      expect.objectContaining({
        request: { method: 'PATCH', path: '/repos/lunch/app/labels/label-149', body: { new_name: 'LABEL-149' } },
      }),
    ]);
  });

  test('skip labels it cannot read and still plan the rest', async () => {
    const github = new FakeGitHub().fail(
      'GET /repos/lunch/app/labels',
      answered(403, 'Resource not accessible by integration'),
    );

    const result = await createPlan(github, repo, { repository: { has_wiki: false }, labels: [{ name: 'bug' }] });

    expect(result.changes.map((change) => change.section)).toEqual(['repository']);
    expect(result.warnings).toEqual([expect.objectContaining({ section: 'labels', cause: 'refused' })]);
    expect((await captureProfile(github, repo)).warnings).toEqual(result.warnings);
  });

  test('lock label writes on an installation without Issues write', async () => {
    const github = new FakeGitHub();
    const result = await plan(github, [{ name: 'bug', color: 'd73a4a' }]);
    const installed = (permissions: Record<string, string>) =>
      ({ status: 'installed', permissions, settings_url: null }) as const;

    expect(lockChanges({ role: 'admin', app: installed({ administration: 'write' }) }, result.changes)).toEqual([
      { change: 0, reason: 'Needs Issues write' },
    ]);
    expect(lockChanges({ role: 'admin', app: installed({ issues: 'write' }) }, result.changes)).toEqual([]);
  });
});

describe('label plans that GitHub has moved on from', () => {
  test('find an old name in any case', async () => {
    const github = new FakeGitHub({ labels: [stored('enhancement')] });

    const result = await plan(github, [{ name: 'feature', renamed_from: ['Enhancement'] }]);

    expect(result.changes.map((change) => change.request)).toEqual([
      { method: 'PATCH', path: '/repos/lunch/app/labels/enhancement', body: { new_name: 'feature' } },
    ]);
  });

  test('refuse a plan whose label was renamed or deleted on GitHub since, without writing', async () => {
    const github = new FakeGitHub({ labels: [stored('enhancement'), stored('wontfix')] });
    const renamed = await plan(github, [{ name: 'feature', renamed_from: ['enhancement'] }]);
    const deleted = await plan(github, [{ name: 'wontfix', absent: true }]);
    github.state.labels = [stored('feature')];

    for (const stale of [renamed, deleted]) {
      await expect(applyPlan(github, stale)).rejects.toBeInstanceOf(StalePlanError);
    }
    expect(github.writes).toEqual([]);
  });
});

describe('label capture', () => {
  test('capture every label, with colors as six lowercase digits, so the same repository matches', async () => {
    const github = new FakeGitHub({ labels: [stored('Bug', 'D73A4A', 'Broken'), stored('question')] });

    const { profile, warnings } = await captureProfile(github, repo);

    expect(warnings).toEqual([]);
    expect(profile.labels).toEqual([
      { name: 'Bug', color: 'd73a4a', description: 'Broken' },
      { name: 'question', color: 'ededed', description: '' },
    ]);
    expect((await createPlan(github, repo, profile)).changes).toEqual([]);
  });

  test('leave labels out of a capture when the repository has none', async () => {
    expect((await captureProfile(new FakeGitHub(), repo)).profile.labels).toBeUndefined();
  });
});

describe('labels in profile files', () => {
  test('refuse a color YAML reads as a number, and say to quote it', async () => {
    const file = await write('labels: [{ name: bug, color: 000000 }]\n');

    expect(await rejection(resolveProfile(file))).toContain("in quotes, as '000000'");
  });

  test('refuse names that differ only in case, and old names that clash', async () => {
    const twice = await write('labels: [{ name: bug }, { name: Bug }]\n');
    const claimed = await write('labels: [{ name: a, renamed_from: [old] }, { name: b, renamed_from: [OLD] }]\n');
    const named = await write('labels: [{ name: a, renamed_from: [b] }, { name: b }]\n');
    const removed = await write('labels: [{ name: a, renamed_from: [b] }, { name: b, absent: true }]\n');
    const own = await write('labels: [{ name: a, renamed_from: [A] }]\n');
    const taken = await write('labels: [{ name: defect, renamed_from: [bug] }, { name: Bug }]\n');
    const absentRename = await write('labels: [{ name: a, absent: true, renamed_from: [b] }]\n');

    expect(await rejection(resolveProfile(twice))).toContain('Label');
    expect(await rejection(resolveProfile(claimed))).toContain('"OLD" is renamed to both "a" and "b"');
    for (const file of [named, removed, own, taken]) {
      expect(await rejection(resolveProfile(file))).toContain('renamed_from');
    }
    expect(await rejection(resolveProfile(absentRename))).toContain('renamed_from');
  });

  test('say when one label lists an old name twice', async () => {
    const file = await write('labels: [{ name: x, renamed_from: [a, A] }]\n');

    expect(await rejection(resolveProfile(file))).toContain('Label "x" lists "A" in renamed_from twice');
  });

  test('take a color in any case in the JSON Schema too', () => {
    // JSON Schema patterns carry no flags, so the pattern itself has to take either case.
    const pattern = /"pattern":"(\^#\?[^"]*)"/u.exec(JSON.stringify(profileFileJsonSchema()))?.[1];

    expect(pattern).toBeDefined();
    const color = new RegExp(String(JSON.parse(`"${pattern ?? ''}"`)), 'u');
    expect(['D73A4A', '#d73a4a', 'a2EEef'].every((value) => color.test(value))).toBe(true);
    expect(color.test('d73a4')).toBe(false);
  });

  test('warn about a draft label that another label renames, and still apply the rename', async () => {
    const file = await write(
      'labels: [{ name: triage, draft: true }, { name: needs-triage, renamed_from: [Triage] }]\n',
    );
    const resolved = await resolveProfile(file);
    const result = await createPlan(
      new FakeGitHub({ labels: [stored('triage')] }),
      repo,
      resolved.profile,
      skippedDrafts(resolved.drafts),
    );

    expect(resolved.warnings).toEqual([
      expect.stringContaining('Draft label "triage": label "needs-triage" is renamed from it'),
    ]);
    expect(result.changes.map((change) => change.request.path)).toEqual(['/repos/lunch/app/labels/triage']);
    expect(result.warnings).toEqual([
      {
        section: 'labels',
        key: 'triage',
        message: 'Label "needs-triage" renames "triage", which the profile skips as a draft',
      },
    ]);
  });

  test('replace a base label named in any case across extends, as rulesets are replaced', async () => {
    const base = await write("labels: [{ name: Bug, color: 'd73a4a', description: Broken }, { name: docs }]\n");
    const own = await write(`extends: ${base}\nlabels: [{ name: bug, color: 'ff0000' }]\n`);

    const resolved = await resolveProfile(own);

    expect(resolved.profile.labels).toEqual([{ name: 'bug', color: 'ff0000' }, { name: 'docs' }]);
    expect(resolved.sources.labels).toEqual({ bug: own, docs: base });
  });

  test('leave draft labels out of plans and list them as skipped', async () => {
    const file = await write("labels: [{ name: release, draft: true, color: 'nope' }, { name: bug }]\n");
    const resolved = await resolveProfile(file);
    const result = await createPlan(new FakeGitHub(), repo, resolved.profile, skippedDrafts(resolved.drafts));

    expect(result.changes.map((change) => change.target)).toEqual(['bug']);
    expect(result.skipped).toEqual([{ section: 'labels', target: 'release' }]);
    expect(resolved.warnings).toEqual([expect.stringContaining('Draft label "release"')]);
  });

  test('add, finish and drop labels with profile edits', async () => {
    const file = await write('labels: [{ name: bug }]\n');

    await editProfile(file, [{ list: 'labels', name: 'Later', draft: true, entry: { name: 'Later', draft: true } }]);
    await editProfile(file, [
      { list: 'labels', name: 'later', draft: true, entry: undefined },
      { list: 'labels', name: 'later', entry: { name: 'Later', color: 'ffffff' } },
      { list: 'labels', name: 'BUG', entry: undefined },
    ]);

    const resolved = await resolveProfile(file);
    expect(resolved.profile.labels).toEqual([{ name: 'Later', color: 'ffffff' }]);
    expect(await readFile(file, 'utf8')).not.toContain('draft');
  });

  test('leave a label out of a staged apply by its name in any case', async () => {
    const profile = await write("labels: [{ name: Bug, color: 'd73a4a' }, { name: docs }]\n");
    const staged = path.join(directory, `staged-${randomUUID()}.yaml`);
    await createStagedApply(staged, 'lunch/app', profile);

    const { exclusions } = await planStagedApply(new FakeGitHub(), staged);
    expect(exclusions.map((exclusion) => exclusion.key)).toEqual(['labels/Bug', 'labels/docs']);

    await editStagedApply(staged, [{ exclude: 'labels/bug', excluded: true }]);
    const { plan: left } = await planStagedApply(new FakeGitHub(), staged);
    expect(left.changes.map((change) => change.target)).toEqual(['docs']);
    expect(await rejection(editStagedApply(staged, [{ exclude: 'labels/nope', excluded: true }]))).toContain(
      'sets nothing it names',
    );
  });

  test('refuse a draft label in a staged apply', async () => {
    const profile = await write('labels: [{ name: bug }]\n');
    const staged = path.join(directory, `staged-${randomUUID()}.yaml`);
    await createStagedApply(staged, 'lunch/app', profile);

    expect(
      await rejection(
        editStagedApply(staged, [{ list: 'labels', name: 'x', draft: true, entry: { name: 'x', draft: true } }]),
      ),
    ).toContain('cannot hold drafts');
  });
});
