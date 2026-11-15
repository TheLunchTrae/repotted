import { expect, test } from 'vitest';

import { pushedLabel } from '../../src/app/repositories/sort-and-filters.js';

const now = Date.parse('2026-11-15T12:00:00Z');

test('says how long ago a repository was pushed to, in the largest whole unit', () => {
  expect(pushedLabel(null, now)).toBe('Never pushed');
  expect(pushedLabel('2026-11-15T11:59:30Z', now)).toBe('Pushed just now');
  expect(pushedLabel('2026-11-15T09:00:00Z', now)).toBe('Pushed 3 hours ago');
  expect(pushedLabel('2026-11-14T10:00:00Z', now)).toBe('Pushed yesterday');
  expect(pushedLabel('2026-10-01T12:00:00Z', now)).toBe('Pushed last month');
  expect(pushedLabel('2024-11-01T12:00:00Z', now)).toBe('Pushed 2 years ago');
});
