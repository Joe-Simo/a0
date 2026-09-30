/**
 * Baseline language table for tools/exec-bench.ts. Every language is one data entry: a
 * hand-written kernel per benchmark kernel (identical u32 semantics), a program template
 * that wraps the kernel in the common driver (xorshift32 input generator, xor
 * accumulator, "ns-per-call checksum" on one output line), a toolchain finder, and the
 * build and run commands. The harness verifies the checksum of every kernel against the
 * A0 result before timing it; a mismatch is recorded as a skipped row, never as a number.
 *
 * Adding a language is adding one entry to LANGUAGES.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { findJava, findJavac, runTool } from '../src/toolchain.js';

export const KERNEL_NAMES = [
  'affine',
  'rotl',
  'clamp',
  'mix',
  'ident',
  'noop',
  'chain3',
  'branchy',
  'arrfill',
  'loop64',
  'arrfill4k',
  'dot1k',
  'prefix1k',
  'hist256',
  'mat4',
  'fnv4k',
  'xs4k',
  'minmax1k',
  'filter2',
] as const;
export type KernelName = (typeof KERNEL_NAMES)[number];

export interface KernelSpec {
  readonly name: KernelName;
  readonly arity: number;
}

/** Iterations per sample for the native C path; the tiers below divide it. */
export const ITER = 20_000_000;
/** Iteration tiers by execution model, so each sample runs for a comparable wall time. */
export const TIER = {
  native: ITER,
  jit: ITER / 4,
  vm: ITER / 20,
  interpreted: ITER / 200,
  slow: ITER / 2000,
} as const;

export type Cmd = readonly [string, readonly string[]];
export type Family = 'compiled-native' | 'jit' | 'vm' | 'interpreted';

export interface Toolchain {
  /** Toolchain name and version as reported by the tool (first useful line). */
  readonly version: string;
  readonly bin: Readonly<Record<string, string>>;
}

export interface Language {
  readonly id: string;
  readonly label: string;
  readonly family: Family;
  /** Which startup table the process-launch latency is reported under. */
  readonly startupGroup: 'compiled' | 'interpreters';
  readonly iterations: number;
  /** Source file name written into the per-kernel build directory. */
  readonly file: string;
  readonly find: () => Toolchain | undefined;
  /** A kernel with no source in this language is reported as skipped-no-source. */
  readonly kernels: Readonly<Partial<Record<KernelName, string>>>;
  /** Full program: the kernel source wrapped in this language's driver. */
  readonly program: (k: KernelSpec, src: string) => string;
  /** Extra files written next to the source (project files). */
  readonly extraFiles?: (dir: string, t: Toolchain) => Readonly<Record<string, string>>;
  readonly build?: (dir: string, t: Toolchain) => readonly Cmd[];
  /**
   * Static check without running, for a language with no build step, using the toolchain's own
   * checker (tools/lang-axes.ts times it per edit). Absent when the toolchain has none.
   */
  readonly check?: (dir: string, t: Toolchain) => readonly Cmd[];
  /** Command that runs one sample of `iters` iterations (a decimal string). */
  readonly run: (dir: string, t: Toolchain, iters: string) => Cmd;
  readonly env?: (t: Toolchain) => Readonly<Record<string, string>>;
  /** Stream carrying the "ns checksum" line (default stdout). */
  readonly output?: 'stderr';
  /** Timer note when it is not a monotonic wall clock. */
  readonly timer?: string;
}

export const BREW = ['/opt/homebrew/bin', '/opt/homebrew/opt', '/usr/local/bin'];

export function onPath(name: string): string | undefined {
  const r = spawnSync('/usr/bin/which', [name], { encoding: 'utf8', shell: false });
  const p = r.stdout.trim();
  return r.status === 0 && p.length > 0 ? p : undefined;
}

/** First existing candidate: A0_<ENV> override, explicit extra paths, then PATH. */
export function locate(
  name: string,
  env: string,
  extra: readonly string[] = [],
): string | undefined {
  const fromEnv = process.env[env];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  for (const p of extra) if (existsSync(p)) return p;
  return onPath(name);
}

export function versionLine(path: string, args: readonly string[], pick = /\S/): string {
  const r = runTool(path, args, { timeoutMs: 30_000 });
  const line = `${r.stdout}\n${r.stderr}`
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0 && pick.test(l));
  return line ?? 'unknown version';
}

export interface ToolSpec {
  readonly name: string;
  readonly env: string;
  readonly extra?: readonly string[];
}

/** A toolchain made of one or more executables; undefined when any is missing. */
export function toolchain(
  bins: Readonly<Record<string, ToolSpec>>,
  version: { readonly of: string; readonly args: readonly string[]; readonly pick?: RegExp },
): Toolchain | undefined {
  const found: Record<string, string> = {};
  for (const [key, spec] of Object.entries(bins)) {
    const p = locate(spec.name, spec.env, spec.extra);
    if (p === undefined) return undefined;
    found[key] = p;
  }
  const main = found[version.of];
  if (main === undefined) return undefined;
  return { version: versionLine(main, version.args, version.pick), bin: found };
}

export function single(
  name: string,
  env: string,
  versionArgs: readonly string[],
  opts: { readonly extra?: readonly string[]; readonly pick?: RegExp } = {},
): () => Toolchain | undefined {
  const spec: ToolSpec =
    opts.extra === undefined ? { name, env } : { name, env, extra: opts.extra };
  return () =>
    toolchain(
      { main: spec },
      opts.pick === undefined
        ? { of: 'main', args: versionArgs }
        : { of: 'main', args: versionArgs, pick: opts.pick },
    );
}

export function jvm(): Toolchain | undefined {
  const javac = findJavac();
  const java = findJava();
  if (javac.path === undefined || java.path === undefined) return undefined;
  return {
    version: `${javac.version ?? 'javac ?'} / ${java.version ?? 'java ?'}`,
    bin: { javac: javac.path, java: java.path },
  };
}

export function javaOnly(): Toolchain | undefined {
  const java = findJava();
  if (java.path === undefined) return undefined;
  return { version: java.version ?? 'java', bin: { java: java.path } };
}

/** Argument names a0..a{n-1} joined by the separator. */
export const args = (k: KernelSpec, sep = ', ', prefix = ''): string =>
  Array.from({ length: k.arity }, (_, i) => `${prefix}a${i}`).join(sep);
/** One statement per argument: `f(i)` for i in 0..arity. */
export const each = (k: KernelSpec, f: (i: number) => string, sep = ' '): string =>
  Array.from({ length: k.arity }, (_, i) => f(i)).join(sep);

export const M = '0xFFFFFFFF';

