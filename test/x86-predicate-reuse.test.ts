import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compile } from '../src/backends.js';
import { A0Error, formatTrap, parseAndValidate, run } from '../src/core.js';
import { findClang } from '../src/toolchain.js';
import type { Case } from '../tools/corpus.js';
import { KERNELS } from '../tools/exec-bench-kernels.js';
import { checkX86_64 } from '../tools/verify.js';

const modes = ['normal', 'after', 'old', 'different', 'xor', 'call'] as const;
type Mode = (typeof modes)[number];
const seed = [1, 2, 3, 4, 5, 6, 7, 8];
function sourceFor(mode: Mode): string {
  const suffix = mode;
  const pred = `fn pred_${suffix} u32x8 u32 u32 u32 u32 -> bool\nj add p1 p2\nk and j 7\nv get p0 k\nn ${mode === 'call' ? 'call add' : 'add'} v p4\nc lt n p3\nret c\nend`;
  const body = [
    `fn step_${suffix} u32x8 u32 u32 u32 u32 -> u32x8`,
    'j add p1 p2',
    'k and j 7',
    ...(mode === 'different' ? ['q xor k 1', 'v get p0 q'] : ['v get p0 k']),
    `n ${mode === 'xor' ? 'xor' : 'add'} v p4`,
    'a set p0 k n',
  ];
  if (mode === 'after') body.push('v2 get a k', 'n2 add v2 1', 'b set a k n2');
  if (mode === 'old') body.push('v2 get p0 k', 'n2 add v2 1', 'q xor k 1', 'b set a q n2');
  body.push(`ret ${mode === 'after' || mode === 'old' ? 'b' : 'a'}`, 'end');
  const top = [
    `fn f_${suffix} u32 u32 u32 u32 -> u32`,
    `a arr ${seed.join(' ')}`,
    `r loop pred_${suffix} step_${suffix} p0 a p1 p2 p3`,
    'h0 mov 2166136261',
  ];
  for (let i = 0; i < 8; i++)
    top.push(`v${i} get r ${i}`, `x${i} xor h${i} v${i}`, `h${i + 1} mul x${i} 16777619`);
  top.push('old get a 0', 'out add h8 old', 'ret out', 'end');
  return [pred, ...body, ...top].join('\n');
}
const source = ['fn add u32 u32 -> u32\nr add p0 p1\nret r\nend', ...modes.map(sourceFor)].join(
  '\n',
);
function oracle(mode: Mode, n: number, offset: number, limit: number, inc: number): number {
  const a = [...seed];
  for (let i = 0; i < n; i++) {
    const j = ((i + offset) >>> 0) & 7,
      next = ((a[j] as number) + inc) >>> 0;
    if (next >= limit) break;
    const old = a[j] as number;
    a[j] =
      mode === 'different'
        ? ((a[j ^ 1] as number) + inc) >>> 0
        : mode === 'xor'
          ? (old ^ inc) >>> 0
          : next;
    if (mode === 'after') a[j] = ((a[j] as number) + 1) >>> 0;
    if (mode === 'old') a[j ^ 1] = (old + 1) >>> 0;
  }
  let h = 2166136261;
  for (const v of a) h = Math.imul(h ^ v, 16777619) >>> 0;
  return (h + (seed[0] as number)) >>> 0;
}

test('native predicate reuse preserves mutation barriers, aliases, different operations and loop trips', async (t) => {
  for (const strict of [false, true]) {
    const p = parseAndValidate((strict ? 'profile strict\n' : '') + source),
      cases: Case[] = [];
    for (const mode of modes)
      for (const n of [0, 1, 2, 7, 8, 16, 31])
        for (const offset of [0, 3, 0xffffffff])
          for (const limit of [0, 10, 0xffffffff])
            for (const inc of [0, 1, 0xffffffff]) {
              const fn = p.byName.get(`f_${mode}`);
              assert.ok(fn);
              const args = [n, offset, limit, inc],
                expected = oracle(mode, n, offset, limit, inc);
              assert.equal(run(fn, args), expected);
              cases.push({ functionName: fn.name, args, expected });
            }
    const r = await checkX86_64(p, cases, findClang());
    if (r.status === 'blocked') {
      t.skip(r.detail);
      return;
    }
    assert.equal(r.status, 'passed', JSON.stringify(r));
    assert.equal(r.cases, cases.length);
  }
});

