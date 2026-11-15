import { vi } from 'vitest';

import type { connect as connectInWorkers } from 'cloudflare:sockets';

// The Workers runtime's sockets module, which tests answer for themselves.
export const connect = vi.fn<typeof connectInWorkers>(() => {
  throw new Error('This test opens no sockets.');
});
