/**
 * Data-parallel benchmark for automatic parallel folds (src/parallel.ts).
 *
 * Kernels (seed p0, every element generated from the index, so nothing is hoisted):
 *   sum24   wrapping sum of gen(i) over 2^24 indices
 *   xor24   xor-hash of the stream gen(i) * (i | 1) over 2^24 indices
 *   count20 count of i < 2^20 with (gen(i) & 1023) < 100
 *   mr22    map-reduce: max over 2^22 of (gen(i) & 0xffff) * (gen'(i) >> 16), two generators
 *   dot64k  dot product of two 65536-element arrays built by map folds (A0's array cap)
 *   max64k  max over a 65536-element array built by a map fold
 *   hash64k sum of a 65536-element array whose element i is 64 chained gen rounds from i (a
 *           heavy map: the GPU map path at full size)
 * A0 is timed as serial C (parallel off: Clang's vectorizer is the SIMD path), the cost-model
 * choice (auto), threads forced on every recognized fold, and the GPU mode (Metal via the
 * Objective-C build of the same file, where eligible). Baselines: idiomatic single-threaded C
 * (clang -O3 -mcpu=native), Rust (opt-level=3, target-cpu=native), Zig (ReleaseFast), Go, Java,
 * Python, JavaScript (Node), plus hand-parallel C (OpenMP `parallel for simd reduction`, libomp)
 * so both ratios can be stated. A0 C is compiled with the same clang flags as the C baseline.
 *
 * Correctness first: every A0 build (off, threads forced, GPU forced) of every kernel at small
 * sizes is compared with the reference interpreter on several seeds; then at full size every
 * baseline's checksum must equal the A0 serial checksum before any timing counts. Timing is
 * interleaved (sample i of every row before sample i+1 of any), median of --samples (default 7).
 * Before timing the tool waits up to 15 minutes for the 1-minute load average to drop below 6
 * and records the load it saw either way.
 *
 * Usage: bun run par-bench [-- --samples=N] [--kernels=a,b] [--no-wait] [--out=PATH]
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { compile } from '../src/backends.js';
import { parseAndValidate, run, type TypedProgram } from '../src/core.js';
import { type ParallelMode, parallelC, planProgram } from '../src/parallel.js';
import { findClang, runTool, withTempDir } from '../src/toolchain.js';
import { jvm, single, type Toolchain } from './exec-bench-languages.js';

const KERNELS = ['sum24', 'xor24', 'count20', 'mr22', 'dot64k', 'max64k', 'hash64k'] as const;
type K = (typeof KERNELS)[number];

/** Calls per sample for native/JIT rows (Python always runs one call per sample). */
const CALLS: Readonly<Record<K, number>> = {
  sum24: 16,
  xor24: 16,
  count20: 64,
  mr22: 16,
  dot64k: 512,
  max64k: 1024,
  hash64k: 16,
};

const GEN = `fn gen u32 u32 -> u32
a mul p0 2654435761
b xor a p1
c shr b 15
d xor b c
e mul d 2246822519
f shr e 13
g xor e f
ret g
end`;

const zeros = (l: number): string => Array.from({ length: l }, () => '0').join(' ');

/** A0 source of a kernel; n trips (and array length l for the array kernels). */
function a0Source(k: K, n: number): string {
  switch (k) {
    case 'sum24':
      return `${GEN}\nfn sumb u32 u32 u32 -> u32\nh call gen p1 p2\ns add p0 h\nret s\nend\nfn sum24 u32 -> u32\nr fold sumb ${n} 0 p0\nret r\nend\n`;
    case 'xor24':
      return `${GEN}\nfn xorb u32 u32 u32 -> u32\nh call gen p1 p2\no or p1 1\nm mul h o\ns xor p0 m\nret s\nend\nfn xor24 u32 -> u32\nr fold xorb ${n} 0 p0\nret r\nend\n`;
    case 'count20':
      return `${GEN}\nfn countb u32 u32 u32 -> u32\nh call gen p1 p2\na and h 1023\nc lt a 100\nv select c 1 0\ns add p0 v\nret s\nend\nfn count20 u32 -> u32\nr fold countb ${n} 0 p0\nret r\nend\n`;
    case 'mr22':
      return `${GEN}\nfn mrb u32 u32 u32 -> u32\nh call gen p1 p2\nk xor p2 1540483477\nj call gen p1 k\na and h 65535\nb shr j 16\nm mul a b\nc lt p0 m\ns select c m p0\nret s\nend\nfn mr22 u32 -> u32\nr fold mrb ${n} 0 p0\nret r\nend\n`;
    case 'dot64k':
      return `${GEN}\nfn fill u32x${n} u32 u32 -> u32x${n}\nh call gen p1 p2\nv set p0 p1 h\nret v\nend\nfn dotb u32 u32 u32x${n} u32x${n} -> u32\na get p2 p1\nb get p3 p1\nm mul a b\ns add p0 m\nret s\nend\nfn dot64k u32 -> u32\nz arr ${zeros(n)}\nx fold fill ${n} z p0\nk xor p0 1540483477\ny fold fill ${n} z k\nr fold dotb ${n} 0 x y\nret r\nend\n`;
    case 'max64k':
      return `${GEN}\nfn fill u32x${n} u32 u32 -> u32x${n}\nh call gen p1 p2\nv set p0 p1 h\nret v\nend\nfn maxb u32 u32 u32x${n} -> u32\na get p2 p1\nc lt p0 a\ns select c a p0\nret s\nend\nfn max64k u32 -> u32\nz arr ${zeros(n)}\nx fold fill ${n} z p0\nr fold maxb ${n} 0 x\nret r\nend\n`;
    case 'hash64k':
      return `${GEN}\nfn mixb u32 u32 u32 -> u32\nk xor p2 p1\nh call gen p0 k\nret h\nend\nfn hfill u32x${n} u32 u32 -> u32x${n}\nr fold mixb 64 p1 p2\nv set p0 p1 r\nret v\nend\nfn hsumb u32 u32 u32x${n} -> u32\na get p2 p1\ns add p0 a\nret s\nend\nfn hash64k u32 -> u32\nz arr ${zeros(n)}\nx fold hfill ${n} z p0\nr fold hsumb ${n} 0 x\nret r\nend\n`;
  }
}