test('native predicate reuse excludes branch-only values and keeps strict trap identity', async (t) => {
  const s = `fn pred u32x8 u32 -> bool\nj xor p1 271828\nk and j 7\nv get p0 k\nc gt v 0\nret c\nend\nfn step u32x8 u32 -> u32x8\nj xor p1 271828\nk and j 7\nv get p0 k\nc gt v 0\nn select c 1 0\nr set p0 k n\nret r\nend\nfn f u32 -> u32\na arr ${seed.join(' ')}\nr loop pred step p0 a\nv get r 0\nret v\nend`;
  for (const strict of [false, true]) {
    const p = parseAndValidate((strict ? 'profile strict\n' : '') + s),
      asm = compile(p, 'x86_64', { optimize: false, x86Platform: 'linux' }).text;
    const body = asm.match(/a0_f:[\s\S]*?\n\tret/)?.[0];
    assert.ok(body);
    assert.equal((body.match(/xorl \$271828/g) ?? []).length, strict ? 2 : 1);
    const fn = p.byName.get('f');
    assert.ok(fn);
    const cases = [0, 1, 8, 31].map((n) => ({
      functionName: 'f',
      args: [n],
      expected: run(fn, [n]),
    }));
    const r = await checkX86_64(p, cases, findClang());
    if (r.status === 'blocked') {
      t.skip(r.detail);
      return;
    }
    assert.equal(r.status, 'passed', JSON.stringify(r));
  }
  const p = parseAndValidate(`profile strict\n${s.replaceAll('get p0 k', 'get p0 p1')}`),
    fn = p.byName.get('f');
  assert.ok(fn);
  const cases: Case[] = [];
  for (const n of [0, 1, 8, 9, 31])
    try {
      cases.push({ functionName: 'f', args: [n], expected: run(fn, [n]) });
    } catch (e) {
      assert.ok(e instanceof A0Error && e.trap);
      cases.push({ functionName: 'f', args: [n], expected: 0, expectedTrap: formatTrap(e.trap) });
    }
  assert.equal((await checkX86_64(p, cases, findClang())).status, 'passed');
});

test('native predicate reuse executes unchanged heap and insertion-sort kernels', async (t) => {
  for (const name of ['heap256', 'isort256', 'bsearch1k']) {
    const k = KERNELS.find((k) => k.name === name);
    assert.ok(k);
    const p = parseAndValidate(k.a0),
      js = await import(`data:text/javascript,${encodeURIComponent(k.js)}`);
    const cases: Case[] = [
      [0, 0],
      [1, 7],
      [0xffffffff, 0x80000000],
      [0xdeadbeef, 31],
    ].map((args) => ({ functionName: name, args, expected: js[name](...args) }));
    const r = await checkX86_64(p, cases, findClang());
    if (r.status === 'blocked') {
      t.skip(r.detail);
      return;
    }
    assert.equal(r.status, 'passed', JSON.stringify(r));
  }
});

test('carried array values remain valid in predicates across swaps and early exits', async (t) => {
  const source = `fn ok u32x8 u32 u32 -> bool\nj sub p2 p1\nk sub j 1\na get p0 k\nb get p0 j\nc gt a b\nret c\nend\nfn step u32x8 u32 u32 -> u32x8\nj sub p2 p1\nk sub j 1\na get p0 k\nb get p0 j\nc set p0 j a\nd set c k b\nret d\nend\nfn carried u32 u32 u32 u32 u32 -> u32\na arr p1 p2 p3 p4 p1 p2 p3 p4\nn and p0 7\nr loop ok step n a 7\nh0 mov 2166136261\n${Array.from({ length: 8 }, (_, i) => `v${i} get r ${i}\nx${i} xor h${i} v${i}\nh${i + 1} mul x${i} 16777619`).join('\n')}\nold get a 0\nout add h8 old\nret out\nend`;
  const values = [
    [0, 0, 0, 0],
    [1, 2, 3, 4],
    [8, 5, 3, 1],
    [0xffffffff, 0x80000000, 1, 0],
  ];
  for (const strict of [false, true]) {
    const p = parseAndValidate((strict ? 'profile strict\n' : '') + source),
      cases: Case[] = [];
    const fn = p.byName.get('carried');
    assert.ok(fn);
    for (let n = 0; n < 8; n++)
      for (const row of values) {
        const a = [...row, ...row];
        for (let i = 0; i < n; i++) {
          const j = 7 - i;
          if ((a[j - 1] as number) <= (a[j] as number)) break;
          [a[j - 1], a[j]] = [a[j] as number, a[j - 1] as number];
        }
        let h = 2166136261;
        for (const v of a) h = Math.imul(h ^ v, 16777619) >>> 0;
        const expected = (h + (row[0] as number)) >>> 0,
          args = [n, ...row];
        assert.equal(run(fn, args), expected);
        cases.push({ functionName: 'carried', args, expected });
      }
    const r = await checkX86_64(p, cases, findClang());
    if (r.status === 'blocked') {
      t.skip(r.detail);
      return;
    }
    assert.equal(r.status, 'passed', JSON.stringify(r));
  }
});

