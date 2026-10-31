import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compile } from '../src/backends.js';
import { A0Error, formatTrap, parseAndValidate, run } from '../src/core.js';
import { findClang } from '../src/toolchain.js';
import type { Case } from '../tools/corpus.js';
import { KERNELS } from '../tools/exec-bench-kernels.js';
import { checkX86_64 } from '../tools/verify.js';

interface Config {
  equal: boolean;
  positive: boolean;
  lower?: number;
  value?: number;
  length?: number;
  feedback?: boolean;
  or?: boolean;
  reverse?: boolean;
}
const configs: Config[] = [
  ...[true, false].flatMap((equal) => [true, false].map((positive) => ({ equal, positive }))),
  ...[0, 2, 7, 31, 0x80000000, 0xffffffff].flatMap((lower) => [
    { equal: true, positive: true, lower },
    { equal: false, positive: false, lower, reverse: true },
  ]),
  { equal: true, positive: true, value: 0xffffffff, length: 4 },
  { equal: false, positive: false, value: 0x80000000, length: 16 },
  { equal: true, positive: true, length: 7 },
  { equal: true, positive: true, feedback: true },
  { equal: true, positive: true, lower: 2, or: true },
];
const words = [0, 1, 0xffffffff, 0x80000000, 0, 1, 3, 0];
const data = (c: Config) =>
  Array.from({ length: c.length ?? 8 }, (_, i) => words[i % words.length] as number);
const source =
  configs
    .map((c, k) => {
      const value = c.feedback ? 'p0' : String(c.value ?? 0),
        literal = c.reverse ? `${value} v` : `v ${value}`;
      const guard =
        c.lower === undefined
          ? ''
          : `g ${c.reverse ? 'le' : 'ge'} ${c.reverse ? `${c.lower} p1` : `p1 ${c.lower}`}\nh ${c.or ? 'or' : 'and'} b g\n`;
      return `fn step${k} u32 u32 u32x${c.length ?? 8} -> u32\nv get p2 p1\nb ${c.equal ? 'eq' : 'ne'} ${literal}\n${guard}u select ${c.lower === undefined ? 'b' : 'h'} ${c.positive ? '1 0' : '0 1'}\nr add p0 u\nret r\nend\nfn f${k} u32 u32 -> u32\na arr ${data(c).join(' ')}\nr fold step${k} p0 p1 a\nret r\nend`;
    })
    .join('\n') +
  [15, 16]
    .map(
      (n) =>
        `\nfn fixed${n} u32 -> u32\na arr ${words.join(' ')}\nr fold step0 ${n} p0 a\nret r\nend`,
    )
    .join('\n');
const counts = [0, 1, 2, 3, 4, 5, 7, 8, 9, 15, 16, 17, 31, 32, 33, 127];
function expected(c: Config, n: number, initial: number): number {
  const a = data(c);
  let state = initial;
  for (let i = 0; i < n; i++) {
    let yes = (a[i % a.length] === (c.feedback ? state : (c.value ?? 0))) === c.equal;
    if (c.lower !== undefined) yes = c.or ? yes || i >= c.lower : yes && i >= c.lower;
    state = (state + (yes === c.positive ? 1 : 0)) >>> 0;
  }
  return state;
}

test('native predicate counts preserve unsigned bounds, modular reads, state, tails and near misses', async (t) => {
  const p = parseAndValidate(source),
    cases: Case[] = [];
  for (const [k, c] of configs.entries())
    for (const n of counts)
      for (const initial of [0, 1, 0xffffffff]) {
        const value = expected(c, n, initial),
          fn = p.byName.get(`f${k}`);
        assert.ok(fn);
        assert.equal(run(fn, [n, initial]), value);
        cases.push({ functionName: fn.name, args: [n, initial], expected: value });
      }
  for (const n of [15, 16])
    for (const initial of [0, 1, 0xffffffff]) {
      cases.push({
        functionName: `fixed${n}`,
        args: [initial],
        expected: expected(configs[0] as Config, n, initial),
      });
    }
  const result = await checkX86_64(p, cases, findClang());
  if (result.status === 'blocked') {
    t.skip(result.detail);
    return;
  }
  assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.equal(result.cases, cases.length);
  for (const optimize of [false, true]) {
    const text = compile(p, 'x86_64', { optimize, x86Platform: 'linux' }).text;
    const body = (k: number) => text.match(new RegExp(`a0_f${k}:[\\s\\S]*?\\n\\tret`))?.[0] ?? '';
    assert.match(body(0), /psrld \$31/);
    assert.doesNotMatch(text.match(/a0_fixed15:[\s\S]*?\n\tret/)?.[0] ?? '', /psrld \$31/);
    for (const [k, c] of configs.entries())
      if (c.feedback || c.or || c.length === 7) assert.doesNotMatch(body(k), /psrld \$31/);
  }
  const darwin = compile(p, 'x86_64', { x86Platform: 'darwin' }).text;
  assert.doesNotMatch(darwin, /pmulld|pminud|pmaxud|sse41|cpuid/);
});