const FULL: Readonly<Record<K, number>> = {
  sum24: 1 << 24,
  xor24: 1 << 24,
  count20: 1 << 20,
  mr22: 1 << 22,
  dot64k: 65536,
  max64k: 65536,
  hash64k: 65536,
};

// ------------------------------------------------------------------ baselines (table-driven)

interface Lang {
  readonly id: string;
  readonly label: string;
  readonly file: string;
  readonly find: () => Toolchain | undefined;
  readonly program: (k: K) => string;
  readonly build?: (dir: string, t: Toolchain) => readonly (readonly [string, string[]])[];
  readonly run: (dir: string, t: Toolchain, calls: string) => readonly [string, string[]];
  readonly output?: 'stderr';
  /** One call per sample regardless of CALLS (interpreters). */
  readonly single?: boolean;
}

const C_GEN =
  'static inline uint32_t gen(uint32_t i, uint32_t s) { uint32_t b = (i * 2654435761u) ^ s; b ^= b >> 15; b *= 2246822519u; return b ^ (b >> 13); }';

const C_KERNELS: Readonly<Record<K, string>> = {
  sum24:
    'static uint32_t kernel(uint32_t s) { uint32_t acc = 0; for (uint32_t i = 0; i < (1u << 24); i++) acc += gen(i, s); return acc; }',
  xor24:
    'static uint32_t kernel(uint32_t s) { uint32_t acc = 0; for (uint32_t i = 0; i < (1u << 24); i++) acc ^= gen(i, s) * (i | 1u); return acc; }',
  count20:
    'static uint32_t kernel(uint32_t s) { uint32_t n = 0; for (uint32_t i = 0; i < (1u << 20); i++) n += (gen(i, s) & 1023u) < 100u; return n; }',
  mr22: 'static uint32_t kernel(uint32_t s) { uint32_t m = 0; for (uint32_t i = 0; i < (1u << 22); i++) { uint32_t v = (gen(i, s) & 0xffffu) * (gen(i, s ^ 0x5bd1e995u) >> 16); if (v > m) m = v; } return m; }',
  dot64k:
    'static uint32_t x_[65536], y_[65536];\nstatic uint32_t kernel(uint32_t s) { for (uint32_t i = 0; i < 65536u; i++) { x_[i] = gen(i, s); y_[i] = gen(i, s ^ 0x5bd1e995u); } uint32_t acc = 0; for (uint32_t i = 0; i < 65536u; i++) acc += x_[i] * y_[i]; return acc; }',
  max64k:
    'static uint32_t x_[65536];\nstatic uint32_t kernel(uint32_t s) { for (uint32_t i = 0; i < 65536u; i++) x_[i] = gen(i, s); uint32_t m = 0; for (uint32_t i = 0; i < 65536u; i++) if (x_[i] > m) m = x_[i]; return m; }',
  hash64k:
    'static uint32_t x_[65536];\nstatic uint32_t kernel(uint32_t s) { for (uint32_t i = 0; i < 65536u; i++) { uint32_t v = i; for (uint32_t j = 0; j < 64u; j++) v = gen(v, s ^ j); x_[i] = v; } uint32_t acc = 0; for (uint32_t i = 0; i < 65536u; i++) acc += x_[i]; return acc; }',
};

/** Hand-parallel C: what a careful programmer writes with OpenMP (threads + SIMD). */
const OMP_KERNELS: Readonly<Record<K, string>> = {
  sum24:
    'static uint32_t kernel(uint32_t s) { uint32_t acc = 0;\n#pragma omp parallel for simd reduction(+:acc)\n for (uint32_t i = 0; i < (1u << 24); i++) acc += gen(i, s); return acc; }',
  xor24:
    'static uint32_t kernel(uint32_t s) { uint32_t acc = 0;\n#pragma omp parallel for simd reduction(^:acc)\n for (uint32_t i = 0; i < (1u << 24); i++) acc ^= gen(i, s) * (i | 1u); return acc; }',
  count20:
    'static uint32_t kernel(uint32_t s) { uint32_t n = 0;\n#pragma omp parallel for simd reduction(+:n)\n for (uint32_t i = 0; i < (1u << 20); i++) n += (gen(i, s) & 1023u) < 100u; return n; }',
  mr22: 'static uint32_t kernel(uint32_t s) { uint32_t m = 0;\n#pragma omp parallel for simd reduction(max:m)\n for (uint32_t i = 0; i < (1u << 22); i++) { uint32_t v = (gen(i, s) & 0xffffu) * (gen(i, s ^ 0x5bd1e995u) >> 16); m = v > m ? v : m; } return m; }',
  dot64k:
    'static uint32_t x_[65536], y_[65536];\nstatic uint32_t kernel(uint32_t s) { uint32_t acc = 0;\n#pragma omp parallel\n {\n#pragma omp for simd\n for (uint32_t i = 0; i < 65536u; i++) { x_[i] = gen(i, s); y_[i] = gen(i, s ^ 0x5bd1e995u); }\n#pragma omp for simd reduction(+:acc)\n for (uint32_t i = 0; i < 65536u; i++) acc += x_[i] * y_[i];\n }\n return acc; }',
  max64k:
    'static uint32_t x_[65536];\nstatic uint32_t kernel(uint32_t s) { uint32_t m = 0;\n#pragma omp parallel\n {\n#pragma omp for simd\n for (uint32_t i = 0; i < 65536u; i++) x_[i] = gen(i, s);\n#pragma omp for simd reduction(max:m)\n for (uint32_t i = 0; i < 65536u; i++) m = x_[i] > m ? x_[i] : m;\n }\n return m; }',
  hash64k:
    'static uint32_t x_[65536];\nstatic uint32_t kernel(uint32_t s) { uint32_t acc = 0;\n#pragma omp parallel\n {\n#pragma omp for\n for (uint32_t i = 0; i < 65536u; i++) { uint32_t v = i; for (uint32_t j = 0; j < 64u; j++) v = gen(v, s ^ j); x_[i] = v; }\n#pragma omp for simd reduction(+:acc)\n for (uint32_t i = 0; i < 65536u; i++) acc += x_[i];\n }\n return acc; }',
};

