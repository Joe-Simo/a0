import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseAndValidate, withoutProfile } from '../../../dist/src/core.js';
import { emitMetal } from '../../../dist/src/metal.js';
import { optimizeFunction } from '../../../dist/src/optimize.js';
import { runTool } from '../../../dist/src/toolchain.js';
import { tables } from '../../../dist/test/fixtures/sv-emitter/tables.js';
import { encode, nativeEmit, runTables } from './transport.mjs';

const root = process.argv[2],
  work = `${root}/build/controls`;
mkdirSync(work, { recursive: true });
const clang = { path: process.argv[3] };
assert.ok(root && clang.path);
const results = [];
const basic = parseAndValidate(`fn f u32 -> u32
r add p0 7
ret r
end
`);
function target(text, driver, level) {
  writeFileSync(`${work}/module.c`, text);
  writeFileSync(
    `${work}/driver.c`,
    `#include <assert.h>
#include <stdint.h>
#include "module.c"
${driver}`,
  );
  const b = runTool(
    clang.path,
    [
      '-std=c11',
      `-O${level}`,
      '-Wall',
      '-Wextra',
      '-Wno-unused-parameter',
      '-Werror',
      '-fsanitize=undefined',
      '-fno-sanitize-recover=all',
      `${work}/driver.c`,
      '-o',
      `${work}/driver`,
    ],
    { timeoutMs: 120000 },
  );
  assert.ok(b.ok, b.stderr);
  const r = runTool(`${work}/driver`, [], { timeoutMs: 120000 });
  assert.ok(r.ok, r.stderr);
}
for (const level of [0, 2]) {
  for (const metal of [false, true]) {
    const words = encode(tables(basic)).length / 4 - 9;
    for (const [name, budget, maxout, counts, code] of [
      ['allocation', words + 10, 50000000, undefined, 4],
      ['publication', 50000000, 150, undefined, 4],
      ['node-count', 50000000, 50000000, [1, 3, 4294967295], 7],
      ['function-count', 50000000, 50000000, [2147483648, 3, 2], 7],
      ['function-row-width', 50000000, 50000000, [429496730, 3, 2], 7],
      ['type-count', 50000000, 50000000, [1, 4294967295, 2], 7],
      ['range', 50000000, 50000000, [1, 3, 3], 3],
    ]) {
      const t = tables(basic);
      if (counts) t.counts = [...counts];
      const r = runTables(t, level, metal, 256, 1024, 0, budget, maxout);
      assert.equal(r.code, code, name);
      if (name === 'publication') assert.equal(r.status.outputCount, 128);
      results.push({ level, metal, name, status: r.code });
    }
    for (const [name, mutate] of [
      ['opcode', (t) => (t.nodes[8] = 99)],
      ['typekind', (t) => (t.types[0] = 99)],
      ['name-byte', (t) => (t.pool[0] = 300)],
    ]) {
      const t = tables(basic);
      mutate(t);
      const r = runTables(t, level, metal);
      assert.equal(r.code, 6, name);
      assert.equal(r.status.resultHandle, 0);
      results.push({ level, metal, name, status: r.code });
    }
    const targetTables = tables(basic);
    targetTables.counts[0] = 0;
    assert.equal(
      runTables(tables(basic), level, metal, 256, 1024, 0, 50000000, 50000000, targetTables).code,
      6,
    );
    results.push({ level, metal, name: 'shape-count', status: 6 });
  }
  assert.equal(nativeEmit(basic, level, 256, 1024, 1).code, 12);
  results.push({ level, name: 'unsupported-C-options', status: 12 });
  const unsafe = parseAndValidate(`profile strict
fn f u32 -> u32
x div p0 p0
ret 7
end
`),
    canonical = withoutProfile(unsafe),
    optimized = { ...canonical, functions: canonical.functions.map((f) => optimizeFunction(f).fn) };
  for (const metal of [false, true]) {
    assert.equal(
      runTables(tables(unsafe), level, metal, 256, 1024, 0, 50000000, 50000000, tables(optimized))
        .code,
      9,
    );
    results.push({ level, metal, name: 'original-strict-before-opt', status: 9 });
  }
  const deadChecked = parseAndValidate(`fn f u32 -> u32
x cadd p0 1
ret 7
end
`),
    optChecked = {
      ...deadChecked,
      functions: deadChecked.functions.map((f) => optimizeFunction(f).fn),
    };
  assert.equal(
    runTables(
      tables(deadChecked),
      level,
      true,
      256,
      1024,
      0,
      50000000,
      50000000,
      tables(optChecked),
    ).code,
    8,
  );
  results.push({ level, metal: true, name: 'checked-before-opt', status: 8 });
  const safe = parseAndValidate(`profile strict
fn f u32 -> u32
x or p0 1
r div 55 x
ret r
end
`),
    plain = withoutProfile(safe),
    opt = { ...plain, functions: plain.functions.map((f) => optimizeFunction(f).fn) };
  for (const metal of [false, true]) {
    const r = runTables(tables(safe), level, metal, 256, 1024, 0, 50000000, 50000000, tables(opt));
    assert.equal(r.code, 0);
    if (!metal)
      target(
        r.text,
        `int main(void){for(uint32_t i=0;i<128;i++)assert(a0_f(i)==55u/(i|1u));}
`,
        level,
      );
    else assert.ok(r.text.includes('kernel void k_f'));
    results.push({ level, metal, name: 'shaped-safe-strict', status: 0 });
  }
  const io = parseAndValidate(`fn f u32 io -> u32
a read p1
v at a 0
t at a 1
b read t
w at b 0
u at b 1
c read u
x at c 0
y at c 1
q arr v w x p0
o puts y q
ret p0
end
`);
  const ir = nativeEmit(io, level, 2, 3);
  assert.equal(ir.code, 0);
  target(
    ir.text,
    `int main(void){a0_io io={0};io.ninput=2;io.input[0]=9;io.input[1]=10;assert(a0_f(77,&io)==77);assert(io.position==2&&io.noutput==3);assert(io.output[0]==4&&io.output[1]==9&&io.output[2]==10);}
`,
    level,
  );
  results.push({ level, name: 'IO-capacities', status: 0, cases: 1 });
  const large = parseAndValidate(`fn bump u32x2048 u32 -> u32x2048
v add p1 1
r set p0 p1 v
ret r
end
fn pred u32x2048 u32 -> bool
r lt p1 7
ret r
end
fn go u32x2048 u32 -> u32x2048
r loop pred bump p1 p0
ret r
end
`);
  const lr = nativeEmit(large, level);
  assert.equal(lr.code, 0);
  target(
    lr.text,
    `int main(void){static a0t_a2048_u in,out;for(uint32_t i=0;i<2048;i++)in.e[i]=i*3+5;for(uint32_t n=0;n<32;n++){a0_go(&out,&in,n);for(uint32_t i=0;i<2048;i++){assert(in.e[i]==i*3+5);assert(out.e[i]==(i<n&&i<7?i+1:i*3+5));}assert(a0arena_top==0);}}
`,
    level,
  );
  results.push({ level, name: 'large-ABI-owned-ref', status: 0, cases: 32 });
  const max = parseAndValidate(`fn peek u32x65536 u32 -> u32
r get p0 p1
ret r
end
`);
  const mr = nativeEmit(max, level);
  assert.equal(mr.code, 0);
  target(
    mr.text,
    `int main(void){static a0t_a65536_u a;a.e[65535]=99;assert(a0_peek(&a,4294967295u)==99);assert(a0_peek(&a,0)==0);}
`,
    level,
  );
  assert.equal(nativeEmit(max, level, 256, 1024, 0, 50000000, 50000000, true).code, 10);
  results.push({ level, name: 'array65536-ABI', status: 0, cases: 2 });
  const nested = parseAndValidate(`fn f u32x1024x2 u32 -> u32x1024x2
a get p0 p1
b set a p1 7
r set p0 p1 b
ret r
end
`);
  const m = emitMetal(nested);
  assert.ok(/thread_local/.test(m));
  writeFileSync(`${work}/reference-large-metal.metal`, m);
  assert.equal(nativeEmit(nested, level, 256, 1024, 0, 50000000, 50000000, true).code, 14);
  results.push({ level, name: 'experimental-Metal-large', status: 14 });
  const mixed = parseAndValidate(`fn f u32x1025 io -> u32
ret 7
end
`);
  assert.throws(() => emitMetal(mixed), /io functions/);
  assert.equal(nativeEmit(mixed, level, 256, 1024, 0, 50000000, 50000000, true).code, 11);
  results.push({ level, name: 'Metal-IO-before-vector', status: 11 });
}
for (const [name, source] of [
  [
    'nodes4096',
    `fn f u32 -> u32
` +
      Array.from(
        { length: 4096 },
        (_, i) => `n${i} add ${i ? `n${i - 1}` : 'p0'} 1
`,
      ).join('') +
      `ret n4095
end
`,
  ],
  [
    'functions1025-pool65536',
    Array.from(
      { length: 1025 },
      (_, i) => `fn ${(`f${i}`).padEnd(64, 'x')} -> u32
ret ${i % 2 ? '4294967295' : '0'}
end
`,
    ).join(''),
  ],
  [
    'params64',
    `fn f ${Array(64).fill('u32').join(' ')} -> u32
r add p0 p63
ret r
end
`,
  ],
]) {
  const p = parseAndValidate(source);
  for (const metal of [false, true]) {
    const r = nativeEmit(p, 2, 256, 1024, 0, 50000000, 50000000, metal);
    assert.equal(r.code, 0, name);
    if (!metal) {
      let main = '';
      if (name === 'nodes4096') main = 'assert(a0_f(7)==4103);';
      if (name === 'functions1025-pool65536')
        main =
          'assert(a0_' +
          'f1023'.padEnd(64, 'x') +
          '()==4294967295u);assert(a0_' +
          'f1024'.padEnd(64, 'x') +
          '()==0);';
      if (name === 'params64')
        main = `assert(a0_f(${Array.from({ length: 64 }, (_, i) => i).join(',')})==63);`;
      target(
        r.text,
        'int main(void){' +
          main +
          `}
`,
        2,
      );
    } else {
      writeFileSync(
        `${work}/metal_stdlib`,
        `#include <cstdint>
namespace metal{using uint=uint32_t;using ulong=uint64_t;}
#define kernel
#define device
#define thread
`,
      );
      writeFileSync(`${work}/capacity.metal`, r.text);
      let main = '';
      if (name === 'nodes4096') main = 'uint in[1]={7},out=0;k_f(in,&out,0);assert(out==4103);';
      if (name === 'functions1025-pool65536')
        main =
          'uint in[1]={0},out=0;k_' +
          'f1023'.padEnd(64, 'x') +
          '(in,&out,0);assert(out==4294967295u);k_' +
          'f1024'.padEnd(64, 'x') +
          '(in,&out,0);assert(out==0);';
      if (name === 'params64')
        main = 'uint in[64]={7},out=0;in[63]=99;k_f(in,&out,0);assert(out==106);';
      writeFileSync(
        `${work}/capacity.cpp`,
        `#include <cassert>
#include "capacity.metal"
int main(){` +
          main +
          `}
`,
      );
      const b = runTool(
        clang.path,
        [
          '-std=c++14',
          '-O2',
          '-Wall',
          '-Wextra',
          '-Wno-unused-parameter',
          '-Wno-unknown-attributes',
          '-Werror',
          '-fsanitize=undefined',
          '-fno-sanitize-recover=all',
          '-I',
          work,
          `${work}/capacity.cpp`,
          '-o',
          `${work}/capacity`,
        ],
        { timeoutMs: 120000 },
      );
      assert.ok(b.ok, b.stderr);
      assert.ok(runTool(`${work}/capacity`, [], { timeoutMs: 120000 }).ok);
    }
    if (metal && name === 'params64') assert.ok(r.text.includes('in[id * 64u + 63u]'));
    results.push({
      level: 2,
      metal,
      name,
      status: 0,
      bytes: r.text.length,
      sha256: createHash('sha256').update(r.text).digest('hex'),
    });
  }
}
writeFileSync(
  `${root}/native-controls.json`,
  JSON.stringify(
    {
      results,
      largeMetalBoundary:
        'Reference still contains mapped C thread_local arena; actual Metal compiler unavailable, so validity is not proved. Experimental A0 Metal returns14 for large ABI until a correct per-thread Metal arena/ABI is implemented.',
    },
    null,
    2,
  ) +
    `
`,
);
console.log({ passed: results.length });
