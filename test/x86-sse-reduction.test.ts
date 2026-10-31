import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { compile } from '../src/backends.js';
import { parseAndValidate, run } from '../src/core.js';
import { findClang, runTool, withTempDir } from '../src/toolchain.js';
import { KERNELS } from '../tools/exec-bench-kernels.js';

const supported = process.arch === 'x64' && ['linux', 'darwin'].includes(process.platform);
const inputs = [
  [0, 0],
  [1, 7],
  [0xffffffff, 0x80000000],
  [0xdeadbeef, 0xffffffff],
];
const word = (n: bigint): number => Number(BigInt.asUintN(32, n));

interface Case {
  name: string;
  count: number;
  length: number;
  product: boolean;
  alias?: boolean;
  field?: boolean;
  dynamic?: boolean;
  shifted?: boolean;
  call?: boolean;
  arithmetic?: boolean;
  shift?: boolean;
  feedback?: boolean;
  afterResult?: boolean;
  kernel?: boolean;
  twoRates?: boolean;
}

function source(c: Case): string {
  if (c.kernel) {
    const kernel = KERNELS.find((k) => k.name === c.name);
    assert.ok(kernel);
    return kernel.a0;
  }
  if (c.arithmetic) {
    const terms = c.twoRates
      ? ['a mul p1 p2', 'b mul p1 p3', 'v mul a b']
      : c.feedback
        ? ['a mul p0 p2', 'b add a p1']
        : c.shift
          ? ['a shl p1 p2', 'b shr p3 p2', 'v xor a b']
          : [
              'a mul p1 p2',
              'b add a p3',
              ...(c.product ? ['c xor p1 p3', 'd mul c p2', 'v mul b d'] : []),
            ];
    return [
      ...(c.call ? [`fn id${c.name} u32 -> u32\nret p0\nend`] : []),
      `fn step${c.name} u32 u32 u32 u32 -> u32`,
      ...terms,
      ...(c.call ? [`q call id${c.name} ${c.shift || c.product ? 'v' : 'b'}`] : []),
      `r add ${c.call ? 'q' : c.shift || c.product ? 'v' : 'b'} p0`,
      ...(c.afterResult ? ['junk add r 1'] : []),
      'ret r',
      'end',
      `fn ${c.name} u32 u32 -> u32`,
      'init xor p0 p1',
      ...(c.dynamic ? ['count and p0 15'] : []),
      `d fold step${c.name} ${c.dynamic ? 'count' : c.count} init p0 p1`,
      'later add p0 p1',
      'r xor d later',
      'ret r',
      'end',
    ].join('\n');
  }
  const t = `u32x${c.length}`;
  const index = c.shifted ? 'j' : 'p1';
  const rows = [
    ...(c.call ? [`fn id${c.name} u32 -> u32\nret p0\nend`] : []),
    `fn step${c.name} u32 u32 ${t} ${t} -> u32`,
    ...(c.shifted ? ['j add p1 1'] : []),
    `a get p2 ${index}`,
    ...(c.product ? [`b get p3 ${index}`, 'v mul b a'] : []),
    ...(c.call ? [`q call id${c.name} ${c.product ? 'v' : 'a'}`] : []),
    `r add ${c.call ? 'q' : c.product ? 'v' : 'a'} p0`,
    'ret r',
    'end',
    `fn ${c.name} u32 u32 -> u32`,
    `a arr ${Array.from({ length: c.length }, (_, i) => (i % 3 === 0 ? 'p0' : i % 3 === 1 ? 'p1' : '4294967295')).join(' ')}`,
    `b arr ${Array.from({ length: c.length }, (_, i) => (i % 2 === 0 ? 'p1' : '2147483648')).join(' ')}`,
    ...(c.field ? ['pack rec p0 a', 'field at pack 1'] : []),
    'init xor p0 p1',
    ...(c.dynamic ? ['count and p0 15'] : []),
    `d fold step${c.name} ${c.dynamic ? 'count' : c.count} init ${c.field ? 'field' : 'a'} ${c.alias ? 'a' : 'b'}`,
    'later add p0 p1',
    'r xor d later',
    'ret r',
    'end',
  ];
  return rows.join('\n');
}