/** Common C driver: `calls` kernel calls on xorshift seeds after one warm-up call. */
const cDriver = (call: string): string => `#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
static uint32_t rng(uint32_t *s) { uint32_t x = *s; x ^= x << 13; x ^= x >> 17; x ^= x << 5; return *s = x; }
volatile uint32_t a0_sink;
int main(int argc, char **argv) {
  long calls = argc > 1 ? atol(argv[1]) : 1;
  uint32_t s = 0x9e3779b9u, acc = 0;
  a0_sink = ${call.replace('SEED', '12345u')};
  struct timespec t0, t1;
  clock_gettime(CLOCK_MONOTONIC, &t0);
  for (long i = 0; i < calls; i++) { uint32_t a = rng(&s); acc ^= ${call.replace('SEED', 'a')}; }
  clock_gettime(CLOCK_MONOTONIC, &t1);
  printf("%.1f %u\\n", ((t1.tv_sec - t0.tv_sec) * 1e9 + (t1.tv_nsec - t0.tv_nsec)) / (double)calls, acc);
  return 0;
}
`;

const RUST_KERNELS: Readonly<Record<K, string>> = {
  sum24:
    'fn kernel(s: u32) -> u32 { (0..1u32 << 24).fold(0u32, |a, i| a.wrapping_add(gen(i, s))) }',
  xor24:
    'fn kernel(s: u32) -> u32 { (0..1u32 << 24).fold(0u32, |a, i| a ^ gen(i, s).wrapping_mul(i | 1)) }',
  count20:
    'fn kernel(s: u32) -> u32 { (0..1u32 << 20).filter(|&i| (gen(i, s) & 1023) < 100).count() as u32 }',
  mr22: 'fn kernel(s: u32) -> u32 { (0..1u32 << 22).map(|i| (gen(i, s) & 0xffff).wrapping_mul(gen(i, s ^ 0x5bd1e995) >> 16)).max().unwrap_or(0) }',
  dot64k:
    'fn kernel(s: u32) -> u32 { let x: Vec<u32> = (0..65536u32).map(|i| gen(i, s)).collect(); let y: Vec<u32> = (0..65536u32).map(|i| gen(i, s ^ 0x5bd1e995)).collect(); x.iter().zip(&y).fold(0u32, |a, (p, q)| a.wrapping_add(p.wrapping_mul(*q))) }',
  max64k:
    'fn kernel(s: u32) -> u32 { let x: Vec<u32> = (0..65536u32).map(|i| gen(i, s)).collect(); x.iter().copied().max().unwrap_or(0) }',
  hash64k:
    'fn kernel(s: u32) -> u32 { let x: Vec<u32> = (0..65536u32).map(|i| (0..64u32).fold(i, |v, j| gen(v, s ^ j))).collect(); x.iter().fold(0u32, |a, v| a.wrapping_add(*v)) }',
};

const ZIG_KERNELS: Readonly<Record<K, string>> = {
  sum24:
    'fn kernel(s: u32) u32 { var acc: u32 = 0; var i: u32 = 0; while (i < 1 << 24) : (i += 1) acc +%= gen(i, s); return acc; }',
  xor24:
    'fn kernel(s: u32) u32 { var acc: u32 = 0; var i: u32 = 0; while (i < 1 << 24) : (i += 1) acc ^= gen(i, s) *% (i | 1); return acc; }',
  count20:
    'fn kernel(s: u32) u32 { var n: u32 = 0; var i: u32 = 0; while (i < 1 << 20) : (i += 1) { if ((gen(i, s) & 1023) < 100) n += 1; } return n; }',
  mr22: 'fn kernel(s: u32) u32 { var m: u32 = 0; var i: u32 = 0; while (i < 1 << 22) : (i += 1) { const v = (gen(i, s) & 0xffff) *% (gen(i, s ^ 0x5bd1e995) >> 16); m = @max(m, v); } return m; }',
  dot64k:
    'var gx: [65536]u32 = undefined;\nvar gy: [65536]u32 = undefined;\nfn kernel(s: u32) u32 { for (&gx, &gy, 0..) |*x, *y, i| { x.* = gen(@intCast(i), s); y.* = gen(@intCast(i), s ^ 0x5bd1e995); } var acc: u32 = 0; for (gx, gy) |x, y| acc +%= x *% y; return acc; }',
  max64k:
    'var gx: [65536]u32 = undefined;\nfn kernel(s: u32) u32 { for (&gx, 0..) |*x, i| x.* = gen(@intCast(i), s); var m: u32 = 0; for (gx) |x| m = @max(m, x); return m; }',
  hash64k:
    'var gx: [65536]u32 = undefined;\nfn kernel(s: u32) u32 { for (&gx, 0..) |*x, i| { var v: u32 = @intCast(i); var j: u32 = 0; while (j < 64) : (j += 1) v = gen(v, s ^ j); x.* = v; } var acc: u32 = 0; for (gx) |x| acc +%= x; return acc; }',
};

