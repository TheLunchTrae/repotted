import { expect, test } from 'vitest';

import { basename, dirname, join, relative, resolve } from '../src/engine/path.js';

// Each expectation is what Node's POSIX path answers for the same call.
test('answers as the POSIX path module does', () => {
  expect(resolve('profiles/a.yaml')).toBe('/profiles/a.yaml');
  expect(resolve('/profiles/teams', '../base.yaml')).toBe('/profiles/base.yaml');
  expect(resolve('/profiles', '/staged/app.yaml')).toBe('/staged/app.yaml');
  expect(resolve('/profiles/', './teams//web.yaml')).toBe('/profiles/teams/web.yaml');
  expect(resolve('/', '../..')).toBe('/');

  expect(join('/batch', 'lunch', 'app.yaml')).toBe('/batch/lunch/app.yaml');
  expect(join('/profiles', '', 'teams/../a.yaml')).toBe('/profiles/a.yaml');
  expect(join('teams', '..', '..', 'a.yaml')).toBe('../a.yaml');
  expect(join('', '')).toBe('.');

  expect(dirname('/profiles/teams/web.yaml')).toBe('/profiles/teams');
  expect(dirname('/profiles/')).toBe('/');
  expect(dirname('/profiles')).toBe('/');
  expect(dirname('web.yaml')).toBe('.');
  expect(dirname('/')).toBe('/');

  expect(basename('/profiles/teams/web.yaml')).toBe('web.yaml');
  expect(basename('/profiles/teams/')).toBe('teams');
  expect(basename('web.yaml')).toBe('web.yaml');

  expect(relative('/staged', '/profiles/teams/web.yaml')).toBe('../profiles/teams/web.yaml');
  expect(relative('/profiles', '/profiles/teams/web.yaml')).toBe('teams/web.yaml');
  expect(relative('/profiles', '/profiles')).toBe('');
});
