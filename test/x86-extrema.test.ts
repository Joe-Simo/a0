import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { compile } from '../src/backends.js';
import { parseAndValidate, run } from '../src/core.js';
import { findClang, runTool, withTempDir } from '../src/toolchain.js';
import { KERNELS } from '../tools/exec-bench-kernels.js';
import { checkX86_64 } from '../tools/verify.js';

type Kind = 'min' | 'max';
interface Config {
  name: string;
  count: number;
  kinds: [Kind, Kind];
  swap?: boolean;
  invert?: boolean;
  inclusive?: boolean;
  put?: boolean;
  dynamic?: boolean;
  feedback?: boolean;
  different?: boolean;
}
const inputs = [
  [0, 0],
  [1, 7],
  [0xffffffff, 0x80000000],
  [0x80000000, 0x7fffffff],
  [0xdeadbeef, 0xffffffff],
];
const flip: Record<string, string> = { lt: 'gt', le: 'ge', gt: 'lt', ge: 'le' };
function body(c: Config): string {
  const lines = [
    `fn step_${c.name} (u32,u32) u32 u32 u32 -> (u32,u32)`,
    'lo at p0 0',
    'hi at p0 1',
    'm mul p1 p2',
    'base add m p3',
    ...(c.feedback ? ['v add base lo'] : ['v xor base 2147483648']),
    ...(c.different ? ['other xor v 123'] : []),
  ];
  for (const [i, kind] of c.kinds.entries()) {
    const field = i ? 'hi' : 'lo';
    const value = i && c.different ? 'other' : 'v';
    let op = kind === 'min' ? (c.inclusive ? 'le' : 'lt') : c.inclusive ? 'ge' : 'gt';
    if (c.swap) op = flip[op] as string;
    if (c.invert) op = flip[op] as string;
    lines.push(
      `c${i} ${op} ${c.swap ? field : value} ${c.swap ? value : field}`,
      `s${i} select c${i} ${c.invert ? field : value} ${c.invert ? value : field}`,
    );
  }
  lines.push(
    ...(c.put ? ['r put p0 0 s0', 'r2 put r 1 s1', 'ret r2'] : ['r rec s0 s1', 'ret r']),
    'end',
  );
  for (const field of [0, 1])
    lines.push(
      `fn ${c.name}_${field} u32 u32 -> u32`,
      'z rec p0 p1',
      ...(c.dynamic ? ['n and p0 15'] : []),
      `r fold step_${c.name} ${c.dynamic ? 'n' : c.count} z p0 p1`,
      `v at r ${field}`,
      'ret v',
      'end',
    );
  return lines.join('\n');
}
function oracle(c: Config, x: number, y: number): number[] {
  let lo = x,
    hi = y;
  const count = c.dynamic ? x & 15 : c.count;
  for (let i = 0; i < count; i++) {
    const base = (Math.imul(i, x) + y) >>> 0;
    const v = c.feedback ? (base + lo) >>> 0 : (base ^ 0x80000000) >>> 0;
    const w = c.different ? (v ^ 123) >>> 0 : v;
    lo = c.kinds[0] === 'min' ? Math.min(lo, v) : Math.max(lo, v);
    hi = c.kinds[1] === 'min' ? Math.min(hi, w) : Math.max(hi, w);
  }
  return [lo, hi];
}
const configs: Config[] = [
  ...[0, 1, 3, 4, 5, 7, 8, 12, 32].map(
    (count): Config => ({ name: `n${count}`, count, kinds: ['min', 'max'] }),
  ),
  { name: 'reverse', count: 16, kinds: ['max', 'min'], swap: true, put: true },
  { name: 'inclusive', count: 16, kinds: ['min', 'max'], inclusive: true, invert: true },
  { name: 'bothmin', count: 8, kinds: ['min', 'min'], swap: true, invert: true },
  { name: 'bothmax', count: 8, kinds: ['max', 'max'], put: true },
  { name: 'dynamic', count: 8, kinds: ['min', 'max'], dynamic: true },
  { name: 'feedback', count: 8, kinds: ['min', 'max'], feedback: true },
  { name: 'different', count: 8, kinds: ['min', 'max'], different: true },
];
const source = configs.map(body).join('\n');
function section(text: string, name: string): string {
  const start = text.indexOf(`a0_${name}:`);
  return text.slice(start, text.indexOf(`.size a0_${name}`, start));
}