const GO_KERNELS: Readonly<Record<K, string>> = {
  sum24:
    'func kernel(s uint32) uint32 { var acc uint32; for i := uint32(0); i < 1<<24; i++ { acc += gen(i, s) }; return acc }',
  xor24:
    'func kernel(s uint32) uint32 { var acc uint32; for i := uint32(0); i < 1<<24; i++ { acc ^= gen(i, s) * (i | 1) }; return acc }',
  count20:
    'func kernel(s uint32) uint32 { var n uint32; for i := uint32(0); i < 1<<20; i++ { if gen(i, s)&1023 < 100 { n++ } }; return n }',
  mr22: 'func kernel(s uint32) uint32 { var m uint32; for i := uint32(0); i < 1<<22; i++ { m = max(m, (gen(i, s)&0xffff)*(gen(i, s^0x5bd1e995)>>16)) }; return m }',
  dot64k:
    'func kernel(s uint32) uint32 { x := make([]uint32, 65536); y := make([]uint32, 65536); for i := range x { x[i] = gen(uint32(i), s); y[i] = gen(uint32(i), s^0x5bd1e995) }; var acc uint32; for i := range x { acc += x[i] * y[i] }; return acc }',
  max64k:
    'func kernel(s uint32) uint32 { x := make([]uint32, 65536); for i := range x { x[i] = gen(uint32(i), s) }; var m uint32; for _, v := range x { m = max(m, v) }; return m }',
  hash64k:
    'func kernel(s uint32) uint32 { x := make([]uint32, 65536); for i := range x { v := uint32(i); for j := uint32(0); j < 64; j++ { v = gen(v, s^j) }; x[i] = v }; var acc uint32; for _, v := range x { acc += v }; return acc }',
};

const JAVA_KERNELS: Readonly<Record<K, string>> = {
  sum24:
    'static int kernel(int s) { int acc = 0; for (int i = 0; i < (1 << 24); i++) acc += gen(i, s); return acc; }',
  xor24:
    'static int kernel(int s) { int acc = 0; for (int i = 0; i < (1 << 24); i++) acc ^= gen(i, s) * (i | 1); return acc; }',
  count20:
    'static int kernel(int s) { int n = 0; for (int i = 0; i < (1 << 20); i++) if ((gen(i, s) & 1023) < 100) n++; return n; }',
  mr22: 'static int kernel(int s) { int m = 0; for (int i = 0; i < (1 << 22); i++) { int v = (gen(i, s) & 0xffff) * (gen(i, s ^ 0x5bd1e995) >>> 16); if (Integer.compareUnsigned(v, m) > 0) m = v; } return m; }',
  dot64k:
    'static int kernel(int s) { int[] x = new int[65536], y = new int[65536]; for (int i = 0; i < 65536; i++) { x[i] = gen(i, s); y[i] = gen(i, s ^ 0x5bd1e995); } int acc = 0; for (int i = 0; i < 65536; i++) acc += x[i] * y[i]; return acc; }',
  max64k:
    'static int kernel(int s) { int[] x = new int[65536]; for (int i = 0; i < 65536; i++) x[i] = gen(i, s); int m = 0; for (int v : x) if (Integer.compareUnsigned(v, m) > 0) m = v; return m; }',
  hash64k:
    'static int kernel(int s) { int[] x = new int[65536]; for (int i = 0; i < 65536; i++) { int v = i; for (int j = 0; j < 64; j++) v = gen(v, s ^ j); x[i] = v; } int acc = 0; for (int v : x) acc += v; return acc; }',
};

const PY_KERNELS: Readonly<Record<K, string>> = {
  sum24:
    'def kernel(s):\n    acc = 0\n    for i in range(1 << 24):\n        acc += gen(i, s)\n    return acc & M',
  xor24:
    'def kernel(s):\n    acc = 0\n    for i in range(1 << 24):\n        acc ^= (gen(i, s) * (i | 1)) & M\n    return acc',
  count20: 'def kernel(s):\n    return sum(1 for i in range(1 << 20) if (gen(i, s) & 1023) < 100)',
  mr22: 'def kernel(s):\n    t = s ^ 0x5bd1e995\n    return max((gen(i, s) & 0xffff) * (gen(i, t) >> 16) for i in range(1 << 22))',
  dot64k:
    'def kernel(s):\n    t = s ^ 0x5bd1e995\n    x = [gen(i, s) for i in range(65536)]\n    y = [gen(i, t) for i in range(65536)]\n    return sum(p * q for p, q in zip(x, y)) & M',
  max64k: 'def kernel(s):\n    x = [gen(i, s) for i in range(65536)]\n    return max(x)',
  hash64k:
    'def kernel(s):\n    x = []\n    for i in range(65536):\n        v = i\n        for j in range(64):\n            v = gen(v, s ^ j)\n        x.append(v)\n    return sum(x) & M',
};

const JS_KERNELS: Readonly<Record<K, string>> = {
  sum24:
    'function kernel(s) { let acc = 0; for (let i = 0; i < 1 << 24; i++) acc = (acc + gen(i, s)) >>> 0; return acc; }',
  xor24:
    'function kernel(s) { let acc = 0; for (let i = 0; i < 1 << 24; i++) acc = (acc ^ Math.imul(gen(i, s), i | 1)) >>> 0; return acc; }',
  count20:
    'function kernel(s) { let n = 0; for (let i = 0; i < 1 << 20; i++) if ((gen(i, s) & 1023) < 100) n++; return n; }',
  mr22: 'function kernel(s) { const t = (s ^ 0x5bd1e995) >>> 0; let m = 0; for (let i = 0; i < 1 << 22; i++) { const v = Math.imul(gen(i, s) & 0xffff, gen(i, t) >>> 16) >>> 0; if (v > m) m = v; } return m; }',
  dot64k:
    'const x_ = new Uint32Array(65536), y_ = new Uint32Array(65536);\nfunction kernel(s) { const t = (s ^ 0x5bd1e995) >>> 0; for (let i = 0; i < 65536; i++) { x_[i] = gen(i, s); y_[i] = gen(i, t); } let acc = 0; for (let i = 0; i < 65536; i++) acc = (acc + Math.imul(x_[i], y_[i])) >>> 0; return acc; }',
  max64k:
    'const x_ = new Uint32Array(65536);\nfunction kernel(s) { for (let i = 0; i < 65536; i++) x_[i] = gen(i, s); let m = 0; for (let i = 0; i < 65536; i++) if (x_[i] > m) m = x_[i]; return m; }',
  hash64k:
    'const x_ = new Uint32Array(65536);\nfunction kernel(s) { for (let i = 0; i < 65536; i++) { let v = i; for (let j = 0; j < 64; j++) v = gen(v, (s ^ j) >>> 0); x_[i] = v; } let acc = 0; for (let i = 0; i < 65536; i++) acc = (acc + x_[i]) >>> 0; return acc; }',
};

