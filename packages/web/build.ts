import { cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

import { pageEsbuildOptions } from './aliases.ts';

const dist = new URL('dist/', import.meta.url);
await rm(dist, { recursive: true, force: true });
await cp(new URL('static/', import.meta.url), dist, { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL('src/main.tsx', import.meta.url))],
  outfile: fileURLToPath(new URL('app.js', dist)),
  ...pageEsbuildOptions,
  minify: true,
});
