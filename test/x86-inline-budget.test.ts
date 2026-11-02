import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compile } from '../src/backends.js';
import { parseAndValidate, run } from '../src/core.js';
import { findClang } from '../src/toolchain.js';
import type { Case } from '../tools/corpus.js';
import { KERNELS } from '../tools/exec-bench-kernels.js';
import { checkX86_64 } from '../tools/verify.js';

function step(name: string, nodes: number, lastCall = false): string {
  const lines = [`fn ${name} u32 u32 u32x7 -> u32`, 'v0 get p2 p1'];
  for (let i = 1; i < nodes; i++) {
    lines.push(
      lastCall && i === nodes - 1
        ? `v${i} call helper v${i - 1} p0`
        : `v${i} ${i % 2 ? 'add' : 'xor'} v${i - 1} ${i % 3 ? 'p0' : 'p1'}`,
    );
  }
  return `${lines.join('\n')}\nret v${nodes - 1}\nend`;
}
const counts = [48, 49, 95, 96, 97];
const helper =
  'fn helper u32 u32 -> u32\n' +
  Array.from(
    { length: 8 },
    (_, i) => `h${i} ${i % 2 ? 'add' : 'xor'} ${i ? `h${i - 1}` : 'p0'} p1`,
  ).join('\n') +
  '\nret h7\nend';
const source = [
  helper,
  ...counts.map((n) => step(`step${n}`, n)),
  step('expanded', 89, true),
  ...[...counts.map(String), 'expanded'].map(
    (n) =>
      `fn probe${n} u32 u32 -> u32\na arr 3 5 7 11 13 17 19\nc and p0 7\nr fold ${n === 'expanded' ? n : `step${n}`} c p1 a\nret r\nend`,
  ),
  'fn ordinary u32 u32 -> u32\na arr 3 5 7 11 13 17 19\nr call step49 p0 0 a\nret r\nend',
].join('\n');
const body = (text: string, name: string): string => {
  const match = new RegExp(`a0_${name}:[\\s\\S]*?\\n\\tret`).exec(text);
  assert.ok(match, name);
  return match[0];
};

for (const x86Platform of ['linux', 'darwin'] as const) {
  test(`x86 ${x86Platform} loop inlining uses the 96 expanded-node budget while plain calls retain their smaller budget`, () => {
    const p = parseAndValidate(source);
    const asm = compile(p, 'x86_64', { optimize: false, x86Platform }).text;
    const prefix = x86Platform === 'darwin' ? '_' : '';
    for (const n of counts) {
      const call = new RegExp(`call ${prefix}a0_step${n}\\b`);
      if (n <= 96) assert.doesNotMatch(body(asm, `probe${n}`), call);
      else assert.match(body(asm, `probe${n}`), call);
    }
    assert.match(body(asm, 'probeexpanded'), new RegExp(`call ${prefix}a0_expanded\\b`));
    assert.match(body(asm, 'ordinary'), new RegExp(`call ${prefix}a0_step49\\b`));
    const strict = compile(parseAndValidate(`profile strict\n${source}`), 'x86_64', {
      optimize: false,
      x86Platform,
    }).text;
    assert.match(
      body(strict, 'probe49'),
      new RegExp(`call ${prefix}a0_step49\\b`),
      'strict trapping frames stay out of line',
    );
  });
}

test('x86 expanded loop bodies preserve zero trips, live extras, state and wrapping arithmetic', async (t) => {
  const p = parseAndValidate(source);
  const cases: Case[] = [];
  for (const fn of p.functions.filter((f) => f.name.startsWith('probe') || f.name === 'ordinary')) {
    for (const a of [0, 1, 7, 31, 0x80000000, 0xffffffff])
      for (const b of [0, 17, 0xffffffff])
        cases.push({ functionName: fn.name, args: [a, b], expected: run(fn, [a, b]) });
  }
  const result = await checkX86_64(p, cases, findClang());
  if (result.status === 'blocked') {
    t.skip(result.detail);
    return;
  }
  assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.equal(result.cases, cases.length);
});

test('x86 full UTF-8 decoder matches interpreter and handwritten reference after bounded inlining', async (t) => {
  const kernel = KERNELS.find((k) => k.name === 'utf8dec4k');
  assert.ok(kernel);
  const p = parseAndValidate(kernel.a0);
  const fn = p.byName.get(kernel.name);
  assert.ok(fn);
  const hand = await import(`data:text/javascript,${encodeURIComponent(kernel.js)}`);
  const cases: Case[] = [
    [0, 0],
    [1, 7],
    [0xffffffff, 0x80000000],
    [0xdeadbeef, 0xffffffff],
  ].map((args) => {
    const expected = run(fn, args, { fuel: 50_000_000 });
    assert.equal(expected, hand.utf8dec4k(...args));
    return { functionName: kernel.name, args, expected };
  });
  const result = await checkX86_64(p, cases, findClang());
  if (result.status === 'blocked') {
    t.skip(result.detail);
    return;
  }
  assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.equal(result.cases, cases.length);
});