function oracle(c: Case, x: number, y: number): number {
  let sum = c.kernel ? 0n : BigInt((x ^ y) >>> 0);
  for (let i = 0; i < (c.dynamic ? x & 15 : c.count); i++) {
    if (c.arithmetic) {
      if (c.feedback) {
        sum = sum * (BigInt(x) + 1n) + BigInt(i);
        continue;
      }
      if (c.twoRates) {
        sum += BigInt(i) * BigInt(x) * BigInt(i) * BigInt(y);
        continue;
      }
      sum += c.shift
        ? BigInt(((i << (x & 31)) ^ (y >>> (x & 31))) >>> 0)
        : (BigInt(i) * BigInt(x) + BigInt(y)) *
          (c.product ? BigInt((i ^ y) >>> 0) * BigInt(x) : 1n);
      continue;
    }
    const j = (i + (c.shifted ? 1 : 0)) % c.length;
    const a = j % 3 === 0 ? x : j % 3 === 1 ? y : 0xffffffff;
    const b = c.alias ? a : j % 2 === 0 ? y : 0x80000000;
    sum += BigInt(a) * (c.product ? BigInt(b) : 1n);
  }
  return c.kernel ? word(sum) : (word(sum) ^ word(BigInt(x) + BigInt(y))) >>> 0;
}

async function check(cases: readonly Case[], strict = false): Promise<string> {
  const p = parseAndValidate(`${strict ? 'profile strict\n' : ''}${cases.map(source).join('\n')}`);
  const expected = cases.flatMap((c) =>
    inputs.map(([x = 0, y = 0]) => {
      const v = oracle(c, x, y);
      const fn = p.byName.get(c.name);
      assert.ok(fn);
      assert.equal(run(fn, [x, y], { fuel: c.kernel ? 5e6 : 1e6 }), v);
      return String(v);
    }),
  );
  const driver = `#include <stdint.h>\n#include <stdio.h>\n${cases.map((c) => `extern uint32_t a0_${c.name}(uint32_t,uint32_t);`).join('\n')}\nint main(void) {\n${cases.flatMap((c) => inputs.map(([x, y]) => `printf("%u\\n",a0_${c.name}(${x}u,${y}u));`)).join('\n')}\nreturn 0;\n}`;
  const clang = findClang().path;
  assert.ok(clang);
  let text = '';
  let unoptimized = '';
  for (const optimize of [false, true]) {
    text = compile(p, 'x86_64', { optimize }).text;
    if (!optimize) unoptimized = text;
    const variants = [text];
    if (process.platform === 'linux' && text.includes('.La0sse41_cap:')) {
      // Make the unselected instructions trap, proving SSE2-only CPUs never execute them.
      variants.push(
        text
          .replace('.La0sse41_cap:\n\t.byte 0', '.La0sse41_cap:\n\t.byte 1')
          .replace(/pmulld[^\n]*/g, 'ud2'),
      );
    }
    for (const variant of variants)
      await withTempDir(async (dir) => {
        await writeFile(join(dir, 'module.s'), variant);
        await writeFile(join(dir, 'driver.c'), driver);
        const build = runTool(clang, ['-O2', 'driver.c', 'module.s', '-o', 'check'], { cwd: dir });
        assert.ok(build.ok, build.stderr);
        const result = runTool(join(dir, 'check'), [], { cwd: dir });
        assert.ok(result.ok, result.stderr);
        assert.deepEqual(result.stdout.trim().split('\n'), expected);
      });
  }
  return unoptimized;
}

test('x86 SSE2 arithmetic reductions preserve wrapping, all tails and live inputs', {
  skip: !supported,
}, async () => {
  const cases = [4, 5, 6, 7, 8, 9, 17].flatMap((count): Case[] => [
    { name: `sum${count}`, count, length: 0, product: false, arithmetic: true },
    { name: `dot${count}`, count, length: 0, product: true, arithmetic: true },
  ]);
  cases.push({
    name: 'shift',
    count: 11,
    length: 0,
    product: false,
    arithmetic: true,
    shift: true,
  });
  cases.push({
    name: 'tworates',
    count: 19,
    length: 0,
    product: true,
    arithmetic: true,
    twoRates: true,
  });
  const text = await check(cases);
  assert.match(text, /pmuludq/);
  assert.match(text, /paddd/);
});

test('x86 SSE2 reduction leaves arrays, short, dynamic and call bodies on scalar paths', {
  skip: !supported,
}, async () => {
  const cases: Case[] = [0, 1, 3].map((count) => ({
    name: `short${count}`,
    count,
    length: 0,
    product: true,
    arithmetic: true,
  }));
  cases.push({ name: 'wrap', count: 9, length: 5, product: true });
  cases.push({ name: 'shifted', count: 7, length: 9, product: true, shifted: true });
  cases.push({
    name: 'dynamic',
    count: 0,
    length: 0,
    product: true,
    dynamic: true,
    arithmetic: true,
  });
  cases.push({ name: 'called', count: 7, length: 0, product: true, call: true, arithmetic: true });
  cases.push({
    name: 'feedback',
    count: 9,
    length: 0,
    product: false,
    arithmetic: true,
    feedback: true,
  });
  cases.push({
    name: 'afterresult',
    count: 9,
    length: 0,
    product: false,
    arithmetic: true,
    afterResult: true,
  });
  const text = await check(cases);
  assert.doesNotMatch(text, /pmuludq/);
});

