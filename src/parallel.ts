/**
 * Automatic parallel folds (C target).
 *
 * A0 guarantees what a C, Rust, or Zig compiler has to prove (and usually cannot) before it may
 * split a loop across threads: every function is pure (no io in the body's types), values have
 * no aliases, and a `fold` has a trip count known before the first iteration. Two fold shapes
 * are recognized syntactically on the (optimized) body function; nothing is guessed.
 *
 * Reduction: `fold B n s x...` where B(state, i, x...) returns `state OP g(i, x...)`, g does not
 * depend on state, and OP is associative and commutative on u32: wrapping add, wrapping mul,
 * and, or, xor (exact modulo 2^32), or min/max written as `select (lt|le|gt|ge state g) ...`.
 * Then fold = s OP (g(0) OP g(1) OP ... OP g(n-1)) in any grouping and order, so the index range
 * is cut into chunks that run on separate threads (or GPU threads), each starting from OP's
 * identity e, and the partials are combined with OP. Each chunk calls B(acc, i, x...) itself,
 * which is exactly acc OP g(i, x...), so no code is synthesized for g.
 *
 * Map: `fold B n a x...` with array state a where B(a, i, x...) is exactly `set a i h(i, x...)`,
 * h independent of a, and n <= length(a) (so the n indices are distinct): iterations write
 * disjoint elements and read nothing written by another, so any order gives the same array.
 * The owned C variant of B updates element i in place (`ownedUpdateInPlace`, the emitter's own
 * rule), so each chunk writes only its own elements.
 *
 * Strategies, chosen per fold by a cost model (work = n * static cost of one body call):
 *  - serial: the unchanged sequential loop (Clang vectorizes it; that is the SIMD path),
 *  - threads: work >= THREAD_WORK; a persistent pthread pool (created on the first parallel
 *    region, at most A0PAR_MAX_THREADS, joined at exit), static contiguous chunks whose bounds
 *    are multiples of a 128-byte line (map chunks never share a line of the state array), one
 *    partial per thread in its own padded line (no false sharing), combined in thread order,
 *  - gpu (mode 'gpu' only): element-wise maps, and reductions whose extras are scalars or arrays
 *    read only at the fold index (`get x i`); work >= GPU_WORK + GPU_WORD * words copied (array
 *    inputs in, the map result out). The body becomes a scalar element function (reads at i
 *    become scalar parameters; a map's `set` becomes its returned value), emitted to MSL by
 *    `emitMetal`, plus a kernel over device buffers; a small Objective-C runtime in the same file
 *    (active only when built with -x objective-c -fobjc-arc, otherwise a stub) dispatches it;
 *    no device or a failed compile falls back to threads.
 * A literal trip count is decided at compile time; a variable one by a runtime test of the same
 * rule. Calls nested inside a parallel chunk run sequentially (thread-local depth), and a region
 * entered while another thread holds the pool runs sequentially, so regions never oversubscribe. `mode: 'off'` (the default of `compile`) emits no parallel code.
 */

import {
  type CFoldSite,
  type CParallel,
  cType,
  hasViewVariant,
  ownedUpdateInPlace,
} from './backends.js';
import {
  A0Error,
  containsIo,
  isPrimitive,
  type Node,
  type Operand,
  type Type,
  type TypedFunc,
  type TypedProgram,
} from './core.js';
import { emitMetal } from './metal.js';
import { optimizeFunction } from './optimize.js';

export type ReduceOp = 'add' | 'mul' | 'and' | 'or' | 'xor' | 'min' | 'max';

export type FoldPlan =
  | { readonly kind: 'reduce'; readonly op: ReduceOp; readonly body: TypedFunc }
  | { readonly kind: 'map'; readonly length: number; readonly body: TypedFunc };

export type Strategy = 'serial' | 'threads' | 'gpu';
export type ParallelMode = 'off' | 'auto' | 'gpu';

/** Work (n * body cost, in simple operations) from which a pool region (wake, join) pays off. */
export const THREAD_WORK = 1 << 20;
/** Work from which a Metal dispatch (encode, commit, wait, read back partials) pays off. */
export const GPU_WORK = 1 << 25;
/** Cost, in simple operations, of one 32-bit word copied into or out of a Metal buffer. */
export const GPU_WORD = 64;
/** GPU threads per reduction; each writes one partial, combined on the CPU. */
export const GPU_THREADS = 1 << 16;

const IDENTITY: Readonly<Record<ReduceOp, number>> = {
  add: 0,
  mul: 1,
  and: 0xffff_ffff,
  or: 0,
  xor: 0,
  min: 0xffff_ffff,
  max: 0,
};
const OP_CODE: Readonly<Record<ReduceOp, number>> = {
  add: 0,
  mul: 1,
  and: 2,
  or: 3,
  xor: 4,
  min: 5,
  max: 6,
};

const isParam = (o: Operand | undefined, index: number): boolean =>
  o?.kind === 'param' && o.index === index;

