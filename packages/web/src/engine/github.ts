import { createGitHub, type GitHub } from '@repotted/core';

import type { Session } from '../session.js';

/**
 * The engine's GitHub client for this tab's sign-in. Each request goes out
 * with the session's current access token. When the browser isn't signed in,
 * the request gets the 401 that GitHub gives a token it refuses, so callers
 * handle both the same way.
 */
export function sessionGitHub(session: Session): GitHub {
  return createGitHub(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const response = await session.fetchGitHub(`${url.pathname}${url.search}`, init);
    return response ?? Response.json({ message: 'Not signed in' }, { status: 401 });
  });
}
