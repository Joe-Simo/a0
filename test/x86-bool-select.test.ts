import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compile } from '../src/backends.js';
import { parseAndValidate, run } from '../src/core.js';
import { findClang } from '../src/toolchain.js';
import type { Case } from '../tools/corpus.js';
import { checkX86_64 } from '../tools/verify.js';

const inputs = [0, 1, 2, 31, 0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff];
const source =
  ['eq', 'ne', 'lt', 'le', 'gt', 'ge']
    .flatMap((op) =>
      [false, true].flatMap((inverse) =>
        [false, true].map((shared) => {
          const name = `${op}${inverse ? 'inv' : 'pos'}${shared ? 'shared' : 'fused'}`;
          return `fn ${name} u32 u32 -> u32\nb ${op} p0 p1\nr select b ${inverse ? '0 1' : '1 0'}\n${shared ? 'q select b 7 19\ns add r q\nret s' : 'ret r'}\nend`;
        }),
      ),
    )
    .join('\n') +
  `
fn step u32 u32 u32 -> u32
b lt p1 p2
c ge p1 2
d and b c
v select d 1 0
r add p0 v
ret r
end
fn counted u32 u32 -> u32
n and p0 31
r fold step n p1 p0
ret r
end
fn invert u32 u32 -> u32
b lt p0 p1
c ge p0 2
d and b c
v select d 0 1
r select d 17 29
s add v r
ret s
end
`;

test('x86 boolean selects preserve fused flags, shared values, inverted values and loop counts', async (t) => {
  for (const profile of ['default', 'strict'] as const) {
    const p = parseAndValidate(`${profile === 'strict' ? 'profile strict\n' : ''}${source}`);
    const cases: Case[] = [];
    for (const fn of p.functions)
      for (const a of inputs)
        for (const b of inputs) {
          if (fn.name === 'step') continue;
          cases.push({ functionName: fn.name, args: [a, b], expected: run(fn, [a, b]) });
        }
    {
      const result = await checkX86_64(p, cases, findClang());
      if (result.status === 'blocked') {
        t.skip(result.detail);
        return;
      }
      assert.equal(result.status, 'passed', JSON.stringify(result));
      assert.equal(result.cases, cases.length);
    }
  }
});

test('x86 boolean-to-word selects avoid conditional moves without folding near misses', () => {
  const p = parseAndValidate(source);
  const asm = compile(p, 'x86_64', { optimize: false }).text;
  const body = asm.match(/a0_eqposfused:[\s\S]*?\n\tret/)?.[0];
  assert.ok(body);
  assert.match(body, /sete/);
  assert.doesNotMatch(body, /cmov/);
  assert.match(asm, /cmov/, 'non-boolean literal branches retain ordinary selects');
});

test('x86 boolean selects preserve parameter, aggregate and checked-arithmetic flags', async (t) => {
  const p = parseAndValidate(`fn parameter bool -> u32
r select p0 1 0
ret r
end
fn checked u32 u32 -> u32
v cadd p0 p1
b at v 1
r select b 0 1
ret r
end
fn aggregate u32 u32 -> u32
b lt p0 p1
a arr true b false
q rem p0 3
v get a q
r select v 1 0
ret r
end`);
  const cases: Case[] = [false, true].map((b) => ({
    functionName: 'parameter',
    args: [b],
    expected: b ? 1 : 0,
  }));
  for (const name of ['checked', 'aggregate']) {
    const fn = p.byName.get(name);
    assert.ok(fn);
    for (const a of inputs)
      for (const b of inputs)
        cases.push({ functionName: name, args: [a, b], expected: run(fn, [a, b]) });
  }
  const result = await checkX86_64(p, cases, findClang());
  if (result.status === 'blocked') {
    t.skip(result.detail);
    return;
  }
  assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.equal(result.cases, cases.length);
});
