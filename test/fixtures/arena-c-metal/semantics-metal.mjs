import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseAndValidate, withoutProfile } from '../../../dist/src/core.js';
import { emitMetal, isKernelCallable } from '../../../dist/src/metal.js';
import { runTool } from '../../../dist/src/toolchain.js';
import { directedFixtures } from '../../../dist/test/fixtures/sv-emitter/cases.js';
import { svTokens } from '../../../dist/test/fixtures/sv-emitter/tokens.js';
import {
  generateCases,
  generateCorpus,
  ioFreeSubset,
  isDriverCallable,
  oracleRun,
  oracleToValue,
} from '../../../dist/tools/corpus.js';
import { nativeEmit } from './transport.mjs';

let level = 0;
const emit = (
  p,
  incap = 256,
  outcap = 1024,
  flags = 0,
  budget = 50000000,
  maxout = 50000000,
  metal = false,
) => nativeEmit(p, level, incap, outcap, flags, budget, maxout, metal);
const root = process.argv[2],
  clang = { path: process.argv[3] };
assert.ok(root && clang.path);
const work = `${root}/build/semantic-metal`;
mkdirSync(work, { recursive: true });
writeFileSync(
  `${work}/metal_stdlib`,
  `#include <cstdint>
namespace metal { using uint=uint32_t; using ulong=uint64_t; }
#define kernel
#define device
#define thread
`,
);
function driver(p) {
  return (
    `#include <cstdio>
#include <cstdlib>
#include <cstring>
#include "module.metal"
int main(){char line[8192];while(fgets(line,sizeof line,stdin)){char *t=strtok(line," \\n");if(!t)continue;int which=atoi(t);uint in[128]={0},out=0;uint n=0;while((t=strtok(nullptr," \\n")))in[n++]=(uint)strtoul(t,nullptr,10);(void)n;(void)in;(void)out;switch(which){` +
    p.functions
      .map((f, i) =>
        isKernelCallable(f) ? `case ${i}: k_${f.name}(in,&out,0);printf("%u\\n",out);break;` : '',
      )
      .join('') +
    `default:abort();}}}
`
  );
}
function bounded(p) {
  return p.functions
    .filter(isDriverCallable)
    .filter((f) => !f.params.includes('io'))
    .flatMap((f) =>
      [0, 1, 7, 31].map((x) => {
        const args = f.params.map((t) => (t === 'bool' ? !!(x & 1) : x));
        return { functionName: f.name, args, expected: oracleToValue(oracleRun(f, args)) };
      }),
    );
}
const results = [];
function check(name, p) {
  let reference;
  try {
    reference = emitMetal(p);
  } catch (e) {
    const r = emit(p, 256, 1024, 0, 50000000, 50000000, true);
    const message = String(e);
    const expected = /checked op/.test(message)
      ? 8
      : /can trap/.test(message)
        ? 9
        : /io functions/.test(message)
          ? 11
          : /1024|limit|length/.test(message)
            ? 10
            : undefined;
    assert.ok(expected, message);
    assert.equal(r.code, expected, name);
    results.push({ level, name, status: r.code });
    return;
  }
  const r = emit(p, 256, 1024, 0, 50000000, 50000000, true);
  assert.equal(r.code, 0, name);
  const wrappers = (s) => [...s.matchAll(/kernel void k_[\s\S]*?\n\}/g)].map((m) => svTokens(m[0]));
  assert.deepEqual(wrappers(r.text), wrappers(reference), `${name} wrapper ABI`);
  assert.ok(!/uint32_t|uint64_t|static inline/.test(r.text));
  writeFileSync(`${work}/module.metal`, r.text);
  writeFileSync(`${work}/metal-target.cpp`, driver(p));
  const b = runTool(
    clang.path,
    [
      '-std=c++14',
      `-O${level}`,
      '-Wall',
      '-Wextra',
      '-Wno-unused-parameter',
      '-Wno-unknown-attributes',
      '-Werror',
      '-fsanitize=undefined',
      '-fno-sanitize-recover=all',
      '-I',
      work,
      `${work}/metal-target.cpp`,
      '-o',
      `${work}/metal-target`,
    ],
    { timeoutMs: 120000 },
  );
  assert.ok(b.ok, name + b.stderr);
  const plain = withoutProfile(p),
    cases = name.startsWith('corpus-') ? generateCases(plain, 42, 12) : bounded(plain),
    fmt = (v) => (typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
  const input =
    cases
      .map((c) =>
        [p.functions.findIndex((f) => f.name === c.functionName), ...c.args.map(fmt)].join(' '),
      )
      .join(`
`) +
    `
`;
  const ran = runTool(`${work}/metal-target`, [], { input, timeoutMs: 120000 });
  assert.ok(ran.ok, name + ran.stderr);
  const actual = ran.stdout.trim().split(`
`);
  if (cases.length) {
    assert.equal(actual.length, cases.length, name);
    for (let i = 0; i < cases.length; i++)
      assert.equal(actual[i], fmt(cases[i].expected), `${name}:${i}`);
  }
  results.push({
    level,
    name,
    status: 0,
    cases: cases.length,
    sourceBytes: r.text.length,
    kernels: wrappers(r.text).length,
  });
}
for (level of [0, 2]) {
  for (const [name, source] of directedFixtures()) check(name, parseAndValidate(source));
  for (const seed of [1, 42, 305419896, 4294967295])
    check(`corpus-${seed}`, ioFreeSubset(generateCorpus(seed)));
}
writeFileSync(
  `${root}/metal-native-check.json`,
  JSON.stringify(
    {
      results,
      boundary:
        'C++14 shim executes generated MSL kernel logic on CPU; not Metal compilation/GPU execution/address-space validation',
    },
    null,
    2,
  ) +
    `
`,
);
console.log({ passed: results.length, cases: results.reduce((n, r) => n + (r.cases ?? 0), 0) });
