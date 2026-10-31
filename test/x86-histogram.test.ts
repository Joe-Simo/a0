import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { compile } from '../src/backends.js';
import { parseAndValidate, run } from '../src/core.js';
import { findClang, runTool, withTempDir } from '../src/toolchain.js';
import { KERNELS } from '../tools/exec-bench-kernels.js';
import { checkX86_64 } from '../tools/verify.js';

test('native bucket updates preserve collisions, wrapping, bounds, tails and borrowed inputs', {
  skip: process.platform !== 'linux' || process.arch !== 'x64',
}, async () => {
  const configs: {
    n: number;
    len: number;
    delta: number;
    feedback?: boolean;
    dynamic?: boolean;
    alias?: boolean;
  }[] = [
    ...[0, 3, 4, 15, 16, 17, 20, 32].map((n) => ({ n, len: 8, delta: 1 })),
    { n: 32, len: 1, delta: 4294967295 },
    { n: 32, len: 7, delta: 3 },
    { n: 32, len: 16, delta: 4294967295 },
    { n: 32, len: 8, delta: 0 },
    { n: 32, len: 8, delta: 7, feedback: true },
    { n: 32, len: 8, delta: 1, dynamic: true },
    { n: 32, len: 8, delta: 1, alias: true },
  ];
  const cases: [number, number][] = [
    [0, 0],
    [1, 7],
    [0xffffffff, 0x80000000],
    [0x80000000, 0xffffffff],
    [0xdeadbeef, 31],
  ];
  const sources = configs.map((c, k) => {
    const l = [
      `fn step${k} u32x${c.len} u32 u32 u32 -> u32x${c.len}`,
      'a mul p1 p2',
      'b add a p3',
      'v mul b 2654435761',
      's shr v p3',
      ...(c.feedback ? ['f get p0 0', 'q xor s f', 'i and q 7'] : ['i mov s']),
      'h get p0 i',
      `u add ${c.delta} h`,
      'r set p0 i u',
      'ret r',
      'end',
      `fn f${k} u32 u32 -> u32`,
      `a arr ${Array(c.len).fill('p1').join(' ')}`,
      ...(c.dynamic ? ['n and p0 31'] : []),
      `r fold step${k} ${c.dynamic ? 'n' : c.n} a p0 p1`,
    ];
    let prev: string = '';
    for (let i = 0; i < c.len; i++) {
      l.push(`e${i} get r ${i}`);
      if (i) {
        l.push(`s${i} add ${prev} e${i}`);
        prev = `s${i}`;
      } else prev = 'e0';
    }
    if (c.alias) {
      l.push('old get a 0', `z add old ${prev}`);
      prev = 'z';
    }
    l.push(`ret ${prev}`, 'end');
    return l.join('\n');
  });
  const p = parseAndValidate(sources.join('\n'));
  const expected: string[] = [];
  const calls = [];
  for (const [k, c] of configs.entries())
    for (const [x, y] of cases) {
      const a = Array(c.len).fill(y);
      for (let i = 0; i < (c.dynamic ? x & 31 : c.n); i++) {
        let idx = (Math.imul((Math.imul(i, x) + y) >>> 0, 2654435761) >>> 0) >>> (y & 31);
        if (c.feedback) idx = (idx ^ a[0]) & 7;
        idx %= c.len;
        a[idx] = (a[idx] + c.delta) >>> 0;
      }
      let v = a.reduce((s, x) => (s + x) >>> 0, 0);
      if (c.alias) v = (v + y) >>> 0;
      assert.equal(run(p.byName.get('f' + k)!, [x, y]), v);
      expected.push(String(v));
      calls.push(`printf("%u\\n",a0_f${k}(${x}u,${y}u));`);
    }
  const driver = `#include <stdint.h>\n#include <stdio.h>\n${configs.map((_, k) => `extern uint32_t a0_f${k}(uint32_t,uint32_t);`).join('\n')}\nint main(void){${calls.join('\n')}return 0;}\n`;
  const clang = findClang().path;
  assert.ok(clang);
  for (const optimize of [false, true]) {
    const text = compile(p, 'x86_64', { optimize }).text;
    for (const [, s] of [
      ['normal', text],
      [
        'forced-sse2',
        text
          .replace('.La0sse41_cap:\n\t.byte 0', '.La0sse41_cap:\n\t.byte 1')
          .replace(/pmulld[^\n]*/g, 'ud2'),
      ],
    ] as const)
      await withTempDir(async (dir) => {
        await writeFile(join(dir, 'm.s'), s);
        await writeFile(join(dir, 'd.c'), driver);
        const b = runTool(clang, ['-O2', 'm.s', 'd.c', '-o', 'check'], { cwd: dir });
        assert.ok(b.ok, b.stderr);
        const r = runTool(join(dir, 'check'), [], { cwd: dir });
        assert.ok(r.ok, r.stderr);
        assert.deepEqual(r.stdout.trim().split('\n'), expected);
        assert.equal(expected.length, 75);
      });
  }
});

test('native vector histogram executes the unchanged stock kernel', async (t) => {
  const k = KERNELS.find((k) => k.name === 'hist256');
  assert.ok(k);
  const p = parseAndValidate(k.a0);
  const js = await import(`data:text/javascript,${encodeURIComponent(k.js)}`);
  const cases = [
    [0, 0],
    [1, 7],
    [0xffffffff, 0x80000000],
    [0x80000000, 0xffffffff],
    [0xdeadbeef, 31],
  ].map((args) => ({ functionName: k.name, args, expected: js.hist256(...args) }));
  for (const c of cases)
    assert.equal(run(p.byName.get(k.name)!, c.args, { fuel: 50000000 }), c.expected);
  const r = await checkX86_64(p, cases, findClang());
  if (r.status === 'blocked') {
    t.skip(r.detail);
    return;
  }
  assert.equal(r.status, 'passed', JSON.stringify(r));
  const linux = compile(p, 'x86_64', { x86Platform: 'linux' }).text;
  assert.match(linux, /call \.La0sse41/);
  assert.match(linux, /pmulld/);
  const darwin = compile(p, 'x86_64', { x86Platform: 'darwin' }).text;
  assert.doesNotMatch(darwin, /pmulld|sse41|cpuid/);
  const strictProgram = parseAndValidate('profile strict\n' + k.a0);
  const strictResult = await checkX86_64(strictProgram, cases, findClang());
  assert.equal(strictResult.status, 'passed', JSON.stringify(strictResult));
  const strict = compile(strictProgram, 'x86_64', {
    x86Platform: 'linux',
  }).text;
  assert.doesNotMatch(strict, /pmulld|sse41|cpuid/);
});