test('predicate structural matching stays bounded for shared expression DAGs', () => {
  const nodes = ['v0 xor p1 p2'];
  for (let i = 1; i <= 30; i++) nodes.push(`a${i} add v${i - 1} v${i - 1}`, `v${i} xor a${i} 1`);
  const common = nodes.join('\n');
  const p = parseAndValidate(
    `fn pred u32x8 u32 u32 -> bool\n${common}\nc ne v30 0\nret c\nend\nfn step u32x8 u32 u32 -> u32x8\n${common}\nr set p0 p1 v30\nret r\nend\nfn dag u32 -> u32\na arr 0 0 0 0 0 0 0 0\nr loop pred step 4 a p0\nv get r 0\nret v\nend`,
  );
  const text = compile(p, 'x86_64', { optimize: false }).text;
  assert.ok(text.length < 100000, `unexpected expansion: ${text.length}`);
});

test('countdown bounds apply only to the matching active loop limit', async (t) => {
  const s = `fn countdown_step u32x8 u32 u32 -> u32x8\nj sub p2 p1\nk sub j 1\nv get p0 k\nw add v 1\nr set p0 k w\nret r\nend\nfn same u32 u32 -> u32\nn and p0 7\na arr p1 0 0 0 0 0 0 0\nr fold countdown_step n a n\nx get r 0\ny get r 7\nz add x y\nret z\nend\nfn other u32 u32 -> u32\nn and p0 7\nm and p1 15\na arr 0 0 0 0 0 0 0 0\nr fold countdown_step n a m\nx get r 0\ny get r 7\nz add x y\nret z\nend\nfn large u32 u32 -> u32\na arr p1 0 0 0 0 0 0 0\nr fold countdown_step p0 a p0\nx get r 0\ny get r 7\nz add x y\nret z\nend`;
  for (const strict of [false, true]) {
    const p = parseAndValidate((strict ? 'profile strict\n' : '') + s),
      cases: Case[] = [];
    for (const name of ['same', 'other', 'large']) {
      const fn = p.byName.get(name);
      assert.ok(fn);
      for (const n of [0, 1, 7, 8, 16, 31])
        for (const m of [0, 1, 7, 0xffffffff]) {
          const count = name === 'large' ? n : n & 7,
            limit = name === 'other' ? m & 15 : count,
            a = [name === 'other' ? 0 : m, 0, 0, 0, 0, 0, 0, 0];
          let traps = false;
          for (let i = 0; i < count; i++) {
            const k = (limit - i - 1) >>> 0;
            if (strict && k >= 8) {
              traps = true;
              break;
            }
            const at = k % 8;
            a[at] = ((a[at] as number) + 1) >>> 0;
          }
          try {
            const value = run(fn, [n, m]);
            assert.equal(traps, false);
            assert.equal(value, ((a[0] as number) + (a[7] as number)) >>> 0);
            cases.push({ functionName: name, args: [n, m], expected: value });
          } catch (e) {
            assert.equal(traps, true);
            assert.ok(e instanceof A0Error && e.trap);
            cases.push({
              functionName: name,
              args: [n, m],
              expected: 0,
              expectedTrap: formatTrap(e.trap),
            });
          }
        }
    }
    const r = await checkX86_64(p, cases, findClang());
    if (r.status === 'blocked') {
      t.skip(r.detail);
      return;
    }
    assert.equal(r.status, 'passed', JSON.stringify(r));
  }
  const text = compile(parseAndValidate(s), 'x86_64', {
    optimize: false,
    x86Platform: 'linux',
  }).text;
  const same = text.match(/a0_same:[\s\S]*?\n\tret/)?.[0] ?? '',
    other = text.match(/a0_other:[\s\S]*?\n\tret/)?.[0] ?? '';
  assert.equal((same.match(/andl \$7/g) ?? []).length, 1);
  assert.ok((other.match(/andl \$7/g) ?? []).length > 1);
});
