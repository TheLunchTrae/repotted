import { afterEach, expect, test } from 'vitest';

import { ProfileEditor } from '../src/app/profile-editor.js';
import { type SettingField, settingSections } from '../src/app/setting-fields.js';
import { matchesSearch, otherNames, searchWords } from '../src/app/setting-search.js';
import { mkdir, rm, writeFile } from '../src/engine/files.js';

afterEach(async () => {
  await rm('/', { recursive: true });
});

const fields = settingSections.flatMap((section) => section.groups.flatMap((group) => group.fields));

function field(path: string): SettingField {
  const found = fields.find((item) => item.path.join('.') === path);
  if (found === undefined) {
    throw new Error(`The editor has no setting ${path}.`);
  }
  return found;
}

function find(query: string): string[] {
  const words = searchWords(query);
  return fields.filter((item) => matchesSearch(item, words)).map((item) => item.path.join('.'));
}

async function opened(text: string): Promise<ProfileEditor> {
  await mkdir('/profiles', { recursive: true });
  await writeFile('/profiles/web.yaml', text);
  const editor = new ProfileEditor('/profiles/web.yaml');
  await editor.load();
  return editor;
}

function found(editor: ProfileEditor): string[] {
  return editor.found.value.flatMap((group) => group.rows.map((row) => row.field.path.join('.')));
}

test('every other name belongs to a setting the editor has', () => {
  expect(Object.keys(otherNames).filter((path) => !fields.some((item) => item.path.join('.') === path))).toEqual([]);
});

test('a setting is found by the start of each word typed, in its label, key, or other names', () => {
  for (const query of ['allow_squash', 'squash allow', 'squ', 'single commit']) {
    expect(find(query)).toContain('merge.allow_squash_merge');
  }
  expect(find('dco')).toEqual(['repository.web_commit_signoff_required']);
  // A word typed must start a word, so the middle of one finds nothing.
  expect(find('uash')).toEqual([]);
  expect(find('   ')).toHaveLength(fields.length);
});

test('a search for a setting finds the options under it, and a tab or group name finds its settings', () => {
  expect(find('has_pull_requests')).toContain('repository.pull_request_creation_policy');
  expect(find('pages')).toEqual(
    expect.arrayContaining(fields.filter((item) => item.section === 'pages').map((item) => item.path.join('.'))),
  );
});

test('a found option shows under the setting it belongs to, which is not counted', async () => {
  const editor = await opened('repository:\n  has_pull_requests: true\n');

  editor.search('who can create');

  expect(editor.filtering.value).toBe(true);
  expect(found(editor)).toEqual(['repository.has_pull_requests', 'repository.pull_request_creation_policy']);
  expect(editor.foundCount.value).toBe(1);
  expect(editor.found.value[0]).toMatchObject({ tab: 'Repository' });

  editor.clearFilters();
  expect(editor.filtering.value).toBe(false);
  expect(editor.query.value).toBe('');
});

test('the filters show what is managed, unsaved, or drafted, and a row stays while it is edited', async () => {
  const editor = await opened(
    'repository:\n  has_wiki: false\n  has_issues: true\ndrafts:\n  repository:\n    has_projects: true\n',
  );
  await editor.set(field('repository.has_issues'), false);

  editor.filter('unsaved', true);
  expect(found(editor)).toEqual(['repository.has_issues']);

  // Reset leaves the row where it is: what is found changes only with the search or a filter.
  await editor.reset(field('repository.has_issues'));
  expect(found(editor)).toEqual(['repository.has_issues']);
  editor.search('wiki');
  expect(found(editor)).toEqual([]);

  editor.filter('unsaved', false);
  editor.filter('managed', true);
  editor.search('');
  expect(found(editor)).toEqual(['repository.has_issues', 'repository.has_projects', 'repository.has_wiki']);

  editor.filter('drafts', true);
  expect(found(editor)).toEqual(['repository.has_projects']);
  // A change over the draft keeps the setting among the drafts.
  await editor.set(field('repository.has_projects'), false);
  editor.search('proj');
  expect(found(editor)).toEqual(['repository.has_projects']);
});

test('a found setting that a change hides leaves the one above it to change back, and the count follows', async () => {
  const editor = await opened('repository:\n  has_pull_requests: true\n');
  editor.search('who can create');

  await editor.set(field('repository.has_pull_requests'), false);

  expect(found(editor)).toEqual(['repository.has_pull_requests']);
  expect(editor.foundCount.value).toBe(0);

  await editor.set(field('repository.has_pull_requests'), true);
  expect(found(editor)).toEqual(['repository.has_pull_requests', 'repository.pull_request_creation_policy']);
  expect(editor.foundCount.value).toBe(1);
});

test('a setting hidden for the value of the one above it is not found', async () => {
  const editor = await opened('repository:\n  has_pull_requests: false\n');

  editor.search('who can create');

  expect(found(editor)).toEqual([]);
  expect(editor.foundSummary.value).toBe('No settings match “who can create”.');
});

test('a save or a discard finds again, so what it settled leaves the filters', async () => {
  const editor = await opened('repository:\n  has_wiki: false\ndrafts:\n  repository:\n    has_projects: true\n');
  const write = (work: () => Promise<void>): Promise<void> => work();
  await editor.set(field('repository.has_wiki'), true);
  editor.filter('unsaved', true);
  expect(found(editor)).toEqual(['repository.has_wiki']);

  await editor.save(write, 'draft');
  expect(found(editor)).toEqual([]);

  editor.filter('unsaved', false);
  editor.filter('drafts', true);
  expect(found(editor)).toEqual(['repository.has_projects', 'repository.has_wiki']);
  await editor.discardDraft(write);
  expect(found(editor)).toEqual([]);
  expect(editor.foundSummary.value).toBe('No settings match these filters.');
});

test('with nothing found, the message says why and where else to look, and an emptied search shows the tabs', async () => {
  const editor = await opened('repository:\n  has_wiki: false\n');
  await editor.addEntry('labels', { name: 'bug' });

  editor.filter('unsaved', true);
  expect(editor.foundSummary.value).toContain('Unsaved changes to rulesets, environments, and labels');
  // Punctuation alone is no word, so the filters are why nothing was found.
  editor.search('-');
  expect(editor.foundSummary.value).toContain('these filters');

  editor.filter('unsaved', false);
  expect(editor.filtering.value).toBe(false);
  editor.search('wiki');
  expect(editor.foundSummary.value).toBe('1 setting found.');
  editor.search('');
  expect(editor.filtering.value).toBe(false);
});

test('a fresh read finds again, and keeps a shown setting whose change is not saved', async () => {
  const editor = await opened('repository:\n  has_pull_requests: true\n  has_wiki: true\n');
  editor.search('who can create');
  await editor.set(field('repository.has_pull_requests'), false);

  await writeFile('/profiles/web.yaml', 'repository:\n  has_pull_requests: true\n');
  await editor.load();

  expect(found(editor)).toEqual(['repository.has_pull_requests']);

  await editor.reset(field('repository.has_pull_requests'));
  editor.search('wiki');
  editor.filter('managed', true);
  expect(found(editor)).toEqual([]);
});
