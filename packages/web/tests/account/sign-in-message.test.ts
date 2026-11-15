import { expect, test } from 'vitest';

import { checkFailureMessage } from '../../src/views/account/sign-in.js';

test("names what came back when the sign-in couldn't be renewed", () => {
  expect(
    checkFailureMessage({
      kind: 'github-sign-in-renewal-unavailable',
      gitHubAnswer: 'status 403, text/html, not JSON',
    }),
  ).toBe("Your sign-in couldn't be renewed just now (status 403, text/html, not JSON). Try again in a minute.");
});

test('leaves out what came back when the Worker gave no word of it', () => {
  expect(checkFailureMessage({ kind: 'github-sign-in-renewal-unavailable', gitHubAnswer: undefined })).toBe(
    "Your sign-in couldn't be renewed just now. Try again in a minute.",
  );
});