const LANGS: readonly Lang[] = [
  {
    id: 'rust',
    label: 'Rust (opt-level=3, target-cpu=native)',
    file: 'bench.rs',
    find: () => {
      const r = `${process.env.HOME ?? ''}/.cargo/bin/rustc`;
      const v = runTool(r, ['--version'], { timeoutMs: 30_000 });
      return v.ok ? { version: v.stdout.trim(), bin: { main: r } } : undefined;
    },
    program: (
      k,
    ) => `#[inline] fn gen(i: u32, s: u32) -> u32 { let mut b = i.wrapping_mul(2654435761) ^ s; b ^= b >> 15; b = b.wrapping_mul(2246822519); b ^ (b >> 13) }
${RUST_KERNELS[k]}
fn rng(s: &mut u32) -> u32 { let mut x = *s; x ^= x << 13; x ^= x >> 17; x ^= x << 5; *s = x; x }
fn main() {
  let calls: u64 = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(1);
  std::hint::black_box(kernel(std::hint::black_box(12345)));
  let mut s: u32 = 0x9e3779b9; let mut acc: u32 = 0;
  let t0 = std::time::Instant::now();
  for _ in 0..calls { let a = rng(&mut s); acc ^= kernel(a); }
  println!("{:.1} {}", t0.elapsed().as_nanos() as f64 / calls as f64, acc);
}
`,
    build: (dir, t) => [
      [
        t.bin.main as string,
        [
          '-C',
          'opt-level=3',
          '-C',
          'target-cpu=native',
          '-o',
          join(dir, 'bench'),
          join(dir, 'bench.rs'),
        ],
      ],
    ],
    run: (dir, _t, n) => [join(dir, 'bench'), [n]],
  },
  {
    id: 'zig',
    label: 'Zig (ReleaseFast)',
    file: 'bench.zig',
    find: single('zig', 'A0_ZIG', ['version']),
    output: 'stderr',
    program: (k) => `const std = @import("std");
inline fn gen(i: u32, s: u32) u32 { var b = (i *% 2654435761) ^ s; b ^= b >> 15; b *%= 2246822519; return b ^ (b >> 13); }
${ZIG_KERNELS[k]}
inline fn rng(s: *u32) u32 { var x = s.*; x ^= x << 13; x ^= x >> 17; x ^= x << 5; s.* = x; return x; }
fn nowNs() f64 { var ts: std.c.timespec = undefined; _ = std.c.clock_gettime(.MONOTONIC, &ts); return @as(f64, @floatFromInt(ts.sec)) * 1e9 + @as(f64, @floatFromInt(ts.nsec)); }
pub fn main(init: std.process.Init.Minimal) void {
    var calls: u64 = 1;
    const argv = init.args.vector;
    if (argv.len > 1) calls = std.fmt.parseInt(u64, std.mem.span(argv[1]), 10) catch 1;
    std.mem.doNotOptimizeAway(kernel(12345));
    var s: u32 = 0x9e3779b9;
    var acc: u32 = 0;
    const t0 = nowNs();
    var i: u64 = 0;
    while (i < calls) : (i += 1) { const a = rng(&s); acc ^= kernel(a); }
    const ns = (nowNs() - t0) / @as(f64, @floatFromInt(calls));
    std.debug.print("{d:.1} {d}\\n", .{ ns, acc });
}
`,
    build: (dir, t) => [
      [
        t.bin.main as string,
        [
          'build-exe',
          join(dir, 'bench.zig'),
          '-O',
          'ReleaseFast',
          '-lc',
          `-femit-bin=${join(dir, 'bench')}`,
        ],
      ],
    ],
    run: (dir, _t, n) => [join(dir, 'bench'), [n]],
  },
  {
    id: 'go',
    label: 'Go',
    file: 'bench.go',
    find: single('go', 'A0_GO', ['version']),
    program: (k) => `package main

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

func gen(i, s uint32) uint32 { b := (i * 2654435761) ^ s; b ^= b >> 15; b *= 2246822519; return b ^ (b >> 13) }

${GO_KERNELS[k]}

var sink uint32

func main() {
	calls := int64(1)
	if len(os.Args) > 1 {
		if v, err := strconv.ParseInt(os.Args[1], 10, 64); err == nil {
			calls = v
		}
	}
	sink = kernel(12345)
	var s uint32 = 0x9e3779b9
	var acc uint32
	t0 := time.Now()
	for i := int64(0); i < calls; i++ {
		s ^= s << 13; s ^= s >> 17; s ^= s << 5
		acc ^= kernel(s)
	}
	fmt.Printf("%.1f %d\\n", float64(time.Since(t0).Nanoseconds())/float64(calls), acc)
}
`,
    build: (dir, t) => [
      [t.bin.main as string, ['build', '-o', join(dir, 'bench'), join(dir, 'bench.go')]],
    ],
    run: (dir, _t, n) => [join(dir, 'bench'), [n]],
  },
  {
    id: 'java',
    label: 'Java',
    file: 'Bench.java',
    find: jvm,
    program: (k) => `public final class Bench {
  static int gen(int i, int s) { int b = (i * 0x9E3779B1) ^ s; b ^= b >>> 15; b *= 0x85EBCA77; return b ^ (b >>> 13); }
  ${JAVA_KERNELS[k]}
  static int pass(long calls) { int s = 0x9e3779b9, acc = 0; for (long i = 0; i < calls; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; acc ^= kernel(s); } return acc; }
  public static void main(String[] a) {
    long calls = a.length > 0 ? Long.parseLong(a[0]) : 1;
    pass(calls);
    long t0 = System.nanoTime();
    int acc = pass(calls);
    double ns = (System.nanoTime() - t0) / (double) calls;
    System.out.printf(java.util.Locale.ROOT, "%.1f %s%n", ns, Integer.toUnsignedString(acc));
  }
}
`,
    build: (dir, t) => [[t.bin.javac as string, ['-d', dir, join(dir, 'Bench.java')]]],
    run: (dir, t, n) => [t.bin.java as string, ['-cp', dir, 'Bench', n]],
  },
  {
    id: 'python',
    label: 'Python',
    file: 'bench.py',
    single: true,
    find: single('python3', 'A0_PYTHON', ['--version']),
    program: (k) => `import sys, time
M = 0xFFFFFFFF
def gen(i, s):
    b = ((i * 2654435761) & M) ^ s
    b ^= b >> 15
    b = (b * 2246822519) & M
    return b ^ (b >> 13)
${PY_KERNELS[k]}
def main():
    calls = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    s = 0x9e3779b9
    acc = 0
    t0 = time.perf_counter()
    for _ in range(calls):
        s ^= (s << 13) & M; s ^= s >> 17; s ^= (s << 5) & M
        acc ^= kernel(s)
    print(f"{(time.perf_counter() - t0) * 1e9 / calls:.1f} {acc}")
main()
`,
    run: (dir, t, n) => [t.bin.main as string, [join(dir, 'bench.py'), n]],
  },
  {
    id: 'js',
    label: 'JavaScript (Node)',
    file: 'bench.mjs',
    find: () => ({ version: `node ${process.version}`, bin: { main: process.execPath } }),
    program: (
      k,
    ) => `function gen(i, s) { let b = (Math.imul(i, 2654435761) ^ s) >>> 0; b = (b ^ (b >>> 15)) >>> 0; b = Math.imul(b, 2246822519) >>> 0; return (b ^ (b >>> 13)) >>> 0; }
${JS_KERNELS[k]}
function pass(calls) { let s = 0x9e3779b9, acc = 0; for (let i = 0; i < calls; i++) { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; acc = (acc ^ kernel(s)) >>> 0; } return acc; }
const calls = Number(process.argv[2] ?? 1);
pass(calls);
const t0 = process.hrtime.bigint();
const acc = pass(calls);
console.log(\`\${(Number(process.hrtime.bigint() - t0) / calls).toFixed(1)} \${acc}\`);
`,
    run: (dir, t, n) => [t.bin.main as string, [join(dir, 'bench.mjs'), n]],
  },
];