export const LANGUAGES: readonly Language[] = [
  // ---------------------------------------------------------------- TypeScript (tsc -> Node)
  {
    id: 'typescript',
    label: 'TypeScript',
    family: 'jit',
    startupGroup: 'interpreters',
    iterations: TIER.jit,
    file: 'bench.ts',
    find: () => {
      const tsc = join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc');
      if (!existsSync(tsc)) return undefined;
      return {
        version: `${versionLine(process.execPath, [tsc, '--version'])} / node ${process.version}`,
        bin: { node: process.execPath, tsc },
      };
    },
    kernels: {
      affine:
        'function affine(x: number, s: number, o: number): number { return (Math.imul(x, s) + o) >>> 0; }',
      rotl: 'function rotl(x: number, n: number): number { return ((x << (n & 31)) | (x >>> ((32 - n) & 31))) >>> 0; }',
      clamp:
        'function clamp(x: number, lo: number, hi: number): number { const t = hi < x ? hi : x; return t < lo ? lo : t; }',
      mix: 'function mix(x: number, y: number): number { const a = (x ^ y) >>> 0; const d = ((a << 13) | (a >>> 19)) >>> 0; const f = (Math.imul(d, 2654435761) + x) >>> 0; return (f ^ (f >>> 16)) >>> 0; }',
      ident: 'function ident(x: number): number { return x; }',
      noop: 'function noop(x: number): number { return x; }',
      chain3:
        'function inc1(x: number): number { return (x + 1) >>> 0; }\nfunction dbl(x: number): number { return (x + x) >>> 0; }\nfunction chain3(x: number, y: number): number { return (inc1(dbl(inc1(x))) + y) >>> 0; }',
      branchy:
        'function branchy(x: number, y: number): number { const m = x < y ? (y - x) >>> 0 : (x - y) >>> 0; const z = x === y ? 0 : m; return (z & 1) === 1 ? z : x; }',
      arrfill:
        'function arrfill(x: number, y: number): number { const a = new Uint32Array(8); for (let i = 0; i < 8; i++) a[i] = (i + x) >>> 0; return ((a[y % 8] as number) + (a[3] as number)) >>> 0; }',
      loop64:
        'function loop64(s: number, k: number): number { for (let i = 0; i < 64; i++) { const b = Math.imul((s ^ k) >>> 0, 2654435761) >>> 0; s = ((b ^ (b >>> 15)) + i) >>> 0; } return s; }',
    },
    program: (k, src) => `declare const process: { argv: string[]; hrtime: { bigint(): bigint } };
declare const console: { log(s: string): void };
${src}
function rng(s: number): number { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; return s >>> 0; }
function run(iters: number, seed: number): number {
  let s = seed; let acc = 0;
  for (let i = 0; i < iters; i++) {
    ${each(k, (i) => `s = rng(s); const a${i} = s;`)}
    acc = (acc ^ ${k.name}(${args(k)})) >>> 0;
  }
  return acc;
}
function main(): void {
  const iters = Number(process.argv[2] ?? ${TIER.jit});
  run(iters, 0x9e3779b9);
  const t0 = process.hrtime.bigint();
  const acc = run(iters, 0x9e3779b9);
  const ns = Number(process.hrtime.bigint() - t0) / iters;
  console.log(\`\${ns} \${acc}\`);
}
main();
`,
    build: (dir, t) => [
      [
        t.bin.node as string,
        [
          t.bin.tsc as string,
          '--target',
          'es2022',
          '--module',
          'es2022',
          '--lib',
          'es2022',
          '--strict',
          '--typeRoots',
          join(dir, 'no-types'),
          '--outDir',
          dir,
          join(dir, 'bench.ts'),
        ],
      ],
    ],
    run: (dir, t, iters) => [t.bin.node as string, [join(dir, 'bench.js'), iters]],
  },
  // ---------------------------------------------------------------- C++ (clang++ -O2)
  {
    id: 'cpp',
    label: 'C++',
    family: 'compiled-native',
    startupGroup: 'compiled',
    iterations: TIER.native,
    file: 'bench.cpp',
    find: single('clang++', 'A0_CLANGXX', ['--version']),
    kernels: {
      affine: 'inline uint32_t affine(uint32_t x, uint32_t s, uint32_t o) { return x * s + o; }',
      rotl: 'inline uint32_t rotl(uint32_t x, uint32_t n) { return (x << (n & 31)) | (x >> ((32 - n) & 31)); }',
      clamp:
        'inline uint32_t clamp(uint32_t x, uint32_t lo, uint32_t hi) { return std::max(std::min(x, hi), lo); }',
      mix: 'inline uint32_t mix(uint32_t x, uint32_t y) { uint32_t a = x ^ y; uint32_t d = (a << 13) | (a >> 19); uint32_t f = d * 2654435761u + x; return f ^ (f >> 16); }',
      ident: 'inline uint32_t ident(uint32_t x) { return x; }',
      noop: 'inline uint32_t noop(uint32_t x) { return x; }',
      chain3:
        'inline uint32_t inc1(uint32_t x) { return x + 1; }\ninline uint32_t dbl(uint32_t x) { return x + x; }\ninline uint32_t chain3(uint32_t x, uint32_t y) { return inc1(dbl(inc1(x))) + y; }',
      branchy:
        'inline uint32_t branchy(uint32_t x, uint32_t y) { uint32_t m = x < y ? y - x : x - y; uint32_t z = x == y ? 0u : m; return (z & 1u) == 1u ? z : x; }',
      arrfill:
        'inline uint32_t arrfill(uint32_t x, uint32_t y) { std::array<uint32_t, 8> a{}; for (uint32_t i = 0; i < 8; i++) a[i] = i + x; return a[y % 8u] + a[3]; }',
      loop64:
        'inline uint32_t loop64(uint32_t s, uint32_t k) { for (uint32_t i = 0; i < 64; i++) { uint32_t b = (s ^ k) * 2654435761u; s = (b ^ (b >> 15)) + i; } return s; }',
    },
    program: (k, src) => `#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
${src}
static inline uint32_t rng(uint32_t &s) { uint32_t x = s; x ^= x << 13; x ^= x >> 17; x ^= x << 5; return s = x; }
int main(int argc, char **argv) {
  long iters = argc > 1 ? std::atol(argv[1]) : ${TIER.native};
  uint32_t s = 0x9e3779b9u, acc = 0;
  auto t0 = std::chrono::steady_clock::now();
  for (long i = 0; i < iters; i++) {
    ${each(k, (i) => `uint32_t a${i} = rng(s);`)}
    acc ^= ${k.name}(${args(k)});
  }
  auto dt = std::chrono::duration<double, std::nano>(std::chrono::steady_clock::now() - t0).count();
  std::printf("%.4f %u\\n", dt / (double)iters, acc);
  return 0;
}
`,
    build: (dir, t) => [
      [
        t.bin.main as string,
        ['-std=c++17', '-O2', '-o', join(dir, 'bench'), join(dir, 'bench.cpp')],
      ],
    ],
    run: (dir, _t, iters) => [join(dir, 'bench'), [iters]],
  },
  // ---------------------------------------------------------------- Objective-C (clang -O2, class methods)
  {
    id: 'objc',
    label: 'Objective-C',
    family: 'compiled-native',
    startupGroup: 'compiled',
    iterations: TIER.native,
    file: 'bench.m',
    find: single('clang', 'A0_CLANG', ['--version']),
    kernels: {
      affine: '+ (uint32_t)affine:(uint32_t)x :(uint32_t)s :(uint32_t)o { return x * s + o; }',
      rotl: '+ (uint32_t)rotl:(uint32_t)x :(uint32_t)n { return (x << (n & 31)) | (x >> ((32 - n) & 31)); }',
      clamp:
        '+ (uint32_t)clamp:(uint32_t)x :(uint32_t)lo :(uint32_t)hi { uint32_t t = hi < x ? hi : x; return t < lo ? lo : t; }',
      mix: '+ (uint32_t)mix:(uint32_t)x :(uint32_t)y { uint32_t a = x ^ y; uint32_t d = (a << 13) | (a >> 19); uint32_t f = d * 2654435761u + x; return f ^ (f >> 16); }',
      ident: '+ (uint32_t)ident:(uint32_t)x { return x; }',
      noop: '+ (uint32_t)noop:(uint32_t)x { return x; }',
      chain3:
        '+ (uint32_t)inc1:(uint32_t)x { return x + 1; }\n+ (uint32_t)dbl:(uint32_t)x { return x + x; }\n+ (uint32_t)chain3:(uint32_t)x :(uint32_t)y { return [self inc1:[self dbl:[self inc1:x]]] + y; }',
      branchy:
        '+ (uint32_t)branchy:(uint32_t)x :(uint32_t)y { uint32_t m = x < y ? y - x : x - y; uint32_t z = x == y ? 0u : m; return (z & 1u) == 1u ? z : x; }',
      arrfill:
        '+ (uint32_t)arrfill:(uint32_t)x :(uint32_t)y { uint32_t a[8]; for (uint32_t i = 0; i < 8; i++) a[i] = i + x; return a[y % 8u] + a[3]; }',
      loop64:
        '+ (uint32_t)loop64:(uint32_t)s :(uint32_t)k { for (uint32_t i = 0; i < 64; i++) { uint32_t b = (s ^ k) * 2654435761u; s = (b ^ (b >> 15)) + i; } return s; }',
    },
    program: (k, src) => `#import <Foundation/Foundation.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
@interface Kernels : NSObject
@end
@implementation Kernels
${src}
@end
static uint32_t rng(uint32_t *s) { uint32_t x = *s; x ^= x << 13; x ^= x >> 17; x ^= x << 5; return *s = x; }
int main(int argc, char **argv) {
  long iters = argc > 1 ? atol(argv[1]) : ${TIER.native};
  uint32_t s = 0x9e3779b9u, acc = 0;
  struct timespec t0, t1;
  clock_gettime(CLOCK_MONOTONIC, &t0);
  for (long i = 0; i < iters; i++) {
    ${each(k, (i) => `uint32_t a${i} = rng(&s);`)}
    acc ^= [Kernels ${k.name}:${args(k, ' :')}];
  }
  clock_gettime(CLOCK_MONOTONIC, &t1);
  double ns = ((t1.tv_sec - t0.tv_sec) * 1e9 + (t1.tv_nsec - t0.tv_nsec)) / (double)iters;
  printf("%.4f %u\\n", ns, acc);
  return 0;
}
`,
    build: (dir, t) => [
      [
        t.bin.main as string,
        [
          '-fobjc-arc',
          '-O2',
          '-framework',
          'Foundation',
          '-o',
          join(dir, 'bench'),
          join(dir, 'bench.m'),
        ],
      ],
    ],
    run: (dir, _t, iters) => [join(dir, 'bench'), [iters]],
  },
  // ---------------------------------------------------------------- Java (javac + java, JIT warm)
  {
    id: 'java',
    label: 'Java',
    family: 'jit',
    startupGroup: 'compiled',
    iterations: TIER.jit,
    file: 'Bench.java',
    find: jvm,
    kernels: {
      affine: 'static int affine(int x, int s, int o) { return x * s + o; }',
      rotl: 'static int rotl(int x, int n) { return (x << (n & 31)) | (x >>> ((32 - n) & 31)); }',
      clamp:
        'static int clamp(int x, int lo, int hi) { int t = Integer.compareUnsigned(hi, x) < 0 ? hi : x; return Integer.compareUnsigned(t, lo) < 0 ? lo : t; }',
      mix: 'static int mix(int x, int y) { int a = x ^ y; int d = (a << 13) | (a >>> 19); int f = d * 0x9E3779B1 + x; return f ^ (f >>> 16); }',
      ident: 'static int ident(int x) { return x; }',
      noop: 'static int noop(int x) { return x; }',
      chain3:
        'static int inc1(int x) { return x + 1; }\nstatic int dbl(int x) { return x + x; }\nstatic int chain3(int x, int y) { return inc1(dbl(inc1(x))) + y; }',
      branchy:
        'static int branchy(int x, int y) { int m = Integer.compareUnsigned(x, y) < 0 ? y - x : x - y; int z = x == y ? 0 : m; return (z & 1) == 1 ? z : x; }',
      arrfill:
        'static int arrfill(int x, int y) { int[] a = new int[8]; for (int i = 0; i < 8; i++) a[i] = i + x; return a[Integer.remainderUnsigned(y, 8)] + a[3]; }',
      loop64:
        'static int loop64(int s, int k) { for (int i = 0; i < 64; i++) { int b = (s ^ k) * 0x9E3779B1; s = (b ^ (b >>> 15)) + i; } return s; }',
    },
    program: (k, src) => `public final class Bench {
${src}
  static int rng(int[] st) { int x = st[0]; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; st[0] = x; return x; }
  static int run(long iters, int[] st) {
    int acc = 0;
    for (long i = 0; i < iters; i++) {
      ${each(k, (i) => `int a${i} = rng(st);`)}
      acc ^= ${k.name}(${args(k)});
    }
    return acc;
  }
  public static void main(String[] argv) {
    long iters = argv.length > 0 ? Long.parseLong(argv[0]) : ${TIER.jit}L;
    int[] st = { 0x9e3779b9 };
    run(iters, st);
    st[0] = 0x9e3779b9;
    long t0 = System.nanoTime();
    int acc = run(iters, st);
    double ns = (System.nanoTime() - t0) / (double) iters;
    System.out.printf(java.util.Locale.ROOT, "%.4f %s%n", ns, Integer.toUnsignedString(acc));
  }
}
`,
    build: (dir, t) => [[t.bin.javac as string, ['-d', dir, join(dir, 'Bench.java')]]],
    run: (dir, t, iters) => [t.bin.java as string, ['-cp', dir, 'Bench', iters]],
  },
  // ---------------------------------------------------------------- Kotlin (kotlinc -> jar, java)
  {
    id: 'kotlin',
    label: 'Kotlin',
    family: 'jit',
    startupGroup: 'compiled',
    iterations: TIER.jit,
    file: 'bench.kt',
    find: () => {
      const java = javaOnly();
      const kotlinc = locate('kotlinc', 'A0_KOTLINC');
      if (java === undefined || kotlinc === undefined) return undefined;
      return {
        version: versionLine(kotlinc, ['-version'], /kotlinc/),
        bin: { ...java.bin, kotlinc },
      };
    },
    kernels: {
      affine: 'fun affine(x: UInt, s: UInt, o: UInt): UInt = x * s + o',
      rotl: 'fun rotl(x: UInt, n: UInt): UInt = (x shl (n and 31u).toInt()) or (x shr ((32u - n) and 31u).toInt())',
      clamp:
        'fun clamp(x: UInt, lo: UInt, hi: UInt): UInt { val t = if (hi < x) hi else x; return if (t < lo) lo else t }',
      mix: 'fun mix(x: UInt, y: UInt): UInt { val a = x xor y; val d = (a shl 13) or (a shr 19); val f = d * 2654435761u + x; return f xor (f shr 16) }',
      ident: 'fun ident(x: UInt): UInt = x',
      noop: 'fun noop(x: UInt): UInt = x',
      chain3:
        'fun inc1(x: UInt): UInt = x + 1u\nfun dbl(x: UInt): UInt = x + x\nfun chain3(x: UInt, y: UInt): UInt = inc1(dbl(inc1(x))) + y',
      branchy:
        'fun branchy(x: UInt, y: UInt): UInt { val m = if (x < y) y - x else x - y; val z = if (x == y) 0u else m; return if ((z and 1u) == 1u) z else x }',
      arrfill:
        'fun arrfill(x: UInt, y: UInt): UInt { val a = UIntArray(8); for (i in 0 until 8) a[i] = i.toUInt() + x; return a[(y % 8u).toInt()] + a[3] }',
      loop64:
        'fun loop64(s0: UInt, k: UInt): UInt { var s = s0; for (i in 0 until 64) { val b = (s xor k) * 2654435761u; s = (b xor (b shr 15)) + i.toUInt() }; return s }',
    },
    program: (k, src) => `${src}
fun rng(st: UIntArray): UInt { var x = st[0]; x = x xor (x shl 13); x = x xor (x shr 17); x = x xor (x shl 5); st[0] = x; return x }
fun run(iters: Long, st: UIntArray): UInt {
  var acc = 0u
  var i = 0L
  while (i < iters) {
    ${each(k, (i) => `val a${i} = rng(st)`, '; ')}
    acc = acc xor ${k.name}(${args(k)})
    i++
  }
  return acc
}
fun main(argv: Array<String>) {
  val iters = if (argv.isNotEmpty()) argv[0].toLong() else ${TIER.jit}L
  val st = UIntArray(1)
  st[0] = 0x9e3779b9u
  run(iters, st)
  st[0] = 0x9e3779b9u
  val t0 = System.nanoTime()
  val acc = run(iters, st)
  val ns = (System.nanoTime() - t0).toDouble() / iters.toDouble()
  println("$ns $acc")
}
`,
    build: (dir, t) => [
      [
        t.bin.kotlinc as string,
        [join(dir, 'bench.kt'), '-include-runtime', '-d', join(dir, 'bench.jar')],
      ],
    ],
    run: (dir, t, iters) => [t.bin.java as string, ['-jar', join(dir, 'bench.jar'), iters]],
  },
  // ---------------------------------------------------------------- Go (go build)
  {
    id: 'go',
    label: 'Go',
    family: 'compiled-native',
    startupGroup: 'compiled',
    iterations: TIER.native,
    file: 'bench.go',
    find: single('go', 'A0_GO', ['version']),
    env: () => ({ GOTOOLCHAIN: 'local', GOFLAGS: '' }),
    kernels: {
      affine: 'func affine(x, s, o uint32) uint32 { return x*s + o }',
      rotl: 'func rotl(x, n uint32) uint32 { return (x << (n & 31)) | (x >> ((32 - n) & 31)) }',
      clamp: 'func clamp(x, lo, hi uint32) uint32 { return max(min(x, hi), lo) }',
      mix: 'func mix(x, y uint32) uint32 { a := x ^ y; d := (a << 13) | (a >> 19); f := d*2654435761 + x; return f ^ (f >> 16) }',
      ident: 'func ident(x uint32) uint32 { return x }',
      noop: 'func noop(x uint32) uint32 { return x }',
      chain3:
        'func inc1(x uint32) uint32 { return x + 1 }\nfunc dbl(x uint32) uint32 { return x + x }\nfunc chain3(x, y uint32) uint32 { return inc1(dbl(inc1(x))) + y }',
      branchy:
        'func branchy(x, y uint32) uint32 { var m uint32; if x < y { m = y - x } else { m = x - y }; z := m; if x == y { z = 0 }; if z&1 == 1 { return z }; return x }',
      arrfill:
        'func arrfill(x, y uint32) uint32 { var a [8]uint32; for i := uint32(0); i < 8; i++ { a[i] = i + x }; return a[y%8] + a[3] }',
      loop64:
        'func loop64(s, k uint32) uint32 { for i := uint32(0); i < 64; i++ { b := (s ^ k) * 2654435761; s = (b ^ (b >> 15)) + i }; return s }',
    },
    program: (k, src) => `package main

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

${src}

func rng(s *uint32) uint32 { x := *s; x ^= x << 13; x ^= x >> 17; x ^= x << 5; *s = x; return x }

func main() {
	iters := int64(${TIER.native})
	if len(os.Args) > 1 {
		v, err := strconv.ParseInt(os.Args[1], 10, 64)
		if err == nil {
			iters = v
		}
	}
	var s uint32 = 0x9e3779b9
	var acc uint32
	t0 := time.Now()
	for i := int64(0); i < iters; i++ {
		${each(k, (i) => `a${i} := rng(&s)`, '; ')}
		acc ^= ${k.name}(${args(k)})
	}
	ns := float64(time.Since(t0).Nanoseconds()) / float64(iters)
	fmt.Printf("%.4f %d\\n", ns, acc)
}
`,
    build: (dir, t) => [
      [t.bin.main as string, ['build', '-o', join(dir, 'bench'), join(dir, 'bench.go')]],
    ],
    run: (dir, _t, iters) => [join(dir, 'bench'), [iters]],
  },
  // ---------------------------------------------------------------- Swift (swiftc -O)
  {
    id: 'swift',
    label: 'Swift',
    family: 'compiled-native',
    startupGroup: 'compiled',
    iterations: TIER.native,
    file: 'bench.swift',
    find: single('swiftc', 'A0_SWIFTC', ['--version'], { pick: /Swift version/ }),
    kernels: {
      affine: 'func affine(_ x: UInt32, _ s: UInt32, _ o: UInt32) -> UInt32 { x &* s &+ o }',
      rotl: 'func rotl(_ x: UInt32, _ n: UInt32) -> UInt32 { (x << (n & 31)) | (x >> ((32 &- n) & 31)) }',
      clamp:
        'func clamp(_ x: UInt32, _ lo: UInt32, _ hi: UInt32) -> UInt32 { max(min(x, hi), lo) }',
      mix: 'func mix(_ x: UInt32, _ y: UInt32) -> UInt32 { let a = x ^ y; let d = (a << 13) | (a >> 19); let f = d &* 2654435761 &+ x; return f ^ (f >> 16) }',
      ident: 'func ident(_ x: UInt32) -> UInt32 { x }',
      noop: 'func noop(_ x: UInt32) -> UInt32 { x }',
      chain3:
        'func inc1(_ x: UInt32) -> UInt32 { x &+ 1 }\nfunc dbl(_ x: UInt32) -> UInt32 { x &+ x }\nfunc chain3(_ x: UInt32, _ y: UInt32) -> UInt32 { inc1(dbl(inc1(x))) &+ y }',
      branchy:
        'func branchy(_ x: UInt32, _ y: UInt32) -> UInt32 { let m = x < y ? y &- x : x &- y; let z = x == y ? 0 : m; return (z & 1) == 1 ? z : x }',
      arrfill:
        'func arrfill(_ x: UInt32, _ y: UInt32) -> UInt32 { var a = [UInt32](repeating: 0, count: 8); for i in 0..<8 { a[i] = UInt32(i) &+ x }; return a[Int(y % 8)] &+ a[3] }',
      loop64:
        'func loop64(_ s0: UInt32, _ k: UInt32) -> UInt32 { var s = s0; for i in 0..<64 { let b = (s ^ k) &* 2654435761; s = (b ^ (b >> 15)) &+ UInt32(i) }; return s }',
    },
    program: (k, src) => `import Darwin
${src}
@inline(__always) func rng(_ s: inout UInt32) -> UInt32 { var x = s; x ^= x << 13; x ^= x >> 17; x ^= x << 5; s = x; return x }
func nowNs() -> Double { var ts = timespec(); clock_gettime(CLOCK_MONOTONIC, &ts); return Double(ts.tv_sec) * 1e9 + Double(ts.tv_nsec) }
func main() {
  let iters = CommandLine.arguments.count > 1 ? (Int(CommandLine.arguments[1]) ?? ${TIER.native}) : ${TIER.native}
  var s: UInt32 = 0x9e3779b9
  var acc: UInt32 = 0
  let t0 = nowNs()
  for _ in 0..<iters {
    ${each(k, (i) => `let a${i} = rng(&s)`, '; ')}
    acc ^= ${k.name}(${args(k)})
  }
  let ns = (nowNs() - t0) / Double(iters)
  print("\\(ns) \\(acc)")
}
main()
`,
    build: (dir, t) => [
      [t.bin.main as string, ['-O', '-o', join(dir, 'bench'), join(dir, 'bench.swift')]],
    ],
    run: (dir, _t, iters) => [join(dir, 'bench'), [iters]],
  },
  // ---------------------------------------------------------------- Zig (ReleaseFast)
  {
    id: 'zig',
    label: 'Zig',
    family: 'compiled-native',
    startupGroup: 'compiled',
    iterations: TIER.native,
    file: 'bench.zig',
    find: single('zig', 'A0_ZIG', ['version']),
    output: 'stderr',
    kernels: {
      affine: 'fn affine(x: u32, s: u32, o: u32) u32 { return x *% s +% o; }',
      rotl: 'fn rotl(x: u32, n: u32) u32 { return (x << @as(u5, @intCast(n & 31))) | (x >> @as(u5, @intCast((32 -% n) & 31))); }',
      clamp: 'fn clamp(x: u32, lo: u32, hi: u32) u32 { return @max(@min(x, hi), lo); }',
      mix: 'fn mix(x: u32, y: u32) u32 { const a = x ^ y; const d = (a << 13) | (a >> 19); const f = d *% 2654435761 +% x; return f ^ (f >> 16); }',
      ident: 'fn ident(x: u32) u32 { return x; }',
      noop: 'fn noop(x: u32) u32 { return x; }',
      chain3:
        'fn inc1(x: u32) u32 { return x +% 1; }\nfn dbl(x: u32) u32 { return x +% x; }\nfn chain3(x: u32, y: u32) u32 { return inc1(dbl(inc1(x))) +% y; }',
      branchy:
        'fn branchy(x: u32, y: u32) u32 { const m = if (x < y) y -% x else x -% y; const z: u32 = if (x == y) 0 else m; return if ((z & 1) == 1) z else x; }',
      arrfill:
        'fn arrfill(x: u32, y: u32) u32 { var a: [8]u32 = undefined; for (&a, 0..) |*e, i| e.* = @as(u32, @intCast(i)) +% x; return a[y % 8] +% a[3]; }',
      loop64:
        'fn loop64(s0: u32, k: u32) u32 { var s = s0; var i: u32 = 0; while (i < 64) : (i += 1) { const b = (s ^ k) *% 2654435761; s = (b ^ (b >> 15)) +% i; } return s; }',
      dot1k:
        'fn dot1k(x: u32, y: u32) u32 { var a: [1024]u32 = undefined; var b: [1024]u32 = undefined; for (0..1024) |i| { const iu: u32 = @intCast(i); a[i] = iu *% x +% y; b[i] = (iu ^ y) *% x; } var s: u32 = 0; for (0..1024) |i| s +%= a[i] *% b[i]; return s; }',
      prefix1k:
        'fn prefix1k(x: u32, y: u32) u32 { var a: [1024]u32 = undefined; for (0..1024) |i| a[i] = @as(u32, @intCast(i)) *% x +% y; for (1..1024) |i| a[i] +%= a[i - 1]; return a[y & 1023] +% a[1023]; }',
      hist256:
        'fn hist256(x: u32, y: u32) u32 { var a: [4096]u32 = undefined; for (0..4096) |i| { const w = @as(u32, @intCast(i)) *% x +% y; a[i] = (w ^ (w >> 15)) *% 2654435761; } var h = [_]u32{0} ** 256; for (0..4096) |i| h[a[i] >> 24] += 1; return h[y & 255] *% 65599 +% h[x & 255]; }',
      mat4: 'fn mat4(x: u32, y: u32) u32 { var a: [16]u32 = undefined; var b: [16]u32 = undefined; for (0..16) |k| { const ku: u32 = @intCast(k); const sh: u5 = @intCast(k); a[k] = (x *% (ku + 1)) ^ (y >> sh); b[k] = (y *% (ku + 3)) +% (x >> sh); } for (0..8) |_| { var c: [16]u32 = undefined; for (0..4) |r| { for (0..4) |j| { var s: u32 = 0; for (0..4) |k| s +%= a[r * 4 + k] *% b[k * 4 + j]; c[r * 4 + j] = s; } } a = c; } return a[0] +% a[5] +% a[10] +% a[15] +% a[x & 15]; }',
      fnv4k:
        'fn fnv4k(x: u32, y: u32) u32 { var a: [4096]u32 = undefined; for (0..4096) |i| { const w = @as(u32, @intCast(i)) *% x +% y; a[i] = (w ^ (w >> 15)) *% 2654435761; } var s: u32 = 2166136261; for (0..4096) |i| { const v = a[i]; s = (s ^ (v & 255)) *% 16777619; s = (s ^ ((v >> 8) & 255)) *% 16777619; s = (s ^ ((v >> 16) & 255)) *% 16777619; s = (s ^ (v >> 24)) *% 16777619; } return s; }',
      xs4k: 'fn xs4k(x: u32, y: u32) u32 { var a: [4096]u32 = undefined; var s = x; for (0..4096) |i| { s ^= s << 13; s ^= s >> 17; s ^= s << 5; a[i] = s; } var r = y; for (0..4096) |i| r ^= a[i]; return r; }',
      minmax1k:
        'fn minmax1k(x: u32, y: u32) u32 { var a: [1024]u32 = undefined; for (0..1024) |i| { const w = @as(u32, @intCast(i)) *% x +% y; a[i] = (w ^ (w >> 15)) *% 2654435761; } var lo: u32 = 0xffffffff; var hi: u32 = 0; for (0..1024) |i| { const v = a[i]; lo = if (v < lo) v else lo; hi = if (v > hi) v else hi; } return hi -% lo; }',
      filter2:
        'fn filter2(x: u32, y: u32) u32 { var a: [1024]u32 = undefined; var b: [1024]u32 = undefined; var c: [1024]u32 = undefined; for (0..1024) |i| { const w = @as(u32, @intCast(i)) *% x +% y; a[i] = (w ^ (w >> 15)) *% 2654435761; } for (0..1024) |i| b[i] = (a[i] +% a[(i + 1) & 1023]) >> 1; for (0..1024) |i| c[i] = (b[i] +% b[(i + 1) & 1023]) >> 1; return c[y & 1023] +% c[1023]; }',
    },
    program: (k, src) => `const std = @import("std");
${src}
inline fn rng(s: *u32) u32 { var x = s.*; x ^= x << 13; x ^= x >> 17; x ^= x << 5; s.* = x; return x; }
fn nowNs() f64 { var ts: std.c.timespec = undefined; _ = std.c.clock_gettime(.MONOTONIC, &ts); return @as(f64, @floatFromInt(ts.sec)) * 1e9 + @as(f64, @floatFromInt(ts.nsec)); }
pub fn main(init: std.process.Init.Minimal) void {
    var iters: u64 = ${TIER.native};
    const argv = init.args.vector;
    if (argv.len > 1) iters = std.fmt.parseInt(u64, std.mem.span(argv[1]), 10) catch ${TIER.native};
    var s: u32 = 0x9e3779b9;
    var acc: u32 = 0;
    const t0 = nowNs();
    var i: u64 = 0;
    while (i < iters) : (i += 1) {
        ${each(k, (i) => `const a${i} = rng(&s);`)}
        acc ^= ${k.name}(${args(k)});
    }
    const ns = (nowNs() - t0) / @as(f64, @floatFromInt(iters));
    std.debug.print("{d} {d}\\n", .{ ns, acc });
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
    run: (dir, _t, iters) => [join(dir, 'bench'), [iters]],
  },
  // ---------------------------------------------------------------- Python (CPython)
  {
    id: 'python',
    label: 'Python',
    family: 'interpreted',
    startupGroup: 'interpreters',
    iterations: TIER.interpreted,
    file: 'bench.py',
    find: single('python3', 'A0_PYTHON', ['--version']),
    kernels: {
      affine: 'def affine(x, s, o):\n    return (x * s + o) & 0xFFFFFFFF',
      rotl: 'def rotl(x, n):\n    return ((x << (n & 31)) | (x >> ((32 - n) & 31))) & 0xFFFFFFFF',
      clamp: 'def clamp(x, lo, hi):\n    t = hi if hi < x else x\n    return lo if t < lo else t',
      mix: 'def mix(x, y):\n    a = x ^ y\n    d = ((a << 13) | (a >> 19)) & 0xFFFFFFFF\n    f = (d * 2654435761 + x) & 0xFFFFFFFF\n    return (f ^ (f >> 16)) & 0xFFFFFFFF',
      ident: 'def ident(x):\n    return x',
      noop: 'def noop(x):\n    return x',
      chain3:
        'def inc1(x):\n    return (x + 1) & 0xFFFFFFFF\ndef dbl(x):\n    return (x + x) & 0xFFFFFFFF\ndef chain3(x, y):\n    return (inc1(dbl(inc1(x))) + y) & 0xFFFFFFFF',
      branchy:
        'def branchy(x, y):\n    m = (y - x) & 0xFFFFFFFF if x < y else (x - y) & 0xFFFFFFFF\n    z = 0 if x == y else m\n    return z if (z & 1) == 1 else x',
      arrfill:
        'def arrfill(x, y):\n    a = [0] * 8\n    for i in range(8):\n        a[i] = (i + x) & 0xFFFFFFFF\n    return (a[y % 8] + a[3]) & 0xFFFFFFFF',
      loop64:
        'def loop64(s, k):\n    for i in range(64):\n        b = ((s ^ k) * 2654435761) & 0xFFFFFFFF\n        s = ((b ^ (b >> 15)) + i) & 0xFFFFFFFF\n    return s',
      arrfill4k:
        'def arrfill4k(x, y):\n    a = [0] * 4096\n    for i in range(4096):\n        a[i] = (i + x) & 0xFFFFFFFF\n    return (a[y % 4096] + a[4095]) & 0xFFFFFFFF',
    },
    program: (k, src) => `${src}
import sys, time
M = 0xFFFFFFFF
def main():
    iters = int(sys.argv[1]) if len(sys.argv) > 1 else ${TIER.interpreted}
    s = 0x9e3779b9
    acc = 0
    f = ${k.name}
    t0 = time.perf_counter()
    for _ in range(iters):
        ${each(k, (i) => `s ^= (s << 13) & M; s ^= s >> 17; s ^= (s << 5) & M; a${i} = s`, '\n        ')}
        acc = (acc ^ f(${args(k)})) & M
    dt = time.perf_counter() - t0
    print(f"{dt * 1e9 / iters:.3f} {acc}")
main()
`,
    check: (dir, t) => [[t.bin.main as string, ['-m', 'py_compile', join(dir, 'bench.py')]]],
    run: (dir, t, iters) => [t.bin.main as string, [join(dir, 'bench.py'), iters]],
  },
  // ---------------------------------------------------------------- Ruby
  {
    id: 'ruby',
    label: 'Ruby',
    family: 'interpreted',
    startupGroup: 'interpreters',
    iterations: TIER.interpreted,
    file: 'bench.rb',
    find: single('ruby', 'A0_RUBY', ['--version']),
    kernels: {
      affine: 'def affine(x, s, o)\n  (x * s + o) & M\nend',
      rotl: 'def rotl(x, n)\n  ((x << (n & 31)) | (x >> ((32 - n) & 31))) & M\nend',
      clamp: 'def clamp(x, lo, hi)\n  t = hi < x ? hi : x\n  t < lo ? lo : t\nend',
      mix: 'def mix(x, y)\n  a = x ^ y\n  d = ((a << 13) | (a >> 19)) & M\n  f = (d * 2654435761 + x) & M\n  f ^ (f >> 16)\nend',
      ident: 'def ident(x)\n  x\nend',
      noop: 'def noop(x)\n  x\nend',
      chain3:
        'def inc1(x)\n  (x + 1) & M\nend\ndef dbl(x)\n  (x + x) & M\nend\ndef chain3(x, y)\n  (inc1(dbl(inc1(x))) + y) & M\nend',
      branchy:
        'def branchy(x, y)\n  m = x < y ? (y - x) & M : (x - y) & M\n  z = x == y ? 0 : m\n  (z & 1) == 1 ? z : x\nend',
      arrfill:
        'def arrfill(x, y)\n  a = Array.new(8, 0)\n  8.times { |i| a[i] = (i + x) & M }\n  (a[y % 8] + a[3]) & M\nend',
      loop64:
        'def loop64(s, k)\n  64.times do |i|\n    b = ((s ^ k) * 2654435761) & M\n    s = ((b ^ (b >> 15)) + i) & M\n  end\n  s\nend',
    },
    program: (k, src) => `M = 0xFFFFFFFF
${src}
iters = (ARGV[0] || ${TIER.interpreted}).to_i
s = 0x9e3779b9
acc = 0
t0 = Process.clock_gettime(Process::CLOCK_MONOTONIC)
iters.times do
  ${each(k, (i) => `s ^= (s << 13) & M; s ^= s >> 17; s ^= (s << 5) & M; a${i} = s`, '\n  ')}
  acc = (acc ^ ${k.name}(${args(k)})) & M
end
dt = Process.clock_gettime(Process::CLOCK_MONOTONIC) - t0
puts "#{'%.3f' % (dt * 1e9 / iters)} #{acc}"
`,
    check: (dir, t) => [[t.bin.main as string, ['-c', join(dir, 'bench.rb')]]],
    run: (dir, t, iters) => [t.bin.main as string, [join(dir, 'bench.rb'), iters]],
  },
  // ---------------------------------------------------------------- PHP
  {
    id: 'php',
    label: 'PHP',
    family: 'interpreted',
    startupGroup: 'interpreters',
    iterations: TIER.interpreted,
    file: 'bench.php',
    find: single('php', 'A0_PHP', ['--version']),
    kernels: {
      affine: `function affine(int $x, int $s, int $o): int { return (mul32($x, $s) + $o) & ${M}; }`,
      rotl: `function rotl(int $x, int $n): int { return (($x << ($n & 31)) | ($x >> ((32 - $n) & 31))) & ${M}; }`,
      clamp:
        'function clamp(int $x, int $lo, int $hi): int { $t = $hi < $x ? $hi : $x; return $t < $lo ? $lo : $t; }',
      mix: `function mix(int $x, int $y): int { $a = $x ^ $y; $d = (($a << 13) | ($a >> 19)) & ${M}; $f = (mul32($d, 2654435761) + $x) & ${M}; return $f ^ ($f >> 16); }`,
      ident: 'function ident(int $x): int { return $x; }',
      noop: 'function noop(int $x): int { return $x; }',
      chain3: `function inc1(int $x): int { return ($x + 1) & ${M}; }\nfunction dbl(int $x): int { return ($x + $x) & ${M}; }\nfunction chain3(int $x, int $y): int { return (inc1(dbl(inc1($x))) + $y) & ${M}; }`,
      branchy: `function branchy(int $x, int $y): int { $m = $x < $y ? ($y - $x) & ${M} : ($x - $y) & ${M}; $z = $x == $y ? 0 : $m; return ($z & 1) == 1 ? $z : $x; }`,
      arrfill: `function arrfill(int $x, int $y): int { $a = array_fill(0, 8, 0); for ($i = 0; $i < 8; $i++) $a[$i] = ($i + $x) & ${M}; return ($a[$y % 8] + $a[3]) & ${M}; }`,
      loop64: `function loop64(int $s, int $k): int { for ($i = 0; $i < 64; $i++) { $b = mul32($s ^ $k, 2654435761); $s = (($b ^ ($b >> 15)) + $i) & ${M}; } return $s; }`,
    },
    program: (k, src) => `<?php
// PHP integers are signed 64-bit and overflow to float, so a u32 product is split into 16-bit halves.
function mul32(int $a, int $b): int { return (($a * ($b & 0xFFFF)) + ((($a * ($b >> 16)) & 0xFFFF) << 16)) & ${M}; }
${src}
function main(array $argv): void {
  $iters = (int)($argv[1] ?? ${TIER.interpreted});
  $s = 0x9e3779b9;
  $acc = 0;
  $t0 = hrtime(true);
  for ($i = 0; $i < $iters; $i++) {
    ${each(k, (i) => `$s ^= ($s << 13) & ${M}; $s ^= $s >> 17; $s ^= ($s << 5) & ${M}; $a${i} = $s;`, '\n    ')}
    $acc = ($acc ^ ${k.name}(${args(k, ', ', '$')})) & ${M};
  }
  $ns = (hrtime(true) - $t0) / $iters;
  printf("%.3f %d\\n", $ns, $acc);
}
main($argv);
`,
    check: (dir, t) => [[t.bin.main as string, ['-l', join(dir, 'bench.php')]]],
    run: (dir, t, iters) => [t.bin.main as string, [join(dir, 'bench.php'), iters]],
  },
  // ---------------------------------------------------------------- Lua
  {
    id: 'lua',
    label: 'Lua',
    family: 'interpreted',
    startupGroup: 'interpreters',
    iterations: TIER.interpreted,
    file: 'bench.lua',
    find: single('lua', 'A0_LUA', ['-v']),
    timer: 'os.clock (process CPU time; Lua has no monotonic wall clock in the standard library)',
    kernels: {
      affine: 'local function affine(x, s, o) return (x * s + o) & M end',
      rotl: 'local function rotl(x, n) return ((x << (n & 31)) | (x >> ((32 - n) & 31))) & M end',
      clamp:
        'local function clamp(x, lo, hi) local t = x; if hi < x then t = hi end; if t < lo then return lo end; return t end',
      mix: 'local function mix(x, y) local a = x ~ y; local d = ((a << 13) | (a >> 19)) & M; local f = (d * 2654435761 + x) & M; return f ~ (f >> 16) end',
      ident: 'local function ident(x) return x end',
      noop: 'local function noop(x) return x end',
      chain3:
        'local function inc1(x) return (x + 1) & M end\nlocal function dbl(x) return (x + x) & M end\nlocal function chain3(x, y) return (inc1(dbl(inc1(x))) + y) & M end',
      branchy:
        'local function branchy(x, y) local m; if x < y then m = (y - x) & M else m = (x - y) & M end; local z = m; if x == y then z = 0 end; if (z & 1) == 1 then return z end; return x end',
      arrfill:
        'local function arrfill(x, y) local a = {}; for i = 0, 7 do a[i + 1] = (i + x) & M end; return (a[(y % 8) + 1] + a[4]) & M end',
      loop64:
        'local function loop64(s, k) for i = 0, 63 do local b = ((s ~ k) * 2654435761) & M; s = ((b ~ (b >> 15)) + i) & M end; return s end',
    },
    program: (k, src) => `local M = 0xFFFFFFFF
${src}
local iters = tonumber(arg[1]) or ${TIER.interpreted}
local s = 0x9e3779b9
local acc = 0
local t0 = os.clock()
for _ = 1, iters do
  ${each(k, (i) => `s = s ~ ((s << 13) & M); s = s ~ (s >> 17); s = s ~ ((s << 5) & M); local a${i} = s`, '\n  ')}
  acc = (acc ~ ${k.name}(${args(k)})) & M
end
local dt = os.clock() - t0
print(string.format("%.3f %d", dt * 1e9 / iters, acc))
`,
    run: (dir, t, iters) => [t.bin.main as string, [join(dir, 'bench.lua'), iters]],
  },
  // ---------------------------------------------------------------- Perl
  {
    id: 'perl',
    label: 'Perl',
    family: 'interpreted',
    startupGroup: 'interpreters',
    iterations: TIER.interpreted,
    file: 'bench.pl',
    find: single('perl', 'A0_PERL', ['-v'], { pick: /This is perl/ }),
    kernels: {
      affine: `sub affine { my ($x, $s, $o) = @_; return ((($x * $s) & ${M}) + $o) & ${M}; }`,
      rotl: `sub rotl { my ($x, $n) = @_; return (($x << ($n & 31)) | ($x >> ((32 - $n) & 31))) & ${M}; }`,
      clamp:
        'sub clamp { my ($x, $lo, $hi) = @_; my $t = $hi < $x ? $hi : $x; return $t < $lo ? $lo : $t; }',
      mix: `sub mix { my ($x, $y) = @_; my $u = $x ^ $y; my $d = (($u << 13) | ($u >> 19)) & ${M}; my $f = ((($d * 2654435761) & ${M}) + $x) & ${M}; return $f ^ ($f >> 16); }`,
      ident: 'sub ident { my ($x) = @_; return $x; }',
      noop: 'sub noop { my ($x) = @_; return $x; }',
      chain3: `sub inc1 { my ($x) = @_; return ($x + 1) & ${M}; }\nsub dbl { my ($x) = @_; return ($x + $x) & ${M}; }\nsub chain3 { my ($x, $y) = @_; return (inc1(dbl(inc1($x))) + $y) & ${M}; }`,
      branchy: `sub branchy { my ($x, $y) = @_; my $m = $x < $y ? ($y - $x) & ${M} : ($x - $y) & ${M}; my $z = $x == $y ? 0 : $m; return ($z & 1) == 1 ? $z : $x; }`,
      arrfill: `sub arrfill { my ($x, $y) = @_; my @a = (0) x 8; for my $i (0 .. 7) { $a[$i] = ($i + $x) & ${M}; } return ($a[$y % 8] + $a[3]) & ${M}; }`,
      loop64: `sub loop64 { my ($s, $k) = @_; for my $i (0 .. 63) { my $t = (($s ^ $k) * 2654435761) & ${M}; $s = (($t ^ ($t >> 15)) + $i) & ${M}; } return $s; }`,
    },
    program: (k, src) => `use strict;
use warnings;
use Time::HiRes qw(time);
${src}
my $iters = $ARGV[0] // ${TIER.interpreted};
my $s = 0x9e3779b9;
my $acc = 0;
my $t0 = time;
for (1 .. $iters) {
  ${each(k, (i) => `$s ^= ($s << 13) & ${M}; $s ^= $s >> 17; $s ^= ($s << 5) & ${M}; my $a${i} = $s;`, '\n  ')}
  $acc = ($acc ^ ${k.name}(${args(k, ', ', '$')})) & ${M};
}
my $dt = time - $t0;
printf("%.3f %u\\n", $dt * 1e9 / $iters, $acc);
`,
    check: (dir, t) => [[t.bin.main as string, ['-c', join(dir, 'bench.pl')]]],
    run: (dir, t, iters) => [t.bin.main as string, [join(dir, 'bench.pl'), iters]],
  },
  // ---------------------------------------------------------------- Tcl
  {
    id: 'tcl',
    label: 'Tcl',
    family: 'interpreted',
    startupGroup: 'interpreters',
    iterations: TIER.interpreted,
    file: 'bench.tcl',
    find: () => {
      const p = locate('tclsh', 'A0_TCLSH');
      if (p === undefined) return undefined;
      const r = runTool(p, [], { input: 'puts "tclsh $tcl_patchLevel"\n', timeoutMs: 30_000 });
      return { version: r.stdout.trim() || 'tclsh', bin: { main: p } };
    },
    kernels: {
      affine: `proc affine {x s o} { expr {($x * $s + $o) & ${M}} }`,
      rotl: `proc rotl {x n} { expr {(($x << ($n & 31)) | ($x >> ((32 - $n) & 31))) & ${M}} }`,
      clamp:
        'proc clamp {x lo hi} { set t [expr {$hi < $x ? $hi : $x}]; expr {$t < $lo ? $lo : $t} }',
      mix: `proc mix {x y} { set a [expr {$x ^ $y}]; set d [expr {(($a << 13) | ($a >> 19)) & ${M}}]; set f [expr {($d * 2654435761 + $x) & ${M}}]; expr {$f ^ ($f >> 16)} }`,
      ident: 'proc ident {x} { return $x }',
      noop: 'proc noop {x} { return $x }',
      chain3: `proc inc1 {x} { expr {($x + 1) & ${M}} }\nproc dbl {x} { expr {($x + $x) & ${M}} }\nproc chain3 {x y} { expr {([inc1 [dbl [inc1 $x]]] + $y) & ${M}} }`,
      branchy: `proc branchy {x y} { set m [expr {$x < $y ? ($y - $x) & ${M} : ($x - $y) & ${M}}]; set z [expr {$x == $y ? 0 : $m}]; expr {($z & 1) == 1 ? $z : $x} }`,
      arrfill: `proc arrfill {x y} { set a [lrepeat 8 0]; for {set i 0} {$i < 8} {incr i} { lset a $i [expr {($i + $x) & ${M}}] }; expr {([lindex $a [expr {$y % 8}]] + [lindex $a 3]) & ${M}} }`,
      loop64: `proc loop64 {s k} { for {set i 0} {$i < 64} {incr i} { set b [expr {(($s ^ $k) * 2654435761) & ${M}}]; set s [expr {(($b ^ ($b >> 15)) + $i) & ${M}}] }; return $s }`,
    },
    program: (k, src) => `${src}
set iters [expr {[llength $argv] > 0 ? [lindex $argv 0] : ${TIER.interpreted}}]
set s [expr {0x9e3779b9}]
set acc 0
set t0 [clock microseconds]
for {set i 0} {$i < $iters} {incr i} {
  ${each(k, (i) => `set s [expr {$s ^ (($s << 13) & ${M})}]; set s [expr {$s ^ ($s >> 17)}]; set s [expr {$s ^ (($s << 5) & ${M})}]; set a${i} $s`, '\n  ')}
  set acc [expr {($acc ^ [${k.name} ${args(k, ' ', '$')}]) & ${M}}]
}
set dt [expr {[clock microseconds] - $t0}]
puts [format "%.3f %ld" [expr {$dt * 1000.0 / $iters}] $acc]
`,
    run: (dir, t, iters) => [t.bin.main as string, [join(dir, 'bench.tcl'), iters]],
  },
  // ---------------------------------------------------------------- Fortran (gfortran -O2)
  {
    id: 'fortran',
    label: 'Fortran',
    family: 'compiled-native',
    startupGroup: 'compiled',
    iterations: TIER.native,
    file: 'bench.f90',
    find: () => {
      const t = single('gfortran', 'A0_GFORTRAN', ['--version'], {
        extra: BREW.map((p) => `${p}/gfortran`),
      })();
      if (t === undefined) return undefined;
      // Homebrew gfortran does not know the macOS SDK; pass its library directory to ld.
      const xcrun = onPath('xcrun');
      const sdk =
        xcrun === undefined
          ? ''
          : runTool(xcrun, ['--show-sdk-path'], { timeoutMs: 30_000 }).stdout.trim();
      return {
        version: t.version,
        bin: { ...t.bin, sdkLib: sdk.length > 0 ? `${sdk}/usr/lib` : '' },
      };
    },
    kernels: {
      affine:
        'pure function affine(x, s, o) result(r)\n  integer(int64), intent(in) :: x, s, o\n  integer(int64) :: r\n  r = iand(mul32(x, s) + o, m32)\nend function',
      rotl: 'pure function rotl(x, n) result(r)\n  integer(int64), intent(in) :: x, n\n  integer(int64) :: r\n  r = iand(ior(ishft(x, int(iand(n, 31_int64))), ishft(x, -int(iand(32_int64 - n, 31_int64)))), m32)\nend function',
      clamp:
        'pure function clamp(x, lo, hi) result(r)\n  integer(int64), intent(in) :: x, lo, hi\n  integer(int64) :: r\n  r = max(min(x, hi), lo)\nend function',
      mix: 'pure function mix(x, y) result(r)\n  integer(int64), intent(in) :: x, y\n  integer(int64) :: r, a, d, f\n  a = ieor(x, y)\n  d = iand(ior(ishft(a, 13), ishft(a, -19)), m32)\n  f = iand(mul32(d, 2654435761_int64) + x, m32)\n  r = ieor(f, ishft(f, -16))\nend function',
      ident:
        'pure function ident(x) result(r)\n  integer(int64), intent(in) :: x\n  integer(int64) :: r\n  r = x\nend function',
      noop: 'pure function noop(x) result(r)\n  integer(int64), intent(in) :: x\n  integer(int64) :: r\n  r = x\nend function',
      chain3:
        'pure function inc1(x) result(r)\n  integer(int64), intent(in) :: x\n  integer(int64) :: r\n  r = iand(x + 1, m32)\nend function\npure function dbl(x) result(r)\n  integer(int64), intent(in) :: x\n  integer(int64) :: r\n  r = iand(x + x, m32)\nend function\npure function chain3(x, y) result(r)\n  integer(int64), intent(in) :: x, y\n  integer(int64) :: r\n  r = iand(inc1(dbl(inc1(x))) + y, m32)\nend function',
      branchy:
        'pure function branchy(x, y) result(r)\n  integer(int64), intent(in) :: x, y\n  integer(int64) :: r, m, z\n  if (x < y) then\n    m = iand(y - x, m32)\n  else\n    m = iand(x - y, m32)\n  end if\n  z = m\n  if (x == y) z = 0\n  if (iand(z, 1_int64) == 1) then\n    r = z\n  else\n    r = x\n  end if\nend function',
      arrfill:
        'pure function arrfill(x, y) result(r)\n  integer(int64), intent(in) :: x, y\n  integer(int64) :: r, a(0:7)\n  integer :: i\n  do i = 0, 7\n    a(i) = iand(int(i, int64) + x, m32)\n  end do\n  r = iand(a(mod(y, 8_int64)) + a(3), m32)\nend function',
      loop64:
        'pure function loop64(s0, k) result(r)\n  integer(int64), intent(in) :: s0, k\n  integer(int64) :: r, s, b\n  integer :: i\n  s = s0\n  do i = 0, 63\n    b = mul32(ieor(s, k), 2654435761_int64)\n    s = iand(ieor(b, ishft(b, -15)) + int(i, int64), m32)\n  end do\n  r = s\nend function',
    },
    program: (k, src) => `module kernels
  use iso_fortran_env, only: int64
  implicit none
  integer(int64), parameter :: m32 = 4294967295_int64
contains
  ! u32 product without signed-overflow: split the multiplier into 16-bit halves.
  pure function mul32(a, b) result(r)
    integer(int64), intent(in) :: a, b
    integer(int64) :: r
    r = iand(a * iand(b, 65535_int64) + ishft(iand(a * ishft(b, -16), 65535_int64), 16), m32)
  end function
${src}
end module

program bench
  use iso_fortran_env, only: int64, real64
  use kernels
  implicit none
  integer(int64) :: iters, i, s, acc, c0, c1, rate, ${args(k)}
  character(len=32) :: arg
  real(real64) :: ns
  iters = ${TIER.native}_int64
  if (command_argument_count() >= 1) then
    call get_command_argument(1, arg)
    read (arg, *) iters
  end if
  s = 2654435769_int64
  acc = 0
  call system_clock(c0, rate)
  do i = 1, iters
    ${each(k, (i) => `s = ieor(s, iand(ishft(s, 13), m32)); s = ieor(s, ishft(s, -17)); s = ieor(s, iand(ishft(s, 5), m32)); a${i} = s`, '\n    ')}
    acc = ieor(acc, ${k.name}(${args(k)}))
  end do
  call system_clock(c1)
  ns = real(c1 - c0, real64) * 1d9 / real(rate, real64) / real(iters, real64)
  write (*, '(F0.4, 1X, I0)') ns, acc
end program
`,
    build: (dir, t) => [
      [
        t.bin.main as string,
        [
          '-O2',
          ...(t.bin.sdkLib === undefined || t.bin.sdkLib.length === 0 ? [] : [`-L${t.bin.sdkLib}`]),
          '-o',
          join(dir, 'bench'),
          join(dir, 'bench.f90'),
        ],
      ],
    ],
    run: (dir, _t, iters) => [join(dir, 'bench'), [iters]],
  },
];
