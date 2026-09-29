/**
 * Gate B (execution quality) micro-benchmark: A0-emitted code versus hand-written
 * baselines with identical observable semantics, on the same machine, same
 * compiler, same flags. Steady-state only (per-call ns after warm-up); startup,
 * memory, energy, and real applications are NOT measured here. Sanitizers are off
 * (production-style flags), unlike the correctness runs in verify.
 *
 * Expected outcome for scalar straight-line kernels is a tie: both sides reach the
 * same optimizer. Ties and losses are recorded as such.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { compile } from '../src/backends.js';
import { parseAndValidate } from '../src/core.js';
import { findClang, runTool, withTempDir } from '../src/toolchain.js';

interface Kernel {
  readonly name: string;
  readonly arity: number;
  readonly a0: string;
  readonly c: string;
  readonly js: string;
}

const KERNELS: readonly Kernel[] = [
  {
    name: 'affine',
    arity: 3,
    a0: 'fn affine u32 u32 u32 -> u32\na mul p0 p1\nb add a p2\nret b\nend',
    c: 'static inline uint32_t hw_affine(uint32_t x, uint32_t s, uint32_t o) { return x * s + o; }',
    js: 'export function affine(x, s, o) { return (Math.imul(x, s) + o) >>> 0; }',
  },
  {
    name: 'rotl',
    arity: 2,
    a0: 'fn rotl u32 u32 -> u32\nl shl p0 p1\nn sub 32 p1\nr shr p0 n\no or l r\nret o\nend',
    c: 'static inline uint32_t hw_rotl(uint32_t x, uint32_t n) { return (x << (n & 31)) | (x >> ((32 - n) & 31)); }',
    js: 'export function rotl(x, n) { return ((x << (n & 31)) | (x >>> ((32 - n) & 31))) >>> 0; }',
  },
  {
    name: 'clamp',
    arity: 3,
    a0: 'fn clamp u32 u32 u32 -> u32\nc lt p2 p0\nr select c p2 p0\nd lt r p1\ns select d p1 r\nret s\nend',
    c: 'static inline uint32_t hw_clamp(uint32_t x, uint32_t lo, uint32_t hi) { uint32_t t = hi < x ? hi : x; return t < lo ? lo : t; }',
    js: 'export function clamp(x, lo, hi) { const t = hi < x ? hi : x; return t < lo ? lo : t; }',
  },
  {
    name: 'mix', // longer dependency chain: a hash-like mixer
    arity: 2,
    a0: 'fn mix u32 u32 -> u32\na xor p0 p1\nb shl a 13\nc shr a 19\nd or b c\ne mul d 2654435761\nf add e p0\ng shr f 16\nh xor f g\nret h\nend',
    c: 'static inline uint32_t hw_mix(uint32_t x, uint32_t y) { uint32_t a = x ^ y; uint32_t d = (a << 13) | (a >> 19); uint32_t f = d * 2654435761u + x; return f ^ (f >> 16); }',
    js: 'export function mix(x, y) { const a = (x ^ y) >>> 0; const d = ((a << 13) | (a >>> 19)) >>> 0; const f = (Math.imul(d, 2654435761) + x) >>> 0; return (f ^ (f >>> 16)) >>> 0; }',
  },
];

const ITER = 20_000_000;
const SAMPLES = 7;

function cDriver(callExpr: (i: number) => string, arity: number): string {
  const args = (base: string) => Array.from({ length: arity }, (_, i) => `${base}${i}`).join(', ');
  return `#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
static uint32_t rng(uint32_t *s) { uint32_t x = *s; x ^= x << 13; x ^= x >> 17; x ^= x << 5; return *s = x; }
int main(int argc, char **argv) {
  long iters = argc > 1 ? atol(argv[1]) : ${ITER};
  uint32_t s = 0x9e3779b9u, acc = 0;
  struct timespec t0, t1;
  clock_gettime(CLOCK_MONOTONIC, &t0);
  for (long i = 0; i < iters; i++) {
    ${Array.from({ length: arity }, (_, i) => `uint32_t a${i} = rng(&s);`).join(' ')}
    acc ^= ${callExpr(0).replace('ARGS', args('a'))};
  }
  clock_gettime(CLOCK_MONOTONIC, &t1);
  double ns = ((t1.tv_sec - t0.tv_sec) * 1e9 + (t1.tv_nsec - t0.tv_nsec)) / (double)iters;
  printf("%.4f %u\\n", ns, acc);
  return 0;
}
`;
}

interface Sample {
  readonly medianNsPerCall: number;
  readonly minNsPerCall: number;
  readonly maxNsPerCall: number;
  readonly checksum: string;
  readonly samples: number;
}

function summarize(values: number[], checksum: string): Sample {
  const s = [...values].sort((a, b) => a - b);
  return {
    medianNsPerCall: s[s.length >> 1] ?? 0,
    minNsPerCall: s[0] ?? 0,
    maxNsPerCall: s[s.length - 1] ?? 0,
    checksum,
    samples: values.length,
  };
}

async function benchC(
  kernel: Kernel,
  clang: string,
): Promise<{
  emitted: Sample;
  handwritten: Sample;
  binaryBytes: { emitted: number; handwritten: number };
}> {
  const program = parseAndValidate(kernel.a0);
  const emittedSrc = compile(program, 'c').text;
  return withTempDir(async (dir) => {
    const build = async (
      name: string,
      header: string,
      call: string,
    ): Promise<{ exe: string; bytes: number }> => {
      const src = join(dir, `${name}.c`);
      const exe = join(dir, name);
      await writeFile(src, `${header}\n${cDriver(() => call, kernel.arity)}`, 'utf8');
      const r = runTool(clang, ['-std=c11', '-O2', '-o', exe, src]);
      if (!r.ok) throw new Error(`${name}: ${r.stderr}`);
      const { stat } = await import('node:fs/promises');
      return { exe, bytes: (await stat(exe)).size };
    };
    const e = await build('emitted', emittedSrc, `a0_${kernel.name}(ARGS)`);
    const h = await build(
      'handwritten',
      `#include <stdint.h>\n${kernel.c}`,
      `hw_${kernel.name}(ARGS)`,
    );
    const runOne = (exe: string): { ns: number; checksum: string } => {
      const r = runTool(exe, [String(ITER)], { timeoutMs: 600_000 });
      if (!r.ok) throw new Error(r.stderr);
      const [ns, sum] = r.stdout.trim().split(' ');
      return { ns: Number(ns), checksum: sum ?? '' };
    };
    const es: number[] = [];
    const hs: number[] = [];
    let ec = '';
    let hc = '';
    for (let i = 0; i < SAMPLES; i += 1) {
      // Interleave to share thermal/scheduling conditions.
      const a = runOne(e.exe);
      const b = runOne(h.exe);
      es.push(a.ns);
      hs.push(b.ns);
      ec = a.checksum;
      hc = b.checksum;
    }
    if (ec !== hc)
      throw new Error(`${kernel.name}: checksum mismatch emitted=${ec} handwritten=${hc}`);
    return {
      emitted: summarize(es, ec),
      handwritten: summarize(hs, hc),
      binaryBytes: { emitted: e.bytes, handwritten: h.bytes },
    };
  });
}

async function benchJs(kernel: Kernel): Promise<{ emitted: Sample; handwritten: Sample }> {
  const program = parseAndValidate(kernel.a0);
  const load = async (src: string): Promise<(...a: number[]) => number> => {
    const mod = (await import(
      `data:text/javascript;base64,${Buffer.from(src).toString('base64')}`
    )) as Record<string, (...a: number[]) => number>;
    const f = mod[kernel.name];
    if (f === undefined) throw new Error('missing export');
    return f;
  };
  const emitted = await load(compile(program, 'js').text);
  const handwritten = await load(kernel.js);
  const iters = ITER / 4;
  const run = (f: (...a: number[]) => number): { ns: number; checksum: string } => {
    let s = 0x9e3779b9;
    let acc = 0;
    const a = [0, 0, 0];
    const start = performance.now();
    for (let i = 0; i < iters; i += 1) {
      for (let k = 0; k < kernel.arity; k += 1) {
        s ^= s << 13;
        s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5;
        s >>>= 0;
        a[k] = s;
      }
      acc =
        (acc ^
          (kernel.arity === 2
            ? f(a[0] as number, a[1] as number)
            : f(a[0] as number, a[1] as number, a[2] as number))) >>>
        0;
    }
    return { ns: ((performance.now() - start) * 1e6) / iters, checksum: String(acc) };
  };
  run(emitted);
  run(handwritten); // warm-up (JIT)
  const es: number[] = [];
  const hs: number[] = [];
  let ec = '';
  let hc = '';
  for (let i = 0; i < SAMPLES; i += 1) {
    const a = run(emitted);
    const b = run(handwritten);
    es.push(a.ns);
    hs.push(b.ns);
    ec = a.checksum;
    hc = b.checksum;
  }
  if (ec !== hc) throw new Error(`${kernel.name}: js checksum mismatch`);
  return { emitted: summarize(es, ec), handwritten: summarize(hs, hc) };
}

function verdict(emitted: Sample, handwritten: Sample): 'win' | 'tie' | 'loss' {
  const ratio = emitted.medianNsPerCall / handwritten.medianNsPerCall;
  const spread = Math.max(
    emitted.maxNsPerCall / emitted.minNsPerCall,
    handwritten.maxNsPerCall / handwritten.minNsPerCall,
  );
  // Within measurement noise (sample spread) counts as a tie.
  if (ratio < 1 / spread && ratio < 0.95) return 'win';
  if (ratio > spread && ratio > 1.05) return 'loss';
  return 'tie';
}

async function main(): Promise<void> {
  const clang = findClang();
  const results: Record<string, unknown> = {};
  for (const k of KERNELS) {
    const js = await benchJs(k);
    const c = clang.path === undefined ? null : await benchC(k, clang.path);
    results[k.name] = {
      c:
        c === null
          ? { status: 'blocked', detail: 'clang not found' }
          : { ...c, verdict: verdict(c.emitted, c.handwritten) },
      js: { ...js, verdict: verdict(js.emitted, js.handwritten) },
    };
    const cv =
      c === null
        ? 'blocked'
        : `${verdict(c.emitted, c.handwritten)} (${c.emitted.medianNsPerCall.toFixed(3)} vs ${c.handwritten.medianNsPerCall.toFixed(3)} ns)`;
    process.stdout.write(
      `${k.name.padEnd(8)} C: ${cv}   JS: ${verdict(js.emitted, js.handwritten)} (${js.emitted.medianNsPerCall.toFixed(3)} vs ${js.handwritten.medianNsPerCall.toFixed(3)} ns)\n`,
    );
  }
  const report = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    clang: clang.version ?? null,
    flags: { c: '-std=c11 -O2 (no sanitizer)', js: 'Node default JIT, in-process, warm' },
    iterationsPerSample: { c: ITER, js: ITER / 4 },
    samplesPerSide: SAMPLES,
    meaning:
      'Steady-state ns per call including the input generator loop, interleaved emitted/hand-written runs, median of samples; verdict is tie when within observed sample spread. Scalar micro-kernels only: not startup, memory, energy, code size at scale, or application evidence. A tie here is the expected result, not a failure or a win.',
    kernels: results,
  };
  await mkdir('results', { recursive: true });
  await writeFile(
    join('results', 'exec-benchmark.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
