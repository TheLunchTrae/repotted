import { createHash } from 'node:crypto';

import { expect, test } from 'vitest';

import { fromBase64, hexDigest, toBase64 } from '../src/bytes.js';

// Larger than one chunk of the encoder, with every byte value.
const large = Uint8Array.from({ length: 100_000 }, (_, index) => (index * 31) % 256);

test('encodes and decodes base64 as Node does, with the line breaks GitHub sends', () => {
  const expected = Buffer.from(large).toString('base64');
  expect(toBase64(large)).toBe(expected);

  const wrapped = (expected.match(/.{1,60}/gu) ?? []).join('\n');
  expect(fromBase64(`${wrapped}\n`)).toEqual(large);
  expect(fromBase64('')).toEqual(new Uint8Array());
});

test('digests bytes and text as Node does, text as UTF-8', async () => {
  expect(await hexDigest('SHA-256', large)).toBe(createHash('sha256').update(large).digest('hex'));
  expect(await hexDigest('SHA-1', large.subarray(10, 500))).toBe(
    createHash('sha1').update(large.subarray(10, 500)).digest('hex'),
  );
  expect(await hexDigest('SHA-256', 'naïve ☕')).toBe(createHash('sha256').update('naïve ☕').digest('hex'));
});
