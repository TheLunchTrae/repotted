import { expect, test } from 'vitest';

import { findGitHubApp, gitHubAppSlug } from '../../src/github/apps.js';
import { answered, FakeGitHub } from '../support/fake-github.js';

test('an app is found by its slug, and an unknown slug finds none', async () => {
  const github = new FakeGitHub({ apps: [{ id: 29_110, slug: 'dependabot', name: 'Dependabot' }] });
  await expect(findGitHubApp(github, 'dependabot')).resolves.toEqual({
    id: 29_110,
    slug: 'dependabot',
    name: 'Dependabot',
  });
  await expect(findGitHubApp(github, 'nothing-here')).resolves.toBeUndefined();
});

test('a failure other than not found is not taken for a missing app', async () => {
  const github = new FakeGitHub().fail('GET /apps/dependabot', answered(403, 'rate limit exceeded'));
  await expect(findGitHubApp(github, 'dependabot')).rejects.toThrow('rate limit exceeded');
});

test('a slug can be typed as the app’s address, and other text is no slug', () => {
  expect(gitHubAppSlug(' Dependabot ')).toBe('dependabot');
  expect(gitHubAppSlug('https://github.com/apps/repotted-app/')).toBe('repotted-app');
  expect(gitHubAppSlug('github.com/apps/renovate?tab=about')).toBe('renovate');
  expect(gitHubAppSlug('two words')).toBeUndefined();
  expect(gitHubAppSlug('https://example.com/apps/x')).toBeUndefined();
  expect(gitHubAppSlug('')).toBeUndefined();
});
