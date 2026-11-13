import { isDeepStrictEqual } from 'node:util';

import { expect, test } from 'vitest';

import { isDeepEqual } from '../src/equal.js';

// Node's comparison is the reference for plain data.
test('compares the data YAML and JSON give as Node does', () => {
  const values: unknown[] = [
    undefined,
    null,
    0,
    -0,
    Number.NaN,
    1,
    '1',
    '',
    true,
    false,
    [],
    {},
    [1, 2],
    [2, 1],
    [1, 2, 3],
    [undefined],
    [null],
    { a: 1 },
    { a: 1, b: 2 },
    { b: 2, a: 1 },
    { a: undefined },
    { a: null },
    { a: { b: [1, { c: 'x' }] } },
    { a: { b: [1, { c: 'y' }] } },
    { 0: 'a' },
    ['a'],
  ];

  for (const left of values) {
    for (const right of structuredClone(values)) {
      expect(isDeepEqual(left, right), `${JSON.stringify(left)} and ${JSON.stringify(right)}`).toBe(
        isDeepStrictEqual(left, right),
      );
    }
  }
});
