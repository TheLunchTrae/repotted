#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';

import { createGitHub } from '@repotted/core';
import { z } from 'zod';

import { resolveToken, startSignIn } from './auth.js';
import { run } from './commands.js';

// Both src/main.ts and the built dist/repotted.js sit one level below package.json.
const { version } = z
  .object({ version: z.string() })
  .parse(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')));

process.exitCode = await run(process.argv.slice(2), {
  version,
  github: async () => createGitHub(await resolveToken()),
  signIn: () => startSignIn(),
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
