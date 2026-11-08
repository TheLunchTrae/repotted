#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';

import { createGitHub } from '@repotted/core';

import manifest from '../package.json' with { type: 'json' };
import { keychain, resolveToken, startSignIn } from './auth.js';
import { run } from './commands.js';

// The build inlines the version, so the npm bundle and the desktop app's
// compiled CLI report it without a package.json beside them.
process.exitCode = await run(process.argv.slice(2), {
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
});