/** Node ids whose value depends on parameter `p` (transitively through operands). */
function dependents(fn: TypedFunc, p: number): Set<string> {
  const d = new Set<string>();
  for (const n of fn.nodes)
    if (n.args.some((o) => isParam(o, p) || (o.kind === 'node' && d.has(o.id)))) d.add(n.id);
  return d;
}

const touches = (o: Operand, d: ReadonlySet<string>): boolean =>
  isParam(o, 0) || (o.kind === 'node' && d.has(o.id));

const noIo = (fn: TypedFunc): boolean =>
  !containsIo(fn.result) &&
  !fn.params.some(containsIo) &&
  ![...fn.types.values()].some(containsIo) &&
  [...fn.calls.values()].every(noIo);

/** The min/max a `select c a b` over (state, g) computes when c compares them, else undefined. */
function minMax(cmp: Node, a: Operand, b: Operand): ReduceOp | undefined {
  const [x, y] = cmp.args;
  if (x === undefined || y === undefined) return undefined;
  // Normalize to "c is true when L < R (or L <= R)": then select(c, L, R) is min and
  // select(c, R, L) is max; ties pick equal values, so strict and non-strict agree.
  let l: Operand;
  let r: Operand;
  if (cmp.op === 'lt' || cmp.op === 'le') [l, r] = [x, y];
  else if (cmp.op === 'gt' || cmp.op === 'ge') [l, r] = [y, x];
  else return undefined;
  const same = (p: Operand, q: Operand): boolean =>
    p.kind === q.kind && JSON.stringify(p) === JSON.stringify(q);
  if (same(a, l) && same(b, r)) return 'min';
  if (same(a, r) && same(b, l)) return 'max';
  return undefined;
}

/** Recognize the body of a `fold` (see the module comment); null when no shape is proven. */
export function analyzeBody(body: TypedFunc, count?: Operand): FoldPlan | null {
  const [stateT, indexT] = body.params;
  if (stateT === undefined || indexT !== 'u32' || !noIo(body)) return null;
  const ret = body.ret;
  if (ret.kind !== 'node') return null;
  const d = dependents(body, 0);
  const index = body.nodes.findIndex((n) => n.id === ret.id);
  const r = body.nodes[index];
  if (r === undefined) return null;
  if (stateT === 'u32') {
    if (body.result !== 'u32') return null;
    if (r.op === 'add' || r.op === 'mul' || r.op === 'and' || r.op === 'or' || r.op === 'xor') {
      const [a, b] = r.args as [Operand, Operand];
      const g = isParam(a, 0) ? b : isParam(b, 0) ? a : undefined;
      // Exactly one operand is the state itself, the other is independent of it, and no other
      // node reads the state (d = {r}).
      if (g === undefined || touches(g, d) || d.size !== 1) return null;
      return { kind: 'reduce', op: r.op, body };
    }
    if (r.op === 'select') {
      const [c, a, b] = r.args as [Operand, Operand, Operand];
      if (c.kind !== 'node') return null;
      const cmp = body.nodes.find((n) => n.id === c.id);
      if (cmp === undefined) return null;
      const g = isParam(a, 0) ? b : isParam(b, 0) ? a : undefined;
      if (g === undefined || touches(g, d) || d.size !== 2) return null;
      const [x, y] = cmp.args as [Operand, Operand];
      const operandsOk =
        (isParam(x, 0) && JSON.stringify(y) === JSON.stringify(g)) ||
        (isParam(y, 0) && JSON.stringify(x) === JSON.stringify(g));
      if (!operandsOk) return null;
      const op = minMax(cmp, a, b);
      return op === undefined ? null : { kind: 'reduce', op, body };
    }
    return null;
  }
  if (isPrimitive(stateT) || stateT.kind !== 'arr' || !isPrimitive(stateT.elem)) return null;
  if (r.op !== 'set' || !isParam(r.args[0], 0) || !isParam(r.args[1], 1)) return null;
  const v = r.args[2] as Operand;
  if (touches(v, d) || d.size !== 1 || !ownedUpdateInPlace(body, index)) return null;
  if (count !== undefined && count.kind === 'u32' && count.value > stateT.length) return null;
  return { kind: 'map', length: stateT.length, body };
}

/**
 * Static cost of one call of `fn` in simple operations: 1 per node, callees and fold/loop bodies
 * multiplied by literal trip counts (a variable count counts as 2^32), aggregate literals and
 * whole-value copies by their length. Only compares folds against the thresholds above.
 */
export function bodyCost(fn: TypedFunc, memo = new Map<string, number>()): number {
  const hit = memo.get(fn.name);
  if (hit !== undefined) return hit;
  let c = 0;
  for (const n of fn.nodes) {
    if (n.op === 'call') {
      const callee = fn.calls.get(n.callee ?? '');
      c += 1 + (callee === undefined ? 0 : bodyCost(callee, memo));
    } else if (n.op === 'fold' || n.op === 'loop') {
      const body = fn.calls.get(n.callee ?? '');
      const trips = n.args[0]?.kind === 'u32' ? n.args[0].value : 2 ** 32;
      c += 1 + trips * (body === undefined ? 1 : bodyCost(body, memo));
    } else if (n.op === 'arr') c += n.args.length;
    else if (n.op === 'div' || n.op === 'rem') c += 4;
    else c += 1;
  }
  const cost = Math.min(Math.max(c, 1), 2 ** 40);
  memo.set(fn.name, cost);
  return cost;
}

