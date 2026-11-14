import { chmod, copyFile, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

import manifest from './package.json' with { type: 'json' };

// The package runs under Node through npx, so the bundle targets Node and
// leaves the published dependencies to npm. The workspace core is bundled in.
const outfile = fileURLToPath(new URL('dist/repotted.js', import.meta.url));
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('src/main.ts', import.meta.url))],
  outfile,
  bundle: true,
  platform: 'node',
  target: `node${manifest.engines.node.replace(/^>=/u, '')}`,
  format: 'esm',
  external: Object.keys(manifest.dependencies),
  logLevel: 'warning',
  write: false,
});

// The smoke checks can run the bundle while another task builds it, so the
// new bundle replaces the old one in a single rename rather than being
// written over it.
const [bundle, ...rest] = outputFiles;
if (bundle === undefined || rest.length > 0) {
  throw new Error(`esbuild made ${outputFiles.length} files, not one bundle.`);
}
const partial = `${outfile}.${process.pid}.tmp`;
await mkdir(path.dirname(outfile), { recursive: true });
await writeFile(partial, bundle.contents);
await chmod(partial, 0o755);
await rename(partial, outfile);
// npm takes the license from the package directory; the repository keeps one copy.
await copyFile(new URL('../../LICENSE', import.meta.url), new URL('LICENSE', import.meta.url));
