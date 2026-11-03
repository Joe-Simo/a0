import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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

test('counted-source conformance evidence stays bound to every current program and input', async () => {
  const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
  const report = JSON.parse(await readFile('results/source-token-conformance.json', 'utf8'));
  const tokens = JSON.parse(await readFile('results/source-tokens.json', 'utf8'));
  assert.equal(report.sourceTokenReportSHA256, hash(await readFile('results/source-tokens.json')));
  assert.equal(
    report.runnerSourceSHA256,
    hash(await readFile('tools/source-token-conformance.ts')),
  );
  assert.equal(report.kernelSourceSHA256, hash(await readFile('tools/exec-bench-kernels.ts')));
  assert.deepEqual(
    report.rows.map((row: { name: string }) => row.name),
    KERNELS.map((kernel) => kernel.name),
  );
  let count = 0;
  for (const [index, kernel] of KERNELS.entries()) {
    const row = report.rows[index];
    const inputs = sourceTokenControlInputs(kernel.arity);
    assert.deepEqual(row.inputs, inputs);
    count += inputs.length;
    for (const language of ['A0', 'C', 'JavaScript', 'Rust']) {
      assert.equal(row.sourceSHA256[language], tokens.rows[index].languages[language].sha256);
    }
    const javascript = new Function(
      `${kernel.js.replace(/\bexport\s+/g, '')}; return ${kernel.name}`,
    )() as (...args: number[]) => number;
    assert.deepEqual(
      row.expected,
      inputs.map((input) => javascript(...input)),
    );
    assert.deepEqual(
      row.compiled.map((entry: { language: string; optimization: number }) => [
        entry.language,
        entry.optimization,
      ]),
      [
        ['C', 0],
        ['Rust', 0],
        ['C', 2],
        ['Rust', 2],
      ],
    );
    const inputHash = hash(inputs.map((input) => input.join(' ')).join('\n') + '\n');
    for (const entry of row.compiled) {
      assert.equal(entry.inputSHA256, inputHash);
      assert.equal(entry.cases, inputs.length);
      assert.match(entry.driverSHA256, /^[0-9a-f]{64}$/);
      assert.match(entry.executableSHA256, /^[0-9a-f]{64}$/);
    }
  }
  assert.equal(report.programs, KERNELS.length);
  assert.equal(report.cases, count);
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
