import type * as Core from '@repotted/core';
import { previewProfile } from '@repotted/core';
import { afterEach, expect, test, vi } from 'vitest';

import { ProfileEditor } from '../src/app/profile-editor.js';
import { settingSections } from '../src/app/setting-fields.js';
import { mkdir, rm, writeFile } from '../src/engine/files.js';

// The engine's preview is wrapped, so a test can hold one open while a later one ends.
vi.mock('@repotted/core', async (original) => {
  const actual = await original<typeof Core>();
  return { ...actual, previewProfile: vi.fn(actual.previewProfile) };
});

afterEach(async () => {
  await rm('/', { recursive: true });
});

test('a preview that ends after a later one does not replace what the later one showed', async () => {
  await mkdir('/profiles', { recursive: true });
  await writeFile('/profiles/web.yaml', 'repository:\n  has_wiki: false\n');
  const editor = new ProfileEditor('/profiles/web.yaml');
  await editor.load();
  const wiki = settingSections[0]?.groups[1]?.fields.find((item) => item.key === 'has_wiki');
  if (wiki === undefined) {
    throw new Error('The editor should offer the wiki setting.');
  }
  const actual = vi.mocked(previewProfile).getMockImplementation();
  const held = Promise.withResolvers<undefined>();
  vi.mocked(previewProfile).mockImplementationOnce(async (file, edits) => {
    await held.promise;
    // The slow preview answers with a profile the engine would refuse by then.
    throw new Error(`A stale preview of ${file} with ${edits.length} edits.`);
  });

  const slow = editor.set(wiki, true);
  await editor.reset(wiki);
  held.resolve(undefined);
  await slow;

  expect(actual).toBeDefined();
  expect(editor.problem.value).toBeUndefined();
  expect(editor.dirty.value).toBe(false);
});
