import { defineConfig } from 'vitest/config';

import { engineAliases } from './packages/web/aliases.ts';

// eslint-disable-next-line standards/no-default-export -- Vitest reads the config from the module's default export
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'node', include: ['packages/{core,cli}/tests/**/*.test.ts', 'scripts/**/*.test.mjs'] } },
      // The web app's tests run the engine as the page does, on its in-memory files.
      { resolve: { alias: engineAliases }, test: { name: 'web', include: ['packages/web/tests/**/*.test.ts'] } },
    ],
  },
});
