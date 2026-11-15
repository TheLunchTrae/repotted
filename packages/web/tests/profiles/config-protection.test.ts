import { afterEach, expect, test } from 'vitest';

import { answered, FakeGitHub } from '../../../core/tests/support/fake-github.js';
import { Apply } from '../../src/app/apply/apply.js';
import { settingSections } from '../../src/app/profile-editor/setting-fields.js';
import { ConfigProtection } from '../../src/app/profiles/config-protection.js';
import { readFile, rm } from '../../src/engine/files.js';

afterEach(async () => {
  await rm('/', { recursive: true });
});

function personal(): FakeGitHub {
  return new FakeGitHub({ ownerType: 'User' });
}

test("checking a personal repository counts the protection's changes and writes nothing", async () => {
  const github = personal();
  const protection = new ConfigProtection(github, () => undefined);

  await protection.check('lunch/app');

  // Read-write workflow tokens, and neither ruleset.
  expect(protection.state.value).toEqual({
    kind: 'checked',
    repository: 'lunch/app',
    owner: 'user',
    changeCount: 3,
    limits: [],
  });
  expect(github.writes).toEqual([]);
});

test('an apply of the protection writes it, and the repository then checks as protected', async () => {
  const github = personal();
  const protection = new ConfigProtection(github, () => undefined);
  await protection.check('lunch/app');
  const profile = await protection.writeProfileForApply();
  if (profile === undefined) {
    throw new Error('The protection fits a personal repository.');
  }
  const apply = new Apply(github, () => undefined);

  await apply.start('lunch/app', profile);
  await apply.review();
  await apply.apply();

  expect(apply.state.value).toMatchObject({ kind: 'applied', changes: 3 });
  expect(github.state.workflow).toMatchObject({ default_workflow_permissions: 'read' });
  expect(github.state.rulesets.map((ruleset) => [ruleset.name, ruleset.rules.map((rule) => rule.type)])).toEqual([
    ['Main: Block Deletion', ['deletion']],
    ['Main: Block Force Pushes', ['non_fast_forward']],
  ]);
  // Nothing in it stops a sync's direct commits to the default branch.
  expect(github.state.rulesets.flatMap((ruleset) => ruleset.rules.map((rule) => rule.type))).not.toContain(
    'pull_request',
  );

  await protection.check('lunch/app');

  expect(protection.state.value).toMatchObject({ kind: 'checked', changeCount: 0 });
});

test("one-off edits to an apply of the protection can't be saved to it", async () => {
  const github = personal();
  const protection = new ConfigProtection(github, () => undefined);
  await protection.check('lunch/app');
  const profile = await protection.writeProfileForApply();
  if (profile === undefined) {
    throw new Error('The protection fits a personal repository.');
  }
  const before = await readFile(profile.file, 'utf8');
  const apply = new Apply(github, () => undefined);
  await apply.start('lunch/app', profile);
  expect(apply.state.value).toMatchObject({ kind: 'editing', fromProfile: true, builtIn: true });

  const wiki = settingSections
    .flatMap((section) => section.groups.flatMap((group) => group.fields))
    .find((field) => field.path.join('.') === 'repository.has_wiki');
  if (wiki === undefined) {
    throw new Error('The editor has a wiki setting.');
  }
  await apply.editor.value?.set(wiki, false);
  await apply.saveToProfile();

  expect(await readFile(profile.file, 'utf8')).toBe(before);
});

test('an apply of the protection that is picked up later still saves nothing to it', async () => {
  const github = personal();
  const protection = new ConfigProtection(github, () => undefined);
  await protection.check('lunch/app');
  const profile = await protection.writeProfileForApply();
  if (profile === undefined) {
    throw new Error('The protection fits a personal repository.');
  }
  await new Apply(github, () => undefined).start('lunch/app', profile);

  const later = new Apply(github, () => undefined);
  await later.pickUp('lunch/app');

  expect(later.state.value).toMatchObject({ kind: 'editing', fromProfile: true, builtIn: true });
});

test("a personal repository the account can't administer is offered no protection", async () => {
  const github = personal();
  github.state.viewer = { admin: false, maintain: false, push: true, triage: true, pull: true };
  const protection = new ConfigProtection(github, () => undefined);

  await protection.check('lunch/app');

  expect(protection.state.value).toEqual({ kind: 'none', repository: 'lunch/app' });
  expect(github.calls.map((call) => call.path)).toEqual(['/repos/lunch/app']);
});

test("an organization's repository is offered no protection", async () => {
  const github = new FakeGitHub({ ownerType: 'Organization' });
  const protection = new ConfigProtection(github, () => undefined);

  await protection.check('lunch/app');

  expect(protection.state.value).toEqual({ kind: 'none', repository: 'lunch/app' });
  expect(await protection.writeProfileForApply()).toBeUndefined();
  expect(github.calls.map((call) => call.path)).toEqual(['/repos/lunch/app']);
});

test("what the repository's plan can't have is said beside what is left to apply", async () => {
  const github = personal().fail(
    'GET /repos/lunch/app/rulesets',
    answered(403, 'Upgrade to GitHub Pro or make this repository public to enable this feature.'),
  );
  const protection = new ConfigProtection(github, () => undefined);

  await protection.check('lunch/app');

  expect(protection.state.value).toMatchObject({
    kind: 'checked',
    changeCount: 1,
    limits: ['this repository’s plan does not support rulesets'],
  });
});

test("a check that can't read the repository says why, and a refused sign-in signs out", async () => {
  let signedOut = false;
  const github = personal().fail('GET /repos/lunch/app', answered(401, 'Bad credentials'));
  const protection = new ConfigProtection(github, () => {
    signedOut = true;
  });

  await protection.check('lunch/app');

  expect(protection.state.value).toMatchObject({ kind: 'failed', repository: 'lunch/app' });
  expect(signedOut).toBe(true);
});

test('a check that lands after the profiles left the repository changes nothing', async () => {
  const github = personal();
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow = {
    request: async (...args: Parameters<FakeGitHub['request']>): Promise<unknown> => {
      await held;
      return github.request(...args);
    },
  };
  const protection = new ConfigProtection(slow, () => undefined);

  const checking = protection.check('lunch/app');
  expect(protection.state.value).toEqual({ kind: 'checking', repository: 'lunch/app' });
  protection.forget();
  release();
  await checking;

  expect(protection.state.value).toEqual({ kind: 'idle' });
});
