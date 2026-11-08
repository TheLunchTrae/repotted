import { chmod, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

import manifest from './package.json' with { type: 'json' };

// The package runs under Node through npx, so the bundle targets Node and
// leaves the published dependencies to npm. The workspace core is bundled in.
await build({
  entryPoints: [fileURLToPath(new URL('src/main.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('dist/repotted.js', import.meta.url)),
  bundle: true,
  platform: 'node',
  target: `node${manifest.engines.node.replace(/^>=/u, '')}`,
  format: 'esm',
  external: Object.keys(manifest.dependencies),
  logLevel: 'warning',
});

await chmod(new URL('dist/repotted.js', import.meta.url), 0o755);
// npm takes the license from the package directory; the repository keeps one copy.
await copyFile(new URL('../../LICENSE', import.meta.url), new URL('LICENSE', import.meta.url));
