import { cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

import { engineAliases } from './aliases.ts';

// The site Workers static assets serve: the files in static/ and the page's
// bundle. wrangler.jsonc runs this before every deploy and dev session.
const dist = new URL('dist/', import.meta.url);
await rm(dist, { recursive: true, force: true });
await cp(new URL('static/', import.meta.url), dist, { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL('src/main.tsx', import.meta.url))],
  outfile: fileURLToPath(new URL('app.js', dist)),
  bundle: true,
  alias: engineAliases,
  format: 'esm',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  target: 'es2024',
  minify: true,
  logLevel: 'warning',
});
