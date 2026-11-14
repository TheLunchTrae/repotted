import { expect, test } from 'vitest';

import { diffLines, foldUnchanged } from '../src/app/line-diff.js';

function marked(before: string, after: string): string[] {
  const marks = { same: ' ', added: '+', removed: '-' };
  return diffLines(before.split(''), after.split('')).map((line) => `${marks[line.kind]}${line.text}`);
}

test('lines only one text has are removed or added, and the rest keep their order', () => {
  expect(marked('abcd', 'abcd')).toEqual([' a', ' b', ' c', ' d']);
  expect(marked('abcd', 'axcd')).toEqual([' a', '-b', '+x', ' c', ' d']);
  expect(marked('abc', 'bcd')).toEqual(['-a', ' b', ' c', '+d']);
  expect(marked('', 'ab')).toEqual(['+a', '+b']);
  expect(marked('ab', '')).toEqual(['-a', '-b']);
  // A repeated line pairs with its own place, not the first like it.
  expect(marked('abab', 'ab')).toHaveLength(4);
  expect(marked('abab', 'ab').filter((line) => line.startsWith(' '))).toEqual([' a', ' b']);
});

test('unchanged lines away from a change are folded, and those beside it stay', () => {
  const before = 'abcdefghijklmnop'.split('');
  const after = 'abcdefghXjklmnop'.split('');

  const folded = foldUnchanged(diffLines(before, after), 2);

  expect(folded.map((line) => (line.kind === 'fold' ? `fold ${line.lines.join('')}` : line.text))).toEqual([
    'fold abcdef',
    'g',
    'h',
    'i',
    'X',
    'j',
    'k',
    'fold lmnop',
  ]);
  // A run of one line more than its context is shorter than the fold that would stand for it.
  expect(foldUnchanged(diffLines('abcX'.split(''), 'abcY'.split('')), 2).some((line) => line.kind === 'fold')).toBe(
    false,
  );
  expect(foldUnchanged(diffLines(['a'], ['a']))).toEqual([{ kind: 'same', text: 'a' }]);
});
