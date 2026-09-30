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
 *  - threads: work >= THREAD_WORK; pthreads, dynamic chunks (8 per thread, so heterogeneous
 *    performance/efficiency cores balance), partials combined in chunk order,
 *  - gpu (mode 'gpu' only, reductions whose body signature is all scalars): work >= GPU_WORK;
 *    Metal through a small Objective-C runtime compiled into the same file when it is built as
 *    Objective-C with -fobjc-arc; built as C (or no Metal device) it falls back to threads.
 * A literal trip count is decided at compile time; a variable one by a runtime test of the same
 * rule. Calls nested inside a parallel chunk run sequentially (thread-local depth), so parallel
 * regions never oversubscribe. `mode: 'off'` (the default of `compile`) emits no parallel code.
 */

import {
  type CFoldSite,
  type CParallel,
  cType,
  hasViewVariant,
  ownedUpdateInPlace,
} from './backends.js';
import {
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

/** Work (n * body cost, in simple operations) from which threads pay for their start and join. */
export const THREAD_WORK = 1 << 20;
/** Work from which a Metal dispatch (encode, commit, wait, read back partials) pays off. */
export const GPU_WORK = 1 << 25;
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

const gpuEligible = (plan: FoldPlan): boolean =>
  plan.kind === 'reduce' && plan.body.params.every(isPrimitive) && isPrimitive(plan.body.result);

/** Strategy for a fold of `n` trips (compile-time decision; variable counts use the same rule). */
export function chooseStrategy(plan: FoldPlan, n: number, mode: ParallelMode): Strategy {
  if (mode === 'off') return 'serial';
  const work = n * bodyCost(plan.body);
  if (mode === 'gpu' && gpuEligible(plan) && work >= GPU_WORK) return 'gpu';
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

/** Threads runtime: dynamic chunks over [0, n), one partial word per chunk. */
const C_THREADS_RUNTIME = `/* A0 parallel folds (src/parallel.ts): pthreads, dynamic chunks, sequential when nested. */
#include <pthread.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <sys/resource.h>
#include <unistd.h>
#define A0PAR_MAX_CHUNKS 512u
#define A0PAR_MAX_THREADS 64u
typedef void (*a0par_fn)(const void *ctx, uint32_t lo, uint32_t hi, uint32_t *out);
typedef struct { a0par_fn fn; const void *ctx; uint32_t n; uint32_t chunk; uint32_t chunks; atomic_uint next; uint32_t *out; } a0par_job;
static _Thread_local unsigned a0par_depth;
static void *a0par_work(void *p) {
  a0par_job *j = (a0par_job *)p;
  a0par_depth += 1u;
  for (;;) {
    const uint32_t k = atomic_fetch_add_explicit(&j->next, 1u, memory_order_relaxed);
    if (k >= j->chunks) break;
    const uint64_t lo = (uint64_t)k * j->chunk;
    const uint64_t end = lo + j->chunk;
    j->fn(j->ctx, (uint32_t)lo, (uint32_t)(end < j->n ? end : j->n), &j->out[k]);
  }
  a0par_depth -= 1u;
  return NULL;
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
/* Worker stack: at least 8 MiB and no smaller than the main thread's soft RLIMIT_STACK,
   so a body whose frame fits on the main thread also fits on a worker. */
static size_t a0par_stack(void) {
  size_t s = (size_t)8u << 20;
  struct rlimit r;
  if (getrlimit(RLIMIT_STACK, &r) == 0 && r.rlim_cur != RLIM_INFINITY && (size_t)r.rlim_cur > s)
    s = (size_t)r.rlim_cur;
  return s;
}
/* Runs fn over [0, n) and returns the number of chunks written to out (at least 1). */
static inline uint32_t a0par_run(a0par_fn fn, const void *ctx, uint32_t n, uint32_t *out) {
  const uint32_t t = a0par_threads();
  if (a0par_depth > 0u || t < 2u || n < 2u) { fn(ctx, 0u, n, out); return 1u; }
  uint32_t chunks = t * 8u < n ? t * 8u : n;
  if (chunks > A0PAR_MAX_CHUNKS) chunks = A0PAR_MAX_CHUNKS;
  const uint32_t chunk = (uint32_t)(((uint64_t)n + chunks - 1u) / chunks);
  chunks = (uint32_t)(((uint64_t)n + chunk - 1u) / chunk);
  a0par_job job = { fn, ctx, n, chunk, chunks, 0u, out };
  pthread_t tid[A0PAR_MAX_THREADS];
  uint32_t started = 0u;
  pthread_attr_t attr;
  const int attr_ok = pthread_attr_init(&attr) == 0;
  if (attr_ok) (void)pthread_attr_setstacksize(&attr, a0par_stack());
  for (uint32_t w = 1u; w < t && w < chunks; w++)
    if (pthread_create(&tid[started], attr_ok ? &attr : NULL, a0par_work, &job) == 0) started++;
  if (attr_ok) pthread_attr_destroy(&attr);
  a0par_work(&job); /* the caller works too; a failed pthread_create only loses a helper */
  for (uint32_t w = 0u; w < started; w++) pthread_join(tid[w], NULL);
  return chunks;
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
/* prm = { n, extra args... }; kernel a0gr in msl writes one partial per thread. */
static bool a0gpu_reduce(const char *msl, const uint32_t *prm, uint32_t nprm, uint32_t op, uint32_t *result) {
  bool ok = false;
  pthread_mutex_lock(&a0gpu_lock);
  @autoreleasepool {
    do {
      if (a0gpu_dead) break;
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
        id<MTLFunction> f = lib == nil ? nil : [lib newFunctionWithName:@"a0gr"];
        pso = f == nil ? nil : [a0gpu_dev newComputePipelineStateWithFunction:f error:&err];
        if (pso == nil) { a0gpu_dead = 1; break; }
        if (a0gpu_sites < A0GPU_SITES) { a0gpu_key[a0gpu_sites] = msl; a0gpu_pso[a0gpu_sites] = pso; a0gpu_sites++; }
      }
      const NSUInteger threads = prm[0] == 0u ? 1u : prm[0] < ${GPU_THREADS}u ? prm[0] : ${GPU_THREADS}u;
      id<MTLBuffer> in = [a0gpu_dev newBufferWithBytes:prm length:nprm * 4u options:MTLResourceStorageModeShared];
      id<MTLBuffer> out = [a0gpu_dev newBufferWithLength:threads * 4u options:MTLResourceStorageModeShared];
      id<MTLCommandBuffer> cb = [a0gpu_queue commandBuffer];
      id<MTLComputeCommandEncoder> enc = [cb computeCommandEncoder];
      [enc setComputePipelineState:pso];
      [enc setBuffer:in offset:0 atIndex:0];
      [enc setBuffer:out offset:0 atIndex:1];
      NSUInteger tg = pso.maxTotalThreadsPerThreadgroup < threads ? pso.maxTotalThreadsPerThreadgroup : threads;
      [enc dispatchThreads:MTLSizeMake(threads, 1, 1) threadsPerThreadgroup:MTLSizeMake(tg, 1, 1)];
      [enc endEncoding];
      [cb commit];
      [cb waitUntilCompleted];
      if (cb.status != MTLCommandBufferStatusCompleted) break;
      const uint32_t *p = (const uint32_t *)out.contents;
      uint32_t acc = p[0];
      for (NSUInteger k = 1; k < threads; k++) acc = a0gpu_combine(op, acc, p[k]);
      *result = acc;
      ok = true;
    } while (0);
  }
  pthread_mutex_unlock(&a0gpu_lock);
  return ok;
}
#else
static inline bool a0gpu_reduce(const char *msl, const uint32_t *prm, uint32_t nprm, uint32_t op, uint32_t *result) {
  (void)msl; (void)prm; (void)nprm; (void)op; (void)result;
  return false;
}
#endif`;

/** The body and its transitive callees, callees first (a standalone program for Metal). */
function subprogram(body: TypedFunc): TypedProgram {
  const order: TypedFunc[] = [];
  const seen = new Set<string>();
  const visit = (f: TypedFunc): void => {
    if (seen.has(f.name)) return;
    seen.add(f.name);
    for (const c of f.calls.values()) visit(c);
    order.push(f);
  };
  visit(body);
  return { functions: order, byName: new Map(order.map((f) => [f.name, f] as const)) };
}

/** MSL for one reduction site: the body's program plus kernel a0gr (strided partials). */
export function reductionMsl(plan: FoldPlan & { kind: 'reduce' }): string {
  const b = plan.body;
  const args = b.params
    .slice(2)
    .map((t, k) => (t === 'bool' ? `(prm[${k + 1}] != 0u)` : `prm[${k + 1}]`));
  const call = [`acc`, 'i', ...args].join(', ');
  return `${emitMetal(subprogram(b))}
kernel void a0gr(device const uint *prm [[buffer(0)]], device uint *out [[buffer(1)]], uint tid [[thread_position_in_grid]], uint nt [[threads_per_grid]]) {
  const uint n = prm[0];
  uint acc = ${IDENTITY[plan.op]}u;
  for (uint i = tid; i < n; ) { acc = a0_${b.name}(${call}); if (n - i <= nt) break; i += nt; }
  out[tid] = acc;
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
    key: `par:${mode}:${force ? 'force' : `${THREAD_WORK}:${GPU_WORK}`}`,
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
  let strategy: Strategy = 'threads';
  if (literal !== undefined && !force) {
    strategy = chooseStrategy(plan, literal, mode);
    if (strategy === 'serial') return undefined;
  } else if (mode === 'gpu' && gpuEligible(plan)) strategy = 'gpu';
  const name = `${fn.name}_${node.id}`;
  const extraTypes = body.params.slice(2);
  const fields = extraTypes.map((t, k) =>
    isPrimitive(t) ? `${cType(t)} x${k};` : `const ${cType(t)} *x${k};`,
  );
  const ctxType = `a0pc_${name}`;
  const ctxDecl = `typedef struct { uint32_t n; ${fields.join(' ')} } ${ctxType};`;
  const xs = extraTypes.map((t, k) => (isPrimitive(t) ? `c->x${k}` : `*c->x${k}`));
  const params = extraTypes.map((t, k) =>
    isPrimitive(t) ? `${cType(t)} x${k}` : `const ${cType(t)} *x${k}`,
  );
  const init = `const ${ctxType} ctx = { n${extraTypes.map((_, k) => `, x${k}`).join('')} };`;
  const argsAt = site.extra.map((e, k) => (isPrimitive(extraTypes[k] as Type) ? e : `&${e}`));
  const workTest =
    literal !== undefined && !force
      ? undefined
      : force
        ? plan.kind === 'map'
          ? `(${site.count}) <= ${plan.length}u`
          : '1'
        : `(uint64_t)(${site.count}) * ${cost}u >= ${THREAD_WORK}u${plan.kind === 'map' ? ` && (${site.count}) <= ${plan.length}u` : ''}`;
  let helper: string;
  let call: string;
  if (plan.kind === 'reduce') {
    const id = hex(IDENTITY[plan.op]);
    // Aggregate extras are read through the body's const-pointer `view` variant (no copies).
    const view = hasViewVariant(body);
    const gpu =
      strategy === 'gpu'
        ? (() => {
            const prm = [
              'n',
              ...extraTypes.map((t, k) => (t === 'bool' ? `(uint32_t)x${k}` : `x${k}`)),
            ];
            return `  if (a0par_depth == 0u${force ? '' : ` && (uint64_t)n * ${cost}u >= ${GPU_WORK}u`}) {
    static const char msl[] = ${JSON.stringify(reductionMsl(plan))};
    const uint32_t prm[] = { ${prm.join(', ')} };
    uint32_t r;
    if (a0gpu_reduce(msl, prm, ${prm.length}u, ${OP_CODE[plan.op]}u, &r)) return r;
  }
`;
          })()
        : '';
    helper = `${ctxDecl}
static void a0pw_${name}(const void *v, uint32_t lo, uint32_t hi, uint32_t *out) {
  const ${ctxType} *c = (const ${ctxType} *)v;
  uint32_t acc = ${id};
  for (uint32_t i = lo; i < hi; i++) acc = ${view ? `a0v_${body.name}(${['acc', 'i', ...extraTypes.map((_, k) => `c->x${k}`)].join(', ')})` : `a0_${body.name}(${['acc', 'i', ...xs].join(', ')})`};
  *out = acc;
}
static uint32_t a0p_${name}(${['uint32_t n', ...params].join(', ')}) {
${gpu}  ${init}
  uint32_t parts[A0PAR_MAX_CHUNKS];
  const uint32_t k = a0par_run(a0pw_${name}, &ctx, n, parts);
  uint32_t acc = ${id};
  for (uint32_t j = 0; j < k; j++) acc = ${combine(plan.op, 'acc', 'parts[j]')};
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
  const ${ctxType} ctx = { n, s${extraTypes.map((_, k) => `, x${k}`).join('')} };
  uint32_t parts[A0PAR_MAX_CHUNKS];
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
