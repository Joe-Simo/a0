import assert from 'node:assert/strict';
import { test } from 'node:test';
import { A0Error, formatProgram, parse } from '../src/core.js';
import { parseDense } from '../src/dense.js';
import { readDenseA0 } from '../src/dense-a0.js';

test('A0 reader chunks adjacent function declarations without requiring blank lines', () => {
  // Each function fits the reader, but the pair exceeds its 16 KiB input.
  // Text is kept as one token, so this tests byte boundaries rather than node limits.
  const text = 'x'.repeat(8300);
  const source = `fn first -> u32x8300\n"${text}"\nfn second -> u32x8300\n"${text}"\ncall first\n`;
  assert.ok(Buffer.byteLength(source) > 16384);
  const got = readDenseA0(source, new Map(), 'adjacent.a0d');
  assert.equal(got.chunks, 2);
  assert.equal(formatProgram(parse(got.text)), formatProgram(parseDense(source)));
});

test('A0 reader refusal identifies an adjacent function at its original UTF-8 byte offset', () => {
  const prefix = '# non-ASCII: λ\r\nfn first\r\nadd A 1\r\n';
  const source = `${prefix}fn second\r\n+ex second(1) == 1\r\nmov A\r\n`;
  assert.throws(
    () => readDenseA0(source, new Map(), 'adjacent.a0d'),
    (error: unknown) => {
      assert.ok(error instanceof A0Error);
      assert.equal(error.id, 'A0625');
      assert.match(
        error.message,
        new RegExp(`function second at byte ${Buffer.byteLength(prefix)}\\b`),
      );
      return true;
    },
  );
});
