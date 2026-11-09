import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execPath } from 'node:process';
import { promisify } from 'node:util';
import { afterAll, expect, test } from 'vitest';

const script = path.join(import.meta.dirname, 'check-directives.mjs');
// A real path: on macOS the temp folder is a symlink, and the child's cwd() is the real path it names files relative to.
const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'repotted-directives-')));

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function check(files) {
  for (const [name, text] of Object.entries(files)) {
    await writeFile(path.join(directory, name), text);
  }
  try {
    await promisify(execFile)(execPath, [script, directory], { cwd: directory });
    return [];
  } catch (error) {
    return error.stderr.trim().split('\n');
  }
}

test('reports malformed directives in comments and nothing in code or JSX text', async () => {
  const violations = await check({
    'cases.ts': [
      '// eslint-disable-next-line no-console -- a reason',
      '// @ts-expect-error -- a reason',
      '// oxlint-disable-next-line no-console',
      '// eslint-disable-next-line no-console',
      '/* eslint-disable */',
      '// eslint-disable-next-line @eslint-community/eslint-comments/no-unused-disable -- a reason',
      '// @ts-ignore',
      "export const text = ['// @ts-ignore', `${String(1)} /* eslint-disable */`, /\\/\\/ @ts-ignore/u];",
      '/**',
      ' * @returns {string} // @ts-ignore',
      ' */',
      'export const last = 1; // @ts-ignore',
    ].join('\n'),
    'view.tsx': [
      'export const view = (',
      '  <p>',
      '    <b>/* eslint-disable */</b>',
      '    {/* @ts-ignore */}',
      '  </p>',
      ');',
    ].join('\n'),
  });

  expect(violations).toEqual([
    'cases.ts:3: use the shared // eslint-disable-next-line <rule>[, <rule>] -- <reason> form',
    'cases.ts:4: use only // eslint-disable-next-line <rule>[, <rule>] -- <reason>',
    'cases.ts:5: use only // eslint-disable-next-line <rule>[, <rule>] -- <reason>',
    'cases.ts:6: the exception-protocol rules cannot suppress themselves',
    'cases.ts:7: use only // @ts-expect-error -- <reason>',
    'cases.ts:12: use only // @ts-expect-error -- <reason>',
    'view.tsx:4: use only // @ts-expect-error -- <reason>',
  ]);
});
