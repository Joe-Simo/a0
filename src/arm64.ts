/**
 * Direct native backend: AArch64 assembly for macOS on Apple silicon (Darwin arm64 ABI).
 * A0 reaches the machine through this code generator plus the system assembler and linker
 * only; no C is generated for the program.
 *
 * Scope: functions over u32 and bool, fixed-size arrays and records of them (value
 * semantics), every scalar op with A0's exact meaning, `call`, `fold`, and `loop` as real
 * loops with literal or variable trip counts. io functions are refused (the C path covers
 * them).
 *
 * Representation: every value is a sequence of 32-bit words. u32 is one word, bool is one
 * word holding 0 or 1, an array is its elements back to back, a record its fields in order.
 *
 * Code shape (third version):
 * - Small callees (at most INLINE_MAX_NODES nodes, nested to INLINE_MAX_DEPTH) are inlined
 *   at `call`, `fold`, and `loop` sites: the body's nodes are emitted in the caller's frame
 *   with its parameters bound to the caller's values, so an iteration is a branch, not a
 *   call. Larger callees are called out of line.
 * - Scalars live in registers. A linear scan over definition order gives each u32/bool
 *   value a home among the callee-saved w19-w28 (spilled to a stack slot when they run
 *   out); a function with no residual call is a leaf and also uses w0-w7, keeping parameter
 *   i in w_i. Loop state and counters are ordinary scalars, so a scalar fold is a register
 *   loop. Callee-saved registers survive residual calls, so nothing is saved around a call.
 *   The body's returned value shares the loop state's register when the state is not read
 *   after that value is defined, so the per-iteration state move disappears.
 * - Literals that need a movz/movk pair (above 4095, not an immediate of their operation)
 *   and are read inside a loop body are materialized once before the loop.
 * - Aggregates live in stack slots. A `set`/`put` on a value that is provably unshared (the
 *   same `mutableHere` analysis as the JavaScript backend: a fresh allocation or the owned
 *   iteration state, read only by `get`/`at` before this node, not returned) writes the
 *   element in place and the result aliases the container's slot; `mov` and an inlined
 *   callee's result alias likewise. Element addressing uses the scaled register form
 *   (`[x16, w, uxtw #2]`), and an index that is the counter of a fold over the whole array
 *   needs no mask. An all-zero array literal is a NEON store loop, and is not written at
 *   all when its only use is the initial state of a fold that overwrites every element.
 * - Element-wise fold bodies are vectorized. A fold with a literal trip count N (a multiple
 *   of 4) whose body reads arrays only at the counter, writes the state only at the counter
 *   (or reduces a scalar state with add/xor/or/and/mul, all associative and commutative on
 *   wrapping u32), and uses only NEON-representable ops (add sub mul and or xor, shifts by
 *   literals, comparisons, select) runs four elements per iteration in v registers. The
 *   language guarantees that make this sound are value semantics (no aliasing between the
 *   state and the arrays it reads) and the static bound (index i < N is the array length).
 *
 * Calling convention (compatible with AAPCS64/Darwin for scalar signatures, so C can call
 * `_a0_<name>` directly):
 * - Each parameter takes the next of x0..x7: a scalar as its value in the w register (bool
 *   zero-extended to 0/1), an aggregate as a pointer to a caller-owned slot that the caller
 *   never changes. The callee copies aggregate parameters into its own slots on entry and
 *   never writes through the pointer.
 * - After eight, parameters go to the stack at Darwin's natural packing: u32 4 bytes
 *   (align 4), bool 1 byte, pointer 8 bytes (align 8), starting at the caller's sp.
 * - A scalar result returns in w0. An aggregate result is written through x8 (the sret
 *   pointer), after all parameters were copied, so x8 may alias an argument slot (fold
 *   state updates rely on this).
 *
 * Frame layout (sp is fixed after the prologue; all slots are addressed from sp):
 *
 *     incoming stack parameters     x29 + 16 + ...
 *     saved x29, x30                <- x29
 *     value slots (S bytes)         sp + O ... sp + O + S - 1
 *       (callee-saved register save area, sret pointer, aggregates, spilled scalars)
 *     outgoing stack arguments      sp ... sp + O - 1
 *
 * S and O are rounded to 16. Frames above 4 KiB are probed one page at a time in the
 * prologue. Scratch: w9-w15 data, x16/x17 addresses; x17 is reserved for large-offset
 * addressing. Vector registers v0-v7 and v16-v31 (all caller-saved) are used only inside
 * copy/zero loops and vectorized folds, never across a call.
 */

import {
  A0Error,
  borrowLive,
  containsIo,
  isPrimitive,
  type Node,
  type Op,
  type Operand,
  type Type,
  type TypedFunc,
  validateFunction,
} from './core.js';

function refuse(message: string): never {
  throw new A0Error(`arm64: ${message}`, undefined, {
    code: 'structure',
    fix: 'compile io functions with the c target; the arm64 backend covers io-free functions',
  });
}

/** Size of a value in 32-bit words. */
function words(t: Type): number {
  if (t === 'u32' || t === 'bool') return 1;
  if (t === 'io') return refuse('io values are not supported by this backend');
  if (t.kind === 'arr') return t.length * words(t.elem);
  return t.fields.reduce((n, f) => n + words(f), 0);
}

const align = (n: number, a: number): number => Math.ceil(n / a) * a;

