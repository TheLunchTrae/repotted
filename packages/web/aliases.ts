import { fileURLToPath } from 'node:url';

import type { BuildOptions } from 'esbuild';

export const engineAliases = {
  'node:fs/promises': fileURLToPath(new URL('src/engine/files.ts', import.meta.url)),
  'node:path': fileURLToPath(new URL('src/engine/path.ts', import.meta.url)),
};

export const pageEsbuildOptions = {
  bundle: true,
  alias: engineAliases,
  format: 'esm',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  target: 'es2024',
  logLevel: 'warning',
} satisfies BuildOptions;
