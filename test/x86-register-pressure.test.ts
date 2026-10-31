import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compile } from '../src/backends.js';
import { parseAndValidate, run } from '../src/core.js';
import { findClang } from '../src/toolchain.js';
import type { Case } from '../tools/corpus.js';
import { checkJs, checkX86_64 } from '../tools/verify.js';

const source = [false, true]
  .map((partial) => {
    const tag = partial ? 'partial' : 'all';
    return `fn step_${tag} (u32,u32,u32) u32 u32 -> (u32,u32,u32)
a at p0 0
b at p0 1
c at p0 2
x add a p2
y xor b x
z mul c 3
r0 put p0 0 y
r1 put r0 1 z
${partial ? 'ret r1' : 'r2 put r1 2 x\nret r2'}
end
fn ${tag} u32 u32 u32 u32 -> u32
s rec p1 p2 7
r fold step_${tag} p0 s p3
a at r 0
b at r 1
c at r 2
x mul a 31
y mul b 65599
z xor x y
v xor z c
old at s 0
o add v old
ret o
end`;
  })
  .join('\n');

function expected(n: number, x: number, y: number, inc: number, partial: boolean): number {
  const old = x;
  let a = x,
    b = y,
    c = 7;
  for (let i = 0; i < n; i++) {
    const next = (a + inc) >>> 0;
    a = (b ^ next) >>> 0;
    b = Math.imul(c, 3) >>> 0;
    if (!partial) c = next;
  }
  return (((Math.imul(a, 31) ^ Math.imul(b, 65599) ^ c) >>> 0) + old) >>> 0;
}

test('native register pressure preserves recurrence values and old-state aliases', async (t) => {
  for (const strict of [false, true]) {
    const p = parseAndValidate(`${strict ? 'profile strict\n' : ''}${source}`),
      cases: Case[] = [];
    for (const n of [0, 1, 2, 3, 7, 16, 31])
      for (const x of [0, 1, 0xffffffff, 0x80000000])
        for (const y of [0, 13, 0xfffffffe])
          for (const inc of [0, 7, 0xffffffff])
            for (const partial of [false, true]) {
              const name = partial ? 'partial' : 'all',
                args = [n, x, y, inc],
                value = expected(n, x, y, inc, partial),
                fn = p.byName.get(name);
              assert.ok(fn);
              assert.equal(run(fn, args), value);
              cases.push({ functionName: name, args, expected: value });
            }
    for (const check of [() => checkJs(p, cases), () => checkX86_64(p, cases, findClang())]) {
      const r = await check();
      if (r.status === 'blocked') {
        t.skip(r.detail);
        return;
      }
      assert.equal(r.status, 'passed', JSON.stringify(r));
    }
  }
});

const params = Array(12).fill('u32').join(' ');
const wide =
  `fn wide ${params} -> u32\n` +
  Array.from({ length: 12 }, (_, i) => `v${i} mul p${i} ${2 * i + 3}`).join('\n') +
  '\n' +
  Array.from({ length: 11 }, (_, i) => `s${i} xor ${i === 0 ? 'v0' : `s${i - 1}`} v${i + 1}`).join(
    '\n',
  ) +
  '\nret s10\nend';
test('native register eviction preserves wide argument frames and long-lived values', async (t) => {
  const forwarded = `fn forwarded ${params} -> u32\nr call wide ${Array.from({ length: 12 }, (_, i) => `p${11 - i}`).join(' ')}\no add r p0\nret o\nend`;
  const p = parseAndValidate(`${wide}\n${forwarded}`),
    cases: Case[] = [];
  let x = 0x2398ab7f;
  for (let i = 0; i < 257; i++) {
    const args = Array.from({ length: 12 }, () => {
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
      return x;
    });
    let value = 0;
    args.forEach((v, j) => {
      value ^= Math.imul(v, 2 * j + 3);
    });
    cases.push({ functionName: 'wide', args, expected: value >>> 0 });
    let reversed = 0;
    args.forEach((_, j) => {
      reversed ^= Math.imul(args[11 - j] as number, 2 * j + 3);
    });
    cases.push({
      functionName: 'forwarded',
      args,
      expected: ((reversed >>> 0) + (args[0] as number)) >>> 0,
    });
  }
  assert.match(compile(p, 'x86_64', { x86Platform: 'linux' }).text, /call a0_wide/);
  const r = await checkX86_64(p, cases, findClang());
  if (r.status === 'blocked') {
    t.skip(r.detail);
    return;
  }
  assert.equal(r.status, 'passed', JSON.stringify(r));
});

test('native matrix pressure agrees with an independent modular arithmetic oracle', async (t) => {
  const { KERNELS } = await import('../tools/exec-bench-kernels.js');
  const kernel = KERNELS.find((k) => k.name === 'mat4');
  assert.ok(kernel);
  const word = (n: bigint) => BigInt.asUintN(32, n);
  const oracle = (x: number, y: number): number => {
    let a = Array.from({ length: 16 }, (_, i) => word(BigInt(x) * BigInt(i + 1)) ^ BigInt(y >>> i));
    const b = Array.from({ length: 16 }, (_, i) =>
      word(BigInt(y) * BigInt(i + 3) + BigInt(x >>> i)),
    );
    for (let n = 0; n < 8; n++)
      a = Array.from({ length: 16 }, (_, i) => {
        const row = i >> 2,
          col = i & 3;
        let s = 0n;
        for (let k = 0; k < 4; k++) s += (a[row * 4 + k] as bigint) * (b[k * 4 + col] as bigint);
        return word(s);
      });
    return Number(
      word(
        (a[0] as bigint) +
          (a[5] as bigint) +
          (a[10] as bigint) +
          (a[15] as bigint) +
          (a[x & 15] as bigint),
      ),
    );
  };
  const inputs: [[number, number], ...[number, number][]] = [
    [0, 0],
    [1, 2],
    [0xffffffff, 0xffffffff],
    [0x80000000, 0x7fffffff],
  ];
  let state = 0xa9817f23;
  for (let i = 0; i < 64; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const x = state;
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    inputs.push([x, state]);
  }
  for (const strict of [false, true]) {
    const p = parseAndValidate(`${strict ? 'profile strict\n' : ''}${kernel.a0}`),
      fn = p.byName.get('mat4');
    assert.ok(fn);
    const cases = inputs.map((args) => {
      const expected = oracle(...args);
      assert.equal(run(fn, args), expected);
      return { functionName: 'mat4', args, expected };
    });
    const r = await checkX86_64(p, cases, findClang());
    if (r.status === 'blocked') {
      t.skip(r.detail);
      return;
    }
    assert.equal(r.status, 'passed', JSON.stringify(r));
  }
});
