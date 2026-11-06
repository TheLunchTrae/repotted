import { chmod, copyFile } from 'node:fs/promises';

import manifest from './package.json' with { type: 'json' };

// The package runs under Node through npx, so the bundle targets Node and
// leaves the published dependencies to npm. The workspace core is bundled in.
const result = await Bun.build({
  entrypoints: [new URL('src/main.ts', import.meta.url).pathname],
  outdir: new URL('dist', import.meta.url).pathname,
  naming: 'repotted.js',
  target: 'node',
  format: 'esm',
  external: Object.keys(manifest.dependencies),
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

await chmod(new URL('dist/repotted.js', import.meta.url), 0o755);
// npm takes the license from the package directory; the repository keeps one copy.
await copyFile(new URL('../../LICENSE', import.meta.url), new URL('LICENSE', import.meta.url));
