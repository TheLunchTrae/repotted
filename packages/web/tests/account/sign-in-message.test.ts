import { expect, test } from 'vitest';

import { checkFailureMessage } from '../../src/views/account/sign-in.js';

test("names what GitHub sent when it couldn't renew the sign-in", () => {
  expect(
    checkFailureMessage({
      kind: 'github-sign-in-renewal-unavailable',
      gitHubAnswer: 'status 403, text/html, not JSON',
    }),
  ).toBe(
    "GitHub couldn't renew your sign-in just now (GitHub sent status 403, text/html, not JSON). Try again in a minute.",
  );
});

test('leaves out what GitHub sent when the Worker gave no word of it', () => {
  expect(checkFailureMessage({ kind: 'github-sign-in-renewal-unavailable', gitHubAnswer: undefined })).toBe(
    "GitHub couldn't renew your sign-in just now. Try again in a minute.",
  );
});