/** Words one GPU dispatch copies: every array extra in, and the map result out. */
const lengthOf = (t: Type): number => (isPrimitive(t) || t.kind !== 'arr' ? 0 : t.length);

function gpuWords(plan: FoldPlan, n: number): number {
  const arrays = plan.body.params.slice(2).reduce((w, t) => w + lengthOf(t), 0);
  return arrays + (plan.kind === 'map' ? n : 0);
}

/** Strategy for a fold of `n` trips (compile-time decision; variable counts use the same rule). */
export function chooseStrategy(plan: FoldPlan, n: number, mode: ParallelMode): Strategy {
  if (mode === 'off') return 'serial';
  const work = n * bodyCost(plan.body);
  if (
    mode === 'gpu' &&
    gpuKernel(plan) !== undefined &&
    work >= GPU_WORK + GPU_WORD * gpuWords(plan, n)
  )
    return 'gpu';
  return work >= THREAD_WORK ? 'threads' : 'serial';
}

export interface FoldReport {
  readonly function: string;
  readonly node: string;
  readonly body: string;
  readonly plan: 'reduce' | 'map' | 'none';
  readonly op?: ReduceOp;
  readonly trips: number | 'variable';
  readonly bodyCost: number;
  readonly strategy: Strategy | 'runtime';
}

