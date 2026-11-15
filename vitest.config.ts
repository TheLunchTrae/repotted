import { defineConfig } from 'vitest/config';

import { fileURLToPath } from 'node:url';

import { engineAliases } from './packages/web/aliases.ts';

const webTestAliases = {
  ...engineAliases,
  'cloudflare:sockets': fileURLToPath(new URL('packages/web/tests/support/cloudflare-sockets.ts', import.meta.url)),
};

// eslint-disable-next-line standards/no-default-export -- Vitest reads the config from the module's default export
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'node', include: ['packages/{core,cli}/tests/**/*.test.ts', 'scripts/**/*.test.mjs'] } },
      // The web app's tests run the engine as the page does, on its in-memory
      // files, and the Worker on a stand-in for the runtime's sockets.
      { resolve: { alias: webTestAliases }, test: { name: 'web', include: ['packages/web/tests/**/*.test.ts'] } },
    ],
  },
});
