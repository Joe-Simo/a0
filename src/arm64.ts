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
 *   callee's result alias likewise. A fold over an array therefore updates one element per
 *   iteration instead of copying the array twice per iteration.
 * - Instruction selection (third version): a compare used only by selects sets the flags
 *   for `csel` directly; a single-use `mul` feeding `add`/`sub` becomes `madd`/`msub`; a
 *   single-use literal shift becomes the shifted-register operand; `shl`/`shr` pairs whose
 *   distances sum to 0 mod 32 become `ror`; a zero literal reads as wzr. Literals that need
 *   movz/movk are materialized once (in the outermost loop's preheader) and kept in a
 *   register. Repeated compares and adjacent word loads/stores are cleaned up afterwards
 *   (one `cmp`, `ldp`/`stp`).
 * - Loops are rotated (test at the bottom, entry test only when the count may be zero); a
 *   loop body's result is computed straight into the state's register when the state is not
 *   read after it. A fold with a literal count of at most 16 trips and 64 body nodes is
 *   unrolled with literal counters. A fold that only fills its array state (`set p0 p1 v`,
 *   no other read of p0) with lane-wise body ops runs four elements per NEON register, up to
 *   four registers per trip; when such a fold writes every element its initial array is
 *   never stored. Array accesses use scaled register offsets, and a counter known to be in
 *   range needs no mask. A leaf with a small frame keeps no frame record.
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
  containsIo,
  isPrimitive,
  type Node,
  type Op,
  type Operand,
  type Type,
  type TypedFunc,
} from './core.js';
import { emitFused, fillRun, overwritesState } from './optimize.js';

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
/** A fold with a literal trip count is emitted straight-line when trips x body nodes fit. */
const UNROLL_MAX_NODES = 64;
const UNROLL_MAX_TRIPS = 16;
/** Zero-literal runs at least this long are cleared by a store loop instead of straight-line stores. */
const ZERO_LOOP_WORDS = 32;
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
  return true;
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
 * Is the zero array at `index` dead storage: its only use is the initial state of a `fold`
 * that writes every element before reading it (see optimize.ts `overwritesState`)? Its zero fill is then unobservable and is skipped.
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
  return overwritesState(fn, use.n);
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

const CONDITION: Partial<Record<Op, string>> = {
  eq: 'eq',
  ne: 'ne',
  lt: 'lo',
  le: 'ls',
  gt: 'hi',
  ge: 'hs',
};
/** The condition that holds after `cmp b, a` exactly when `cond` holds after `cmp a, b`. */
const SWAPPED: Record<string, string> = {
  eq: 'eq',
  ne: 'ne',
  lo: 'hi',
  hi: 'lo',
  ls: 'hs',
  hs: 'ls',
};

/** A rotate recognized from `or (shl x s) (shr x t)` with s + t = 0 (mod 32). */
type Rotate =
  | { readonly x: Operand; readonly right: number }
  | { readonly x: Operand; readonly rightBy: Operand }
  | { readonly x: Operand; readonly leftBy: Operand };

/**
 * Instruction-selection plan for one function body: nodes whose only consumer can absorb
 * them into a single AArch64 instruction are emitted at that consumer instead of at their
 * definition (a compare into `csel`, a `mul` into `madd`/`msub`, a literal shift into the
 * shifted-register operand, `shl`/`shr` pairs into `ror`). Decided from the function's
 * use lists alone, so it holds for every inlined instance of the function.
 */
interface Selection {
  readonly byId: ReadonlyMap<string, Node>;
  readonly deferred: ReadonlySet<string>;
  /** `arr` nodes whose only use is as the state of a fill fold that overwrites every element. */
  readonly deadInit: ReadonlySet<string>;
  readonly compare: ReadonlySet<string>;
  readonly rotate: ReadonlyMap<string, Rotate>;
  readonly madd: ReadonlyMap<string, { readonly mul: Node; readonly other: Operand }>;
  readonly shifted: ReadonlyMap<
    string,
    {
      readonly other: Operand;
      readonly x: Operand;
      readonly kind: 'lsl' | 'lsr';
      readonly by: number;
    }
  >;
}

const SELECTIONS = new WeakMap<TypedFunc, Selection>();

