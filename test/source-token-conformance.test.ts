import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findClang } from '../src/toolchain.js';
import { KERNELS } from '../tools/exec-bench-kernels.js';
import {
  checkTokenControlOutput,
  compiledTokenControl,
  sourceTokenControlInputs,
} from '../tools/source-token-conformance.js';

test('token conformance inputs retain boundary cases and deterministic full-width values', () => {
  const rows = sourceTokenControlInputs(3);
  assert.deepEqual(rows, sourceTokenControlInputs(3));
  assert.ok(rows.some((row) => row.every((value) => value === 0)));
  assert.ok(rows.some((row) => row.every((value) => value === 0xffffffff)));
  assert.equal(new Set(rows.map((row) => row.join(','))).size, rows.length);
  for (const row of rows)
    for (const value of row)
      assert.ok(Number.isInteger(value) && value >= 0 && value <= 0xffffffff);
  assert.throws(() => sourceTokenControlInputs(0));
  assert.throws(() => sourceTokenControlInputs(17));
});

test('token conformance rejects checksum collisions, extra rows and malformed values', () => {
  checkTokenControlOutput('1\n2\n', [1, 2], 'valid');
  checkTokenControlOutput('1\r\n2\r\n', [1, 2], 'CRLF');
  // Both pairs have the same XOR checksum; only per-input comparison detects this.
  assert.throws(() => checkTokenControlOutput('0\n3\n', [1, 2], 'collision'));
  for (const text of [
    '1\n',
    '1\n2\n3\n',
    '1\n2 \n',
    '1\n02\n',
    '1\n-2\n',
    '1\n4294967296\n',
    '1\n2',
  ]) {
    assert.throws(() => checkTokenControlOutput(text, [1, 2], 'malformed'));
  }
});

const clang = findClang();
test('compiled token controls execute the counted C and reject a semantic mutation', {
  skip: clang.path ? false : 'C compiler unavailable',
}, async () => {
  assert.ok(clang.path);
  const kernel = KERNELS.find((row) => row.name === 'affine');
  assert.ok(kernel);
  const inputs = [
    [0, 0, 0],
    [7, 9, 11],
    [0xffffffff, 2, 1],
  ];
  const expected = [0, 74, 0xffffffff];
  const result = await compiledTokenControl(kernel, 'C', clang.path, inputs, expected, 0, false);
  assert.equal(result.cases, 3);
  await assert.rejects(
    compiledTokenControl(
      {
        ...kernel,
        c: 'static inline uint32_t hw_affine(uint32_t x, uint32_t s, uint32_t o) { return x * s + o + 1; }',
      },
      'C',
      clang.path,
      inputs,
      expected,
      0,
      false,
    ),
    /input 0/,
  );
});