/** Every fold of a program with its recognized shape and chosen strategy. */
export function planProgram(program: TypedProgram, mode: ParallelMode): FoldReport[] {
  const out: FoldReport[] = [];
  for (const fn of program.functions) {
    for (const n of optimizeFunction(fn).fn.nodes) {
      if (n.op !== 'fold') continue;
      const raw = fn.calls.get(n.callee ?? '') ?? program.byName.get(n.callee ?? '');
      if (raw === undefined) continue;
      const plan = analyzeBody(optimizeFunction(raw).fn, n.args[0]);
      const count = n.args[0];
      const trips = count?.kind === 'u32' ? count.value : 'variable';
      out.push({
        function: fn.name,
        node: n.id,
        body: raw.name,
        plan: plan === null ? 'none' : plan.kind,
        ...(plan?.kind === 'reduce' ? { op: plan.op } : {}),
        trips,
        bodyCost: bodyCost(raw),
        strategy:
          plan === null
            ? 'serial'
            : trips === 'variable'
              ? 'runtime'
              : chooseStrategy(plan, trips, mode),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// C emission

const hex = (v: number): string => `0x${v.toString(16)}u`;

function combine(op: ReduceOp, a: string, b: string): string {
  switch (op) {
    case 'add':
      return `(uint32_t)(${a} + ${b})`;
    case 'mul':
      return `(uint32_t)((uint64_t)${a} * (uint64_t)${b})`;
    case 'and':
      return `(${a} & ${b})`;
    case 'or':
      return `(${a} | ${b})`;
    case 'xor':
      return `(${a} ^ ${b})`;
    case 'min':
      return `(${b} < ${a} ? ${b} : ${a})`;
    case 'max':
      return `(${a} < ${b} ? ${b} : ${a})`;
  }
}

/**
 * Threads runtime: a persistent pool. Workers are created once (on the first region), spin
 * briefly on a generation counter after each region and then sleep on a condition variable;
 * an atexit handler wakes and joins them. A region cuts [0, n) into one static chunk per
 * thread, each a multiple of A0PAR_LINE_WORDS long, and each thread writes its partial into
 * its own 128-byte slot. The caller runs chunk 0 itself.
 */
const C_THREADS_RUNTIME = `/* A0 parallel folds (src/parallel.ts): persistent pthread pool, static line-aligned chunks, padded partials. */
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#define A0PAR_MAX_THREADS 64u
/* Chunk bounds are multiples of one 128-byte line (Apple M cache line; two x86-64 lines). */
#define A0PAR_LINE 128u
#define A0PAR_LINE_WORDS (A0PAR_LINE / 4u)
#define A0PAR_SPIN 50000u
typedef void (*a0par_fn)(const void *ctx, uint32_t lo, uint32_t hi, uint32_t *out);
typedef struct { _Alignas(A0PAR_LINE) uint32_t v; } a0par_slot;
static _Thread_local unsigned a0par_depth;
static struct {
  pthread_mutex_t m;
  pthread_cond_t go, done;
  pthread_t tid[A0PAR_MAX_THREADS];
  uint32_t helpers;
  int stop;
  atomic_uint gen, pending;
  atomic_flag busy;
  a0par_fn fn;
  const void *ctx;
  uint32_t n, chunk, parts;
  a0par_slot *out;
} a0par_pool = { .m = PTHREAD_MUTEX_INITIALIZER, .go = PTHREAD_COND_INITIALIZER, .done = PTHREAD_COND_INITIALIZER, .busy = ATOMIC_FLAG_INIT };
static inline void a0par_relax(void) {
#if defined(__aarch64__) || defined(__arm__)
  __asm__ __volatile__("yield");
#elif defined(__x86_64__) || defined(__i386__)
  __builtin_ia32_pause();
#endif
}
/* Worker count: A0_THREADS when set, else the online processors (at most A0PAR_MAX_THREADS). */
static uint32_t a0par_threads(void) {
  static atomic_uint cached;
  uint32_t t = atomic_load_explicit(&cached, memory_order_relaxed);
  if (t == 0u) {
    const char *env = getenv("A0_THREADS");
    long c = env != NULL ? atol(env) : sysconf(_SC_NPROCESSORS_ONLN);
    t = c < 1 ? 1u : c > (long)A0PAR_MAX_THREADS ? A0PAR_MAX_THREADS : (uint32_t)c;
    atomic_store_explicit(&cached, t, memory_order_relaxed);
  }
  return t;
}
static void a0par_chunk(uint32_t w) {
  if (w >= a0par_pool.parts) return;
  const uint64_t lo = (uint64_t)w * a0par_pool.chunk;
  const uint64_t hi = lo + a0par_pool.chunk;
  a0par_pool.fn(a0par_pool.ctx, (uint32_t)lo, (uint32_t)(hi < a0par_pool.n ? hi : a0par_pool.n), &a0par_pool.out[w].v);
}
static void *a0par_worker(void *arg) {
  const uint32_t w = (uint32_t)(uintptr_t)arg;
  a0par_depth = 1u; /* folds inside a chunk run sequentially */
  unsigned seen = 0u;
  for (;;) {
    unsigned g = atomic_load_explicit(&a0par_pool.gen, memory_order_acquire);
    for (uint32_t k = 0u; g == seen && k < A0PAR_SPIN; k++) {
      a0par_relax();
      g = atomic_load_explicit(&a0par_pool.gen, memory_order_acquire);
    }
    if (g == seen) {
      pthread_mutex_lock(&a0par_pool.m);
      while ((g = atomic_load_explicit(&a0par_pool.gen, memory_order_acquire)) == seen && !a0par_pool.stop)
        pthread_cond_wait(&a0par_pool.go, &a0par_pool.m);
      pthread_mutex_unlock(&a0par_pool.m);
      if (g == seen) return NULL; /* stop */
    }
    seen = g;
    a0par_chunk(w);
    if (atomic_fetch_sub_explicit(&a0par_pool.pending, 1u, memory_order_acq_rel) == 1u) {
      pthread_mutex_lock(&a0par_pool.m);
      pthread_cond_signal(&a0par_pool.done);
      pthread_mutex_unlock(&a0par_pool.m);
    }
  }
}
static void a0par_shutdown(void) {
  pthread_mutex_lock(&a0par_pool.m);
  a0par_pool.stop = 1;
  pthread_cond_broadcast(&a0par_pool.go);
  pthread_mutex_unlock(&a0par_pool.m);
  for (uint32_t w = 0u; w < a0par_pool.helpers; w++) pthread_join(a0par_pool.tid[w], NULL);
  a0par_pool.helpers = 0u;
}
static void a0par_start(void) {
  const uint32_t t = a0par_threads();
  /* Helpers are numbered 1.. (the caller is 0); a failed pthread_create only loses helpers. */
  for (uint32_t w = 1u; w < t; w++) {
    if (pthread_create(&a0par_pool.tid[a0par_pool.helpers], NULL, a0par_worker, (void *)(uintptr_t)(a0par_pool.helpers + 1u)) != 0) break;
    a0par_pool.helpers++;
  }
  if (a0par_pool.helpers > 0u) atexit(a0par_shutdown);
}
/* Runs fn over [0, n) and returns the number of slots written to out (at least 1). */
static inline uint32_t a0par_run(a0par_fn fn, const void *ctx, uint32_t n, a0par_slot *out) {
  static pthread_once_t once = PTHREAD_ONCE_INIT;
  if (a0par_depth > 0u || n < 2u * A0PAR_LINE_WORDS || a0par_threads() < 2u ||
      atomic_flag_test_and_set_explicit(&a0par_pool.busy, memory_order_acquire)) {
    fn(ctx, 0u, n, &out[0].v);
    return 1u;
  }
  pthread_once(&once, a0par_start);
  const uint32_t t = a0par_pool.helpers + 1u;
  if (t < 2u) {
    atomic_flag_clear_explicit(&a0par_pool.busy, memory_order_release);
    fn(ctx, 0u, n, &out[0].v);
    return 1u;
  }
  uint64_t chunk = ((uint64_t)n + t - 1u) / t;
  chunk = (chunk + A0PAR_LINE_WORDS - 1u) / A0PAR_LINE_WORDS * A0PAR_LINE_WORDS;
  a0par_pool.fn = fn;
  a0par_pool.ctx = ctx;
  a0par_pool.n = n;
  a0par_pool.chunk = (uint32_t)chunk;
  a0par_pool.parts = (uint32_t)(((uint64_t)n + chunk - 1u) / chunk);
  a0par_pool.out = out;
  atomic_store_explicit(&a0par_pool.pending, a0par_pool.helpers, memory_order_relaxed);
  pthread_mutex_lock(&a0par_pool.m);
  atomic_fetch_add_explicit(&a0par_pool.gen, 1u, memory_order_release);
  pthread_cond_broadcast(&a0par_pool.go);
  pthread_mutex_unlock(&a0par_pool.m);
  a0par_depth += 1u;
  a0par_chunk(0u);
  a0par_depth -= 1u;
  for (uint32_t k = 0u; atomic_load_explicit(&a0par_pool.pending, memory_order_acquire) != 0u && k < A0PAR_SPIN; k++) a0par_relax();
  if (atomic_load_explicit(&a0par_pool.pending, memory_order_acquire) != 0u) {
    pthread_mutex_lock(&a0par_pool.m);
    while (atomic_load_explicit(&a0par_pool.pending, memory_order_acquire) != 0u)
      pthread_cond_wait(&a0par_pool.done, &a0par_pool.m);
    pthread_mutex_unlock(&a0par_pool.m);
  }
  const uint32_t parts = a0par_pool.parts;
  atomic_flag_clear_explicit(&a0par_pool.busy, memory_order_release);
  return parts;
}`;

/**
 * Metal runtime, active only when the file is compiled as Objective-C with ARC on Apple
 * platforms; otherwise a stub that reports "not run" so the caller uses threads.
 */
const C_GPU_RUNTIME = `#if defined(__OBJC__) && defined(__APPLE__)
#if !__has_feature(objc_arc)
#error "the A0 Metal runtime needs -fobjc-arc"
#endif
#import <Metal/Metal.h>
#include <stdio.h>
#define A0GPU_SITES 64u
static pthread_mutex_t a0gpu_lock = PTHREAD_MUTEX_INITIALIZER;
static id<MTLDevice> a0gpu_dev;
static id<MTLCommandQueue> a0gpu_queue;
static int a0gpu_dead;
static const char *a0gpu_key[A0GPU_SITES];
static id<MTLComputePipelineState> a0gpu_pso[A0GPU_SITES];
static unsigned a0gpu_sites;
static uint32_t a0gpu_combine(uint32_t op, uint32_t a, uint32_t b) {
  switch (op) {
    case 0u: return a + b;
    case 1u: return (uint32_t)((uint64_t)a * b);
    case 2u: return a & b;
    case 3u: return a | b;
    case 4u: return a ^ b;
    case 5u: return b < a ? b : a;
    default: return a < b ? b : a;
  }
}
/* One dispatch of kernel a0gk in msl over grid threads. Buffer 0 = prm (n, scalar extras),
   buffer 1 = grid output words, buffers 2.. = the arrays arr[k] of words[k] words. op 0-6
   combines the grid partials with that operation into *result; op 7 (a map) copies the grid
   words to result. False when there is no device or the kernel does not build or run. */
static bool a0gpu_run(const char *msl, const uint32_t *prm, uint32_t nprm, const uint32_t *const *arr, const uint32_t *words, uint32_t narr, uint32_t grid, uint32_t op, uint32_t *result) {
  bool ok = false;
  pthread_mutex_lock(&a0gpu_lock);
  @autoreleasepool {
    do {
      if (a0gpu_dead || grid == 0u) break;
      if (a0gpu_dev == nil) {
        a0gpu_dev = MTLCreateSystemDefaultDevice();
        if (a0gpu_dev == nil) { a0gpu_dead = 1; break; }
        a0gpu_queue = [a0gpu_dev newCommandQueue];
      }
      id<MTLComputePipelineState> pso = nil;
      for (unsigned k = 0; k < a0gpu_sites; k++) if (a0gpu_key[k] == msl) pso = a0gpu_pso[k];
      if (pso == nil) {
        NSError *err = nil;
        id<MTLLibrary> lib = [a0gpu_dev newLibraryWithSource:@(msl) options:nil error:&err];
        id<MTLFunction> f = lib == nil ? nil : [lib newFunctionWithName:@"a0gk"];
        pso = f == nil ? nil : [a0gpu_dev newComputePipelineStateWithFunction:f error:&err];
        if (pso == nil) { a0gpu_dead = 1; break; }
        if (a0gpu_sites < A0GPU_SITES) { a0gpu_key[a0gpu_sites] = msl; a0gpu_pso[a0gpu_sites] = pso; a0gpu_sites++; }
      }
      id<MTLBuffer> in = [a0gpu_dev newBufferWithBytes:prm length:nprm * 4u options:MTLResourceStorageModeShared];
      id<MTLBuffer> out = [a0gpu_dev newBufferWithLength:(NSUInteger)grid * 4u options:MTLResourceStorageModeShared];
      if (in == nil || out == nil) break;
      id<MTLCommandBuffer> cb = [a0gpu_queue commandBuffer];
      id<MTLComputeCommandEncoder> enc = [cb computeCommandEncoder];
      [enc setComputePipelineState:pso];
      [enc setBuffer:in offset:0 atIndex:0];
      [enc setBuffer:out offset:0 atIndex:1];
      bool buffers = true;
      for (uint32_t k = 0u; k < narr; k++) {
        id<MTLBuffer> b = [a0gpu_dev newBufferWithBytes:arr[k] length:(NSUInteger)words[k] * 4u options:MTLResourceStorageModeShared];
        if (b == nil) { buffers = false; break; }
        [enc setBuffer:b offset:0 atIndex:2u + k];
      }
      if (!buffers) { [enc endEncoding]; break; }
      NSUInteger tg = pso.maxTotalThreadsPerThreadgroup < grid ? pso.maxTotalThreadsPerThreadgroup : grid;
      [enc dispatchThreads:MTLSizeMake(grid, 1, 1) threadsPerThreadgroup:MTLSizeMake(tg, 1, 1)];
      [enc endEncoding];
      [cb commit];
      [cb waitUntilCompleted];
      if (cb.status != MTLCommandBufferStatusCompleted) break;
      const uint32_t *p = (const uint32_t *)out.contents;
      if (op == 7u) memcpy(result, p, (size_t)grid * 4u);
      else {
        uint32_t acc = p[0];
        for (uint32_t k = 1u; k < grid; k++) acc = a0gpu_combine(op, acc, p[k]);
        *result = acc;
      }
      ok = true;
    } while (0);
  }
  pthread_mutex_unlock(&a0gpu_lock);
  /* A0_GPU_LOG=1 reports each dispatch on stderr (tests and benchmarks check the GPU ran). */
  if (getenv("A0_GPU_LOG") != NULL) fprintf(stderr, "a0gpu %s\\n", ok ? "ran" : "fallback");
  return ok;
}
#else
static inline bool a0gpu_run(const char *msl, const uint32_t *prm, uint32_t nprm, const uint32_t *const *arr, const uint32_t *words, uint32_t narr, uint32_t grid, uint32_t op, uint32_t *result) {
  (void)msl; (void)prm; (void)nprm; (void)arr; (void)words; (void)narr; (void)grid; (void)op; (void)result;
  return false;
}
#endif`;

/** The function and its transitive callees, callees first (a standalone program for Metal). */
function subprogram(fn: TypedFunc): TypedProgram {
  const order: TypedFunc[] = [];
  const seen = new Set<string>();
  const visit = (f: TypedFunc): void => {
    if (seen.has(f.name)) return;
    seen.add(f.name);
    for (const c of f.calls.values()) visit(c);
    order.push(f);
  };
  visit(fn);
  return { functions: order, byName: new Map(order.map((f) => [f.name, f] as const)) };
}

const isU32Array = (t: Type): boolean => !isPrimitive(t) && t.kind === 'arr' && t.elem === 'u32';

/**
 * The element function of a GPU-eligible fold, or null: the body with the same parameter
 * positions where every array extra (u32 elements, read only by `get x p1`) becomes the scalar
 * element x[p1 % length] and each such `get` a `mov` of it; for a map, parameter 0 becomes an
 * unused u32 and the final `set p0 p1 v` is dropped, returning v. For a reduction it computes
 * B(acc, i, x...) and for a map h(i, x...), exactly, for every i < n.
 */
export function elementFunction(plan: FoldPlan): TypedFunc | null {
  const b = plan.body;
  const params: Type[] = [...b.params];
  for (let k = 2; k < params.length; k++) {
    const t = params[k] as Type;
    if (t === 'u32' || t === 'bool') continue;
    if (!isU32Array(t)) return null;
    const readsOnlyAtIndex = b.nodes.every((n) =>
      n.args.every(
        (o, j) => !isParam(o, k) || (n.op === 'get' && j === 0 && isParam(n.args[1], 1)),
      ),
    );
    if (!readsOnlyAtIndex || isParam(b.ret, k)) return null;
    params[k] = 'u32';
  }
  const isArrayRead = (n: Node): boolean =>
    n.op === 'get' && n.args[0]?.kind === 'param' && n.args[0].index >= 2;
  let nodes: Node[] = b.nodes.map((n) =>
    isArrayRead(n) ? { id: n.id, op: 'mov', args: [n.args[0] as Operand] } : n,
  );
  let ret = b.ret;
  let result = b.result;
  const types = new Map(b.types);
  if (plan.kind === 'map') {
    if (!isU32Array(b.params[0] as Type) || b.ret.kind !== 'node') return null;
    const last = b.ret.id;
    const set = nodes.find((n) => n.id === last);
    if (set === undefined) return null;
    ret = set.args[2] as Operand;
    result = 'u32';
    params[0] = 'u32';
    nodes = nodes.filter((n) => n.id !== last);
    types.delete(last);
  }
  const names = new Set(subprogram(b).functions.map((f) => f.name));
  let name = `${b.name}_elem`;
  while (names.has(name)) name = `${name}_`;
  return { ...b, name, params, result, nodes, ret, types };
}

const gpuKernels = new WeakMap<TypedFunc, string | null>();

/**
 * MSL for one GPU site, or undefined when the fold has no GPU form: the element function's
 * program (emitMetal) plus kernel a0gk. A reduction runs up to GPU_THREADS threads, each folding
 * a strided index set from OP's identity into one partial; a map runs one thread per index.
 */
export function gpuKernel(plan: FoldPlan): string | undefined {
  const cached = gpuKernels.get(plan.body);
  if (cached !== undefined) return cached ?? undefined;
  const msl = buildKernel(plan);
  gpuKernels.set(plan.body, msl ?? null);
  return msl;
}

function buildKernel(plan: FoldPlan): string | undefined {
  const e = elementFunction(plan);
  if (e === null) return undefined;
  let lib: string;
  try {
    lib = emitMetal(subprogram(e));
  } catch (err) {
    if (err instanceof A0Error) return undefined; // e.g. a callee's array exceeds Metal's limit
    throw err;
  }
  const extras = plan.body.params.slice(2);
  let scalar = 0;
  let array = 0;
  const bufs: string[] = [];
  const args = extras.map((t) => {
    if (isPrimitive(t)) {
      scalar += 1;
      return t === 'bool' ? `(prm[${scalar}] != 0u)` : `prm[${scalar}]`;
    }
    const k = array++;
    bufs.push(`device const uint *a${k} [[buffer(${2 + k})]]`);
    return `a${k}[i % ${t.kind === 'arr' ? t.length : 1}u]`;
  });
  const head = [
    'device const uint *prm [[buffer(0)]]',
    'device uint *out [[buffer(1)]]',
    ...bufs,
    'uint tid [[thread_position_in_grid]]',
    'uint nt [[threads_per_grid]]',
  ].join(', ');
  const body =
    plan.kind === 'reduce'
      ? `  const uint n = prm[0];
  uint acc = ${IDENTITY[plan.op]}u;
  for (uint i = tid; i < n; ) { acc = a0_${e.name}(${['acc', 'i', ...args].join(', ')}); if (n - i <= nt) break; i += nt; }
  out[tid] = acc;`
      : `  const uint i = tid;
  (void)nt;
  if (i < prm[0]) out[i] = a0_${e.name}(${['0u', 'i', ...args].join(', ')});`;
  return `${lib}
kernel void a0gk(${head}) {
${body}
}
`;
}

interface Options {
  readonly mode: ParallelMode;
  /** Take the parallel path for every recognized fold regardless of the cost model (tests). */
  readonly force?: boolean;
}

/**
 * The `cParallel` compile option: `compile(program, 'c', { cParallel: parallelC({ mode }) })`.
 * Mode 'off' returns undefined (the plain sequential C output).
 */
export function parallelC(options: Options): CParallel | undefined {
  const { mode } = options;
  if (mode === 'off') return undefined;
  const force = options.force === true;
  return {
    key: `par:${mode}:${force ? 'force' : `${THREAD_WORK}:${GPU_WORK}:${GPU_WORD}`}`,
    runtime: mode === 'gpu' ? `${C_THREADS_RUNTIME}\n${C_GPU_RUNTIME}` : C_THREADS_RUNTIME,
    fold: (site) => emitSite(site, mode, force),
  };
}

function emitSite(
  site: CFoldSite,
  mode: ParallelMode,
  force: boolean,
): { helpers: [string, string][]; text: string } | undefined {
  const { fn, node } = site;
  if (node.op !== 'fold') return undefined;
  const raw = fn.calls.get(node.callee ?? '');
  if (raw === undefined) return undefined;
  const body = optimizeFunction(raw).fn;
  const countOperand = node.args[0] as Operand;
  const plan = analyzeBody(body, countOperand);
  if (plan === null) return undefined;
  // Capped so n * cost stays inside uint64 in the emitted runtime test.
  const cost = Math.min(bodyCost(body), 2 ** 31);
  const literal = countOperand.kind === 'u32' ? countOperand.value : undefined;
  const msl = mode === 'gpu' ? gpuKernel(plan) : undefined;
  let strategy: Strategy = 'threads';
  if (literal !== undefined && !force) {
    strategy = chooseStrategy(plan, literal, mode);
    if (strategy === 'serial') return undefined;
  } else if (msl !== undefined) strategy = 'gpu';
  const name = `${fn.name}_${node.id}`;
  const extraTypes = body.params.slice(2);
  const fields = extraTypes.map((t, k) =>
    isPrimitive(t) ? `${cType(t)} x${k};` : `const ${cType(t)} *x${k};`,
  );
  const ctxType = `a0pc_${name}`;
  const xs = extraTypes.map((t, k) => (isPrimitive(t) ? `c->x${k}` : `*c->x${k}`));
  const params = extraTypes.map((t, k) =>
    isPrimitive(t) ? `${cType(t)} x${k}` : `const ${cType(t)} *x${k}`,
  );
  const argsAt = site.extra.map((e, k) => (isPrimitive(extraTypes[k] as Type) ? e : `&${e}`));
  const bound = plan.kind === 'map' ? ` && (${site.count}) <= ${plan.length}u` : '';
  const workTest =
    literal !== undefined && !force
      ? undefined
      : force
        ? plan.kind === 'map'
          ? `(${site.count}) <= ${plan.length}u`
          : '1'
        : `(uint64_t)(${site.count}) * ${cost}u >= ${THREAD_WORK}u${bound}`;
  // GPU dispatch (tried first; false means no device or no kernel, and threads run instead).
  let gpu = '';
  if (strategy === 'gpu' && msl !== undefined) {
    const scalars = extraTypes.flatMap((t, k) =>
      isPrimitive(t) ? [t === 'bool' ? `(uint32_t)x${k}` : `x${k}`] : [],
    );
    const arrays = extraTypes.flatMap((t, k) => (isPrimitive(t) ? [] : [{ t, k }]));
    const words = arrays.reduce((w, { t }) => w + lengthOf(t), 0);
    const grid = plan.kind === 'reduce' ? `n < ${GPU_THREADS}u ? n : ${GPU_THREADS}u` : 'n';
    const moved = plan.kind === 'map' ? `(uint64_t)n + ${words}u` : `${words}u`;
    const gate = force
      ? ''
      : ` && (uint64_t)n * ${cost}u >= ${GPU_WORK}u + ${GPU_WORD}u * (${moved})`;
    const arr =
      arrays.length === 0
        ? 'NULL, NULL'
        : `(const uint32_t *const[]){ ${arrays.map(({ k }) => `x${k}->e`).join(', ')} }, (const uint32_t[]){ ${arrays.map(({ t }) => `${lengthOf(t)}u`).join(', ')} }`;
    const prm = ['n', ...scalars];
    const target = plan.kind === 'reduce' ? '&r' : 's->e';
    gpu = `  if (a0par_depth == 0u && n > 0u${gate}) {
    static const char msl[] = ${JSON.stringify(msl)};
    const uint32_t prm[] = { ${prm.join(', ')} };
${plan.kind === 'reduce' ? '    uint32_t r;\n' : ''}    if (a0gpu_run(msl, prm, ${prm.length}u, ${arr}, ${arrays.length}u, ${grid}, ${plan.kind === 'reduce' ? OP_CODE[plan.op] : 7}u, ${target})) return${plan.kind === 'reduce' ? ' r' : ''};
  }
`;
  }
  let helper: string;
  let call: string;
  if (plan.kind === 'reduce') {
    const id = hex(IDENTITY[plan.op]);
    // Aggregate extras are read through the body's const-pointer `view` variant (no copies).
    const view = hasViewVariant(body);
    const step = view
      ? `a0v_${body.name}(${['acc', 'i', ...extraTypes.map((_, k) => `c->x${k}`)].join(', ')})`
      : `a0_${body.name}(${['acc', 'i', ...xs].join(', ')})`;
    helper = `typedef struct { uint32_t n; ${fields.join(' ')} } ${ctxType};
static void a0pw_${name}(const void *v, uint32_t lo, uint32_t hi, uint32_t *out) {
  const ${ctxType} *c = (const ${ctxType} *)v;
  uint32_t acc = ${id};
  for (uint32_t i = lo; i < hi; i++) acc = ${step};
  *out = acc;
}
static uint32_t a0p_${name}(${['uint32_t n', ...params].join(', ')}) {
${gpu}  const ${ctxType} ctx = { n${extraTypes.map((_, k) => `, x${k}`).join('')} };
  a0par_slot parts[A0PAR_MAX_THREADS];
  const uint32_t k = a0par_run(a0pw_${name}, &ctx, n, parts);
  uint32_t acc = ${id};
  for (uint32_t j = 0; j < k; j++) acc = ${combine(plan.op, 'acc', 'parts[j].v')};
  return acc;
}`;
    call = `${site.state} = ${combine(plan.op, site.state, `a0p_${name}(${[site.count, ...argsAt].join(', ')})`)};`;
  } else {
    const st = cType(body.params[0] as Type);
    helper = `typedef struct { uint32_t n; ${st} *s; ${fields.join(' ')} } ${ctxType};
static void a0pw_${name}(const void *v, uint32_t lo, uint32_t hi, uint32_t *out) {
  const ${ctxType} *c = (const ${ctxType} *)v;
  for (uint32_t i = lo; i < hi; i++) a0o_${body.name}(${['c->s', 'i', ...xs].join(', ')});
  *out = 0u;
}
static void a0p_${name}(${[`${st} *s`, 'uint32_t n', ...params].join(', ')}) {
${gpu}  const ${ctxType} ctx = { n, s${extraTypes.map((_, k) => `, x${k}`).join('')} };
  a0par_slot parts[A0PAR_MAX_THREADS];
  (void)a0par_run(a0pw_${name}, &ctx, n, parts);
}`;
    call = `a0p_${name}(${[`&${site.state}`, site.count, ...argsAt].join(', ')});`;
  }
  const decl = site.decl.length > 0 ? `  ${site.decl}\n` : '';
  const text =
    workTest === undefined
      ? `${decl}  ${call}`
      : `${decl}  if (${workTest}) { ${call} } else { ${site.loop} }`;
  return { helpers: [[name, helper]], text };
}
