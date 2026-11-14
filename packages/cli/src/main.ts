#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';

import { createGitHub } from '@repotted/core';

import manifest from '../package.json' with { type: 'json' };
import { keychain, resolveToken, startSignIn } from './auth.js';
import { run } from './commands.js';

function main(): void {
  // The build inlines the version, so the bundle reports it without a package.json beside it.
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

main();
