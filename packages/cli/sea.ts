// Builds the repotted CLI as one executable for the desktop app, which runs it
// for all its GitHub work: the CLI and its dependencies in one bundle, run by a
// copy of this Node as a single executable application. The keychain module is
// native, and Node loads native code only from a real file, so it ships beside
// the executable as repotted-keyring.node rather than inside it.
//
// Usage: node packages/cli/sea.ts <output executable>
import { execFileSync } from 'node:child_process';
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
  const main = path.join(work, 'main.mjs');
  await build({
    entryPoints: [fileURLToPath(new URL('src/main.ts', import.meta.url))],
    outfile: main,
    bundle: true,
    platform: 'node',
    format: 'esm',
    minify: true,
    logLevel: 'warning',
    // Bundled CommonJS dependencies require Node's built-in modules, which an
    // ES module bundle can reach only through a require of its own.
    banner: {
      js: "import { createRequire as seaRequire } from 'node:module'; const require = seaRequire(import.meta.url);",
    },
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

  const config = path.join(work, 'sea-config.json');
  await writeFile(
    config,
    JSON.stringify({
      main,
      mainFormat: 'module',
      output: executable,
      disableExperimentalSEAWarning: true,
      useCodeCache: true,
      // The CLI holds the user's GitHub token, so NODE_OPTIONS cannot add
      // Node flags, such as --require, to it.
      execArgvExtension: 'none',
    }),
  );
  await rm(executable, { force: true });
  execFileSync(process.execPath, ['--build-sea', config], { stdio: 'inherit' });
  // Writing the bundle into Node breaks its signature, and macOS runs no
  // unsigned code on Apple silicon; packaging signs it properly afterwards.
  if (process.platform === 'darwin') {
    execFileSync('codesign', ['--force', '--sign', '-', executable], { stdio: 'inherit' });
  }
  await copyFile(native, addon);
} finally {
  await rm(work, { recursive: true, force: true });
}
