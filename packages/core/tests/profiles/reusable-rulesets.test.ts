import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { parse } from 'yaml';

import { parseRepo } from '../../src/github/client.js';
import { applyPlan, createPlan } from '../../src/plan/plan.js';
import { editProfile, resolveProfile } from '../../src/profiles/profile.js';
import { FakeGitHub } from '../support/fake-github.js';

const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'repotted-ruleset-')));
const repo = parseRepo('lunch/app');

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function write(name: string, text: string): Promise<string> {
  const file = path.join(directory, name);
  await writeFile(file, text);
  return file;
}

describe('reusable rulesets', () => {
  test('direct and referenced application update the same target and preserve unrelated configuration', async () => {
    const definition = await write('main.yaml', 'kind: ruleset\nrulesets: [{ name: Main, enforcement: evaluate }]\n');
    const consumer = await write('service.yaml', 'references: { rulesets: [main.yaml] }\n');
    const github = new FakeGitHub({
      rulesets: [
        {
          id: 7,
          name: 'Main',
          target: 'branch',
          enforcement: 'active',
          bypass_actors: [{ actor_id: 42, actor_type: 'Integration', bypass_mode: 'always' }],
          conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
          rules: [{ type: 'deletion' }],
        },
        { id: 8, name: 'Release', target: 'tag', enforcement: 'active', bypass_actors: [], rules: [] },
      ],
    });
    const direct = await createPlan(github, repo, (await resolveProfile(definition)).profile);
    const referenced = await createPlan(github, repo, (await resolveProfile(consumer)).profile);

    expect(referenced.changes).toEqual(direct.changes);
    expect(direct.changes.map((change) => change.request)).toEqual([
      {
        method: 'PUT',
        path: '/repos/lunch/app/rulesets/7',
        body: {
          name: 'Main',
          target: 'branch',
          enforcement: 'evaluate',
          bypass_actors: [{ actor_id: 42, actor_type: 'Integration', bypass_mode: 'always' }],
          conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
          rules: [{ type: 'deletion' }],
        },
      },
    ]);
    const otherSections = { ...github.state, rulesets: undefined };
    await applyPlan(github, direct);
    expect({ ...github.state, rulesets: undefined }).toEqual(otherSections);
    expect(github.state.rulesets.map((ruleset) => ruleset.name).sort()).toEqual(['Main', 'Release']);
    expect((await createPlan(github, repo, (await resolveProfile(definition)).profile)).changes).toEqual([]);
  });

  test('uses references after base profiles and inline entries after references without flattening edits', async () => {
    await write('base.yaml', 'rulesets: [{ name: Main, rules: [{ type: creation }] }]\n');
    const shared = await write(
      'shared.yaml',
      'kind: ruleset\nrulesets: [{ name: Main, rules: [{ type: deletion }] }]\n',
    );
    const consumer = await write('layered.yaml', 'extends: base.yaml\nreferences: { rulesets: [shared.yaml] }\n');
    expect((await resolveProfile(consumer)).sources.rulesets['Main']).toBe(shared);
    expect((await resolveProfile(consumer)).profile.rulesets).toEqual([
      { name: 'Main', rules: [{ type: 'deletion' }] },
    ]);
    await editProfile(consumer, [{ path: ['repository', 'has_wiki'], value: false }]);
    expect(parse(await readFile(consumer, 'utf8'))).toMatchObject({ references: { rulesets: ['shared.yaml'] } });
    await writeFile(
      consumer,
      'extends: base.yaml\nreferences: { rulesets: [shared.yaml] }\nrulesets: [{ name: Main, enforcement: disabled }]\n',
    );
    expect((await resolveProfile(consumer)).profile.rulesets).toEqual([{ name: 'Main', enforcement: 'disabled' }]);
  });

  test('resolves shared edits for every consumer and retains target identity independently of filename', async () => {
    const shared = await write('common.yaml', 'kind: ruleset\nrulesets: [{ name: Main, enforcement: active }]\n');
    const library = await write('library.yaml', 'references: { rulesets: [common.yaml] }\n');
    const service = await write('application.yaml', 'references: { rulesets: [common.yaml] }\n');
    await writeFile(shared, 'kind: ruleset\nrulesets: [{ name: Main, enforcement: evaluate }]\n');
    for (const file of [library, service]) {
      const resolved = await resolveProfile(file);
      expect(resolved.profile.rulesets).toEqual([{ name: 'Main', enforcement: 'evaluate' }]);
      expect(resolved.chain).toContain(shared);
    }
  });

  test('rejects two references that resolve to the same target instead of silently replacing one', async () => {
    await write('collision-a.yaml', 'kind: ruleset\nrulesets: [{ name: Main, enforcement: active }]\n');
    await write('collision-b.yaml', 'kind: ruleset\nrulesets: [{ name: Main, enforcement: disabled }]\n');
    const consumer = await write('collision.yaml', 'references: { rulesets: [collision-a.yaml, collision-b.yaml] }\n');
    await expect(resolveProfile(consumer)).rejects.toThrow(/Main/u);
  });

  test('rejects a missing or wrongly typed reference and validates the effective owner', async () => {
    await write('not-a-ruleset.yaml', 'kind: actions-policy\nactions: { enabled: false }\n');
    const missing = await write('missing.yaml', 'references: { rulesets: [missing-definition.yaml] }\n');
    const wrong = await write('wrong.yaml', 'references: { rulesets: [not-a-ruleset.yaml] }\n');
    await write('push.yaml', 'kind: ruleset\nrulesets: [{ name: Push, target: push }]\n');
    const personal = await write('personal.yaml', 'owner_type: user\nreferences: { rulesets: [push.yaml] }\n');

    await expect(resolveProfile(missing)).rejects.toThrow(/missing-definition/u);
    await expect(resolveProfile(wrong)).rejects.toThrow(/ruleset/u);
    await expect(resolveProfile(personal)).rejects.toThrow(/push/u);
  });

  test('keeps a same-target draft beside the applying definition and preserves references while editing it', async () => {
    const file = await write('draft-ruleset.yaml', 'kind: ruleset\nrulesets: [{ name: Main, enforcement: active }]\n');
    const consumer = await write('draft-consumer.yaml', 'references: { rulesets: [draft-ruleset.yaml] }\n');
    await editProfile(file, [
      { list: 'rulesets', name: 'Main', draft: true, entry: { name: 'Main', draft: true, enforcement: 'later' } },
    ]);
    const resolved = await resolveProfile(consumer);
    expect(resolved.profile.rulesets).toEqual([{ name: 'Main', enforcement: 'active' }]);
    expect(resolved.drafts.rulesets).toEqual([{ name: 'Main', draft: true, enforcement: 'later' }]);
    await expect(
      editProfile(file, [{ list: 'rulesets', name: 'Another', draft: true, entry: { name: 'Another', draft: true } }]),
    ).rejects.toThrow(/one target/u);
  });

  test.each([
    'kind: ruleset\nrulesets: []\n',
    'kind: ruleset\nrulesets: [{ name: Main }, { name: Release }]\n',
    'kind: ruleset\nrulesets: [{ name: Main }]\nrepository: { has_wiki: false }\n',
  ])('rejects a definition that does not describe exactly one ruleset: %s', async (text) => {
    const file = await write(`invalid-${text.length}.yaml`, text);
    await expect(resolveProfile(file)).rejects.toThrow(/ruleset/u);
  });
});