test('strict predicate counts retain exact bounds failures and live scalar arguments', async (t) => {
  const strict = parseAndValidate(`profile strict\n${source}`),
    cases: Case[] = [];
  for (const name of ['f0', 'f4', 'f16', 'f18']) {
    const fn = strict.byName.get(name);
    assert.ok(fn);
    for (const n of [0, 1, 3, 4, 7, 8, 9, 16])
      try {
        cases.push({
          functionName: name,
          args: [n, 0xffffffff],
          expected: run(fn, [n, 0xffffffff]),
        });
      } catch (e) {
        assert.ok(e instanceof A0Error && e.trap);
        cases.push({
          functionName: name,
          args: [n, 0xffffffff],
          expected: 0,
          expectedTrap: formatTrap(e.trap),
        });
      }
  }
  const result = await checkX86_64(strict, cases, findClang());
  if (result.status === 'blocked') {
    t.skip(result.detail);
    return;
  }
  assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.doesNotMatch(compile(strict, 'x86_64').text, /psrld \$31/);
  const p = parseAndValidate(
    `${source}\nfn live u32 u32 u32 u32 u32 u32 -> u32\na arr ${words.join(' ')}\nr fold step0 p0 p1 a\nb add p0 p1\nc xor p2 p3\nd add p4 p5\ne xor b c\nf xor e d\ng add r f\nret g\nend`,
  );
  const fn = p.byName.get('live');
  assert.ok(fn);
  const live: Case[] = counts.map((n) => ({
    functionName: 'live',
    args: [n, 0xffffffff, 0x80000000, 37, 0xdeadbeef, 7],
    expected: run(fn, [n, 0xffffffff, 0x80000000, 37, 0xdeadbeef, 7]),
  }));
  assert.equal((await checkX86_64(p, live, findClang())).status, 'passed');
  const spilled = parseAndValidate(
    `${source}\nfn spilled ${Array(12).fill('u32').join(' ')} -> u32\na arr ${words.join(' ')}\nr fold step0 p7 p9 a\n${Array.from({ length: 12 }, (_, i) => `s${i} add ${i ? `s${i - 1}` : 'r'} p${i}`).join('\n')}\nret s11\nend`,
  );
  const spillFn = spilled.byName.get('spilled');
  assert.ok(spillFn);
  const spillCases: Case[] = counts.map((n) => {
    const args = Array.from({ length: 12 }, (_, i) => (0xdeadbeef + i * 7919) >>> 0);
    args[7] = n;
    args[9] = 0xffffffff;
    return { functionName: 'spilled', args, expected: run(spillFn, args) };
  });
  assert.equal((await checkX86_64(spilled, spillCases, findClang())).status, 'passed');
});

test('native predicate count accelerates the unchanged sieve without changing its oracle', async (t) => {
  const k = KERNELS.find((k) => k.name === 'sieve4k');
  assert.ok(k);
  const p = parseAndValidate(k.a0),
    hand = await import(`data:text/javascript,${encodeURIComponent(k.js)}`);
  const cases: Case[] = [
    [0, 0],
    [1, 7],
    [2047, 0xffffffff],
    [0xffffffff, 0x80000000],
    [0xdeadbeef, 31],
  ].map((args) => ({ functionName: k.name, args, expected: hand.sieve4k(...args) }));
  const fn = p.byName.get(k.name);
  assert.ok(fn);
  for (const c of cases) assert.equal(run(fn, c.args, { fuel: 100000000 }), c.expected);
  const r = await checkX86_64(p, cases, findClang());
  if (r.status === 'blocked') {
    t.skip(r.detail);
    return;
  }
  assert.equal(r.status, 'passed', JSON.stringify(r));
});