test('strict x86 reductions preserve ordinary frame and iteration lowering', {
  skip: !supported,
}, async () => {
  const text = await check(
    [{ name: 'strictsum', count: 7, length: 0, product: true, arithmetic: true }],
    true,
  );
  assert.doesNotMatch(text, /pmuludq/);
});

test('x86 SSE2 reduction executes the unchanged dot1k workload after fill fusion', {
  skip: !supported,
}, async () => {
  const text = await check([
    { name: 'dot1k', count: 1024, length: 0, product: true, arithmetic: true, kernel: true },
  ]);
  assert.match(text, /pmuludq/);
});

test('Linux SSE4.1 dispatch preserves six live arguments and concurrent first calls', {
  skip: !supported || process.platform !== 'linux',
}, async () => {
  const p = parseAndValidate(`
fn step u32 u32 u32 -> u32
a xor p1 p2
b mul a p1
r add p0 b
ret r
end
fn live u32 u32 u32 u32 u32 u32 -> u32
r fold step 19 p0 p1
a add p0 p1
b xor p2 p3
c add p4 p5
d xor a b
e add d c
out xor r e
ret out
end`);
  const text = compile(p, 'x86_64', { optimize: false, x86Platform: 'linux' }).text;
  assert.match(text, /call \.La0sse41/);
  assert.match(text, /pmulld/);
  const driver = `#include <stdint.h>
#include <stdatomic.h>
#include <pthread.h>
extern uint32_t a0_live(uint32_t,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t);
static atomic_int ready=0, go=0, failed=0;
static void *work(void *ptr) {
  uint32_t k=(uint32_t)(uintptr_t)ptr;
  atomic_fetch_add(&ready,1);
  while (!atomic_load(&go)) {}
  for (uint32_t j=0;j<200;j++) {
    uint32_t a=0xdeadbeefu+j+k,b=0xffffffffu-k,c=j*7919u,d=0x80000000u,e=k+17u,f=j^0xabcdefu;
    uint32_t sum=a;
    for (uint32_t i=0;i<19;i++) sum+=(i^b)*i;
    uint32_t expected=sum^(((a+b)^(c^d))+(e+f));
    if(a0_live(a,b,c,d,e,f)!=expected) atomic_store(&failed,1);
  }
  return 0;
}
int main(void) {
  pthread_t threads[8];
  for(uintptr_t i=0;i<8;i++) if(pthread_create(&threads[i],0,work,(void*)i)) return 2;
  while(atomic_load(&ready)!=8) {}
  atomic_store(&go,1);
  for(int i=0;i<8;i++) pthread_join(threads[i],0);
  return atomic_load(&failed);
}`;
  const clang = findClang().path;
  assert.ok(clang);
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'driver.c'), driver);
    for (const [i, variant] of [
      text,
      text
        .replace('.La0sse41_cap:\n\t.byte 0', '.La0sse41_cap:\n\t.byte 1')
        .replace(/pmulld[^\n]*/g, 'ud2'),
    ].entries()) {
      await writeFile(join(dir, 'module.s'), variant);
      const build = runTool(clang, ['-O2', '-pthread', 'driver.c', 'module.s', '-o', 'check'], {
        cwd: dir,
      });
      assert.ok(build.ok, build.stderr);
      for (let round = 0; round < 10; round++) {
        const result = runTool(join(dir, 'check'), [], { cwd: dir });
        assert.ok(result.ok, `variant ${i} round ${round}: ${result.stderr}`);
      }
    }
  });
});

test('SSE4.1 dispatch stays absent from Darwin and multiply-free reductions', () => {
  const p = parseAndValidate(
    source({ name: 'product', count: 19, length: 0, product: true, arithmetic: true }),
  );
  const darwin = compile(p, 'x86_64', { x86Platform: 'darwin' }).text;
  assert.doesNotMatch(darwin, /sse41|pmulld|cpuid/);
  const q = parseAndValidate(
    'fn step u32 u32 -> u32\na xor p1 7\nr add p0 a\nret r\nend\nfn sum u32 -> u32\nr fold step 19 p0\nret r\nend',
  );
  assert.doesNotMatch(compile(q, 'x86_64', { x86Platform: 'linux' }).text, /sse41|pmulld|cpuid/);
});
