// Builds the desktop app's compiled CLI with sea.ts and checks what its startup
// snapshot must not do: freeze the build's environment into the executable, or
// stop the CLI from starting, serving MCP and loading its keychain module. The
// build runs with fake GITHUB_TOKEN and REPOTTED_GITHUB_CLIENT_ID values, which
// a module-scope read would store in the snapshot, and the executable runs
// without them, where such a read would still use them. node-smoke.mjs and a
// relative `profile` run from the examples folder, so a working directory frozen
// at build time fails them too.
//
// Usage: node packages/cli/tests/sea-check.mjs
import { spawnSync } from 'node:child_process';
import { log } from 'node:console';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { env, execPath, platform } from 'node:process';
import { fileURLToPath, URL } from 'node:url';

// Built from one marker, so a secret scanner doesn't read them as credentials.
const marker = 'repotted-sea-check-build-time';
const sentinels = {
  GITHUB_TOKEN: `${marker}-token`,
  REPOTTED_GITHUB_CLIENT_ID: `${marker}-client-id`,
};

function runChecked(command, args, options) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${path.basename(args[0] ?? command)} exited ${result.status}.`);
  }
}

const work = await mkdtemp(path.join(tmpdir(), 'repotted-sea-check-'));
try {
  const executable = path.join(work, platform === 'win32' ? 'repotted-cli.exe' : 'repotted-cli');
  runChecked(execPath, [fileURLToPath(new URL('../sea.ts', import.meta.url)), executable], {
    env: { ...env, ...sentinels },
  });

  const contents = await readFile(executable);
  for (const [name, value] of Object.entries(sentinels)) {
    if (contents.includes(value)) {
      throw new Error(`The executable holds the build's ${name}; something reads it at module scope.`);
    }
  }

  runChecked(execPath, [fileURLToPath(new URL('node-smoke.mjs', import.meta.url)), executable]);

  // A relative profile path resolves against the working directory the command
  // runs in, not the one the snapshot was built in.
  const profile = spawnSync(executable, ['profile', 'repotted.yaml', '--json'], {
    cwd: fileURLToPath(new URL('../../../examples/', import.meta.url)),
    encoding: 'utf8',
  });
  if (profile.error !== undefined) {
    throw profile.error;
  }
  if (profile.status !== 0) {
    throw new Error(`profile repotted.yaml --json exited ${profile.status} with: ${profile.stdout}${profile.stderr}`);
  }

  // Without a token variable, a GitHub CLI sign-in or a client ID, status is
  // signed out with the Repotted App. A keychain that has no Secret Service to
  // reach, as on CI, adds its failure to problems; one that failed to load
  // names its file there.
  const runEnv = { ...env, GH_CONFIG_DIR: path.join(work, 'no-gh') };
  for (const name of ['GITHUB_TOKEN', 'GH_TOKEN', 'REPOTTED_GITHUB_CLIENT_ID']) {
    delete runEnv[name];
  }
  const status = spawnSync(executable, ['status', '--json'], { encoding: 'utf8', env: runEnv });
  if (status.error !== undefined) {
    throw status.error;
  }
  const answer = status.status === 1 ? JSON.parse(status.stdout) : undefined;
  if (
    answer?.signed_in !== false ||
    answer.reason !== 'not_signed_in' ||
    answer.token_variable !== null ||
    answer.install_url === null ||
    answer.problems.some((problem) => problem.includes('repotted-keyring'))
  ) {
    throw new Error(`status --json exited ${status.status} with: ${status.stdout}${status.stderr}`);
  }
  log("The compiled CLI keeps none of the build's environment and loads its keychain module");
} finally {
  await rm(work, { recursive: true, force: true });
}
