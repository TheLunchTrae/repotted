// Builds the repotted CLI as one executable for the desktop app, which runs it
// for all its GitHub work: the CLI and its dependencies in one bundle, run by a
// copy of this Node as a single executable application. It starts from a V8
// startup snapshot of the heap after the bundle's modules are evaluated, so
// each run, and the app runs it for every call, skips that work. The keychain
// module is native, and Node loads native code only from a real file, so it
// ships beside the executable as repotted-keyring.node rather than inside it,
// and loads after the snapshot.
//
// Usage: node packages/cli/sea.ts <output executable>
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const output = process.argv[2];
if (output === undefined) {
  console.error('Usage: node packages/cli/sea.ts <output executable>');
  process.exit(2);
}
const executable = path.resolve(output);
const addon = path.join(path.dirname(executable), 'repotted-keyring.node');

// @napi-rs/keyring picks its native package by platform; the desktop app
// builds on macOS and Windows, and Linux runs the same check in development.
const platforms: Readonly<Record<string, string>> = {
  'darwin-arm64': 'darwin-arm64',
  'darwin-x64': 'darwin-x64',
  'linux-x64': 'linux-x64-gnu',
  'win32-x64': 'win32-x64-msvc',
};
const platform = platforms[`${process.platform}-${process.arch}`];
if (platform === undefined) {
  console.error(`No keychain module for ${process.platform}-${process.arch}.`);
  process.exit(1);
}
const keyring = createRequire(createRequire(import.meta.url).resolve('@napi-rs/keyring'));
const native = keyring.resolve(`@napi-rs/keyring-${platform}/keyring.${platform}.node`);

const work = await mkdtemp(path.join(tmpdir(), 'repotted-sea-'));
try {
  const main = path.join(work, 'main.cjs');
  const bundled = await build({
    entryPoints: [fileURLToPath(new URL('src/main.ts', import.meta.url))],
    outfile: main,
    bundle: true,
    platform: 'node',
    // Node builds a startup snapshot only from a CommonJS main script, which
    // can't import(), so each import() of a built-in module becomes a require.
    format: 'cjs',
    supported: { 'dynamic-import': false },
    minify: true,
    logLevel: 'warning',
    plugins: [
      {
        name: 'keyring-beside-executable',
        setup(plugin) {
          plugin.onResolve({ filter: /^@napi-rs\/keyring$/ }, () => ({ path: 'keyring', namespace: 'sea' }));
          plugin.onLoad({ filter: /^keyring$/, namespace: 'sea' }, () => ({
            loader: 'js',
            contents: [
              "import path from 'node:path';",
              'const addon = { exports: {} };',
              "process.dlopen(addon, path.join(path.dirname(process.execPath), 'repotted-keyring.node'));",
              'export const { AsyncEntry } = addon.exports;',
            ].join('\n'),
          }));
        },
      },
    ],
  });
  // esbuild only warns about some code that fails at run time in a CommonJS
  // bundle, such as import.meta, which it leaves empty.
  if (bundled.warnings.length > 0) {
    throw new Error('Bundling the single executable warned.');
  }

  const config = path.join(work, 'sea-config.json');
  await writeFile(
    config,
    JSON.stringify({
      main,
      output: executable,
      disableExperimentalSEAWarning: true,
      useSnapshot: true,
      // The CLI holds the user's GitHub token, so NODE_OPTIONS cannot add
      // Node flags, such as --require, to it.
      execArgvExtension: 'none',
    }),
  );
  await rm(executable, { force: true });
  // Node builds the snapshot by running the bundle, and warns when the bundle
  // loads a built-in module that isn't verified in snapshots, whose state can
  // be out of sync when the executable starts. Such a module loads where it is
  // used instead, and a warning here fails the build.
  const sea = spawnSync(process.execPath, ['--build-sea', config], {
    encoding: 'utf8',
    stdio: ['ignore', 'inherit', 'pipe'],
  });
  if (sea.error !== undefined) {
    throw sea.error;
  }
  process.stderr.write(sea.stderr);
  if (sea.status !== 0 || sea.stderr.includes('Warning:')) {
    await rm(executable, { force: true });
    throw new Error('Building the single executable failed or warned.');
  }
  // Writing the bundle into Node breaks its signature, and macOS runs no
  // unsigned code on Apple silicon; packaging signs it properly afterwards.
  if (process.platform === 'darwin') {
    execFileSync('codesign', ['--force', '--sign', '-', executable], { stdio: 'inherit' });
  }
  await copyFile(native, addon);
} finally {
  await rm(work, { recursive: true, force: true });
}