const INLINE_MAX_NODES = 512;
const INLINE_MAX_DEPTH = 6;
/** Literals hoisted out of one loop (each takes a register for the loop's extent). */
const HOIST_MAX = 6;
const CALLEE_SAVED = ['w19', 'w20', 'w21', 'w22', 'w23', 'w24', 'w25', 'w26', 'w27', 'w28'];
const ARG_REGS = ['w0', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7'];

const FRESH_OPS = new Set<Op>(['arr', 'rec', 'set', 'put']);

function sameOp(x: Operand, y: Operand): boolean {
  return (
    (x.kind === 'node' && y.kind === 'node' && x.id === y.id) ||
    (x.kind === 'param' && y.kind === 'param' && x.index === y.index)
  );
}

const isParam = (o: Operand | undefined, index: number): boolean =>
  o !== undefined && o.kind === 'param' && o.index === index;

/**
 * May the aggregate operand `o` be updated in place by the node at `index`? The same
 * analysis as the JavaScript backend: sound when the value is provably unshared (a fresh
 * allocation or the owned state parameter p0), every other use is a `get`/`at` read before
 * `index`, and it is not returned.
 */
function mutableHere(
  fn: TypedFunc,
  o: Operand,
  index: number,
  position: number,
  ownedP0: boolean,
): boolean {
  if (o.kind === 'node') {
    const def = fn.nodes.find((n) => n.id === o.id);
    if (def === undefined || !FRESH_OPS.has(def.op)) return false;
  } else if (!(o.kind === 'param' && o.index === 0 && ownedP0)) {
    return false;
  }
  if (sameOp(fn.ret, o)) return false;
  for (const [j, n] of fn.nodes.entries()) {
    for (const [k, arg] of n.args.entries()) {
      if (!sameOp(arg, o)) continue;
      // The updating node itself may name `o` only as its target: a fold whose initial value is
      // also an extra argument reads that value on every trip, so the state needs its own copy.
      if (j === index) {
        if (k !== position) return false;
        continue;
      }
      if (j > index) return false;
      if (!((n.op === 'get' || n.op === 'at') && k === 0)) return false;
    }
  }
  // A borrowed read (`at`, or `get` at a literal index) names part of `o`'s storage.
  const writes = fn.nodes[index]?.op === 'set' || fn.nodes[index]?.op === 'put';
  return !borrowLive(fn, o, index, writes);
}

/** An all-zero literal of an array of scalars. */
function zeroArray(fn: TypedFunc, n: Node): boolean {
  const t = fn.types.get(n.id);
  return (
    n.op === 'arr' &&
    t !== undefined &&
    !isPrimitive(t) &&
    t.kind === 'arr' &&
    isPrimitive(t.elem) &&
    n.args.every((o) => (o.kind === 'u32' && o.value === 0) || (o.kind === 'bool' && !o.value))
  );
}

/**
 * Does every trip of `body` (as a fold body) write state element i (`set p0 p1 v` is the
 * result) without reading the state at all? Then a fold over the whole array overwrites
 * every element of its initial value before anything can observe it.
 */
function writesEveryElement(body: TypedFunc): boolean {
  const ret = body.ret;
  if (ret.kind !== 'node') return false;
  const set = body.nodes.find((n) => n.id === ret.id);
  if (set === undefined || set.op !== 'set' || !isParam(set.args[0], 0) || !isParam(set.args[1], 1))
    return false;
  return body.nodes.every((n) => n === set || n.args.every((a) => !isParam(a, 0)));
}

/**
 * Is the zero array at `index` dead storage: its only use is the initial state of a `fold`
 * whose literal trip count is the array length and whose body writes element i on every
 * trip without reading the state? Its zero fill is then unobservable and is skipped.
 */
function deadZeroFill(fn: TypedFunc, index: number): boolean {
  const node = fn.nodes[index] as Node;
  const me: Operand = { kind: 'node', id: node.id };
  if (sameOp(fn.ret, me)) return false;
  let use: { n: Node; k: number } | undefined;
  let count = 0;
  for (const n of fn.nodes)
    for (const [k, a] of n.args.entries())
      if (sameOp(a, me)) {
        count += 1;
        use = { n, k };
      }
  if (count !== 1 || use === undefined || use.n.op !== 'fold' || use.k !== 1) return false;
  const trips = use.n.args[0];
  if (trips === undefined || trips.kind !== 'u32' || trips.value !== node.args.length) return false;
  const body = fn.calls.get(use.n.callee ?? '');
  return body !== undefined && writesEveryElement(body);
}

const FEEDABLE: ReadonlySet<Op> = new Set<Op>([
  'mov',
  'add',
  'sub',
  'mul',
  'and',
  'or',
  'xor',
  'shl',
  'shr',
  'div',
  'rem',
  'eq',
  'ne',
  'lt',
  'le',
  'gt',
  'ge',
  'select',
  'get',
  'at',
]);
const FEEDS = new WeakMap<TypedFunc, ReadonlyMap<string, { arr: string; word: number }>>();

/**
 * Scalars whose only use is one element of an aggregate literal (`arr`/`rec`) built later
 * in the same body: they are written straight into the literal's slot when computed, so
 * they hold no register while the other elements are computed.
 */
function feedsOf(fn: TypedFunc): ReadonlyMap<string, { arr: string; word: number }> {
  const have = FEEDS.get(fn);
  if (have !== undefined) return have;
  const uses = new Map<string, number>();
  const count = (o: Operand): void => {
    if (o.kind === 'node') uses.set(o.id, (uses.get(o.id) ?? 0) + 1);
  };
  for (const n of fn.nodes) n.args.forEach(count);
  count(fn.ret);
  const ops = new Map(fn.nodes.map((n) => [n.id, n.op]));
  const out = new Map<string, { arr: string; word: number }>();
  for (const n of fn.nodes) {
    if (n.op !== 'arr' && n.op !== 'rec') continue;
    let word = 0;
    for (const o of n.args) {
      const t = o.kind === 'node' ? fn.types.get(o.id) : undefined;
      if (
        o.kind === 'node' &&
        t !== undefined &&
        isPrimitive(t) &&
        uses.get(o.id) === 1 &&
        FEEDABLE.has(ops.get(o.id) ?? 'fold')
      )
        out.set(o.id, { arr: n.id, word });
      word += o.kind === 'node' ? words(fn.types.get(o.id) ?? 'u32') : 1;
    }
  }
  FEEDS.set(fn, out);
  return out;
}

/** Where each parameter travels: a register index, or a byte offset in the stack area. */
interface ArgPlace {
  readonly reg?: number;
  readonly stack?: number;
  readonly size: 1 | 4 | 8;
}

/** Darwin arm64 placement for a parameter list; `bytes` is the stack area used. */
function argLayout(params: readonly Type[]): { places: ArgPlace[]; bytes: number } {
  let next = 0;
  let offset = 0;
  const places = params.map((t): ArgPlace => {
    const size = isPrimitive(t) ? (t === 'bool' ? 1 : 4) : 8;
    if (next < 8) return { reg: next++, size };
    offset = align(offset, size);
    const place: ArgPlace = { stack: offset, size };
    offset += size;
    return place;
  });
  return { places, bytes: offset };
}

/** 32/64-bit immediate materialization with movz/movk. */
function movImm(reg: string, value: number): string[] {
  const lo = value & 0xffff;
  const hi = Math.floor(value / 0x10000) & 0xffff;
  const out = [`movz ${reg}, #${lo}`];
  if (hi !== 0) out.push(`movk ${reg}, #${hi}, lsl #16`);
  return out;
}

/** Is `v` encodable as a 32-bit logical immediate (a rotated run of ones repeating with period 2..32)? */
function isLogicalImm32(v: number): boolean {
  const x = v >>> 0;
  if (x === 0 || x === 0xffffffff) return false;
  for (const size of [2, 4, 8, 16, 32]) {
    const mask = size === 32 ? 0xffffffff : (1 << size) - 1;
    const elem = x & mask;
    let ok = true;
    for (let i = size; i < 32 && ok; i += size) ok = ((x >>> i) & mask) === elem;
    if (!ok) continue;
    // elem must be a rotation of a contiguous run of ones within `size` bits.
    let r = elem;
    let rotated = 0;
    while ((r & 1) === 1 && rotated < size) {
      r = ((r >>> 1) | ((r & 1) << (size - 1))) & mask;
      rotated += 1;
    }
    if (rotated === size) return false;
    // Now r has a zero at bit 0: a run of ones must be contiguous.
    const lowest = r & -r;
    return ((r + lowest) & r) === 0;
  }
  return false;
}

/**
 * u32 literals a loop body materializes into a register (above the 12-bit immediate range
 * and not an immediate form of their operation), in first-occurrence order, following
 * callees that will be inlined. These are loaded once before the loop.
 */
function loopLiterals(fns: readonly TypedFunc[], depth: number, out: Set<number>): void {
  if (depth >= INLINE_MAX_DEPTH) return;
  for (const fn of fns)
    for (const n of fn.nodes) {
      n.args.forEach((a, k) => {
        if (a.kind !== 'u32' || a.value <= 4095) return;
        if (k === 1 && (n.op === 'shl' || n.op === 'shr')) return;
        if (k === 1 && (n.op === 'get' || n.op === 'set' || n.op === 'at' || n.op === 'put'))
          return;
        if (
          k === 1 &&
          (n.op === 'and' || n.op === 'or' || n.op === 'xor') &&
          isLogicalImm32(a.value)
        )
          return;
        out.add(a.value);
      });
      const callee = fn.calls.get(n.callee ?? '');
      const pred = fn.calls.get(n.pred ?? '');
      const next = [callee, pred].filter(
        (f): f is TypedFunc => f !== undefined && f.nodes.length <= INLINE_MAX_NODES,
      );
      if (next.length > 0) loopLiterals(next, depth + 1, out);
    }
}

// ---------------------------------------------------------------------------
// Vectorization plan
// ---------------------------------------------------------------------------

type VReg = number;
const VECTOR_POOL: readonly VReg[] = [
  0,
  1,
  2,
  3,
  4,
  5,
  6,
  7,
  ...Array.from({ length: 14 }, (_, i) => 16 + i),
];
/** Scratch pair for the two halves of a shifted (`get a (add i c)`) load. */
const VEC_TMP = [30, 31] as const;
/** Pointer registers for the arrays a vector loop touches, in `arrays` order. */
const VECTOR_PTRS = ['x12', 'x13', 'x14', 'x15'];

type VecStep =
  | { readonly k: 'load'; readonly dst: VReg; readonly ptr: number }
  /** Elements i+c .. i+c+3 (mod N) of an extra array: two loads joined by `ext`. */
  | { readonly k: 'loadx'; readonly dst: VReg; readonly ptr: number; readonly c: number }
  | { readonly k: 'store'; readonly src: VReg; readonly ptr: number }
  | {
      readonly k: 'op3';
      readonly insn: string;
      readonly dst: VReg;
      readonly a: VReg;
      readonly b: VReg;
      readonly lanes: '4s' | '16b';
    }
  | {
      readonly k: 'shift';
      readonly insn: 'shl' | 'ushr';
      readonly dst: VReg;
      readonly a: VReg;
      readonly imm: number;
    }
  | { readonly k: 'copy'; readonly dst: VReg; readonly a: VReg }
  | { readonly k: 'not'; readonly dst: VReg; readonly a: VReg }
  | { readonly k: 'bsl'; readonly dst: VReg; readonly c: VReg; readonly a: VReg; readonly b: VReg };

type VecConst =
  | { readonly reg: VReg; readonly kind: 'operand'; readonly o: Operand }
  | { readonly reg: VReg; readonly kind: 'index' }
  | { readonly reg: VReg; readonly kind: 'step' };

type ReduceOp = 'add' | 'eor' | 'orr' | 'and' | 'mul' | 'umin' | 'umax';

/** One accumulator: acc = acc op x per trip; `field` is the record field it lives in. */
interface Reduction {
  readonly op: ReduceOp;
  readonly acc: VReg;
  readonly x: VReg;
  readonly field?: number;
}

interface VecPlan {
  /** Trip count; every array touched has exactly this many u32 elements. */
  readonly n: number;
  /** Arrays by pointer register: p0 (the state) or an extra parameter. */
  readonly arrays: readonly Operand[];
  readonly consts: readonly VecConst[];
  readonly steps: readonly VecStep[];
  readonly index?: { readonly reg: VReg; readonly step: VReg };
  /**
   * Scalar or record state: one accumulator per scalar (or per record field), seeded with
   * the initial value in lane 0 (every lane for min/max) and the identity elsewhere.
   */
  readonly reduce?: readonly Reduction[];
}

/**
 * Is `value` a commutative, associative update of the accumulator: op(acc, x), op(x, acc),
 * or a min/max written as `select (cmp p q) A B` with {p, q} = {A, B} = {acc, x}? `isAcc`
 * recognizes a read of the accumulator. Returns the op, x, and the nodes the update
 * consumes (the comparison), or undefined.
 */
function reductionOf(
  value: Node,
  defs: ReadonlyMap<string, Node>,
  resolve: (o: Operand) => Operand,
  isAcc: (o: Operand) => boolean,
): { op: ReduceOp; x: Operand; plumbing: readonly string[] } | undefined {
  const simple = REDUCE_OPS[value.op];
  if (simple !== undefined) {
    const [a, b] = value.args.map(resolve);
    if (a === undefined || b === undefined || isAcc(a) === isAcc(b)) return undefined;
    return { op: simple, x: isAcc(a) ? b : a, plumbing: [] };
  }
  if (value.op !== 'select') return undefined;
  const [c, ra, rb] = value.args.map(resolve);
  if (c === undefined || ra === undefined || rb === undefined || c.kind !== 'node')
    return undefined;
  const cmp = defs.get(c.id);
  if (cmp === undefined) return undefined;
  const [p, q] = cmp.args.map(resolve);
  if (p === undefined || q === undefined || isAcc(p) === isAcc(q)) return undefined;
  const less = cmp.op === 'lt' || cmp.op === 'le';
  const greater = cmp.op === 'gt' || cmp.op === 'ge';
  if (!less && !greater) return undefined;
  const x = isAcc(p) ? q : p;
  // Equal operands pick either side: the same value, so ties are exact.
  let pickP: boolean;
  if (sameOp(ra, p) && sameOp(rb, q)) pickP = true;
  else if (sameOp(ra, q) && sameOp(rb, p)) pickP = false;
  else return undefined;
  const min = less === pickP;
  return { op: min ? 'umin' : 'umax', x, plumbing: [cmp.id] };
}

const REDUCE_OPS: Readonly<Partial<Record<Op, ReduceOp>>> = {
  add: 'add',
  xor: 'eor',
  or: 'orr',
  and: 'and',
  mul: 'mul',
};

const isU32Array = (t: Type | undefined, n: number): boolean =>
  t !== undefined && !isPrimitive(t) && t.kind === 'arr' && t.elem === 'u32' && t.length === n;

/**
 * Plan a four-lane NEON loop for `fold body count init extras` when the body is
 * element-wise (see the header), or undefined when it is not. Pure: both emission passes
 * compute the same plan.
 */
function vectorPlan(body: TypedFunc, count: number): VecPlan | undefined {
  if (count % 4 !== 0 || count < 8 || body.nodes.length > 64) return undefined;
  const state = body.params[0];
  if (state === undefined || body.params[1] !== 'u32') return undefined;
  const arrayState = !isPrimitive(state) && state.kind === 'arr';
  const recordFields =
    !isPrimitive(state) && state.kind === 'rec' && state.fields.every((f) => f === 'u32')
      ? state.fields.length
      : undefined;
  if (arrayState) {
    if (!isU32Array(state, count)) return undefined;
  } else if (recordFields === undefined && state !== 'u32') return undefined;
  if (recordFields !== undefined && (recordFields < 1 || recordFields > 4)) return undefined;
  for (const [i, t] of body.params.entries())
    if (i >= 2 && t !== 'u32' && !isU32Array(t, count)) return undefined;
  const retOperand = body.ret;
  if (retOperand.kind !== 'node') return undefined;
  const ret = body.nodes.find((n) => n.id === retOperand.id);
  if (ret === undefined) return undefined;
  const defs = new Map(body.nodes.map((n) => [n.id, n]));
  // `mov` chains resolve to their source so a mov costs nothing.
  const resolve = (o: Operand): Operand => {
    let cur = o;
    for (let guard = 0; guard < body.nodes.length && cur.kind === 'node'; guard += 1) {
      const d = defs.get(cur.id);
      if (d === undefined || d.op !== 'mov') break;
      cur = d.args[0] as Operand;
    }
    return cur;
  };
  // Reduction shape: ret = op(p0, x) (or a min/max select) with p0 read nowhere else; for
  // a record, ret = put(... put(p0, k, op(at p0 k, x_k)) ...) covering every field once.
  let reduce: { op: ReduceOp; x: Operand; field?: number }[] | undefined;
  /** Nodes that are accumulator plumbing, not per-lane steps. */
  const skip = new Set<string>();
  if (!arrayState && recordFields === undefined) {
    const r = reductionOf(ret, defs, resolve, (o) => isParam(o, 0));
    if (r === undefined || body.types.get(ret.id) !== 'u32') return undefined;
    reduce = [{ op: r.op, x: r.x }];
    for (const id of r.plumbing) skip.add(id);
    skip.add(ret.id);
    for (const n of body.nodes)
      if (!skip.has(n.id) && n.args.some((o) => isParam(resolve(o), 0))) return undefined;
  } else if (recordFields !== undefined) {
    reduce = [];
    const reads = new Map<string, number>();
    for (const n of body.nodes)
      if (n.op === 'at' && isParam(resolve(n.args[0] as Operand), 0)) {
        const f = n.args[1];
        if (f === undefined || f.kind !== 'u32') return undefined;
        reads.set(n.id, f.value);
      }
    const seen = new Set<number>();
    let cur: Node | undefined = ret;
    while (cur !== undefined && cur.op === 'put') {
      const [into, f, v] = cur.args;
      if (f === undefined || f.kind !== 'u32' || v === undefined || seen.has(f.value))
        return undefined;
      const field = f.value;
      seen.add(field);
      skip.add(cur.id);
      const vv = resolve(v);
      const vn = vv.kind === 'node' ? defs.get(vv.id) : undefined;
      if (vn === undefined) return undefined;
      const r = reductionOf(
        vn,
        defs,
        resolve,
        (o) => o.kind === 'node' && reads.get(o.id) === field,
      );
      if (r === undefined) return undefined;
      reduce.push({ op: r.op, x: r.x, field });
      skip.add(vn.id);
      for (const id of r.plumbing) skip.add(id);
      const next = resolve(into as Operand);
      if (isParam(next, 0)) {
        cur = undefined;
        break;
      }
      cur = next.kind === 'node' ? defs.get(next.id) : undefined;
      if (cur === undefined) return undefined;
    }
    if (cur !== undefined || seen.size !== recordFields) return undefined;
    for (const id of reads.keys()) skip.add(id);
    // The state is read only through the field reads, and each read only by its update.
    for (const n of body.nodes) {
      if (reads.has(n.id)) continue;
      for (const o of n.args) {
        const r = resolve(o);
        if (isParam(r, 0) && !(skip.has(n.id) && n.op === 'put')) return undefined;
        if (r.kind === 'node' && reads.has(r.id) && !skip.has(n.id)) return undefined;
        if (r.kind === 'node' && skip.has(r.id) && !skip.has(n.id) && !reads.has(r.id))
          return undefined;
      }
    }
  } else {
    if (ret.op !== 'set' || !isParam(ret.args[0], 0) || !isParam(ret.args[1], 1)) return undefined;
    for (const n of body.nodes)
      if (n !== ret)
        for (const [k, o] of n.args.entries())
          if (isParam(resolve(o), 0) && !(n.op === 'get' && k === 0)) return undefined;
  }
  // `add p1 c` (1 <= c <= 3) used only as the index of `get` on an extra array: a shifted
  // load (power-of-two N, so the wrap is a mask), not a lane computation.
  const shifted = new Map<string, number>();
  if ((count & (count - 1)) === 0)
    for (const n of body.nodes) {
      if (n.op !== 'add') continue;
      const [x, y] = n.args.map(resolve);
      const lit = isParam(x, 1) ? y : isParam(y, 1) ? x : undefined;
      if (lit?.kind !== 'u32' || lit.value < 1 || lit.value > 3) continue;
      const me: Operand = { kind: 'node', id: n.id };
      const onlyIndex = body.nodes.every((u) =>
        u.args.every((o, j) => !sameOp(resolve(o), me) || (u.op === 'get' && j === 1)),
      );
      if (onlyIndex && !sameOp(resolve(body.ret), me)) {
        shifted.set(n.id, lit.value);
        skip.add(n.id);
      }
    }
  // Register plan.
  const pool = [...VECTOR_POOL];
  const consts: VecConst[] = [];
  const constReg = new Map<string, VReg>();
  const take = (): VReg | undefined => pool.shift();
  const constFor = (o: Operand): VReg | undefined => {
    const key =
      o.kind === 'u32'
        ? `u${o.value}`
        : o.kind === 'bool'
          ? `b${o.value}`
          : `p${(o as { index: number }).index}`;
    const have = constReg.get(key);
    if (have !== undefined) return have;
    const reg = take();
    if (reg === undefined) return undefined;
    constReg.set(key, reg);
    consts.push({ reg, kind: 'operand', o });
    return reg;
  };
  let index: { reg: VReg; step: VReg } | undefined;
  const indexReg = (): VReg | undefined => {
    if (index === undefined) {
      const reg = take();
      const step = take();
      if (reg === undefined || step === undefined) return undefined;
      index = { reg, step };
      consts.push({ reg, kind: 'index' }, { reg: step, kind: 'step' });
    }
    return index.reg;
  };
  const arrays: Operand[] = [];
  const ptrFor = (o: Operand): number | undefined => {
    const at = arrays.findIndex((a) => sameOp(a, o));
    if (at >= 0) return at;
    if (arrays.length >= VECTOR_PTRS.length) return undefined;
    arrays.push(o);
    return arrays.length - 1;
  };
  // Last use of every node within the body (steps are emitted in node order).
  const lastUse = new Map<string, number>();
  body.nodes.forEach((n, i) => {
    for (const o of n.args) {
      const r = resolve(o);
      if (r.kind === 'node') lastUse.set(r.id, i);
    }
  });
  for (const r of reduce ?? []) {
    const x = resolve(r.x);
    if (x.kind === 'node') lastUse.set(x.id, body.nodes.length);
  }
  const nodeReg = new Map<string, VReg>();
  const steps: VecStep[] = [];
  const accs: VReg[] = [];
  for (const _ of reduce ?? []) {
    const acc = take();
    if (acc === undefined) return undefined;
    accs.push(acc);
  }
  /** Register holding an operand's lanes (allocating constants on demand). */
  const regOf = (o: Operand): VReg | undefined => {
    const r = resolve(o);
    switch (r.kind) {
      case 'node':
        return nodeReg.get(r.id);
      case 'param':
        if (r.index === 1) return indexReg();
        if (r.index === 0 || body.params[r.index] !== 'u32') return undefined;
        return constFor(r);
      case 'u32':
      case 'bool':
        return constFor(r);
    }
  };
  for (const [i, n] of body.nodes.entries()) {
    if (n.op === 'mov' || skip.has(n.id)) continue;
    const t = body.types.get(n.id);
    const [a, b, c] = n.args;
    const release = (): void => {
      for (const o of n.args) {
        const r = resolve(o);
        if (r.kind === 'node' && lastUse.get(r.id) === i) {
          const reg = nodeReg.get(r.id);
          if (reg !== undefined) pool.push(reg);
        }
      }
    };
    const fresh = (): VReg | undefined => {
      const reg = take();
      if (reg !== undefined) nodeReg.set(n.id, reg);
      return reg;
    };
    if (n.op === 'get') {
      if (a === undefined || b === undefined || t !== 'u32') return undefined;
      const src = resolve(a);
      if (src.kind !== 'param' || !isU32Array(body.params[src.index], count)) return undefined;
      const rb = resolve(b);
      const c = rb.kind === 'node' ? shifted.get(rb.id) : undefined;
      if (!isParam(rb, 1) && (c === undefined || src.index < 2)) return undefined;
      const ptr = ptrFor(src);
      const dst = fresh();
      if (ptr === undefined || dst === undefined) return undefined;
      steps.push(c === undefined ? { k: 'load', dst, ptr } : { k: 'loadx', dst, ptr, c });
      release();
      continue;
    }
    if (n === ret) {
      // The store of `set p0 p1 v`.
      const value = resolve(c as Operand);
      const valueType =
        value.kind === 'node' ? body.types.get(value.id) : value.kind === 'bool' ? 'bool' : 'u32';
      if (valueType !== 'u32') return undefined;
      const src = regOf(value);
      const ptr = ptrFor({ kind: 'param', index: 0 });
      if (src === undefined || ptr === undefined) return undefined;
      steps.push({ k: 'store', src, ptr });
      release();
      continue;
    }
    switch (n.op) {
      case 'add':
      case 'sub':
      case 'mul':
      case 'and':
      case 'or':
      case 'xor': {
        const ra = regOf(a as Operand);
        const rb = regOf(b as Operand);
        const dst = fresh();
        if (ra === undefined || rb === undefined || dst === undefined) return undefined;
        const insn = n.op === 'or' ? 'orr' : n.op === 'xor' ? 'eor' : n.op;
        const lanes = n.op === 'add' || n.op === 'sub' || n.op === 'mul' ? '4s' : '16b';
        steps.push({ k: 'op3', insn, dst, a: ra, b: rb, lanes });
        break;
      }
      case 'shl':
      case 'shr': {
        if (b === undefined || b.kind !== 'u32') return undefined;
        const ra = regOf(a as Operand);
        const dst = fresh();
        if (ra === undefined || dst === undefined) return undefined;
        const imm = b.value & 31;
        if (imm === 0) steps.push({ k: 'copy', dst, a: ra });
        else steps.push({ k: 'shift', insn: n.op === 'shl' ? 'shl' : 'ushr', dst, a: ra, imm });
        break;
      }
      case 'eq':
      case 'ne':
      case 'lt':
      case 'le':
      case 'gt':
      case 'ge': {
        const ra = regOf(a as Operand);
        const rb = regOf(b as Operand);
        const dst = fresh();
        if (ra === undefined || rb === undefined || dst === undefined) return undefined;
        // cmhi/cmhs are unsigned greater / greater-or-equal; lt/le swap the operands.
        const form: Record<string, [string, boolean]> = {
          eq: ['cmeq', false],
          ne: ['cmeq', false],
          gt: ['cmhi', false],
          ge: ['cmhs', false],
          lt: ['cmhi', true],
          le: ['cmhs', true],
        };
        const [insn, swap] = form[n.op] as [string, boolean];
        steps.push({ k: 'op3', insn, dst, a: swap ? rb : ra, b: swap ? ra : rb, lanes: '4s' });
        if (n.op === 'ne') steps.push({ k: 'not', dst, a: dst });
        break;
      }
      case 'select': {
        const rc = regOf(a as Operand);
        const ra = regOf(b as Operand);
        const rb = regOf(c as Operand);
        const dst = fresh();
        if (rc === undefined || ra === undefined || rb === undefined || dst === undefined)
          return undefined;
        // A bool scalar parameter would be 0/1, not a lane mask: only masks may select.
        const cond = resolve(a as Operand);
        if (cond.kind === 'param') return undefined;
        steps.push({ k: 'bsl', dst, c: rc, a: ra, b: rb });
        break;
      }
      default:
        return undefined;
    }
    release();
  }
  if (reduce !== undefined) {
    const out: Reduction[] = [];
    for (const [k, r] of reduce.entries()) {
      const x = regOf(r.x);
      const acc = accs[k];
      if (x === undefined || acc === undefined) return undefined;
      out.push(r.field === undefined ? { op: r.op, acc, x } : { op: r.op, acc, x, field: r.field });
    }
    const plan: VecPlan = { n: count, arrays, consts, steps, reduce: out };
    return index === undefined ? plan : { ...plan, index };
  }
  const plan: VecPlan = { n: count, arrays, consts, steps };
  return index === undefined ? plan : { ...plan, index };
}

/** A value in the emitter: a literal (possibly hoisted into a home), or a named key. */
type Val =
  | {
      readonly kind: 'lit';
      readonly value: number;
      readonly type: 'u32' | 'bool';
      readonly home?: string;
    }
  | { readonly kind: 'key'; readonly key: string; readonly type: Type };

/** One function body being emitted, either the top level or an inlined callee. */
interface Env {
  readonly fn: TypedFunc;
  /** Key prefix that keeps this instance's node keys apart from every other's. */
  readonly prefix: string;
  /** What each parameter of `fn` is bound to. */
  readonly params: readonly Val[];
  /** Whether p0 is an aggregate this instance owns (the iteration state or an unshared argument). */
  readonly ownedP0: boolean;
  readonly depth: number;
  /** Literals hoisted by enclosing loops: value to the key holding it. */
  readonly lits: ReadonlyMap<number, string>;
  /** A fold body's read of the element written on the previous trip, held in `key`. */
  readonly carry?: Carry;
}

interface Carry {
  /** The `get p0 (sub p1 1)` node. */
  readonly get: string;
  /** The body's result `set p0 p1 v`. */
  readonly set: string;
  readonly key: string;
  readonly type: 'u32' | 'bool';
}

/**
 * A fold body whose result is `set p0 p1 v` on an array of scalars and which reads
 * `get p0 (sub p1 1)`: that read is the value written on the previous trip (index
 * (i - 1) mod N is exactly the element trip i - 1 wrote), or on trip 0 the initial
 * element at (2^32 - 1) mod N. It is carried in a register instead of reloaded, which
 * takes the store-to-load round trip off the recurrence.
 */
function carriedRead(body: TypedFunc): { get: string; set: string } | undefined {
  const ret = body.ret;
  const state = body.params[0];
  if (ret.kind !== 'node' || state === undefined || isPrimitive(state) || state.kind !== 'arr')
    return undefined;
  if (!isPrimitive(state.elem)) return undefined;
  const set = body.nodes.find((n) => n.id === ret.id);
  if (set === undefined || set.op !== 'set' || !isParam(set.args[0], 0) || !isParam(set.args[1], 1))
    return undefined;
  const defs = new Map(body.nodes.map((n) => [n.id, n]));
  for (const n of body.nodes) {
    const j = n.args[1];
    if (n.op !== 'get' || !isParam(n.args[0], 0) || j?.kind !== 'node') continue;
    const d = defs.get(j.id);
    const one = d?.args[1];
    if (d?.op === 'sub' && isParam(d.args[0], 1) && one?.kind === 'u32' && one.value === 1)
      return { get: n.id, set: set.id };
  }
  return undefined;
}

type Home = { readonly reg: string } | { readonly slot: number };

class FunctionEmitter {
  out: string[] = [];
  #dry = true;
  #pos = 0;
  #labels = 0;
  readonly #defs = new Map<string, { pos: number; type: Type }>();
  readonly #last = new Map<string, number>();
  #loops: { start: number; used: Set<string> }[] = [];
  readonly #alias = new Map<string, string>();
  /** Byte offset of an alias within the storage it names (a borrowed field or element). */
  readonly #aliasOff = new Map<string, number>();
  readonly #regs = new Map<string, string>();
  readonly #slots = new Map<string, number>();
  /** Body results that may share the loop state's register (no state read after their definition). */
  readonly #coalesce = new Map<string, string>();
  /** Scalar keys known to be below a literal bound (loop counters with a literal count). */
  readonly #bounds = new Map<string, number>();
  #slotBytes = 0;
  #outgoing = 0;
  #leaf = true;
  #saved: string[] = [];

  constructor(readonly fn: TypedFunc) {}

  #emit(...lines: string[]): void {
    if (this.#dry) return;
    for (const l of lines) this.out.push(l.endsWith(':') ? l : `\t${l}`);
  }

  #label(): string {
    this.#labels += 1;
    return `La0_${this.fn.name}_${this.#labels}`;
  }

  // --- values, keys, homes -------------------------------------------------------------

  #alloc(key: string, bytes: number, alignment = 4): number {
    this.#slotBytes = align(this.#slotBytes, alignment);
    const off = this.#slotBytes;
    this.#slotBytes = align(this.#slotBytes + bytes, 4);
    this.#slots.set(key, off);
    return off;
  }

  #canon(key: string): string {
    let k = key;
    for (let a = this.#alias.get(k); a !== undefined; a = this.#alias.get(k)) k = a;
    return k;
  }

  /** Byte offset of `key` within its canonical slot (0 unless it is a borrowed part). */
  #offset(key: string): number {
    let off = 0;
    for (let k = key, a = this.#alias.get(k); a !== undefined; k = a, a = this.#alias.get(k))
      off += this.#aliasOff.get(k) ?? 0;
    return off;
  }

  /** Byte offset from sp of a key's slot (aliases resolved). */
  #slot(key: string): number {
    const off = this.#slots.get(this.#canon(key));
    if (off === undefined) {
      if (this.#dry) return 0;
      throw new A0Error(`arm64: no slot for ${key}`);
    }
    return this.#outgoing + off + this.#offset(key);
  }

  /** Define `key` at the current position; aggregates get a slot. */
  #def(key: string, type: Type): void {
    if (!this.#dry) return;
    this.#defs.set(key, { pos: this.#pos, type });
    if (!isPrimitive(type)) this.#alloc(key, 4 * words(type));
  }

  /** Define aggregate `key` as another name for `target`'s storage. */
  #defAlias(key: string, target: string, type: Type, offset = 0): void {
    if (!this.#dry) return;
    this.#defs.set(key, { pos: this.#pos, type });
    this.#aliasOff.set(key, offset + this.#offset(target));
    this.#alias.set(key, this.#canon(target));
  }

  /** Record a read of `v` at the current position (for liveness). */
  #use(v: Val): void {
    if (!this.#dry) return;
    const key = v.kind === 'key' ? v.key : v.home;
    if (key === undefined) return;
    this.#last.set(key, this.#pos);
    for (const l of this.#loops) l.used.add(key);
  }

  #home(key: string): Home {
    if (this.#dry) return { slot: 0 };
    const reg = this.#regs.get(key);
    return reg === undefined ? { slot: this.#slot(key) } : { reg };
  }

  #resolve(env: Env, o: Operand): Val {
    switch (o.kind) {
      case 'u32': {
        const home = env.lits.get(o.value);
        return home === undefined
          ? { kind: 'lit', value: o.value, type: 'u32' }
          : { kind: 'lit', value: o.value, type: 'u32', home };
      }
      case 'bool':
        return { kind: 'lit', value: o.value ? 1 : 0, type: 'bool' };
      case 'param':
        return env.params[o.index] ?? refuse(`unknown parameter p${o.index}`);
      case 'node':
        return {
          kind: 'key',
          key: `${env.prefix}n_${o.id}`,
          type: env.fn.types.get(o.id) ?? refuse(`unknown node ${o.id}`),
        };
    }
  }

  // --- low-level emission ----------------------------------------------------------------

  /** `op reg, [base, #off]`; large offsets go through x17 with the 12-bit-shifted add form. */
  #mem(op: 'ldr' | 'str' | 'ldrb' | 'strb', reg: string, base: string, off: number): void {
    const scale = op.endsWith('b') ? 1 : reg.startsWith('x') ? 8 : reg.startsWith('q') ? 16 : 4;
    if (off >= 0 && off % scale === 0 && off / scale <= 4095) {
      this.#emit(`${op} ${reg}, [${base}, #${off}]`);
      return;
    }
    const hi = off - (off % 4096);
    const lo = off % 4096;
    if (hi <= 0xfff000 && lo % scale === 0) {
      this.#emit(`add x17, ${base}, #${hi >> 12}, lsl #12`, `${op} ${reg}, [x17, #${lo}]`);
      return;
    }
    this.#emit(...movImm('x17', off), `add x17, ${base}, x17`, `${op} ${reg}, [x17]`);
  }

  /** reg = base + off (one add for offsets up to 4095 or a multiple of 4096, else two). */
  #addr(reg: string, base: string, off: number): void {
    if (off <= 4095) {
      this.#emit(`add ${reg}, ${base}, #${off}`);
      return;
    }
    const hi = off - (off % 4096);
    const lo = off % 4096;
    if (hi <= 0xfff000) {
      this.#emit(`add ${reg}, ${base}, #${hi >> 12}, lsl #12`);
      if (lo !== 0) this.#emit(`add ${reg}, ${reg}, #${lo}`);
      return;
    }
    this.#emit(...movImm('x17', off), `add ${reg}, ${base}, x17`);
  }

  /** Copy `n` words from [src + so] to [dst + d]. Uses w9, w13, x14, x15, x17, q0, q1. */
  #copy(dst: string, d: number, src: string, so: number, n: number): void {
    if (dst === src && d === so) return;
    const chunks = Math.floor(n / 8);
    if (chunks < 2) {
      for (let k = 0; k < n; k += 1) {
        this.#mem('ldr', 'w9', src, so + 4 * k);
        this.#mem('str', 'w9', dst, d + 4 * k);
      }
      return;
    }
    // Eight words (32 bytes) per trip through two q registers, then the remainder by word.
    const top = this.#label();
    this.#addr('x14', src, so);
    this.#addr('x15', dst, d);
    this.#emit(...movImm('w13', chunks), `${top}:`);
    this.#emit(
      'ldp q0, q1, [x14], #32',
      'stp q0, q1, [x15], #32',
      'subs w13, w13, #1',
      `b.ne ${top}`,
    );
    for (let k = 0; k < n % 8; k += 1) {
      this.#emit(`ldr w9, [x14, #${4 * k}]`, `str w9, [x15, #${4 * k}]`);
    }
  }

  /** Zero `n` words at [sp + off]. Uses x15, w13, q0. */
  #zero(off: number, n: number): void {
    const chunks = Math.floor(n / 8);
    if (chunks < 2) {
      for (let k = 0; k < n; k += 1) this.#mem('str', 'wzr', 'sp', off + 4 * k);
      return;
    }
    const top = this.#label();
    this.#addr('x15', 'sp', off);
    this.#emit('movi v0.2d, #0', ...movImm('w13', chunks), `${top}:`);
    this.#emit('stp q0, q0, [x15], #32', 'subs w13, w13, #1', `b.ne ${top}`);
    for (let k = 0; k < n % 8; k += 1) this.#emit(`str wzr, [x15, #${4 * k}]`);
  }

  /** A w register holding scalar `v`: its home register, or `scratch` after materializing. */
  #read(v: Val, scratch: string): string {
    if (v.kind === 'lit' && v.home === undefined) {
      if (v.value === 0) return 'wzr';
      this.#emit(...movImm(scratch, v.value));
      return scratch;
    }
    const home = this.#home(v.kind === 'lit' ? (v.home as string) : v.key);
    if ('reg' in home) return home.reg;
    this.#mem('ldr', scratch, 'sp', home.slot);
    return scratch;
  }

  /**
   * `#read` for the first operand of an immediate-form add/sub/cmp, where register 31 is
   * sp rather than wzr: a literal zero is materialized instead.
   */
  #readRn(v: Val, scratch: string): string {
    const r = this.#read(v, scratch);
    if (r !== 'wzr') return r;
    this.#emit(`movz ${scratch}, #0`);
    return scratch;
  }

  /** dst = scalar `v`. */
  #into(dst: string, v: Val): void {
    const r = this.#read(v, dst);
    if (r !== dst) this.#emit(`mov ${dst}, ${r}`);
  }

  /**
   * Write scalar `key` with `produce(d)`, which leaves the value in register `d`. A `direct`
   * producer is a single instruction, so `d` may be the home register even when it is also a
   * source; otherwise the value goes through w12.
   */
  #set(key: string, produce: (d: string) => void, direct = false): void {
    const home = this.#home(key);
    if ('reg' in home) {
      if (direct) {
        produce(home.reg);
        return;
      }
      produce('w12');
      this.#emit(`mov ${home.reg}, w12`);
      return;
    }
    produce('w12');
    this.#mem('str', 'w12', 'sp', home.slot);
  }

  /** Store `v` (any type) at [base + off]. */
  #place(v: Val, base: string, off: number): void {
    if (v.kind === 'lit' || isPrimitive(v.type)) {
      this.#mem('str', this.#read(v, 'w9'), base, off);
      return;
    }
    this.#copy(base, off, 'sp', this.#slot(v.key), words(v.type));
  }

  /**
   * A w register holding `idx mod n` (a bounded counter needs no mask; a power of two
   * masks; otherwise udiv/msub). Uses w10-w12.
   */
  #index(idx: Val, n: number): string {
    const r = this.#read(idx, 'w10');
    if (n === 1) return 'wzr';
    if (idx.kind === 'key' && (this.#bounds.get(idx.key) ?? Number.POSITIVE_INFINITY) <= n)
      return r;
    if (idx.kind === 'lit') {
      this.#emit(...movImm('w10', idx.value % n));
      return 'w10';
    }
    if ((n & (n - 1)) === 0) this.#emit(`and w10, ${r}, #${n - 1}`);
    else this.#emit(...movImm('w11', n), `udiv w12, ${r}, w11`, `msub w10, w12, w11, ${r}`);
    return 'w10';
  }

  /** x16 = sp + base + (idx mod n) * elemBytes for aggregate elements. */
  #elementAddr(base: number, idx: Val, n: number, elemBytes: number): void {
    const r = this.#index(idx, n);
    if ((elemBytes & (elemBytes - 1)) === 0)
      this.#emit(`ubfiz x10, x${r.slice(1)}, #${Math.log2(elemBytes)}, #32`);
    else this.#emit(...movImm('w11', elemBytes), `umull x10, ${r}, w11`);
    this.#addr('x16', 'sp', base);
    this.#emit('add x16, x16, x10');
  }

  // --- calls and inlining ------------------------------------------------------------------

  #inlinable(callee: TypedFunc, env: Env): boolean {
    return callee.nodes.length <= INLINE_MAX_NODES && env.depth < INLINE_MAX_DEPTH;
  }

  /** Residual out-of-line call: arguments per the convention, result into `dst`. */
  #call(name: string, callee: TypedFunc, args: readonly Val[], dst: string): void {
    this.#leaf = false;
    const { places, bytes } = argLayout(callee.params);
    this.#outgoing = Math.max(this.#outgoing, bytes);
    for (const a of args) this.#use(a);
    args.forEach((a, k) => {
      const place = places[k] as ArgPlace;
      if (place.reg !== undefined) {
        const r = place.reg;
        if (a.kind === 'lit' || isPrimitive(a.type)) this.#into(`w${r}`, a);
        else this.#addr(`x${r}`, 'sp', this.#slot(a.key));
        return;
      }
      const at = place.stack as number;
      if (a.kind === 'lit' || isPrimitive(a.type)) {
        this.#into('w9', a);
        this.#mem(a.type === 'bool' ? 'strb' : 'str', 'w9', 'sp', at);
      } else {
        this.#addr('x9', 'sp', this.#slot(a.key));
        this.#mem('str', 'x9', 'sp', at);
      }
    });
    if (!isPrimitive(callee.result)) this.#addr('x8', 'sp', this.#slot(dst));
    this.#emit(`bl _a0_${name}`);
    if (isPrimitive(callee.result)) this.#set(dst, (d) => this.#emit(`mov ${d}, w0`), true);
  }

  /**
   * Inline `callee` with its parameters bound to `args`. `sink` 'bind' defines `result` from
   * the callee's return value (aliasing an aggregate); 'store' writes it into the existing
   * `result` (a loop state).
   */
  #inline(
    env: Env,
    callee: TypedFunc,
    args: readonly Val[],
    ownedP0: boolean,
    result: string,
    type: Type,
    tag: string,
    sink: 'bind' | 'store',
    carry?: Carry,
  ): void {
    const base: Env = {
      fn: callee,
      prefix: `${env.prefix}${tag}.`,
      params: args,
      ownedP0,
      depth: env.depth + 1,
      lits: env.lits,
    };
    const sub: Env = carry === undefined ? base : { ...base, carry };
    this.#body(sub);
    // The result is written after the body's last node, at a position of its own, so a dead
    // trailing node of the callee can never share the return value's register.
    this.#pos += 1;
    const ret = this.#resolve(sub, callee.ret);
    if (isPrimitive(type)) {
      if (sink === 'bind') this.#def(result, type);
      else if (this.#dry && ret.kind === 'key' && callee.ret.kind === 'node') {
        // The body's own result may live in the state's register when the state is not
        // read after it is defined: the per-trip move then vanishes.
        const def = this.#defs.get(ret.key);
        const lastRead = this.#last.get(result) ?? -1;
        if (def !== undefined && !this.#alias.has(ret.key) && lastRead <= def.pos)
          this.#coalesce.set(ret.key, result);
      }
      this.#use(ret);
      this.#set(result, (d) => this.#into(d, ret), true);
      return;
    }
    this.#use(ret);
    if (ret.kind !== 'key') refuse('an aggregate literal cannot be returned');
    if (sink === 'bind') {
      this.#defAlias(result, ret.key, type);
      return;
    }
    this.#copy('sp', this.#slot(result), 'sp', this.#slot(ret.key), words(type));
  }

  // --- vectorized folds ----------------------------------------------------------------------

  /**
   * Emit `fold` as a four-lane NEON loop per `plan`. The state key is already defined (an
   * aggregate slot, or a scalar key written from the accumulator at the end).
   */
  #vectorFold(
    env: Env,
    plan: VecPlan,
    key: string,
    t: Type,
    init: Val,
    extras: readonly Val[],
  ): void {
    const sub: Env = {
      fn: env.fn,
      prefix: env.prefix,
      params: [{ kind: 'key', key, type: t }, { kind: 'lit', value: 0, type: 'u32' }, ...extras],
      ownedP0: true,
      depth: env.depth + 1,
      lits: env.lits,
    };
    const v = (r: VReg, lanes = '4s'): string => `v${r}.${lanes}`;
    // Constants: broadcast scalars and literals, the lane index vector, its step, the accumulator.
    for (const c of plan.consts) {
      if (c.kind === 'index') {
        this.#emit(`movi ${v(c.reg)}, #0`);
        for (let lane = 1; lane < 4; lane += 1)
          this.#emit(`movz w9, #${lane}`, `ins v${c.reg}.s[${lane}], w9`);
      } else if (c.kind === 'step') this.#emit(`movi ${v(c.reg)}, #4`);
      else if (c.o.kind === 'bool')
        this.#emit(c.o.value ? `mvni ${v(c.reg)}, #0` : `movi ${v(c.reg)}, #0`);
      else {
        const val = this.#resolve(sub, c.o);
        this.#use(val);
        const r = this.#read(val, 'w9');
        if (r === 'wzr') this.#emit(`movi ${v(c.reg)}, #0`);
        else this.#emit(`dup ${v(c.reg)}, ${r}`);
      }
    }
    for (const { op, acc, field } of plan.reduce ?? []) {
      // The initial value: the scalar state, or its record field.
      let r: string;
      if (field === undefined) r = this.#read(init, 'w9');
      else {
        if (init.kind !== 'key') refuse('vector loop over a literal record');
        this.#mem('ldr', 'w9', 'sp', this.#slot(init.key) + 4 * field);
        r = 'w9';
      }
      if (op === 'umin' || op === 'umax') {
        this.#emit(`dup ${v(acc)}, ${r}`);
        continue;
      }
      this.#emit(
        op === 'and'
          ? `mvni ${v(acc)}, #0`
          : op === 'mul'
            ? `movi ${v(acc)}, #1`
            : `movi ${v(acc)}, #0`,
      );
      this.#emit(`ins v${acc}.s[0], ${r}`);
    }
    plan.arrays.forEach((o, k) => {
      const val = this.#resolve(sub, o);
      if (val.kind !== 'key') refuse('vector loop over a literal');
      this.#addr(VECTOR_PTRS[k] as string, 'sp', this.#slot(val.key));
    });
    const top = this.#label();
    this.#emit('movz x10, #0', ...movImm('w11', plan.n), `${top}:`);
    for (const s of plan.steps) {
      switch (s.k) {
        case 'load':
          this.#emit(`ldr q${s.dst}, [${VECTOR_PTRS[s.ptr]}, x10]`);
          break;
        case 'loadx': {
          const [lo, hi] = VEC_TMP;
          const base = VECTOR_PTRS[s.ptr];
          this.#emit(
            'add x9, x10, #16',
            `and x9, x9, #${4 * plan.n - 1}`,
            `ldr q${lo}, [${base}, x10]`,
            `ldr q${hi}, [${base}, x9]`,
            `ext v${s.dst}.16b, v${lo}.16b, v${hi}.16b, #${4 * s.c}`,
          );
          break;
        }
        case 'store':
          this.#emit(`str q${s.src}, [${VECTOR_PTRS[s.ptr]}, x10]`);
          break;
        case 'op3':
          this.#emit(`${s.insn} ${v(s.dst, s.lanes)}, ${v(s.a, s.lanes)}, ${v(s.b, s.lanes)}`);
          break;
        case 'shift':
          this.#emit(`${s.insn} ${v(s.dst)}, ${v(s.a)}, #${s.imm}`);
          break;
        case 'copy':
          this.#emit(`orr ${v(s.dst, '16b')}, ${v(s.a, '16b')}, ${v(s.a, '16b')}`);
          break;
        case 'not':
          this.#emit(`mvn ${v(s.dst, '16b')}, ${v(s.a, '16b')}`);
          break;
        case 'bsl':
          this.#emit(
            `orr ${v(s.dst, '16b')}, ${v(s.c, '16b')}, ${v(s.c, '16b')}`,
            `bsl ${v(s.dst, '16b')}, ${v(s.a, '16b')}, ${v(s.b, '16b')}`,
          );
          break;
      }
    }
    for (const { op, acc, x } of plan.reduce ?? []) {
      const lanes = op === 'eor' || op === 'orr' || op === 'and' ? '16b' : '4s';
      this.#emit(`${op} ${v(acc, lanes)}, ${v(acc, lanes)}, ${v(x, lanes)}`);
    }
    if (plan.index !== undefined)
      this.#emit(`add ${v(plan.index.reg)}, ${v(plan.index.reg)}, ${v(plan.index.step)}`);
    this.#emit('add x10, x10, #16', 'subs w11, w11, #4', `b.ne ${top}`);
    for (const { op, acc, field } of plan.reduce ?? []) {
      // Horizontal combine of the four lanes into w9.
      if (op === 'add' || op === 'umin' || op === 'umax') {
        this.#emit(
          `${op === 'add' ? 'addv' : `${op}v`} s${acc}, ${v(acc)}`,
          `umov w9, v${acc}.s[0]`,
        );
      } else {
        this.#emit(`umov w9, v${acc}.s[0]`);
        for (let lane = 1; lane < 4; lane += 1)
          this.#emit(`umov w10, v${acc}.s[${lane}]`, `${op} w9, w9, w10`);
      }
      if (field === undefined) this.#set(key, (d) => this.#emit(`mov ${d}, w9`), true);
      else this.#mem('str', 'w9', 'sp', this.#slot(key) + 4 * field);
    }
  }

  // --- nodes -------------------------------------------------------------------------------

  #body(env: Env): void {
    for (const [i, n] of env.fn.nodes.entries()) this.#node(env, n, i);
  }

  #node(env: Env, n: Node, index: number): void {
    const t = env.fn.types.get(n.id) ?? refuse(`untyped node ${n.id}`);
    const key = `${env.prefix}n_${n.id}`;
    const vals = n.args.map((o) => this.#resolve(env, o));
    const [a, b, c] = vals;
    this.#pos += 1;
    if (n.op !== 'fold' && n.op !== 'loop') for (const v of vals) this.#use(v);
    const feed = feedsOf(env.fn).get(n.id);
    const scalar = (produce: (d: string) => void, direct = false): void => {
      if (feed !== undefined) {
        // Written into the aggregate literal's slot, which is defined here (first element).
        const akey = `${env.prefix}n_${feed.arr}`;
        const at = env.fn.types.get(feed.arr) ?? refuse(`untyped node ${feed.arr}`);
        if (this.#dry && !this.#defs.has(akey)) this.#def(akey, at);
        produce('w12');
        this.#mem('str', 'w12', 'sp', this.#slot(akey) + 4 * feed.word);
        return;
      }
      this.#def(key, t);
      this.#set(key, produce, direct);
    };
    const bin = (insn: string, imm?: (v: number) => string | undefined): void => {
      const literal = b?.kind === 'lit' && imm !== undefined ? imm(b.value) : undefined;
      const ra =
        literal !== undefined && (insn === 'add' || insn === 'sub')
          ? this.#readRn(a as Val, 'w10')
          : this.#read(a as Val, 'w10');
      if (literal !== undefined) {
        scalar((d) => this.#emit(`${insn} ${d}, ${ra}, ${literal}`), true);
        return;
      }
      const rb = this.#read(b as Val, 'w11');
      scalar((d) => this.#emit(`${insn} ${d}, ${ra}, ${rb}`), true);
    };
    const small = (v: number): string | undefined => (v <= 4095 ? `#${v}` : undefined);
    const logical = (v: number): string | undefined => (isLogicalImm32(v) ? `#${v}` : undefined);
    const shift = (v: number): string => `#${v & 31}`;
    const cmp = (cond: string): void => {
      const immB = b?.kind === 'lit' && b.value <= 4095 ? `#${b.value}` : undefined;
      const ra = immB !== undefined ? this.#readRn(a as Val, 'w10') : this.#read(a as Val, 'w10');
      const rb = immB ?? this.#read(b as Val, 'w11');
      scalar((d) => this.#emit(`cmp ${ra}, ${rb}`, `cset ${d}, ${cond}`), true);
    };
    const aggregateOf = (v: Val, what: string): { key: string; type: Type } => {
      if (v.kind !== 'key' || isPrimitive(v.type)) refuse(`${n.op} needs ${what}`);
      return { key: v.key, type: v.type };
    };
    if (env.carry?.get === n.id) {
      const cv: Val = { kind: 'key', key: env.carry.key, type: env.carry.type };
      this.#use(cv);
      scalar((d) => this.#into(d, cv), true);
      return;
    }
    switch (n.op) {
      case 'mov': {
        const v = a as Val;
        if (v.kind === 'key' && !isPrimitive(v.type)) this.#defAlias(key, v.key, t);
        else scalar((d) => this.#into(d, v), true);
        return;
      }
      case 'add':
        bin('add', small);
        return;
      case 'sub':
        bin('sub', small);
        return;
      case 'mul':
        bin('mul');
        return;
      case 'and':
        bin('and', logical);
        return;
      case 'or':
        bin('orr', logical);
        return;
      case 'xor':
        bin('eor', logical);
        return;
      // LSLV/LSRV on W registers use the distance modulo 32: A0's five-bit mask.
      case 'shl':
        bin('lsl', shift);
        return;
      case 'shr':
        bin('lsr', shift);
        return;
      case 'div': {
        // UDIV yields 0 for a zero divisor; A0 requires all ones.
        const ra = this.#read(a as Val, 'w10');
        const rb = this.#readRn(b as Val, 'w11');
        scalar((d) =>
          this.#emit(
            `udiv ${d}, ${ra}, ${rb}`,
            `cmp ${rb === 'wzr' ? 'w11' : rb}, #0`,
            `csinv ${d}, ${d}, wzr, ne`,
          ),
        );
        return;
      }
      case 'rem': {
        // a - (a / b) * b; a zero divisor gives quotient 0, hence the dividend (A0's rule).
        const ra = this.#read(a as Val, 'w10');
        const rb = this.#read(b as Val, 'w11');
        scalar((d) => this.#emit(`udiv ${d}, ${ra}, ${rb}`, `msub ${d}, ${d}, ${rb}, ${ra}`));
        return;
      }
      case 'eq':
        cmp('eq');
        return;
      case 'ne':
        cmp('ne');
        return;
      case 'lt':
        cmp('lo');
        return;
      case 'le':
        cmp('ls');
        return;
      case 'gt':
        cmp('hi');
        return;
      case 'ge':
        cmp('hs');
        return;
      case 'select': {
        // Both operands are already computed values; select picks one.
        const rc = this.#readRn(a as Val, 'w9');
        if (isPrimitive(t)) {
          const rb = this.#read(b as Val, 'w10');
          const rcc = this.#read(c as Val, 'w11');
          scalar((d) => this.#emit(`cmp ${rc}, #0`, `csel ${d}, ${rb}, ${rcc}, ne`), true);
          return;
        }
        this.#def(key, t);
        this.#addr('x10', 'sp', this.#slot(aggregateOf(b as Val, 'a value').key));
        this.#addr('x11', 'sp', this.#slot(aggregateOf(c as Val, 'a value').key));
        this.#emit(`cmp ${rc}, #0`, 'csel x16, x10, x11, ne');
        this.#copy('sp', this.#slot(key), 'x16', 0, words(t));
        return;
      }
      case 'arr':
      case 'rec': {
        if (!(this.#dry && this.#defs.has(key))) this.#def(key, t);
        if (zeroArray(env.fn, n)) {
          if (!deadZeroFill(env.fn, index)) this.#zero(this.#slot(key), vals.length);
          return;
        }
        const feeds = feedsOf(env.fn);
        let off = this.#slot(key);
        for (const [k, v] of vals.entries()) {
          const o = n.args[k] as Operand;
          if (!(o.kind === 'node' && feeds.get(o.id)?.arr === n.id)) this.#place(v, 'sp', off);
          off += 4 * words(v.type);
        }
        return;
      }
      case 'get': {
        const src = aggregateOf(a as Val, 'an array');
        const at = src.type;
        if (isPrimitive(at) || at.kind !== 'arr') refuse('get needs an array');
        const ew = words(at.elem);
        const base = this.#slot(src.key);
        if (b?.kind === 'lit') {
          const off = base + (b.value % at.length) * ew * 4;
          if (isPrimitive(t)) scalar((d) => this.#mem('ldr', d, 'sp', off), true);
          else {
            // A borrowed read of a literal element: named in place, not copied.
            this.#defAlias(key, src.key, t, (b.value % at.length) * ew * 4);
          }
          return;
        }
        if (isPrimitive(t)) {
          const r = this.#index(b as Val, at.length);
          this.#addr('x16', 'sp', base);
          scalar((d) => this.#emit(`ldr ${d}, [x16, ${r}, uxtw #2]`), true);
          return;
        }
        this.#elementAddr(base, b as Val, at.length, ew * 4);
        this.#def(key, t);
        this.#copy('sp', this.#slot(key), 'x16', 0, ew);
        return;
      }
      case 'set': {
        const src = aggregateOf(a as Val, 'an array');
        const at = src.type;
        if (isPrimitive(at) || at.kind !== 'arr') refuse('set needs an array');
        const ew = words(at.elem);
        if (mutableHere(env.fn, n.args[0] as Operand, index, 0, env.ownedP0))
          this.#defAlias(key, src.key, t);
        else {
          this.#def(key, t);
          this.#copy('sp', this.#slot(key), 'sp', this.#slot(src.key), words(at));
        }
        const dst = this.#slot(key);
        if (env.carry?.set === n.id) {
          const carry = env.carry;
          this.#set(carry.key, (d) => this.#into(d, c as Val), true);
        }
        if (b?.kind === 'lit') {
          this.#place(c as Val, 'sp', dst + (b.value % at.length) * ew * 4);
          return;
        }
        if (isPrimitive(at.elem)) {
          const r = this.#index(b as Val, at.length);
          this.#addr('x16', 'sp', dst);
          this.#emit(`str ${this.#read(c as Val, 'w9')}, [x16, ${r}, uxtw #2]`);
          return;
        }
        this.#elementAddr(dst, b as Val, at.length, ew * 4);
        this.#place(c as Val, 'x16', 0);
        return;
      }
      case 'at':
      case 'put': {
        const src = aggregateOf(a as Val, 'a record');
        const rt = src.type;
        if (isPrimitive(rt) || rt.kind !== 'rec' || b?.kind !== 'lit')
          refuse(`${n.op} needs a record and a literal field`);
        if (rt.fields[b.value] === undefined) refuse('field out of range');
        const off = 4 * rt.fields.slice(0, b.value).reduce((s, f) => s + words(f), 0);
        if (n.op === 'at') {
          const from = this.#slot(src.key) + off;
          if (isPrimitive(t)) scalar((d) => this.#mem('ldr', d, 'sp', from), true);
          else {
            // A borrowed read: the field is named in place, not copied.
            this.#defAlias(key, src.key, t, off);
          }
          return;
        }
        if (mutableHere(env.fn, n.args[0] as Operand, index, 0, env.ownedP0))
          this.#defAlias(key, src.key, t);
        else {
          this.#def(key, t);
          this.#copy('sp', this.#slot(key), 'sp', this.#slot(src.key), words(rt));
        }
        this.#place(c as Val, 'sp', this.#slot(key) + off);
        return;
      }
      case 'call': {
        const name = n.callee as string;
        const callee = env.fn.calls.get(name) ?? refuse(`unknown callee ${name}`);
        if (this.#inlinable(callee, env)) {
          const owned =
            a !== undefined &&
            a.kind === 'key' &&
            !isPrimitive(a.type) &&
            mutableHere(env.fn, n.args[0] as Operand, index, 0, env.ownedP0);
          this.#inline(env, callee, vals, owned, key, t, n.id, 'bind');
          return;
        }
        this.#def(key, t);
        this.#call(name, callee, vals, key);
        return;
      }
      case 'fold':
      case 'loop': {
        const [count, init, ...extras] = vals as [Val, Val, ...Val[]];
        const name = n.callee as string;
        const callee = env.fn.calls.get(name) ?? refuse(`unknown callee ${name}`);
        const pred = n.pred === undefined ? undefined : env.fn.calls.get(n.pred);
        const counter = `${env.prefix}i_${n.id}`;
        const state: Val = { kind: 'key', key, type: t };
        const cval: Val = { kind: 'key', key: counter, type: 'u32' };
        this.#use(init);
        for (const e of extras) this.#use(e);
        const plan =
          n.op === 'fold' && count.kind === 'lit' && this.#inlinable(callee, env)
            ? vectorPlan(callee, count.value)
            : undefined;
        // State: a scalar home, or the init slot itself when nothing else reads it.
        if (isPrimitive(t)) {
          if (plan === undefined) scalar((d) => this.#into(d, init), true);
          else this.#def(key, t);
        } else if (
          init.kind === 'key' &&
          mutableHere(env.fn, n.args[1] as Operand, index, 1, env.ownedP0)
        )
          this.#defAlias(key, init.key, t);
        else {
          this.#def(key, t);
          this.#place(init, 'sp', this.#slot(key));
        }
        if (plan !== undefined) {
          this.#vectorFold(env, plan, key, t, init, extras);
          this.#pos += 1;
          this.#use(state);
          return;
        }
        // Literals the body materializes are loaded once, before the loop.
        const lits = new Map(env.lits);
        const wanted = new Set<number>();
        if (count.kind === 'lit' && count.value > 4095) wanted.add(count.value);
        loopLiterals([callee, ...(pred === undefined ? [] : [pred])], env.depth + 1, wanted);
        const hoisted: Val[] = [];
        for (const value of wanted) {
          if (lits.has(value) || hoisted.length >= HOIST_MAX) continue;
          const lkey = `${env.prefix}k_${n.id}_${value}`;
          this.#def(lkey, 'u32');
          this.#set(lkey, (d) => this.#emit(...movImm(d, value)), true);
          lits.set(value, lkey);
          hoisted.push({ kind: 'lit', value, type: 'u32', home: lkey });
        }
        const loopEnv: Env = { ...env, lits };
        // The previous trip's element, carried in a register (see carriedRead).
        let carry: Carry | undefined;
        const carried =
          n.op === 'fold' && this.#inlinable(callee, env) ? carriedRead(callee) : undefined;
        const elem = !isPrimitive(t) && t.kind === 'arr' ? t.elem : undefined;
        if (
          carried !== undefined &&
          !isPrimitive(t) &&
          t.kind === 'arr' &&
          (elem === 'u32' || elem === 'bool')
        ) {
          const ckey = `${env.prefix}r_${n.id}`;
          const off = this.#slot(key) + 4 * (0xffffffff % t.length);
          this.#def(ckey, elem);
          this.#set(ckey, (d) => this.#mem('ldr', d, 'sp', off), true);
          carry = { ...carried, key: ckey, type: elem };
          hoisted.push({ kind: 'key', key: ckey, type: elem });
        }
        const countVal = this.#resolve(loopEnv, n.args[0] as Operand);
        this.#def(counter, 'u32');
        this.#set(counter, (d) => this.#emit(`movz ${d}, #0`), true);
        if (count.kind === 'lit') this.#bounds.set(counter, count.value);
        this.#loops.push({ start: this.#pos, used: new Set() });
        const top = this.#label();
        const done = this.#label();
        this.#emit(`${top}:`);
        this.#use(countVal);
        this.#use(cval);
        const ci = this.#read(cval, 'w9');
        const limit =
          count.kind === 'lit' && count.value <= 4095
            ? `#${count.value}`
            : this.#read(countVal, 'w10');
        this.#emit(`cmp ${ci}, ${limit}`, `b.hs ${done}`);
        const args: Val[] = [state, cval, ...extras];
        if (pred !== undefined) {
          const pkey = `${env.prefix}c_${n.id}`;
          if (this.#inlinable(pred, env))
            this.#inline(loopEnv, pred, args, false, pkey, 'bool', `${n.id}.p`, 'bind');
          else {
            this.#def(pkey, 'bool');
            this.#call(n.pred as string, pred, args, pkey);
          }
          const pv: Val = { kind: 'key', key: pkey, type: 'bool' };
          this.#use(pv);
          this.#emit(`cbz ${this.#read(pv, 'w9')}, ${done}`);
        }
        if (this.#inlinable(callee, env))
          this.#inline(loopEnv, callee, args, true, key, t, n.id, 'store', carry);
        else this.#call(name, callee, args, key);
        this.#use(cval);
        const cr = this.#read(cval, 'w9');
        this.#set(counter, (d) => this.#emit(`add ${d}, ${cr}, #1`), true);
        this.#emit(`b ${top}`, `${done}:`);
        // Loop end: values from outside that the body reads stay live to here; so do the
        // state, the counter, and the hoisted literals.
        this.#pos += 1;
        this.#use(state);
        this.#use(cval);
        for (const h of hoisted) this.#use(h);
        const region = this.#loops.pop();
        if (region !== undefined && this.#dry) {
          for (const k of region.used) {
            const def = this.#defs.get(k);
            if (def !== undefined && def.pos < region.start)
              this.#last.set(k, Math.max(this.#last.get(k) ?? 0, this.#pos));
          }
        }
        return;
      }
      case 'read':
      case 'write':
      case 'puts':
        refuse(`${n.op} is an io operation`);
        return;
    }
  }

  // --- register allocation ---------------------------------------------------------------

  /** Linear scan over definition order: scalars get callee-saved homes (and w0-w7 in a leaf). */
  #allocate(): void {
    const pool = this.#leaf ? [...ARG_REGS, ...CALLEE_SAVED] : CALLEE_SAVED;
    const keys = [...this.#defs.entries()]
      .filter(([k, d]) => isPrimitive(d.type) && !this.#alias.has(k))
      .sort((x, y) => x[1].pos - y[1].pos);
    const busy = new Map<string, number>();
    /** The single key holding each busy register (absent when shared by coalescing). */
    const holder = new Map<string, string>();
    const coalesced = new Set(this.#coalesce.values());
    for (const [key, d] of keys) {
      const last = this.#last.get(key) ?? d.pos;
      for (const [r, l] of busy)
        if (l <= d.pos) {
          busy.delete(r);
          holder.delete(r);
        }
      const target = this.#coalesce.get(key);
      const shared = target === undefined ? undefined : this.#regs.get(target);
      if (shared !== undefined) {
        this.#regs.set(key, shared);
        busy.set(shared, Math.max(busy.get(shared) ?? 0, last));
        holder.delete(shared);
        continue;
      }
      let reg: string | undefined;
      const p = /^p(\d+)$/.exec(key);
      if (this.#leaf && p !== null && Number(p[1]) < 8 && !busy.has(`w${p[1]}`)) reg = `w${p[1]}`;
      if (reg === undefined) reg = pool.find((r) => !busy.has(r));
      if (reg === undefined && !coalesced.has(key)) {
        // No free register: the live value whose range ends furthest away gives up its
        // register (and lives in its slot throughout) when that is later than this one's
        // end, so short-lived temporaries stay in registers (the classic linear-scan rule).
        let victim: string | undefined;
        let far = last;
        for (const [r, l] of busy) {
          const k = holder.get(r);
          if (k !== undefined && l > far && !coalesced.has(k)) {
            victim = r;
            far = l;
          }
        }
        if (victim !== undefined) {
          this.#regs.delete(holder.get(victim) as string);
          reg = victim;
        }
      }
      if (reg === undefined) continue;
      busy.set(reg, last);
      holder.set(reg, key);
      this.#regs.set(key, reg);
    }
    const used = new Set([...this.#regs.values()].filter((r) => CALLEE_SAVED.includes(r)));
    this.#saved = CALLEE_SAVED.filter((r) => used.has(r)).map((r) => `x${r.slice(1)}`);
  }

  // --- function -------------------------------------------------------------------------

  emit(): string {
    const fn = this.fn;
    if (
      containsIo(fn.result) ||
      fn.params.some(containsIo) ||
      [...fn.types.values()].some(containsIo)
    )
      refuse(`function ${fn.name} uses io; io functions are out of scope for this backend`);
    const env: Env = {
      fn,
      prefix: '',
      params: fn.params.map((t, i) => ({ kind: 'key', key: `p${i}`, type: t })),
      ownedP0: true,
      depth: 0,
      lits: new Map(),
    };
    // Pass 1 (dry): positions, liveness, aliases, aggregate slots, residual-call needs.
    this.#dry = true;
    this.#pos = 0;
    for (const [i, t] of fn.params.entries()) this.#def(`p${i}`, t);
    this.#body(env);
    this.#pos += 1;
    const ret = this.#resolve(env, fn.ret);
    this.#use(ret);
    this.#allocate();
    for (const [k, d] of this.#defs)
      if (isPrimitive(d.type) && !this.#regs.has(k) && !this.#alias.has(k)) this.#alloc(k, 4);
    if (this.#saved.length > 0) this.#alloc('save', 8 * this.#saved.length, 8);
    const sretSlot = !isPrimitive(fn.result) && !this.#leaf;
    if (sretSlot) this.#alloc('sret', 8, 8);
    this.#outgoing = align(this.#outgoing, 16);
    const frame = this.#outgoing + align(this.#slotBytes, 16);
    // Pass 2: emission.
    this.#dry = false;
    this.out = [];
    this.#labels = 0;
    this.#pos = 0;
    this.#loops = [];
    this.#bounds.clear();
    const sym = `_a0_${fn.name}`;
    this.out.push(`\t.globl ${sym}`, '\t.p2align 2', `${sym}:`);
    this.#emit('stp x29, x30, [sp, #-16]!', 'mov x29, sp');
    if (frame > 4096) {
      // Probe one page at a time so the guard page is never skipped.
      const pages = Math.floor(frame / 4096);
      const probe = this.#label();
      this.#emit(...movImm('w9', pages), `${probe}:`);
      this.#emit('sub sp, sp, #4096', 'str xzr, [sp]', 'subs w9, w9, #1', `b.ne ${probe}`);
      if (frame % 4096 > 0) this.#emit(`sub sp, sp, #${frame % 4096}`);
    } else if (frame > 0) this.#emit(`sub sp, sp, #${frame}`);
    for (const [k, r] of this.#saved.entries())
      this.#mem('str', r, 'sp', this.#slot('save') + 8 * k);
    if (sretSlot) this.#mem('str', 'x8', 'sp', this.#slot('sret'));
    // Incoming parameters: aggregates copied first (their pointers are in x0-x7, which
    // scalar homes may then reuse in a leaf), then register scalars, then stack scalars.
    const { places } = argLayout(fn.params);
    fn.params.forEach((t, i) => {
      const place = places[i] as ArgPlace;
      if (isPrimitive(t)) return;
      if (place.reg !== undefined)
        this.#copy('sp', this.#slot(`p${i}`), `x${place.reg}`, 0, words(t));
      else {
        this.#mem('ldr', 'x12', 'sp', frame + 16 + (place.stack as number));
        this.#copy('sp', this.#slot(`p${i}`), 'x12', 0, words(t));
      }
    });
    fn.params.forEach((t, i) => {
      const place = places[i] as ArgPlace;
      if (!isPrimitive(t) || place.reg === undefined) return;
      const r = `w${place.reg}`;
      if (t === 'bool') this.#emit(`and ${r}, ${r}, #1`);
      this.#set(
        `p${i}`,
        (d) => {
          if (d !== r) this.#emit(`mov ${d}, ${r}`);
        },
        true,
      );
    });
    fn.params.forEach((t, i) => {
      const place = places[i] as ArgPlace;
      if (!isPrimitive(t) || place.stack === undefined) return;
      const incoming = frame + 16 + place.stack;
      this.#set(
        `p${i}`,
        (d) => {
          this.#mem(t === 'bool' ? 'ldrb' : 'ldr', d, 'sp', incoming);
          if (t === 'bool') this.#emit(`and ${d}, ${d}, #1`);
        },
        true,
      );
    });
    this.#body(env);
    this.#pos += 1;
    if (isPrimitive(fn.result)) this.#into('w0', ret);
    else if (this.#leaf) this.#place(ret, 'x8', 0);
    else {
      this.#mem('ldr', 'x12', 'sp', this.#slot('sret'));
      this.#place(ret, 'x12', 0);
    }
    for (const [k, r] of this.#saved.entries())
      this.#mem('ldr', r, 'sp', this.#slot('save') + 8 * k);
    this.#emit('mov sp, x29', 'ldp x29, x30, [sp], #16', 'ret');
    return this.out.join('\n');
  }
}

// ---------------------------------------------------------------------------
// Fold fusion
// ---------------------------------------------------------------------------

/**
 * Fuse a producer fold into its consumer: when `A = fold f1 N z e...` builds an N-element
 * array whose element i depends only on i and `e` (f1 writes element i on every trip and
 * never reads its state), and A's only use is an extra argument of `fold f2 N init ... A
 * ...` whose body reads A only at the counter, the consumer's `get A i` becomes f1's
 * element expression and A is never stored. Exact under A0's value semantics: A is
 * immutable, unshared, and has no identity, so no other code can observe that it was not
 * materialized. The fused body is synthesized for this backend only (it is always inlined:
 * the top-level function is depth 0).
 */
function fuseFolds(fn: TypedFunc): TypedFunc {
  let cur = fn;
  for (let round = 0; round < 8; round += 1) {
    const next = fuseOnce(cur);
    if (next === undefined) return cur;
    cur = next;
  }
  return cur;
}

function fuseOnce(fn: TypedFunc): TypedFunc | undefined {
  const uses = new Map<string, number>();
  const count = (o: Operand): void => {
    if (o.kind === 'node') uses.set(o.id, (uses.get(o.id) ?? 0) + 1);
  };
  for (const n of fn.nodes) n.args.forEach(count);
  count(fn.ret);
  const defs = new Map(fn.nodes.map((n) => [n.id, n]));
  for (const consumer of fn.nodes) {
    const trips = consumer.args[0];
    const body2 = fn.calls.get(consumer.callee ?? '');
    if (consumer.op !== 'fold' || trips?.kind !== 'u32' || body2 === undefined) continue;
    for (let k = 2; k < consumer.args.length; k += 1) {
      const a = consumer.args[k] as Operand;
      if (a.kind !== 'node' || uses.get(a.id) !== 1) continue;
      const producer = defs.get(a.id);
      const body1 = fn.calls.get(producer?.callee ?? '');
      if (
        producer === undefined ||
        body1 === undefined ||
        producer.op !== 'fold' ||
        producer.args[0]?.kind !== 'u32' ||
        producer.args[0].value !== trips.value ||
        !isU32Array(fn.types.get(producer.id), trips.value) ||
        !writesEveryElement(body1)
      )
        continue;
      // The consumer reads its parameter k only as `get pk p1`.
      const onlyAtCounter = body2.nodes.every((n) =>
        n.args.every(
          (o, j) => !isParam(o, k) || (n.op === 'get' && j === 0 && isParam(n.args[1], 1)),
        ),
      );
      if (!onlyAtCounter || isParam(body2.ret, k)) continue;
      const fused = fuseBodies(fn, body2, k, body1);
      if (fused === undefined) continue;
      const init = producer.args[1] as Operand;
      const dropInit =
        init.kind === 'node' && uses.get(init.id) === 1 && defs.get(init.id)?.op === 'arr';
      const extras2 = consumer.args.slice(2).filter((_, j) => j + 2 !== k);
      const nodes = fn.nodes
        .filter((n) => n !== producer && !(dropInit && init.kind === 'node' && n.id === init.id))
        .map((n) =>
          n === consumer
            ? {
                ...n,
                callee: fused.name,
                args: [trips, consumer.args[1] as Operand, ...extras2, ...producer.args.slice(2)],
              }
            : n,
        );
      const calls = new Map(fn.calls);
      calls.set(fused.name, fused);
      return validateFunction(
        { name: fn.name, params: fn.params, result: fn.result, nodes, ret: fn.ret },
        calls,
      );
    }
  }
  return undefined;
}

/** The body of `fold f2` with its parameter k replaced by f1's element expression. */
function fuseBodies(
  fn: TypedFunc,
  body2: TypedFunc,
  k: number,
  body1: TypedFunc,
): TypedFunc | undefined {
  const set = body1.nodes.find((n) => body1.ret.kind === 'node' && n.id === body1.ret.id);
  if (set === undefined || body1.nodes.some((n) => n.args.some((o) => sameOp(o, body1.ret))))
    return undefined;
  const extras2 = body2.params.length - 3;
  let fresh = 0;
  const rename = new Map<string, string>();
  const nextId = (prefix: string, id: string): string => {
    const name = `v${fresh}`;
    fresh += 1;
    rename.set(`${prefix}${id}`, name);
    return name;
  };
  const map1 = (o: Operand): Operand => {
    if (o.kind === 'node') return { kind: 'node', id: rename.get(`a${o.id}`) as string };
    if (o.kind === 'param' && o.index >= 2)
      return { kind: 'param', index: 2 + extras2 + o.index - 2 };
    return o;
  };
  const nodes: Node[] = [];
  for (const n of body1.nodes) {
    if (n === set) continue;
    const args = n.args.map(map1);
    nodes.push({ ...n, id: nextId('a', n.id), args });
  }
  const element = map1(set.args[2] as Operand);
  const map2 = (o: Operand): Operand => {
    if (o.kind === 'node') return { kind: 'node', id: rename.get(`b${o.id}`) as string };
    if (o.kind === 'param' && o.index > k) return { kind: 'param', index: o.index - 1 };
    return o;
  };
  for (const n of body2.nodes) {
    const id = nextId('b', n.id);
    if (n.op === 'get' && isParam(n.args[0], k)) nodes.push({ id, op: 'mov', args: [element] });
    else {
      const { callee, pred, text } = n;
      nodes.push({
        id,
        op: n.op,
        args: n.args.map(map2),
        ...(callee === undefined ? {} : { callee }),
        ...(pred === undefined ? {} : { pred }),
        ...(text === undefined ? {} : { text }),
      });
    }
  }
  if (nodes.length > INLINE_MAX_NODES) return undefined;
  const calls = new Map([...body2.calls, ...body1.calls]);
  let name = 'fz';
  for (let i = 0; calls.has(name) || fn.calls.has(name) || name === fn.name; i += 1)
    name = `fz${i}`;
  const params = [...body2.params.filter((_, j) => j !== k), ...body1.params.slice(2)];
  return validateFunction(
    { name, params, result: body2.result, nodes, ret: map2(body2.ret) },
    calls,
  );
}

/** Emit one function as Darwin AArch64 assembly (a `.globl _a0_<name>` block). */
export function emitArm64Function(fn: TypedFunc): string {
  return new FunctionEmitter(fuseFolds(fn)).emit();
}

/** Assemble function blocks into one .s module for `clang -x assembler` / `as`. */
export function assembleArm64(bodies: readonly string[], compilerVersion: string): string {
  return `; Generated by A0 ${compilerVersion}. Darwin arm64 assembly; exact u32/bool semantics.\n\t.section __TEXT,__text,regular,pure_instructions\n\n${bodies.join('\n\n')}\n\n.subsections_via_symbols\n`;
}