// ------------------------------------------------------------------ harness

const CFLAGS = ['-std=c11', '-O3', '-mcpu=native'];

interface Cli {
  readonly samples: number;
  readonly kernels: ReadonlySet<string> | null;
  readonly wait: boolean;
  readonly out: string;
}

function parseCli(argv: readonly string[]): Cli {
  let samples = 7;
  let kernels: Set<string> | null = null;
  let wait = true;
  let out = join('results', 'parallel.json');
  for (const a of argv) {
    const [key, value = ''] = a.split('=', 2) as [string, string?];
    if (key === '--samples') samples = Math.max(1, Number(value) || 7);
    else if (key === '--kernels') kernels = new Set(value.split(',').filter((v) => v.length > 0));
    else if (key === '--no-wait') wait = false;
    else if (key === '--out') out = value;
    else throw new Error(`unknown option ${a}`);
  }
  return { samples, kernels, wait, out };
}

const median = (a: readonly number[]): number => [...a].sort((p, q) => p - q)[a.length >> 1] ?? 0;

function readLine(text: string): { ns: number; checksum: string } {
  const line = text
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[0-9.eE+-]+ [0-9]+$/.test(l))
    .pop();
  if (line === undefined) throw new Error(`no "ns checksum" line: ${text.slice(-300)}`);
  const [ns, checksum] = line.split(' ') as [string, string];
  return { ns: Number(ns), checksum };
}

interface Row {
  readonly id: string;
  readonly cmd: readonly [string, string[]];
  readonly stderr: boolean;
  readonly calls: number;
  readonly ns: number[];
  checksum: string;
}

/** A0 C build for a mode; GPU mode is compiled as Objective-C with ARC and linked with Metal. */
async function buildA0(
  clang: string,
  dir: string,
  name: string,
  program: TypedProgram,
  fnName: string,
  mode: ParallelMode,
  force: boolean,
  driver: string,
): Promise<string> {
  const cParallel = parallelC({ mode, force });
  const text = compile(program, 'c', cParallel === undefined ? {} : { cParallel }).text;
  const src = join(dir, `${name}.c`);
  const drv = join(dir, `${name}_drv.c`);
  const exe = join(dir, name);
  const obj = join(dir, `${name}.o`);
  await writeFile(src, text, 'utf8');
  await writeFile(drv, `#include <stdint.h>\nuint32_t a0_${fnName}(uint32_t);\n${driver}`, 'utf8');
  if (mode === 'gpu') {
    runOk(
      runTool(
        clang,
        ['-x', 'objective-c', '-fobjc-arc', ...CFLAGS.slice(1), '-c', '-o', obj, src],
        {
          timeoutMs: 300_000,
        },
      ),
      `${name}: clang (objective-c)`,
    );
    runOk(
      runTool(
        clang,
        [...CFLAGS, '-o', exe, drv, obj, '-framework', 'Metal', '-framework', 'Foundation'],
        { timeoutMs: 300_000 },
      ),
      `${name}: link`,
    );
  } else {
    runOk(
      runTool(clang, [...CFLAGS, '-Wall', '-Wextra', '-o', exe, drv, src], { timeoutMs: 300_000 }),
      `${name}: clang`,
    );
  }
  return exe;
}