test('native unsigned extrema preserve order, initial values, wrapping, short and remainder cases', {
  skip: process.platform !== 'linux' || process.arch !== 'x64',
}, async () => {
  const clang = findClang().path;
  assert.ok(clang);
  for (const strict of [false, true]) {
    const p = parseAndValidate((strict ? 'profile strict\n' : '') + source);
    const calls: string[] = [];
    const expected: string[] = [];
    for (const c of configs)
      for (const [x = 0, y = 0] of inputs)
        for (const field of [0, 1]) {
          const name = `${c.name}_${field}`,
            value = oracle(c, x, y)[field];
          assert.equal(run(p.byName.get(name)!, [x, y]), value);
          calls.push(`printf("%u\\n",a0_${name}(${x}u,${y}u));`);
          expected.push(String(value));
        }
    const driver = `#include <stdint.h>\n#include <stdio.h>\n${configs.flatMap((c) => [0, 1].map((f) => `extern uint32_t a0_${c.name}_${f}(uint32_t,uint32_t);`)).join('\n')}\nint main(void){${calls.join('\n')}return 0;}\n`;
    for (const optimize of [false, true]) {
      const text = compile(p, 'x86_64', { optimize, x86Platform: 'linux' }).text;
      if (strict) assert.doesNotMatch(text, /pminud|pmaxud/);
      else {
        // Optimized short folds may be unrolled before backend emission.
        if (!optimize) assert.match(section(text, 'n8_0'), /pminud/);
        for (const name of ['n0', 'n1', 'n3', 'n5', 'n7', 'dynamic', 'feedback', 'different'])
          assert.doesNotMatch(section(text, `${name}_0`), /pminud|pmaxud/, name);
      }
      const variants = [text];
      if (text.includes('.La0sse41_cap:'))
        variants.push(
          text
            .replace('.La0sse41_cap:\n\t.byte 0', '.La0sse41_cap:\n\t.byte 1')
            .replace(/(?:pminud|pmaxud|pmulld)[^\n]*/g, 'ud2'),
        );
      for (const variant of variants)
        await withTempDir(async (dir) => {
          await writeFile(join(dir, 'module.s'), variant);
          await writeFile(join(dir, 'driver.c'), driver);
          const build = runTool(clang, ['-O2', 'module.s', 'driver.c', '-o', 'check'], {
            cwd: dir,
          });
          assert.ok(build.ok, build.stderr);
          const result = runTool(join(dir, 'check'), [], { cwd: dir });
          assert.ok(result.ok, result.stderr);
          assert.deepEqual(result.stdout.trim().split('\n'), expected);
        });
    }
  }
  const darwin = compile(parseAndValidate(source), 'x86_64', { x86Platform: 'darwin' }).text;
  assert.doesNotMatch(darwin, /pminud|pmaxud|sse41|cpuid/);
});

test('native extrema execute the unchanged minmax1k benchmark and retain its source semantics', async (t) => {
  const k = KERNELS.find((k) => k.name === 'minmax1k');
  assert.ok(k);
  const p = parseAndValidate(k.a0),
    hand = await import(`data:text/javascript,${encodeURIComponent(k.js)}`);
  for (const args of inputs)
    assert.equal(run(p.byName.get('minmax1k')!, args, { fuel: 5000000 }), hand.minmax1k(...args));
  const cases = inputs.map((args) => ({
    functionName: 'minmax1k',
    args,
    expected: hand.minmax1k(...args) as number,
  }));
  const report = await checkX86_64(p, cases, findClang());
  if (report.status === 'blocked') {
    t.skip(report.detail);
    return;
  }
  assert.equal(report.status, 'passed', JSON.stringify(report));
  const text = compile(p, 'x86_64', { x86Platform: 'linux' }).text;
  assert.match(text, /pminud/);
  assert.match(text, /pmaxud/);
});

test('extrema dispatch preserves six live arguments and concurrent initialization', {
  skip: process.platform !== 'linux' || process.arch !== 'x64',
}, async () => {
  const c: Config = { name: 'livebody', count: 32, kinds: ['min', 'max'] };
  const step = body(c).split('fn livebody_0')[0];
  const p = parseAndValidate(
    step +
      `fn live u32 u32 u32 u32 u32 u32 -> u32\nz rec p0 p1\nr fold step_livebody 32 z p4 p5\nlo at r 0\nhi at r 1\ns sub hi lo\na add p0 p1\nb xor p2 p3\nc add p4 p5\nd xor a b\ne xor d c\nf xor s e\nret f\nend`,
  );
  const text = compile(p, 'x86_64', { optimize: false, x86Platform: 'linux' }).text;
  assert.match(text, /call \.La0sse41/);
  const driver = `#include <stdint.h>\n#include <stdatomic.h>\n#include <pthread.h>\nextern uint32_t a0_live(uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t);\nstatic atomic_int ready=0,go=0,failed=0;\nstatic void*work(void*ptr){uint32_t k=(uint32_t)(uintptr_t)ptr;atomic_fetch_add(&ready,1);while(!atomic_load(&go)){}for(uint32_t j=0;j<100;j++){uint32_t a=0xdeadbeefu+j+k,b=0xffffffffu-k,c=j*7919u,d=0x80000000u,e=k+17u,f=j^0xabcdefu,lo=a,hi=b;for(uint32_t i=0;i<32;i++){uint32_t v=(i*e+f)^0x80000000u;if(v<lo)lo=v;if(v>hi)hi=v;}uint32_t expected=(hi-lo)^((a+b)^(c^d)^(e+f));if(a0_live(a,b,c,d,e,f)!=expected)atomic_store(&failed,1);}return 0;}\nint main(void){pthread_t t[8];for(uintptr_t i=0;i<8;i++)if(pthread_create(&t[i],0,work,(void*)i))return 2;while(atomic_load(&ready)!=8){}atomic_store(&go,1);for(int i=0;i<8;i++)pthread_join(t[i],0);return atomic_load(&failed);}\n`;
  const clang = findClang().path;
  assert.ok(clang);
  for (const variant of [
    text,
    text
      .replace('.La0sse41_cap:\n\t.byte 0', '.La0sse41_cap:\n\t.byte 1')
      .replace(/(?:pminud|pmaxud|pmulld)[^\n]*/g, 'ud2'),
  ])
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'module.s'), variant);
      await writeFile(join(dir, 'driver.c'), driver);
      const build = runTool(clang, ['-O2', '-pthread', 'module.s', 'driver.c', '-o', 'check'], {
        cwd: dir,
      });
      assert.ok(build.ok, build.stderr);
      for (let i = 0; i < 8; i++) {
        const result = runTool(join(dir, 'check'), [], { cwd: dir });
        assert.ok(result.ok, result.stderr);
      }
    });
});
