import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { compile } from '../src/backends.js';
import { A0Error, formatTrap, makeIo, parseAndValidate, run } from '../src/core.js';
import { findClang } from '../src/toolchain.js';
import type { Case } from '../tools/corpus.js';
import { KERNELS } from '../tools/exec-bench-kernels.js';
import { checkNative, checkX86_64 } from '../tools/verify.js';
import { INTERMEDIATE_RECORD_CASES } from './fixtures/native-intermediate-records.js';

const INPUTS = [
  [0, 0],
  [7, 13],
  [17, 3],
  [0xffffffff, 1],
  [1, 0xffffffff],
  [0x9e3779b9, 15],
];
const CLANG = findClang();

async function check(source: string, target: 'c' | 'x86_64', t: TestContext): Promise<void> {
  const p = parseAndValidate(source);
  const fn = p.byName.get('probe');
  assert.ok(fn);
  const cases: Case[] = INPUTS.map((args, index) => {
    const hasIo = fn.params.at(-1) === 'io';
    const input = Array.from({ length: index }, (_, j) => Math.imul(j + 1, 0x9e3779b9) >>> 0);
    const io = hasIo ? makeIo(input) : undefined;
    const plain = hasIo ? [args[0] as number] : args;
    try {
      const expected = run(fn, io === undefined ? plain : [...plain, io]);
      return {
        functionName: 'probe',
        args: plain,
        expected,
        ...(io === undefined ? {} : { input, expectedOutput: [...io.output] }),
      };
    } catch (e) {
      assert.ok(e instanceof A0Error && e.trap !== undefined);
      return { functionName: 'probe', args: plain, expected: 0, expectedTrap: formatTrap(e.trap) };
    }
  });
  const reports =
    target === 'x86_64'
      ? [await checkX86_64(p, cases, CLANG)]
      : await Promise.all(
          [false, true].map((optimize) =>
            checkNative(
              p,
              cases,
              CLANG,
              false,
              'C intermediate record snapshots',
              compile(p, 'c', { optimize }).text,
            ),
          ),
        );
  for (const report of reports) {
    if (report.status === 'blocked') {
      t.skip(report.detail);
      return;
    }
    assert.equal(report.status, 'passed', JSON.stringify(report));
    assert.equal(report.cases, cases.length);
  }
}

for (const [name, source] of INTERMEDIATE_RECORD_CASES)
  for (const target of ['c', 'x86_64'] as const)
    test(`${target} intermediate record snapshots: ${name}`, async (t) => check(source, target, t));

test('x86 nested heap iterations retain only the initial aggregate copy', () => {
  const kernel = KERNELS.find((k) => k.name === 'heap256');
  assert.ok(kernel);
  for (const optimize of [false, true]) {
    const text: string = compile(parseAndValidate(kernel.a0), 'x86_64', {
      optimize,
      x86Platform: 'linux',
    }).text;
    const entry: string | undefined = /a0_heap256:[\s\S]*?\n\tret\n/.exec(text)?.[0];
    assert.ok(entry);
    assert.equal([...entry.matchAll(/\tcall \.La0copy/g)].length, 1);
  }
});