function runOk<T extends { ok: boolean; stderr: string; stdout: string }>(r: T, what: string): T {
  if (!r.ok) throw new Error(`${what} failed: ${(r.stderr || r.stdout).slice(-1500)}`);
  return r;
}

/** Small-size exactness: every A0 build against the reference interpreter. */
async function verifySmall(clang: string, gpu: boolean): Promise<Record<string, unknown>> {
  const seeds = [0, 1, 0x9e3779b9, 0xffffffff, 12345];
  const out: Record<string, unknown> = {};
  await withTempDir(async (dir) => {
    for (const k of KERNELS) {
      const n = k === 'dot64k' || k === 'max64k' || k === 'hash64k' ? 67 : 4099;
      const program = parseAndValidate(a0Source(k, n));
      const fn = program.byName.get(k);
      if (fn === undefined) throw new Error(k);
      const want = seeds.map((s) => String(run(fn, [s >>> 0], { fuel: 1e9 })));
      const driver = `#include <stdio.h>\nint main(void) { const uint32_t s[] = { ${seeds.map((s) => `${s >>> 0}u`).join(', ')} }; for (unsigned i = 0; i < ${seeds.length}u; i++) printf("%u\\n", a0_${k}(s[i])); return 0; }\n`;
      const builds: [string, ParallelMode, boolean][] = [
        ['off', 'off', false],
        ['threads', 'auto', true],
        ...(gpu ? ([['gpu', 'gpu', true]] as [string, ParallelMode, boolean][]) : []),
      ];
      const row: Record<string, string> = {};
      for (const [label, mode, force] of builds) {
        const exe = await buildA0(clang, dir, `${k}_${label}`, program, k, mode, force, driver);
        const r = runOk(
          runTool(exe, [], { timeoutMs: 120_000, env: { ...process.env, A0_GPU_LOG: '1' } }),
          `${k}_${label}`,
        );
        // Forced GPU builds must really dispatch (no silent fallback to threads).
        if (label === 'gpu' && (!r.stderr.includes('a0gpu ran') || r.stderr.includes('fallback')))
          throw new Error(`${k} gpu: dispatch did not run: ${r.stderr.slice(0, 300)}`);
        const got = r.stdout.trim().split('\n');
        const ok = got.length === want.length && got.every((g, i) => g === want[i]);
        if (!ok)
          throw new Error(
            `${k} ${label}: interpreter ${want.join(',')} but C ${got.join(',')} (n=${n})`,
          );
        row[label] = 'exact';
      }
      out[k] = { trips: n, seeds: seeds.length, ...row };
      process.stderr.write(`verify ${k} n=${n}: ${Object.keys(row).join(', ')} exact\n`);
    }
  });
  return out;
}

