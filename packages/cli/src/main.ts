#!/usr/bin/env node
import { startupSnapshot } from 'node:v8';

import { createGitHub } from '@repotted/core';

import manifest from '../package.json' with { type: 'json' };
import { keychain, resolveToken, startSignIn } from './auth.js';
import { run } from './commands.js';

function main(): void {
  // The build inlines the version, so the npm bundle and the desktop app's
  // compiled CLI report it without a package.json beside them.
  run(process.argv.slice(2), {
    version: manifest.version,
    env: process.env,
    github: async () => createGitHub(await resolveToken()),
    signIn: () => startSignIn(),
    signOut: () => keychain.clear(),
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    interactive: process.stdin.isTTY,
    async confirm(question) {
      // Loaded on use: Node hasn't verified readline in startup snapshots.
      const { createInterface } = await import('node:readline/promises');
      const prompt = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return /^y(?:es)?$/iu.test((await prompt.question(question)).trim());
      } finally {
        prompt.close();
      }
    },
  }).then(
    (code) => {
      process.exitCode = code;
    },
    // run reports every failure of a command; this is a failure to report one.
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}

// The desktop app's compiled CLI starts from a startup snapshot of this
// bundle, with every module already evaluated; see sea.ts. A snapshot holds
// only the heap, so main runs when the executable starts, not when the
// snapshot is built.
if (startupSnapshot.isBuildingSnapshot()) {
  startupSnapshot.setDeserializeMainFunction(main);
} else {
  main();
}