function selection(fn: TypedFunc): Selection {
  const cached = SELECTIONS.get(fn);
  if (cached !== undefined) return cached;
  const byId = new Map(fn.nodes.map((n) => [n.id, n]));
  const uses = new Map<string, { consumer: Node | undefined; position: number }[]>();
  const useOf = (o: Operand, consumer: Node | undefined, position: number): void => {
    if (o.kind !== 'node') return;
    const list = uses.get(o.id) ?? [];
    list.push({ consumer, position });
    uses.set(o.id, list);
  };
  for (const n of fn.nodes) for (const [k, o] of n.args.entries()) useOf(o, n, k);
  useOf(fn.ret, undefined, 0);
  /** The node behind operand `o` when its single use is by `consumer`. */
  const soleUse = (o: Operand, consumer: Node): Node | undefined => {
    if (o.kind !== 'node') return undefined;
    const list = uses.get(o.id) ?? [];
    return list.length === 1 && list[0]?.consumer === consumer ? byId.get(o.id) : undefined;
  };
  const litShift = (n: Node | undefined, op: Op): n is Node =>
    n !== undefined && n.op === op && n.args[1]?.kind === 'u32';
  const deferred = new Set<string>();
  const compare = new Set<string>();
  const rotate = new Map<string, Rotate>();
  const madd = new Map<string, { mul: Node; other: Operand }>();
  const shifted = new Map<
    string,
    { other: Operand; x: Operand; kind: 'lsl' | 'lsr'; by: number }
  >();
  for (const n of fn.nodes) {
    const list = uses.get(n.id) ?? [];
    if (
      CONDITION[n.op] !== undefined &&
      list.length > 0 &&
      list.every((u) => u.consumer?.op === 'select' && u.position === 0)
    ) {
      compare.add(n.id);
      deferred.add(n.id);
    }
  }
  for (const n of fn.nodes) {
    if (n.op === 'or') {
      const pa = soleUse(n.args[0] as Operand, n);
      const pb = soleUse(n.args[1] as Operand, n);
      const [l, r] =
        pa?.op === 'shl' && pb?.op === 'shr'
          ? [pa, pb]
          : pa?.op === 'shr' && pb?.op === 'shl'
            ? [pb, pa]
            : [];
      if (
        l !== undefined &&
        r !== undefined &&
        sameOp(l.args[0] as Operand, r.args[0] as Operand)
      ) {
        const x = l.args[0] as Operand;
        const ls = l.args[1] as Operand;
        const rs = r.args[1] as Operand;
        let plan: Rotate | undefined;
        let extra: Node | undefined;
        if (ls.kind === 'u32' && rs.kind === 'u32') {
          if (((ls.value & 31) + (rs.value & 31)) % 32 === 0) plan = { x, right: rs.value & 31 };
        } else {
          // Variable distances: one side is `sub L s` with L = 0 (mod 32), the other `s`.
          const subOf = (o: Operand, user: Node): Node | undefined => {
            const d = soleUse(o, user);
            return d?.op === 'sub' && d.args[0]?.kind === 'u32' && d.args[0].value % 32 === 0
              ? d
              : undefined;
          };
          const rsub = subOf(rs, r);
          const lsub = subOf(ls, l);
          if (rsub !== undefined && sameOp(rsub.args[1] as Operand, ls)) {
            plan = { x, leftBy: ls };
            extra = rsub;
          } else if (lsub !== undefined && sameOp(lsub.args[1] as Operand, rs)) {
            plan = { x, rightBy: rs };
            extra = lsub;
          }
        }
        if (plan !== undefined) {
          rotate.set(n.id, plan);
          deferred.add(l.id);
          deferred.add(r.id);
          if (extra !== undefined) deferred.add(extra.id);
          continue;
        }
      }
    }
    if (n.op === 'add' || n.op === 'sub') {
      const positions = n.op === 'add' ? [1, 0] : [1];
      const k = positions.find((p) => soleUse(n.args[p] as Operand, n)?.op === 'mul');
      if (k !== undefined) {
        const mul = soleUse(n.args[k] as Operand, n) as Node;
        madd.set(n.id, { mul, other: n.args[1 - k] as Operand });
        deferred.add(mul.id);
        continue;
      }
    }
    if (n.op === 'add' || n.op === 'sub' || n.op === 'and' || n.op === 'or' || n.op === 'xor') {
      const positions = n.op === 'sub' ? [1] : [1, 0];
      for (const p of positions) {
        const s = soleUse(n.args[p] as Operand, n);
        if (!(litShift(s, 'shl') || litShift(s, 'shr'))) continue;
        const by = (s.args[1] as { value: number }).value & 31;
        shifted.set(n.id, {
          other: n.args[1 - p] as Operand,
          x: s.args[0] as Operand,
          kind: s.op === 'shl' ? 'lsl' : 'lsr',
          by,
        });
        deferred.add(s.id);
        break;
      }
    }
  }
  const deadInit = new Set<string>();
  for (const n of fn.nodes) {
    if (n.op !== 'arr') continue;
    const list = uses.get(n.id) ?? [];
    const only = list.length === 1 ? list[0] : undefined;
    const fold = only?.consumer;
    const t = fn.types.get(n.id);
    if (only === undefined || fold === undefined || fold.op !== 'fold' || only.position !== 1)
      continue;
    const count = fold.args[0];
    const body = fold.callee === undefined ? undefined : fn.calls.get(fold.callee);
    if (
      count?.kind === 'u32' &&
      t !== undefined &&
      !isPrimitive(t) &&
      t.kind === 'arr' &&
      count.value >= t.length &&
      body !== undefined &&
      fillBody(body) !== undefined
    )
      deadInit.add(n.id);
  }
  const result: Selection = { byId, deferred, deadInit, compare, rotate, madd, shifted };
  SELECTIONS.set(fn, result);
  return result;
}

/**
 * A fold body that only fills its state: `ret` is `set p0 p1 v` and nothing else reads p0,
 * so trip i writes element i and reads no element. With a literal count of at least the
 * array length every element is written, so the initial value is never observed.
 */
function fillBody(callee: TypedFunc): { value: Operand; nodes: readonly Node[] } | undefined {
  const ret = callee.ret;
  if (ret.kind !== 'node') return undefined;
  const last = callee.nodes.find((n) => n.id === ret.id);
  const state = callee.params[0];
  if (
    last === undefined ||
    last.op !== 'set' ||
    state === undefined ||
    isPrimitive(state) ||
    state.kind !== 'arr' ||
    words(state.elem) !== 1
  )
    return undefined;
  const [target, index, value] = last.args as [Operand, Operand, Operand];
  if (
    !(target.kind === 'param' && target.index === 0 && index.kind === 'param' && index.index === 1)
  )
    return undefined;
  for (const n of callee.nodes)
    for (const [k, o] of n.args.entries())
      if (o.kind === 'param' && o.index === 0 && !(n === last && k === 0)) return undefined;
  return { value, nodes: callee.nodes.filter((n) => n !== last) };
}