async function waitForQuiet(wait: boolean): Promise<Record<string, unknown>> {
  const start = loadavg();
  const t0 = Date.now();
  if (wait) {
    while ((loadavg()[0] as number) >= 6 && Date.now() - t0 < 15 * 60_000) {
      process.stderr.write(`load ${(loadavg()[0] as number).toFixed(1)}; waiting for < 6\n`);
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }
  const now = loadavg();
  return {
    atStart: start,
    atTimingStart: now,
    waitedSeconds: Math.round((Date.now() - t0) / 1000),
    quiet: (now[0] as number) < 6,
  };
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  const clang = findClang().path;
  if (clang === undefined) throw new Error('clang is required');
  const gpu = process.platform === 'darwin';
  const omp = '/opt/homebrew/opt/libomp';
  const verification = await verifySmall(clang, gpu);
  const tools = LANGS.map((l) => ({ lang: l, tool: l.find() }));
  const report: Record<string, unknown> = {};
  const plans: Record<string, unknown> = {};
  const load = await waitForQuiet(cli.wait);
  await withTempDir(async (root) => {
    for (const k of KERNELS) {
      if (cli.kernels !== null && !cli.kernels.has(k)) continue;
      const dir = join(root, k);
      await mkdir(dir, { recursive: true });
      const program = parseAndValidate(a0Source(k, FULL[k]));
      plans[k] = { auto: planProgram(program, 'auto'), gpu: planProgram(program, 'gpu') };
      const calls = CALLS[k];
      const driver = cDriver(`a0_${k}(SEED)`);
      const rows: Row[] = [];
      const add = (id: string, exe: string, stderr = false, n = calls): void => {
        rows.push({ id, cmd: [exe, [String(n)]], stderr, calls: n, ns: [], checksum: '' });
      };
      add('a0_serial', await buildA0(clang, dir, 'a0_serial', program, k, 'off', false, driver));
      add('a0_auto', await buildA0(clang, dir, 'a0_auto', program, k, 'auto', false, driver));
      add('a0_threads', await buildA0(clang, dir, 'a0_threads', program, k, 'auto', true, driver));
      const gpuPlan = planProgram(program, 'gpu').some((p) => p.strategy === 'gpu');
      if (gpu && gpuPlan)
        add('a0_gpu', await buildA0(clang, dir, 'a0_gpu', program, k, 'gpu', false, driver));
      const hand = async (name: string, body: string, extra: string[]): Promise<string> => {
        const src = join(dir, `${name}.c`);
        const exe = join(dir, name);
        await writeFile(
          src,
          `#include <stdint.h>\n${C_GEN}\n${body}\n${cDriver('kernel(SEED)')}`,
          'utf8',
        );
        runOk(runTool(clang, [...CFLAGS, ...extra, '-o', exe, src], { timeoutMs: 300_000 }), name);
        return exe;
      };
      add('c', await hand('c', C_KERNELS[k], []));
      add(
        'c_openmp',
        await hand('c_openmp', OMP_KERNELS[k], [
          '-Xpreprocessor',
          '-fopenmp',
          `-I${omp}/include`,
          `-L${omp}/lib`,
          '-lomp',
        ]),
      );
      const skipped: Record<string, string> = {};
      for (const { lang, tool } of tools) {
        if (tool === undefined) {
          skipped[lang.id] = 'skipped-no-toolchain';
          continue;
        }
        const ldir = join(dir, lang.id);
        await mkdir(ldir, { recursive: true });
        await writeFile(join(ldir, lang.file), lang.program(k), 'utf8');
        let ok = true;
        for (const [cmd, args] of lang.build?.(ldir, tool) ?? []) {
          const r = runTool(cmd, args, { cwd: ldir, timeoutMs: 600_000 });
          if (!r.ok) {
            skipped[lang.id] = `skipped-build-failed: ${(r.stderr || r.stdout).slice(-600)}`;
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        const n = lang.single === true ? 1 : calls;
        const [cmd, args] = lang.run(ldir, tool, String(n));
        rows.push({
          id: lang.id,
          cmd: [cmd, args],
          stderr: lang.output === 'stderr',
          calls: n,
          ns: [],
          checksum: '',
        });
      }
      // Checksums: every row at its own call count must equal the A0 serial result at that count.
      const expected = new Map<number, string>();
      const serial = rows[0] as Row;
      const check = (r: Row): string => {
        const out = runTool(r.cmd[0], r.cmd[1], { timeoutMs: 900_000 });
        if (!out.ok) throw new Error(`${r.id}/${k}: ${out.stderr.slice(-500)}`);
        return readLine(r.stderr ? out.stderr : out.stdout).checksum;
      };
      const want = (n: number): string => {
        let v = expected.get(n);
        if (v === undefined) {
          const r = runTool(serial.cmd[0], [String(n)], { timeoutMs: 900_000 });
          v = readLine(r.stdout).checksum;
          expected.set(n, v);
        }
        return v;
      };
      const verified: Row[] = [];
      for (const r of rows) {
        const got = check(r);
        if (got !== want(r.calls)) {
          skipped[r.id] = `skipped-checksum-mismatch: expected ${want(r.calls)} got ${got}`;
          process.stderr.write(`${k}/${r.id}: checksum mismatch\n`);
          continue;
        }
        r.checksum = got;
        verified.push(r);
      }
      // Evidence that the GPU row really dispatches at full size (1 call + the warm-up call).
      const gpuRow = verified.find((r) => r.id === 'a0_gpu');
      const gpuLog =
        gpuRow === undefined
          ? undefined
          : runTool(gpuRow.cmd[0], ['1'], {
              timeoutMs: 900_000,
              env: { ...process.env, A0_GPU_LOG: '1' },
            }).stderr;
      const gpuDispatches =
        gpuLog === undefined
          ? undefined
          : {
              ran: gpuLog.split('a0gpu ran').length - 1,
              fallback: gpuLog.split('a0gpu fallback').length - 1,
            };
      for (let i = 0; i < cli.samples; i += 1) {
        for (const r of verified) {
          const out = runTool(r.cmd[0], r.cmd[1], { timeoutMs: 900_000 });
          const got = readLine(r.stderr ? out.stderr : out.stdout);
          if (got.checksum !== r.checksum) throw new Error(`${r.id}/${k}: checksum changed`);
          r.ns.push(got.ns);
        }
      }
      const med: Record<string, number> = {};
      for (const r of verified) med[r.id] = median(r.ns);
      const a0Best = Math.min(
        ...['a0_auto', 'a0_gpu']
          .filter((id) => med[id] !== undefined)
          .map((id) => med[id] as number),
      );
      const ratios: Record<string, number> = {};
      for (const [id, ns] of Object.entries(med)) ratios[id] = ns / (med.a0_auto as number);
      report[k] = {
        trips: FULL[k],
        callsPerSample: calls,
        medianNsPerCall: med,
        samples: Object.fromEntries(verified.map((r) => [r.id, r.ns])),
        baselineOverA0Auto: ratios,
        baselineOverA0Best: Object.fromEntries(
          Object.entries(med).map(([id, ns]) => [id, ns / a0Best]),
        ),
        skipped,
        ...(gpuDispatches === undefined ? {} : { gpuDispatches }),
      };
      process.stdout.write(
        `${k.padEnd(8)} ${Object.entries(med)
          .map(([id, ns]) => `${id} ${(ns / 1000).toFixed(1)}us`)
          .join('  ')}\n`,
      );
    }
  });
  const result = {
    generatedAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    cpus: (await import('node:os')).cpus().length,
    clang: runTool(clang, ['--version']).stdout.split('\n')[0],
    flags: {
      a0AndC: CFLAGS.join(' '),
      a0Gpu: `-x objective-c -fobjc-arc ${CFLAGS.slice(1).join(' ')} -framework Metal`,
      openmp: `${CFLAGS.join(' ')} -Xpreprocessor -fopenmp (libomp)`,
      rust: '-C opt-level=3 -C target-cpu=native',
      zig: '-O ReleaseFast',
    },
    toolchains: Object.fromEntries(tools.map(({ lang, tool }) => [lang.id, tool?.version ?? null])),
    samples: cli.samples,
    load: { ...load, atEnd: loadavg() },
    verification,
    plans,
    meaning:
      'ns per kernel call (median of interleaved samples; each sample runs callsPerSample calls after one warm-up call; Python one call). a0_serial: A0 C with parallel folds off (Clang vectorizes the loop: the SIMD path). a0_auto: the cost model (src/parallel.ts; persistent pool, static line-aligned chunks). a0_threads: threads forced on every recognized fold. gpuDispatches: A0_GPU_LOG count for one a0_gpu run (warm-up + 1 call). a0_gpu: GPU mode (Metal, Objective-C build) where the cost model picks the GPU. c: idiomatic single-threaded C; c_openmp: hand-parallel C (OpenMP parallel for simd reduction). baselineOverA0Auto = row / a0_auto (above 1: A0 faster). Every row checksum-verified against A0 serial; small sizes verified against the reference interpreter.',
    kernels: report,
  };
  await mkdir(join(cli.out, '..'), { recursive: true });
  await writeFile(cli.out, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