/** Ops a fill body may use to be computed four lanes at a time (32-bit lanes, A0 wrap semantics). */
const VECTOR_OPS = new Set<Op>(['mov', 'add', 'sub', 'mul', 'and', 'or', 'xor', 'shl', 'shr']);
/** Vector registers for a vectorized fill: v16 lane counters, v17 step, v18 shift mask, v19.. values. */
const VECTOR_FIRST = 19;
const VECTOR_LAST = 31;

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
  /** The `sub p1 1` index when the read is its only use (then never computed). */
  readonly index?: string;
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
function carriedRead(body: TypedFunc): { get: string; set: string; index?: string } | undefined {
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
    if (d?.op === 'sub' && isParam(d.args[0], 1) && one?.kind === 'u32' && one.value === 1) {
      const reads = body.nodes.filter((m) => m.args.some((a) => sameOp(a, j))).length;
      return reads === 1 && !sameOp(body.ret, j)
        ? { get: n.id, set: set.id, index: d.id }
        : { get: n.id, set: set.id };
    }
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
  #loops: { start: number; used: Set<string>; key: string }[] = [];
  /** Literals materialized once: keyed by value and the outermost enclosing loop ('' at top). */
  readonly #consts = new Map<string, number>();
  /** Hoisted literals per outermost loop key, materialized in that loop's preheader. */
  readonly #loopConsts = new Map<string, string[]>();
  /** Top-level literals already materialized in pass 2. */
  readonly #ready = new Set<string>();
  /** Largest value a scalar key can hold (a literal-count loop counter). */
  readonly #bound = new Map<string, number>();
  /** Register hints: key -> key whose register it takes (a loop body result onto its state). */
  readonly #coalesce = new Map<string, string>();
  readonly #alias = new Map<string, string>();
  readonly #regs = new Map<string, string>();
  readonly #slots = new Map<string, number>();
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

  /** Byte offset from sp of a key's slot (aliases resolved). */
  #slot(key: string): number {
    const off = this.#slots.get(this.#canon(key));
    if (off === undefined) {
      if (this.#dry) return 0;
      throw new A0Error(`arm64: no slot for ${key}`);
    }
    return this.#outgoing + off;
  }

  /** Define `key` at the current position; aggregates get a slot. */
  #def(key: string, type: Type): void {
    if (!this.#dry) return;
    this.#defs.set(key, { pos: this.#pos, type });
    if (!isPrimitive(type)) this.#alloc(key, 4 * words(type));
  }

  /** Define aggregate `key` as another name for `target`'s storage. */
  #defAlias(key: string, target: string, type: Type): void {
    if (!this.#dry) return;
    if (this.#consts.has(this.#canon(target))) refuse('internal: alias of a literal');
    this.#defs.set(key, { pos: this.#pos, type });
    this.#alias.set(key, this.#canon(target));
  }

  /** Record a read of `v` at the current position (for liveness). */
  #use(v: Val): void {
    if (!this.#dry) return;
    // A literal with a hoisted home reads that home.
    const raw = v.kind === 'key' ? v.key : v.home;
    if (raw === undefined) return;
    const k = this.#canon(raw);
    this.#last.set(k, this.#pos);
    for (const l of this.#loops) l.used.add(k);
  }

  #home(key: string): Home {
    if (this.#dry) return { slot: 0 };
    const reg = this.#regs.get(this.#canon(key));
    return reg === undefined ? { slot: this.#slot(key) } : { reg };
  }

  /** Resolve operand `o` and record the read. */
  #val(env: Env, o: Operand): Val {
    const v = this.#resolve(env, o);
    this.#use(v);
    return v;
  }

  /**
   * A register holding literal `value`. Literals needing movz/movk are materialized once:
   * in the preheader of the outermost enclosing loop, or at their first read in straight-line
   * code, and kept in a register while later reads remain (inline in `scratch` when spilled).
   */
  #lit(value: number, scratch: string): string {
    const outer = this.#loops[0];
    // Outside loops only a literal needing movz+movk is worth a register across its reads.
    if (outer === undefined && movImm(scratch, value).length === 1) {
      if (!this.#dry) this.#emit(...movImm(scratch, value));
      return scratch;
    }
    const scope = outer?.key ?? '';
    const key = `#k${value}@${scope}`;
    if (this.#dry) {
      if (!this.#defs.has(key)) {
        // Half a position early: the register is taken before this node's operands die.
        this.#defs.set(key, {
          pos: (outer === undefined ? this.#pos : outer.start) - 0.5,
          type: 'u32',
        });
        this.#consts.set(key, value);
        if (outer !== undefined)
          this.#loopConsts.set(scope, [...(this.#loopConsts.get(scope) ?? []), key]);
      }
      this.#use({ kind: 'key', key, type: 'u32' });
      return scratch;
    }
    const reg = this.#regs.get(key);
    if (reg === undefined) {
      this.#emit(...movImm(scratch, value));
      return scratch;
    }
    if (outer === undefined && !this.#ready.has(key)) {
      this.#emit(...movImm(reg, value));
      this.#ready.add(key);
    }
    return reg;
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
      // Loads then stores two words at a time; `pairMemory` turns each pair into ldp/stp.
      for (let k = 0; k < n; k += 2) {
        const two = k + 1 < n;
        this.#mem('ldr', 'w9', src, so + 4 * k);
        if (two) this.#mem('ldr', 'w13', src, so + 4 * k + 4);
        this.#mem('str', 'w9', dst, d + 4 * k);
        if (two) this.#mem('str', 'w13', dst, d + 4 * k + 4);
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

  /**
   * A w register holding scalar `v`: its home register, or `scratch` after materializing.
   * With `zr`, a zero literal reads as wzr (only where register 31 means the zero register).
   */
  #read(v: Val, scratch: string, zr = false): string {
    if (v.kind === 'lit' && v.home === undefined) {
      if (v.value === 0) {
        if (zr) return 'wzr';
        this.#emit(`movz ${scratch}, #0`);
        return scratch;
      }
      return this.#lit(v.value, scratch);
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
    if (v.kind === 'lit') {
      this.#emit(...movImm(dst, v.value));
      return;
    }
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
      this.#mem('str', this.#read(v, 'w9', true), base, off);
      return;
    }
    if (v.kind === 'key') this.#copy(base, off, 'sp', this.#slot(v.key), words(v.type));
  }

  /**
   * A w register holding (index operand mod n), n > 1: the index itself when its bound
   * proves it in range, else w10. Uses w10-w12.
   */
  #index(idx: Val, n: number): string {
    const r = this.#read(idx, 'w10');
    const bound = idx.kind === 'key' ? this.#bound.get(this.#canon(idx.key)) : undefined;
    if (bound !== undefined && bound < n) return r;
    if ((n & (n - 1)) === 0) this.#emit(`and w10, ${r}, #${n - 1}`);
    else {
      const rn = this.#lit(n, 'w11');
      this.#emit(`udiv w12, ${r}, ${rn}`, `msub w10, w12, ${rn}, ${r}`);
    }
    return 'w10';
  }

  /**
   * Address operand of element `index` (a w register) of an array at [sp + base]. One-word
   * elements use the scaled register-offset form; larger ones compute x16 (uses x10, x16).
   */
  #element(base: number, index: string, elemBytes: number, pointer: boolean): string {
    if (elemBytes === 4 && !pointer) {
      let b = 'sp';
      if (base !== 0) {
        this.#addr('x16', 'sp', base);
        b = 'x16';
      }
      return `[${b}, ${index}, uxtw #2]`;
    }
    this.#addr('x16', 'sp', base);
    const shift = Math.log2(elemBytes);
    if (Number.isInteger(shift) && shift <= 4) this.#emit(`add x16, x16, ${index}, uxtw #${shift}`);
    else {
      const re = this.#lit(elemBytes, 'w11');
      this.#emit(`umull x10, ${index}, ${re}`, 'add x16, x16, x10');
    }
    return '[x16]';
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
      if (sink === 'bind') {
        // A scalar result is another name for the callee's return value.
        if (ret.kind === 'key') this.#defAlias(result, ret.key, type);
        else {
          this.#def(result, type);
          this.#set(result, (d) => this.#into(d, ret), true);
        }
        return;
      }
      // Loop state: when the state is not read after the body's result is defined, the
      // result can be computed straight into the state's register (no copy per trip).
      if (this.#dry && ret.kind === 'key') {
        const rk = this.#canon(ret.key);
        const def = this.#defs.get(rk);
        const lastState = this.#last.get(this.#canon(result)) ?? Number.POSITIVE_INFINITY;
        const loop = this.#loops.at(-1);
        if (
          def !== undefined &&
          !this.#consts.has(rk) &&
          loop !== undefined &&
          def.pos > loop.start &&
          lastState <= def.pos
        )
          this.#coalesce.set(rk, this.#canon(result));
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

  /**
   * A fill fold (see `fillBody`) with a literal count within the array, whose body uses only
   * lane-wise ops over the counter, loop-invariant scalars, and literals: computed four
   * elements per trip in NEON registers and stored 16 bytes at a time, with the count mod 4
   * trailing trips inlined as scalar code. Returns false when the fold does not qualify.
   */
  #vectorFill(
    env: Env,
    n: Node,
    index: number,
    callee: TypedFunc,
    count: Val,
    init: Val,
    extras: readonly Val[],
    key: string,
    t: Type,
  ): boolean {
    // The shared fill-run analysis (optimize.ts `fillRun`) decides the shape.
    const run = fillRun(env.fn, n);
    const body = run === undefined ? undefined : { value: run.value, nodes: run.nodes };
    if (
      body === undefined ||
      count.kind !== 'lit' ||
      count.value < 8 ||
      isPrimitive(t) ||
      t.kind !== 'arr' ||
      count.value > t.length ||
      extras.some((e) => e.kind === 'key' && !isPrimitive(e.type)) ||
      !this.#inlinable(callee, env) ||
      body.nodes.some((m) => !VECTOR_OPS.has(m.op) || !isPrimitive(callee.types.get(m.id) ?? 'io'))
    )
      return false;
    // Registers: invariants and literals once; per unrolled copy, one per node plus a lane
    // counter (copy 0 uses v16). Four copies when they fit, else two, else one.
    const lits = new Map<number, string>();
    const invariants = new Map<number, string>();
    const varShift = body.nodes.some(
      (m) => (m.op === 'shl' || m.op === 'shr') && m.args[1]?.kind !== 'u32',
    );
    let next = VECTOR_FIRST;
    const take = (): string | undefined => (next <= VECTOR_LAST ? `v${next++}` : undefined);
    const shared = (o: Operand): boolean => {
      if (o.kind === 'node' || (o.kind === 'param' && o.index === 1)) return true;
      if (o.kind === 'param') {
        if (!invariants.has(o.index)) {
          const r = take();
          if (r === undefined) return false;
          invariants.set(o.index, r);
        }
        return true;
      }
      const v = o.kind === 'u32' ? o.value : o.value ? 1 : 0;
      if (!lits.has(v)) {
        const r = take();
        if (r === undefined) return false;
        lits.set(v, r);
      }
      return true;
    };
    for (const m of body.nodes)
      for (const [k, o] of m.args.entries())
        if (!((m.op === 'shl' || m.op === 'shr') && k === 1 && o.kind === 'u32') && !shared(o))
          return false;
    if (!shared(body.value)) return false;
    const free = VECTOR_LAST - next + 1;
    const copies = [4, 2, 1].find(
      (u) => u * body.nodes.length + (u - 1) <= free && 4 * u <= count.value,
    );
    if (copies === undefined) return false;
    const counters = ['v16'];
    for (let u = 1; u < copies; u += 1) counters.push(take() as string);
    const regs: Map<string, string>[] = [];
    for (let u = 0; u < copies; u += 1)
      regs.push(new Map(body.nodes.map((m) => [m.id, take() as string])));
    const reg = (o: Operand, u: number): string => {
      if (o.kind === 'node') return regs[u]?.get(o.id) as string;
      if (o.kind === 'param')
        return o.index === 1 ? (counters[u] as string) : (invariants.get(o.index) as string);
      return lits.get(o.kind === 'u32' ? o.value : o.value ? 1 : 0) as string;
    };
    // State: the init slot itself when owned, else a copy (skipped when the init is dead).
    if (init.kind === 'key' && mutableHere(env.fn, n.args[1] as Operand, index, 1, env.ownedP0))
      this.#defAlias(key, init.key, t);
    else {
      this.#def(key, t);
      this.#place(init, 'sp', this.#slot(key));
    }
    // Preheader: lane counters {4u, 4u+1, 4u+2, 4u+3}, step 4 x copies, invariants broadcast.
    this.#emit(
      'movz x9, #0',
      'movk x9, #1, lsl #32',
      'movz x10, #2',
      'movk x10, #3, lsl #32',
      'fmov d16, x9',
      'mov v16.d[1], x10',
    );
    const trips = Math.floor(count.value / (4 * copies));
    // One trip covering the whole fill is straight-line code (no counter, no branch).
    const single = trips === 1 && count.value === 4 * copies;
    if (!single) this.#emit(`movi v17.4s, #${4 * copies}`);
    for (let u = 1; u < copies; u += 1)
      this.#emit(
        `movi ${counters[u]}.4s, #${4 * u}`,
        `add ${counters[u]}.4s, ${counters[u]}.4s, v16.4s`,
      );
    if (varShift) this.#emit('movi v18.4s, #31');
    for (const [p, r] of invariants) {
      const v = extras[p - 2] ?? refuse(`fill body reads missing parameter p${p}`);
      this.#use(v);
      this.#emit(`dup ${r}.4s, ${this.#read(v, 'w9', true)}`);
    }
    for (const [v, r] of lits) {
      if (v <= 255) this.#emit(`movi ${r}.4s, #${v}`);
      else this.#emit(...movImm('w9', v), `dup ${r}.4s, w9`);
    }
    const lanes = (u: number): void => {
      for (const m of body.nodes) {
        const d = regs[u]?.get(m.id) as string;
        const [a, b] = m.args as [Operand, Operand];
        const ra = reg(a, u);
        switch (m.op) {
          case 'mov':
            this.#emit(`orr ${d}.16b, ${ra}.16b, ${ra}.16b`);
            break;
          case 'add':
          case 'sub':
          case 'mul':
            this.#emit(`${m.op} ${d}.4s, ${ra}.4s, ${reg(b, u)}.4s`);
            break;
          case 'and':
          case 'or':
          case 'xor':
            this.#emit(
              `${{ and: 'and', or: 'orr', xor: 'eor' }[m.op]} ${d}.16b, ${ra}.16b, ${reg(b, u)}.16b`,
            );
            break;
          case 'shl':
          case 'shr': {
            if (b.kind === 'u32') {
              const k = b.value & 31;
              if (k === 0) this.#emit(`orr ${d}.16b, ${ra}.16b, ${ra}.16b`);
              else this.#emit(`${m.op === 'shl' ? 'shl' : 'ushr'} ${d}.4s, ${ra}.4s, #${k}`);
              break;
            }
            // Distance modulo 32 (A0's five-bit mask); USHL shifts right for negative lanes.
            this.#emit(`and ${d}.16b, ${reg(b, u)}.16b, v18.16b`);
            if (m.op === 'shr') this.#emit(`neg ${d}.4s, ${d}.4s`);
            this.#emit(`ushl ${d}.4s, ${ra}.4s, ${d}.4s`);
            break;
          }
          default:
            refuse(`internal: ${m.op} in a vector fill`);
        }
      }
    };
    const q = (u: number): string => `q${reg(body.value, u).slice(1)}`;
    const top = this.#label();
    this.#addr('x14', 'sp', this.#slot(key));
    if (!single) this.#emit(...movImm('w13', trips), `${top}:`);
    for (let u = 0; u < copies; u += 1) lanes(u);
    for (let u = 0; u < copies; u += 2)
      this.#emit(
        u + 1 < copies
          ? `stp ${q(u)}, ${q(u + 1)}, [x14, #${16 * u}]`
          : `str ${q(u)}, [x14, #${16 * u}]`,
      );
    if (single) return true;
    this.#emit(`add x14, x14, #${16 * copies}`);
    for (const c of counters) this.#emit(`add ${c}.4s, ${c}.4s, v17.4s`);
    this.#emit('subs w13, w13, #1', `b.ne ${top}`);
    // Whole groups of four left over: copy u's counters already hold the next group u.
    const groups = Math.floor((count.value - trips * 4 * copies) / 4);
    for (let u = 0; u < groups; u += 1) {
      lanes(u);
      this.#emit(`str ${q(u)}, [x14, #${16 * u}]`);
    }
    const state: Val = { kind: 'key', key, type: t };
    for (let i = 4 * Math.floor(count.value / 4); i < count.value; i += 1)
      this.#inline(
        env,
        callee,
        [state, { kind: 'lit', value: i, type: 'u32' }, ...extras],
        true,
        key,
        t,
        `${n.id}#${i}`,
        'store',
      );
    return true;
  }

  /** Set the flags for select condition `o` and return the condition code meaning true. */
  #condition(env: Env, o: Operand): string {
    const sel = selection(env.fn);
    const def = o.kind === 'node' && sel.compare.has(o.id) ? sel.byId.get(o.id) : undefined;
    if (def === undefined) {
      this.#emit(`cmp ${this.#read(this.#val(env, o), 'w9')}, #0`);
      return 'ne';
    }
    let x = this.#val(env, def.args[0] as Operand);
    let y = this.#val(env, def.args[1] as Operand);
    let cond = CONDITION[def.op] as string;
    if (x.kind === 'lit' && y.kind !== 'lit') {
      [x, y] = [y, x];
      cond = SWAPPED[cond] as string;
    }
    const rx = this.#read(x, 'w10');
    const ry = y.kind === 'lit' && y.value <= 4095 ? `#${y.value}` : this.#read(y, 'w11', true);
    this.#emit(`cmp ${rx}, ${ry}`);
    return cond;
  }

  #body(env: Env): void {
    for (const [i, n] of env.fn.nodes.entries()) this.#node(env, n, i);
  }

  #node(env: Env, n: Node, index: number): void {
    const t = env.fn.types.get(n.id) ?? refuse(`untyped node ${n.id}`);
    const key = `${env.prefix}n_${n.id}`;
    const sel = selection(env.fn);
    this.#pos += 1;
    // Absorbed into its consumer's instruction (see `selection`): nothing to emit here.
    if (sel.deferred.has(n.id)) return;
    // The index of the carried previous-element read: the read comes from a register.
    if (env.carry?.index === n.id) return;
    const vals = n.args.map((o) => this.#resolve(env, o));
    const [a, b, c] = vals;
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
    const COMMUTES = new Set(['add', 'mul', 'and', 'orr', 'eor']);
    const bin = (insn: string, imm?: (v: number) => string | undefined): void => {
      let [x, y] = [a as Val, b as Val];
      if (COMMUTES.has(insn) && x.kind === 'lit' && y.kind !== 'lit') [x, y] = [y, x];
      const literal = y.kind === 'lit' && imm !== undefined ? imm(y.value) : undefined;
      if (literal === '#0' && insn !== 'and') {
        // x op 0 = x for add, sub, orr, eor, and both shifts.
        scalar((d) => this.#into(d, x), true);
        return;
      }
      if (literal !== undefined) {
        const rx = this.#read(x, 'w10');
        scalar((d) => this.#emit(`${insn} ${d}, ${rx}, ${literal}`), true);
        return;
      }
      const rx = this.#read(x, 'w10', true);
      const ry = this.#read(y, 'w11', true);
      scalar((d) => this.#emit(`${insn} ${d}, ${rx}, ${ry}`), true);
    };
    /** add/sub/and/orr/eor, absorbing a planned rotate, multiply, or shifted operand. */
    const arith = (insn: string, imm: (v: number) => string | undefined): void => {
      const rot = sel.rotate.get(n.id);
      if (rot !== undefined) {
        const rx = this.#read(this.#val(env, rot.x), 'w11', true);
        if ('right' in rot) {
          scalar((d) => this.#emit(`ror ${d}, ${rx}, #${rot.right}`), true);
          return;
        }
        const by = this.#read(
          this.#val(env, 'rightBy' in rot ? rot.rightBy : rot.leftBy),
          'w10',
          true,
        );
        if ('rightBy' in rot) scalar((d) => this.#emit(`ror ${d}, ${rx}, ${by}`), true);
        // Left by s is right by -s: RORV takes the distance modulo 32.
        else scalar((d) => this.#emit(`neg w10, ${by}`, `ror ${d}, ${rx}, w10`), true);
        return;
      }
      const ma = sel.madd.get(n.id);
      if (ma !== undefined) {
        const r0 = this.#read(this.#val(env, ma.mul.args[0] as Operand), 'w10', true);
        const r1 = this.#read(this.#val(env, ma.mul.args[1] as Operand), 'w11', true);
        const ro = this.#read(this.#val(env, ma.other), 'w9', true);
        const op = insn === 'add' ? 'madd' : 'msub';
        scalar((d) => this.#emit(`${op} ${d}, ${r0}, ${r1}, ${ro}`), true);
        return;
      }
      const sh = sel.shifted.get(n.id);
      if (sh !== undefined) {
        const ro = this.#read(this.#val(env, sh.other), 'w10', true);
        const rx = this.#read(this.#val(env, sh.x), 'w11', true);
        scalar((d) => this.#emit(`${insn} ${d}, ${ro}, ${rx}, ${sh.kind} #${sh.by}`), true);
        return;
      }
      bin(insn, imm);
    };
    const small = (v: number): string | undefined => (v <= 4095 ? `#${v}` : undefined);
    const logical = (v: number): string | undefined => (isLogicalImm32(v) ? `#${v}` : undefined);
    const shift = (v: number): string => `#${v & 31}`;
    const cmp = (cond: string): void => {
      const [x, y, cc] =
        a?.kind === 'lit' && b?.kind !== 'lit'
          ? [b as Val, a, SWAPPED[cond] as string]
          : [a as Val, b as Val, cond];
      const rx = this.#read(x, 'w10');
      const ry = y.kind === 'lit' && y.value <= 4095 ? `#${y.value}` : this.#read(y, 'w11', true);
      scalar((d) => this.#emit(`cmp ${rx}, ${ry}`, `cset ${d}, ${cc}`), true);
    };
    const aggregateOf = (v: Val, what: string): { key: string; type: Type } => {
      if (v.kind !== 'key' || isPrimitive(v.type)) refuse(`${n.op} needs ${what}`);
      return { key: v.key, type: v.type };
    };
    if (env.carry?.get === n.id) {
      const cv: Val = { kind: 'key', key: env.carry.key, type: env.carry.type };
      this.#use(cv);
      // Another name for the carried register when every read of it precedes the `set`
      // that overwrites the register with this trip's element.
      const me: Operand = { kind: 'node', id: n.id };
      const setAt = env.fn.nodes.findIndex((m) => m.id === env.carry?.set);
      const early = env.fn.nodes.every((m, i) => i < setAt || !m.args.some((o) => sameOp(o, me)));
      if (feed === undefined && early && !sameOp(env.fn.ret, me)) {
        this.#defAlias(key, env.carry.key, t);
        return;
      }
      scalar((d) => this.#into(d, cv), true);
      return;
    }
    switch (n.op) {
      case 'mov': {
        const v = a as Val;
        if (v.kind === 'key') this.#defAlias(key, v.key, t);
        else scalar((d) => this.#into(d, v), true);
        return;
      }
      case 'add':
        arith('add', small);
        return;
      case 'sub':
        arith('sub', small);
        return;
      case 'mul':
        bin('mul');
        return;
      case 'and':
        arith('and', logical);
        return;
      case 'or':
        arith('orr', logical);
        return;
      case 'xor':
        arith('eor', logical);
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
        // Both operands are already computed values; select picks one. A compare whose
        // only uses are selects sets the flags here instead of materializing a bool.
        const cc = this.#condition(env, n.args[0] as Operand);
        if (isPrimitive(t)) {
          const rb = this.#read(b as Val, 'w13', true);
          const rcc = this.#read(c as Val, 'w14', true);
          scalar((d) => this.#emit(`csel ${d}, ${rb}, ${rcc}, ${cc}`), true);
          return;
        }
        this.#def(key, t);
        this.#addr('x10', 'sp', this.#slot(aggregateOf(b as Val, 'a value').key));
        this.#addr('x11', 'sp', this.#slot(aggregateOf(c as Val, 'a value').key));
        this.#emit(`csel x16, x10, x11, ${cc}`);
        this.#copy('sp', this.#slot(key), 'x16', 0, words(t));
        return;
      }
      case 'arr':
      case 'rec': {
        // A feed (see feedsOf) may already have defined the slot.
        if (!(this.#dry && this.#defs.has(key))) this.#def(key, t);
        if (sel.deadInit.has(n.id)) return;
        if (zeroArray(env.fn, n)) {
          if (!deadZeroFill(env.fn, index)) this.#zero(this.#slot(key), vals.length);
          return;
        }
        const feeds = feedsOf(env.fn);
        let off = this.#slot(key);
        for (let i = 0; i < vals.length; ) {
          const o = n.args[i] as Operand;
          if (o.kind === 'node' && feeds.get(o.id)?.arr === n.id) {
            off += 4 * words((vals[i] as Val).type);
            i += 1;
            continue;
          }
          // A run of zero literals is cleared 16 bytes per store.
          let run = 0;
          while (vals[i + run]?.kind === 'lit' && (vals[i + run] as { value: number }).value === 0)
            run += 1;
          if (run >= ZERO_LOOP_WORDS) {
            this.#zero(off, run);
            off += 4 * run;
            i += run;
            continue;
          }
          const v = vals[i] as Val;
          this.#place(v, 'sp', off);
          off += 4 * words(v.type);
          i += 1;
        }
        return;
      }
      case 'get': {
        const src = aggregateOf(a as Val, 'an array');
        const at = src.type;
        if (isPrimitive(at) || at.kind !== 'arr') refuse('get needs an array');
        const ew = words(at.elem);
        const base = this.#slot(src.key);
        if (b?.kind === 'lit' || at.length === 1) {
          const off = base + (b?.kind === 'lit' ? b.value % at.length : 0) * ew * 4;
          if (isPrimitive(t)) scalar((d) => this.#mem('ldr', d, 'sp', off), true);
          else {
            this.#def(key, t);
            this.#copy('sp', this.#slot(key), 'sp', off, ew);
          }
          return;
        }
        const ri = this.#index(b as Val, at.length);
        if (isPrimitive(t)) {
          const where = this.#element(base, ri, ew * 4, false);
          scalar((d) => this.#emit(`ldr ${d}, ${where}`), true);
        } else {
          this.#def(key, t);
          this.#element(base, ri, ew * 4, true);
          this.#copy('sp', this.#slot(key), 'x16', 0, ew);
        }
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
        if (b?.kind === 'lit' || at.length === 1) {
          const k = b?.kind === 'lit' ? b.value % at.length : 0;
          this.#place(c as Val, 'sp', dst + k * ew * 4);
          return;
        }
        const ri = this.#index(b as Val, at.length);
        const v = c as Val;
        if (v.kind === 'lit' || isPrimitive(v.type)) {
          const where = this.#element(dst, ri, ew * 4, false);
          this.#emit(`str ${this.#read(v, 'w9', true)}, ${where}`);
          return;
        }
        this.#element(dst, ri, ew * 4, true);
        this.#place(v, 'x16', 0);
        return;
      }
      case 'at':
      case 'put': {
        const src = aggregateOf(a as Val, 'a record');
        const rt = src.type;
        if (isPrimitive(rt) || rt.kind !== 'rec' || b?.kind !== 'lit')
          refuse(`${n.op} needs a record and a literal field`);
        const field = rt.fields[b.value] ?? refuse('field out of range');
        const off = 4 * rt.fields.slice(0, b.value).reduce((s, f) => s + words(f), 0);
        if (n.op === 'at') {
          const from = this.#slot(src.key) + off;
          if (isPrimitive(t)) scalar((d) => this.#mem('ldr', d, 'sp', from), true);
          else {
            this.#def(key, t);
            this.#copy('sp', this.#slot(key), 'sp', from, words(field));
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
        // A short fold with a literal count is straight-line code: each trip is the inlined
        // body with its counter bound to a literal (constant indices, no loop overhead).
        if (
          n.op === 'fold' &&
          count.kind === 'lit' &&
          count.value <= UNROLL_MAX_TRIPS &&
          count.value * callee.nodes.length <= UNROLL_MAX_NODES &&
          this.#inlinable(callee, env)
        ) {
          const trip = (i: number): Val => ({ kind: 'lit', value: i, type: 'u32' });
          if (isPrimitive(t)) {
            let cur = init;
            for (let i = 0; i < count.value; i += 1) {
              const k = `${key}#${i}`;
              this.#inline(
                env,
                callee,
                [cur, trip(i), ...extras],
                true,
                k,
                t,
                `${n.id}#${i}`,
                'bind',
              );
              cur = { kind: 'key', key: k, type: t };
            }
            if (cur.kind === 'key') this.#defAlias(key, cur.key, t);
            else scalar((d) => this.#into(d, cur), true);
            return;
          }
          if (
            init.kind === 'key' &&
            mutableHere(env.fn, n.args[1] as Operand, index, 1, env.ownedP0)
          )
            this.#defAlias(key, init.key, t);
          else {
            this.#def(key, t);
            this.#place(init, 'sp', this.#slot(key));
          }
          for (let i = 0; i < count.value; i += 1)
            this.#inline(
              env,
              callee,
              [state, trip(i), ...extras],
              true,
              key,
              t,
              `${n.id}#${i}`,
              'store',
            );
          return;
        }
        const plan =
          n.op === 'fold' && count.kind === 'lit' && this.#inlinable(callee, env)
            ? vectorPlan(callee, count.value)
            : undefined;
        if (n.op === 'fold' && this.#vectorFill(env, n, index, callee, count, init, extras, key, t))
          return;
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
        if (count.kind === 'lit' && count.value > 0) this.#bound.set(counter, count.value - 1);
        this.#set(counter, (d) => this.#emit(`movz ${d}, #0`), true);
        this.#loops.push({ start: this.#pos, used: new Set(), key });
        const top = this.#label();
        const done = this.#label();
        // Preheader: literals the loop reads, once (outermost loop only).
        if (!this.#dry && this.#loops.length === 1)
          for (const ck of this.#loopConsts.get(key) ?? []) {
            const reg = this.#regs.get(ck);
            if (reg !== undefined) this.#emit(...movImm(reg, this.#consts.get(ck) as number));
          }
        // Rotated loop: the trip test sits at the bottom; the entry test (counter = 0 < count)
        // is needed only when the count may be zero.
        this.#use(countVal);
        this.#use(cval);
        if (count.kind === 'lit') {
          if (count.value === 0) this.#emit(`b ${done}`);
        } else this.#emit(`cbz ${this.#read(countVal, 'w10')}, ${done}`);
        this.#emit(`${top}:`);
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
        this.#use(countVal);
        this.#use(cval);
        const ci = this.#read(cval, 'w9');
        const limit =
          count.kind === 'lit' && count.value <= 4095
            ? `#${count.value}`
            : this.#read(countVal, 'w10');
        this.#emit(`cmp ${ci}, ${limit}`, `b.lo ${top}`, `${done}:`);
        // Loop end: values from outside that the body reads stay live to here; so do the state and counter.
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
      // A coalesced loop result shares its state's register, which stays busy for the
      // state's whole range (that range contains the result's).
      const hinted = this.#coalesce.get(key);
      const shared = hinted === undefined ? undefined : this.#regs.get(hinted);
      if (shared !== undefined && (busy.get(shared) ?? -1) >= last) {
        this.#regs.set(key, shared);
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
      if (isPrimitive(d.type) && !this.#regs.has(k) && !this.#alias.has(k) && !this.#consts.has(k))
        this.#alloc(k, 4);
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
    this.#ready.clear();
    const sym = `_a0_${fn.name}`;
    this.out.push(`\t.globl ${sym}`, '\t.p2align 2', `${sym}:`);
    // A leaf with a small frame needs no frame record: sp alone addresses its slots.
    const record = !this.#leaf || frame > 4080;
    const incomingBase = frame + (record ? 16 : 0);
    if (record) this.#emit('stp x29, x30, [sp, #-16]!', 'mov x29, sp');
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
        this.#mem('ldr', 'x12', 'sp', incomingBase + (place.stack as number));
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
      const incoming = incomingBase + place.stack;
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
    if (record) this.#emit('mov sp, x29', 'ldp x29, x30, [sp], #16');
    else if (frame > 0) this.#emit(`add sp, sp, #${frame}`);
    this.#emit('ret');
    return pairMemory(dropRepeatedCompares(this.out)).join('\n');
  }
}

/** Instructions that leave the flags alone; the first operand is the destination (none for stores). */
const FLAG_PRESERVING = new Set([
  'add',
  'sub',
  'and',
  'orr',
  'eor',
  'mul',
  'madd',
  'msub',
  'udiv',
  'umull',
  'csel',
  'cset',
  'csinv',
  'movz',
  'movk',
  'mov',
  'lsl',
  'lsr',
  'ror',
  'neg',
  'ldr',
  'ldrb',
  'ldp',
  'str',
  'strb',
  'stp',
]);

/** Register number named by a w/x operand, or undefined for zr/sp/immediates. */
const regNumber = (o: string): string | undefined => /^[wx](\d+)$/.exec(o)?.[1];

/**
 * Drop a `cmp` that repeats the previous flag-setting instruction when nothing in between
 * wrote the flags, a compared register, or control flow (labels and branches end the run).
 */
function dropRepeatedCompares(lines: readonly string[]): string[] {
  const out: string[] = [];
  let live: { text: string; regs: Set<string> } | undefined;
  for (const line of lines) {
    const m = /^\t(\S+)\s*(.*)$/.exec(line);
    if (m === null) {
      live = undefined;
      out.push(line);
      continue;
    }
    const [, op, rest] = m as unknown as [string, string, string];
    const operands = rest.split(',').map((o) => o.trim());
    if (op === 'cmp') {
      if (live?.text === rest) continue;
      live = {
        text: rest,
        regs: new Set(operands.map(regNumber).filter((r): r is string => r !== undefined)),
      };
      out.push(line);
      continue;
    }
    if (live !== undefined) {
      if (!FLAG_PRESERVING.has(op) || /\]!|\], #/.test(rest)) live = undefined;
      else {
        const dests =
          op === 'ldp' ? operands.slice(0, 2) : op.startsWith('st') ? [] : operands.slice(0, 1);
        if (dests.some((d) => live?.regs.has(regNumber(d) ?? '') === true)) live = undefined;
      }
    }
    out.push(line);
  }
  return out;
}

const SINGLE_MEM = /^\t(ldr|str) (w\d+|wzr), \[(sp|x\d+), #(\d+)\]$/;

/**
 * Pair adjacent word loads/stores to consecutive offsets from one base into ldp/stp (the
 * signed 7-bit scaled offset reaches 252). A load pair needs two distinct destinations,
 * neither of them the base.
 */
function pairMemory(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const x = SINGLE_MEM.exec(lines[i] as string);
    const y = x === null ? null : SINGLE_MEM.exec(lines[i + 1] ?? '');
    if (x !== null && y !== null) {
      const [, op, r1, base, o1] = x as unknown as [string, string, string, string, string];
      const [, op2, r2, base2, o2] = y as unknown as [string, string, string, string, string];
      const off = Number(o1);
      const baseNum = base.slice(1);
      const loadOk = op === 'str' || (r1 !== r2 && r1.slice(1) !== baseNum && r1 !== 'wzr');
      if (
        op === op2 &&
        base === base2 &&
        Number(o2) === off + 4 &&
        off % 4 === 0 &&
        off <= 252 &&
        loadOk
      ) {
        out.push(`\t${op === 'ldr' ? 'ldp' : 'stp'} ${r1}, ${r2}, [${base}, #${off}]`);
        i += 1;
        continue;
      }
    }
    out.push(lines[i] as string);
  }
  return out;
}

/** Emit one function as Darwin AArch64 assembly (a `.globl _a0_<name>` block). */
export function emitArm64Function(fn: TypedFunc): string {
  return emitFused(fn, (f) => new FunctionEmitter(f).emit());
}

/** Assemble function blocks into one .s module for `clang -x assembler` / `as`. */
export function assembleArm64(bodies: readonly string[], compilerVersion: string): string {
  return `; Generated by A0 ${compilerVersion}. Darwin arm64 assembly; exact u32/bool semantics.\n\t.section __TEXT,__text,regular,pure_instructions\n\n${bodies.join('\n\n')}\n\n.subsections_via_symbols\n`;
}
