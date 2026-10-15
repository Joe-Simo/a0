/**
 * Direct native backend: x86-64 assembly (System V AMD64 ABI, AT&T syntax as clang and GNU
 * as accept it) for macOS and Linux. A0 reaches the machine through this code generator plus
 * the system assembler and linker only; no C is generated for the program.
 *
 * Scope: the same as the AArch64 backend (src/arm64.ts). Functions over u32 and bool,
 * fixed-size arrays and records of them (value semantics), every scalar op with A0's exact
 * meaning, `call`, `fold`, and `loop` as real loops with literal or variable trip counts,
 * and io (`read`, `write`, `puts`).
 *
 * Representation: every value is a sequence of 32-bit words. u32 is one word, bool is one
 * word holding 0 or 1, an array is its elements back to back, a record its fields in order.
 * An io token is two words: the address of the caller's io struct, laid out as the C
 * runtime's (src/backends.ts `cIoRuntime`): `{ u32 input[IN]; u32 ninput; u32 position;
 * u32 output[OUT]; u32 noutput; }`. A token lives in a stack slot like an aggregate (never in a
 * register home) but crosses calls by value, as the C ABI passes `a0_io *`: a pointer in the
 * next argument register or eightbyte, and a token result in rax. `read`, `write` and `puts`
 * call small module-local helpers that `assembleX86_64` emits once per module with IN and OUT
 * (so function bodies do not depend on the capacities and the emission cache stays keyed as
 * before): the token in r11 (kept), the value or length in eax, the element address in r10;
 * they clobber only rax and r10, so a leaf stays a leaf. Exhausted input reads 0; under the
 * strict profile it traps `input` through the shared trap runtime. A full output buffer drops
 * the word, as the C runtime does.
 *
 * Code shape (the AArch64 backend's second version, on x86-64):
 * - Small callees (at most INLINE_MAX_NODES nodes, nested to INLINE_MAX_DEPTH) are inlined
 *   at `call`, `fold`, and `loop` sites when what they expand to (their own inlined callees
 *   counted) fits a budget: INLINE_MAX_CALL at a plain `call`, INLINE_MAX_LOOP_BODY for a
 *   fold or loop body; larger callees are called out of line.
 * - Scalars live in registers. A linear scan over definition order gives each u32/bool
 *   value a home among the callee-saved ebx, r12d-r15d (spilled to a stack slot when they
 *   run out); a function with no residual call is a leaf and also uses edi, esi, r8d, r9d,
 *   keeping a parameter in its arrival register when it arrives in one of those; a leaf
 *   also uses edx unless it divides and ecx unless it shifts or rotates by a variable. The
 *   scalar defined by the last node and returned is computed into eax, and an inlined loop
 *   body's result takes the loop state's register when the state is not read after it.
 * - Instruction selection (planned per function, see `planFor`): lea for three-operand
 *   add/sub and multipliers 2, 3, 5, 9; shifts for other powers of two; `rol`/`ror` for
 *   `or (shl x n) (shr x (32 - n))` and its literal forms; a comparison feeding only selects
 *   becomes flags plus `cmov` at each select (a single-bit `and` compared with 0 or the bit
 *   is `test`); a materialized bool is `xor; cmp; setcc`.
 * - Loops test at the bottom (one guard when the trip count is not a positive literal).
 * - Aggregates live in stack slots and are updated in place when provably unshared (the
 *   same `mutableHere` analysis as the JavaScript and AArch64 backends); `at` and a
 *   literal-index `get` of an aggregate borrow that part of the slot (`borrowLive`). Copies and
 *   literal fills move 16 bytes at a time through xmm0 (above 32 words a copy calls the module's
 *   shared copy helper, a fill loops; an `arr` of one
 *   aggregate repeated copies it once, then replicates it forward); a variable index uses SIB
 *   scaling and skips its mask when a range fact (a fold counter below a literal count, `and`,
 *   `rem`, `shr` by a literal) proves it below the length.
 *
 * Calling convention (System V AMD64 for scalar signatures, so C can call `a0_<name>`
 * directly; `_a0_<name>` on macOS):
 * - An aggregate result is returned through the hidden sret pointer in rdi (first integer
 *   argument), which the callee also returns in rax; each parameter then takes the next of
 *   rdi, rsi, rdx, rcx, r8, r9: a scalar as its value (bool 0/1 in the low byte, upper bits
 *   ignored), an aggregate as a pointer to a caller-owned slot that the caller never changes.
 *   The callee copies aggregate parameters into its own slots on entry.
 * - After six, parameters go to the stack, one eightbyte each, starting at the caller's rsp.
 * - A scalar result returns in eax. The sret result is written after all parameters were
 *   copied, so it may alias an argument slot (fold state updates rely on this).
 *
 * Frame layout (rsp is fixed after the prologue; all slots are addressed from rsp):
 *
 *     incoming stack parameters     rbp + 16 + 8k
 *     return address                rbp + 8
 *     saved rbp                     <- rbp
 *     value slots (S bytes)         rsp + O ... rsp + O + S - 1
 *       (callee-saved register save area, sret pointer, aggregates, spilled scalars)
 *     outgoing stack arguments      rsp ... rsp + O - 1
 *
 * Value slots whose live ranges are disjoint share bytes (`#pack`). A store of a register to a
 * slot followed by a reload of that slot reads the register instead (`forwardStores`).
 * S and O are rounded to 16, so rsp is 16-byte aligned at every call. Frames above 4 KiB
 * are probed one page at a time in the prologue; an empty frame skips the rsp restore.
 * Scratch: eax (data, copy offset), r10/r11 (addresses and operands), xmm0 (copies), ecx
 * and edx (shift count, division) when the function needs them.
 */

import {
  A0Error,
  borrowLive,
  isPrimitive,
  type Node,
  type Op,
  type Operand,
  type Type,
  type TypedFunc,
} from './core.js';
import {
  FRAME_BASE,
  FRAME_BYTES,
  type NativeTrapKind,
  type TrapModule,
  trapIndex,
  x86TrapRuntime,
} from './native-trap.js';
import {
  callTraps,
  emitFused,
  type FillRun,
  fillRun,
  mayTrapFn,
  overwritesState,
  siteOf,
} from './optimize.js';

export type X86Platform = 'darwin' | 'linux';

/** The platform whose symbol and section conventions the emitted assembly follows. */
export const HOST_X86_PLATFORM: X86Platform = process.platform === 'linux' ? 'linux' : 'darwin';

function refuse(message: string): never {
  throw new A0Error(`x86_64: ${message}`, undefined, {
    code: 'structure',
    fix: 'compile this function with the c target',
  });
}

/** Size of a value in 32-bit words. */
function words(t: Type): number {
  if (t === 'u32' || t === 'bool') return 1;
  if (t === 'io') return 2;
  if (t.kind === 'arr') return t.length * words(t.elem);
  return t.fields.reduce((n, f) => n + words(f), 0);
}

/** A value held in a 32-bit register home: u32 and bool (an io token is a 64-bit address in a slot). */
const isScalar = (t: Type): t is 'u32' | 'bool' => t === 'u32' || t === 'bool';

const align = (n: number, a: number): number => Math.ceil(n / a) * a;

const INLINE_MAX_NODES = 48;
const INLINE_MAX_DEPTH = 6;
/**
 * Budgets for the nodes an inlined callee expands to, counting its own inlined callees (a
 * nest of small callees inlined into each other grows multiplicatively, so the per-callee
 * limit alone duplicated whole call trees at every site). A fold or loop body runs once per
 * trip from one site, so it gets the larger budget; a plain `call` site only inlines what is
 * about as cheap as the call sequence it replaces.
 */
const INLINE_MAX_LOOP_BODY = 96;
const INLINE_MAX_CALL = 8;

type Site = 'call' | 'loop';
const CALLEE_SAVED = ['%ebx', '%r12d', '%r13d', '%r14d', '%r15d'];
/** Integer argument registers in order; a home only in a leaf, and never edx/ecx. */
const ARG_REGS = ['%edi', '%esi', '%edx', '%ecx', '%r8d', '%r9d'];
const LEAF_ARG_HOMES = ['%edi', '%esi', '%r8d', '%r9d'];

const FRESH_OPS = new Set<Op>(['arr', 'rec', 'set', 'put']);

/**
 * Is the aggregate literal at `index` only the initial state of a fold that writes every
 * element before reading it (optimize.ts `overwritesState`)? Its stores are then dead.
 */
function deadLiteral(fn: TypedFunc, index: number): boolean {
  const node = fn.nodes[index] as Node;
  const me = (o: Operand): boolean => o.kind === 'node' && o.id === node.id;
  if (me(fn.ret)) return false;
  const users = fn.nodes.filter((n) => n.args.some(me));
  const user = users[0];
  return (
    users.length === 1 &&
    user !== undefined &&
    user.op === 'fold' &&
    user.args.filter(me).length === 1 &&
    user.args[1] !== undefined &&
    me(user.args[1]) &&
    overwritesState(fn, user)
  );
}

/** An index s * p1 + c + t * pK (pK a scalar extra parameter, K >= 2; t is 0, 1 or -1), mod 2^32. */
interface Affine {
  readonly s: number;
  readonly c: number;
  readonly k: number;
  readonly t: number;
}

/** An operand as an affine index, given the affine forms of the nodes before it. */
function affineOf(
  o: Operand | undefined,
  nodes: ReadonlyMap<string, Affine | undefined>,
): Affine | undefined {
  if (o === undefined) return undefined;
  if (o.kind === 'u32') return { s: 0, c: o.value >>> 0, k: 0, t: 0 };
  if (o.kind === 'param') {
    if (o.index === 1) return { s: 1, c: 0, k: 0, t: 0 };
    // An extra parameter used as an index or an add/sub operand is a u32 in a valid program.
    if (o.index >= 2) return { s: 0, c: 0, k: o.index, t: 1 };
    return undefined;
  }
  return o.kind === 'node' ? nodes.get(o.id) : undefined;
}

/** The affine form (in p1 and at most one extra parameter) of every add/sub node of `body`. */
function affineNodes(body: TypedFunc): Map<string, Affine | undefined> {
  const out = new Map<string, Affine | undefined>();
  for (const n of body.nodes) {
    const a = affineOf(n.args[0], out);
    const b = affineOf(n.args[1], out);
    if ((n.op !== 'add' && n.op !== 'sub') || a === undefined || b === undefined) {
      out.set(n.id, undefined);
      continue;
    }
    const sign = n.op === 'add' ? 1 : -1;
    const t = a.t + sign * b.t;
    const k = a.t !== 0 ? a.k : b.k;
    if ((a.t !== 0 && b.t !== 0 && a.k !== b.k) || (t !== 0 && Math.abs(t) !== 1)) {
      out.set(n.id, undefined);
      continue;
    }
    out.set(n.id, {
      s: (a.s + sign * b.s) >>> 0,
      c: (a.c + sign * b.c) >>> 0,
      k: t === 0 ? 0 : k,
      t,
    });
  }
  return out;
}

/**
 * A carried read of a fold or loop body over array state of scalars (the shape of src/wasm.ts
 * `carriedRead`): the body's result is `set X w v`, which is also its last node, and it reads
 * `get p0 r` where r at trip p1 + 1 is w at trip p1 (both affine in p1, see `affineNodes`). Trip
 * i + 1 reads the value trip i stored last, so that value can stay in a register across the back
 * edge instead of making a round trip through memory. `first` is the read's index on trip 0.
 * `guard` is set when the read's only use is `select (eq p1 0) K get` with K loop-invariant (a
 * literal or an extra parameter): K stands in on trip 0, so with the register starting at K the
 * select is the register on every trip.
 */
interface CarriedRead {
  readonly get: string;
  readonly set: string;
  readonly first: Affine;
  readonly guard?: { readonly select: string; readonly k: Operand };
}

function carriedRead(body: TypedFunc): CarriedRead | undefined {
  const ret = body.ret;
  const set = body.nodes.at(-1);
  const st = body.params[0];
  if (ret.kind !== 'node' || set?.id !== ret.id || set.op !== 'set') return undefined;
  if (st === undefined || isPrimitive(st) || st.kind !== 'arr' || !isScalar(st.elem))
    return undefined;
  const forms = affineNodes(body);
  const w = affineOf(set.args[1], forms);
  if (w === undefined) return undefined;
  for (const n of body.nodes) {
    if (n.op !== 'get' || n.args[0]?.kind !== 'param' || n.args[0].index !== 0) continue;
    const r = affineOf(n.args[1], forms);
    if (r === undefined || r.s !== w.s || r.k !== w.k || r.t !== w.t) continue;
    if ((r.c + r.s) >>> 0 !== w.c) continue;
    const guard = guardedCarry(body, n.id);
    return { get: n.id, set: set.id, first: r, ...(guard === undefined ? {} : { guard }) };
  }
  return undefined;
}

/** The `select (eq p1 0) K get` that is the read `get`'s only use, K loop-invariant (see `CarriedRead`). */
function guardedCarry(body: TypedFunc, get: string): CarriedRead['guard'] {
  const isGet = (o: Operand | undefined): boolean => o?.kind === 'node' && o.id === get;
  const users = body.nodes.filter((n) => n.args.some(isGet));
  const sel = users[0];
  if (users.length !== 1 || sel?.op !== 'select' || sel.args.filter(isGet).length !== 1)
    return undefined;
  const [cond, k, other] = sel.args;
  const invariant =
    k?.kind === 'u32' || k?.kind === 'bool' || (k?.kind === 'param' && k.index >= 2);
  if (!invariant || !isGet(other) || cond?.kind !== 'node') return undefined;
  const eq = body.nodes.find((n) => n.id === cond.id);
  const [x, y] = eq?.args ?? [];
  const isIndex = (o: Operand | undefined): boolean => o?.kind === 'param' && o.index === 1;
  const isZero = (o: Operand | undefined): boolean => o?.kind === 'u32' && o.value === 0;
  if (eq?.op !== 'eq' || !((isIndex(x) && isZero(y)) || (isIndex(y) && isZero(x))))
    return undefined;
  return { select: sel.id, k };
}

/** Ops a carried read never drops even when nothing reads their value. */
const KEEP_OPS = new Set<Op>(['read', 'write', 'puts', 'call', 'fold', 'loop']);

/**
 * The body nodes that emit nothing under a carried read besides the read itself: the guarded
 * read (its select is the register), and every pure node whose readers all emit nothing (the
 * read's index, the guard's comparison). Only an inlined body gets a carried read, and a body
 * that can trap is never inlined (`inlinableAt`), so dropping these nodes drops no trap.
 */
function carryDead(body: TypedFunc, found: CarriedRead): Set<string> {
  const read = found.guard?.select ?? found.get;
  const quiet = new Set([found.get, read]);
  const dead = new Set(found.guard === undefined ? [] : [found.get]);
  const ret = body.ret.kind === 'node' ? body.ret.id : undefined;
  for (let i = body.nodes.length - 1; i >= 0; i -= 1) {
    const n = body.nodes[i] as Node;
    if (quiet.has(n.id) || n.id === ret || KEEP_OPS.has(n.op)) continue;
    const readers = body.nodes.filter((m) =>
      m.args.some((o) => o.kind === 'node' && o.id === n.id),
    );
    if (readers.every((m) => quiet.has(m.id) || dead.has(m.id))) dead.add(n.id);
  }
  return dead;
}

/**
 * The last position in `fn` at which the value of a node in `ids` is read: a node absorbed by
 * its consumer (a rotate half, a tested bit mask, a comparison fused into selects) reads at that
 * consumer's position.
 */
function lastRead(fn: TypedFunc, ids: ReadonlySet<string>): number {
  const plan = planFor(fn);
  let last = -1;
  const visit = (of: ReadonlySet<string>): void => {
    const absorbed = new Set<string>();
    for (const [j, m] of fn.nodes.entries()) {
      if (!m.args.some((o) => o.kind === 'node' && of.has(o.id))) continue;
      if (plan.skip.has(m.id) || plan.fused.has(m.id)) absorbed.add(m.id);
      else last = Math.max(last, j);
    }
    if (absorbed.size > 0) visit(absorbed);
  };
  visit(ids);
  return last;
}

/** SSE2 registers for a fill run: xmm1 lane indices, xmm2 step, xmm3.. values, xmm14/15 temps. */
const SSE_FIRST = 3;
const SSE_LAST = 13;
const SSE_OP: Partial<Record<Op, string>> = {
  add: 'paddd',
  sub: 'psubd',
  and: 'pand',
  or: 'por',
  xor: 'pxor',
  shl: 'pslld',
  shr: 'psrld',
};

/** A uniform operand of a fill run as a map key: `u:<literal>` or `p:<parameter index>`. */
function formatUniform(o: Operand): string {
  if (o.kind === 'u32') return `u:${o.value >>> 0}`;
  if (o.kind === 'bool') return `u:${o.value ? 1 : 0}`;
  if (o.kind === 'param') return `p:${o.index}`;
  return `n:${o.id}`;
}

/** The 64-bit name of a 32-bit register. */
function q(reg: string): string {
  if (/^%r\d+d$/.test(reg)) return reg.slice(0, -1);
  return `%r${reg.slice(2)}`;
}

const LOW8: Readonly<Record<string, string>> = {
  '%eax': '%al',
  '%ebx': '%bl',
  '%ecx': '%cl',
  '%edx': '%dl',
  '%edi': '%dil',
  '%esi': '%sil',
};

/** The low-byte name of a 32-bit register (for setcc). */
function low8(reg: string): string {
  const m = /^%r(\d+)d$/.exec(reg);
  return m === null ? (LOW8[reg] ?? refuse(`no byte register for ${reg}`)) : `%r${m[1]}b`;
}

/** Condition codes of the unsigned comparisons, and their negations. */
const CC: Readonly<Partial<Record<Op, string>>> = {
  eq: 'e',
  ne: 'ne',
  lt: 'b',
  le: 'be',
  gt: 'a',
  ge: 'ae',
};
const NOT_CC: Readonly<Record<string, string>> = {
  e: 'ne',
  ne: 'e',
  b: 'ae',
  ae: 'b',
  be: 'a',
  a: 'be',
};

/** A comparison as flags: `cmp b, a` or a single-bit `test mask, y`, read with condition `cc`. */
type Shape =
  | { readonly kind: 'cmp'; readonly a: Operand; readonly b: Operand; readonly cc: string }
  | { readonly kind: 'test'; readonly y: Operand; readonly mask: number; readonly cc: string };

/** A rotate recognized from `or (shl x n) (shr x (32 - n))` and its literal forms. */
interface Rot {
  readonly x: Operand;
  /** Literal left-rotate distance, or the variable distance operand. */
  readonly count: number | Operand;
  readonly left: boolean;
}

/**
 * Per-function instruction selection plan, computed once from the node graph: nodes whose
 * only consumer absorbs them (rotate halves, a bit mask tested by a comparison), comparisons
 * that feed only scalar selects (emitted as flags at each select, never as a 0/1 value), and
 * the flag shape of every comparison.
 */
interface Plan {
  readonly skip: ReadonlySet<string>;
  readonly fused: ReadonlySet<string>;
  readonly shapes: ReadonlyMap<string, Shape>;
  readonly rots: ReadonlyMap<string, Rot>;
}

const PLANS = new WeakMap<TypedFunc, Plan>();

function planFor(fn: TypedFunc): Plan {
  const cached = PLANS.get(fn);
  if (cached !== undefined) return cached;
  const defs = new Map(fn.nodes.map((n) => [n.id, n]));
  const uses = new Map<string, { node: Node; k: number }[]>();
  for (const n of fn.nodes)
    for (const [k, o] of n.args.entries())
      if (o.kind === 'node') uses.set(o.id, [...(uses.get(o.id) ?? []), { node: n, k }]);
  const returned = fn.ret.kind === 'node' ? fn.ret.id : undefined;
  /** The defining node of `o` when its single consumer is the node being planned. */
  const single = (o: Operand, op: Op): Node | undefined => {
    if (o.kind !== 'node' || o.id === returned || uses.get(o.id)?.length !== 1) return undefined;
    const d = defs.get(o.id);
    return d?.op === op ? d : undefined;
  };
  const lit = (o: Operand | undefined): number | undefined =>
    o?.kind === 'u32' ? o.value >>> 0 : undefined;
  const skip = new Set<string>();
  const fused = new Set<string>();
  const shapes = new Map<string, Shape>();
  const rots = new Map<string, Rot>();
  for (const n of fn.nodes) {
    const cc = CC[n.op];
    if (cc !== undefined) {
      const [a, b] = n.args as [Operand, Operand];
      let shape: Shape = { kind: 'cmp', a, b, cc };
      // eq/ne of (and y 2^k) against 0 or 2^k is one bit test.
      if (n.op === 'eq' || n.op === 'ne')
        for (const [m, v] of [
          [a, b],
          [b, a],
        ] as const) {
          const and = single(m, 'and');
          if (and === undefined) continue;
          const [y, mk] = and.args as [Operand, Operand];
          const [yy, mask] = lit(mk) !== undefined ? [y, lit(mk)] : [mk, lit(y)];
          const value = lit(v);
          if (mask === undefined || mask === 0 || (mask & (mask - 1)) !== 0) continue;
          if (value !== 0 && value !== mask) continue;
          const bitSet = (n.op === 'eq') === (value === mask);
          shape = { kind: 'test', y: yy, mask, cc: bitSet ? 'ne' : 'e' };
          skip.add(and.id);
          break;
        }
      shapes.set(n.id, shape);
      const us = uses.get(n.id) ?? [];
      if (
        n.id !== returned &&
        us.length > 0 &&
        us.every(
          (u) =>
            u.node.op === 'select' && u.k === 0 && isPrimitive(fn.types.get(u.node.id) ?? 'io'),
        )
      )
        fused.add(n.id);
      continue;
    }
    if (n.op !== 'or' && n.op !== 'xor' && n.op !== 'add') continue;
    const [p, r] = n.args as [Operand, Operand];
    for (const [l, h] of [
      [p, r],
      [r, p],
    ] as const) {
      const shl = single(l, 'shl');
      const shr = single(h, 'shr');
      if (
        shl === undefined ||
        shr === undefined ||
        !sameOp(shl.args[0] as Operand, shr.args[0] as Operand)
      )
        continue;
      const x = shl.args[0] as Operand;
      const [cl, cr] = [shl.args[1] as Operand, shr.args[1] as Operand];
      const kl = lit(cl);
      const kr = lit(cr);
      if (kl !== undefined && kr !== undefined) {
        // x << k | x >> (32 - k) for 0 < k < 32 has disjoint halves: or, xor, and add agree.
        if ((kl & 31) === 0 || ((kl & 31) + (kr & 31)) % 32 !== 0) continue;
        rots.set(n.id, { x, count: kl & 31, left: true });
      } else {
        // Variable distance: shl x n | shr x ((32 - n) & 31) is rotl x n for every n (both
        // halves are x when n & 31 is 0), which holds for `or` only.
        if (n.op !== 'or') continue;
        const subR = single(cr, 'sub');
        const subL = single(cl, 'sub');
        const isNeg = (s: Node | undefined, of: Operand): boolean =>
          s !== undefined && (lit(s.args[0]) ?? 1) % 32 === 0 && sameOp(s.args[1] as Operand, of);
        if (isNeg(subR, cl)) {
          rots.set(n.id, { x, count: cl, left: true });
          skip.add((subR as Node).id);
        } else if (isNeg(subL, cr)) {
          rots.set(n.id, { x, count: cr, left: false });
          skip.add((subL as Node).id);
        } else continue;
      }
      skip.add(shl.id);
      skip.add(shr.id);
      break;
    }
  }
  const plan: Plan = { skip, fused, shapes, rots };
  PLANS.set(fn, plan);
  return plan;
}

/** A 32-bit immediate as the assembler wants it (signed). */
const imm = (v: number): string => `$${v | 0}`;

function sameOp(x: Operand, y: Operand): boolean {
  return (
    (x.kind === 'node' && y.kind === 'node' && x.id === y.id) ||
    (x.kind === 'param' && y.kind === 'param' && x.index === y.index)
  );
}

/**
 * May the aggregate operand `o` be updated in place by the node at `index`? Sound when the
 * value is provably unshared (a fresh allocation or the owned state parameter p0), every
 * other use is a `get`/`at` read before `index`, and it is not returned.
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

/** Where each parameter travels: an integer register index, or a byte offset in the stack area. */
interface ArgPlace {
  readonly reg?: number;
  readonly stack?: number;
}

/** System V placement for a parameter list (`sret` takes rdi); `bytes` is the stack area used. */
function argLayout(params: readonly Type[], sret: boolean): { places: ArgPlace[]; bytes: number } {
  let next = sret ? 1 : 0;
  let offset = 0;
  const places = params.map((): ArgPlace => {
    if (next < 6) return { reg: next++ };
    const place: ArgPlace = { stack: offset };
    offset += 8;
    return place;
  });
  return { places, bytes: offset };
}

/** Whether `callee` is inlined at a `site` `depth` inlinings deep (see INLINE_MAX_CALL). */
function inlinableAt(callee: TypedFunc, depth: number, site: Site): boolean {
  return (
    callee.nodes.length <= INLINE_MAX_NODES &&
    depth < INLINE_MAX_DEPTH &&
    !mayTrapFn(callee) &&
    expandedNodes(callee, depth + 1) <= (site === 'call' ? INLINE_MAX_CALL : INLINE_MAX_LOOP_BODY)
  );
}

const EXPANDED = new WeakMap<TypedFunc, Map<number, number>>();

/** Nodes `fn` emits when its body is emitted `depth` inlinings deep, inlined callees included. */
function expandedNodes(fn: TypedFunc, depth: number): number {
  let memo = EXPANDED.get(fn);
  if (memo === undefined) {
    memo = new Map();
    EXPANDED.set(fn, memo);
  }
  const known = memo.get(depth);
  if (known !== undefined) return known;
  let total = 0;
  for (const n of fn.nodes) {
    total += 1;
    for (const name of [n.callee, n.pred]) {
      if (name === undefined) continue;
      const g = fn.calls.get(name);
      if (g !== undefined && inlinableAt(g, depth, n.op === 'call' ? 'call' : 'loop'))
        total += expandedNodes(g, depth + 1);
    }
  }
  memo.set(depth, total);
  return total;
}

/** A value in the emitter: a literal, or a named key whose home is a register or a slot. */
type Val =
  | { readonly kind: 'lit'; readonly value: number; readonly type: 'u32' | 'bool' }
  | { readonly kind: 'key'; readonly key: string; readonly type: Type };

/** One function body being emitted, either the top level or an inlined callee. */
interface Env {
  readonly fn: TypedFunc;
  readonly prefix: string;
  readonly params: readonly Val[];
  readonly ownedP0: boolean;
  readonly depth: number;
  /** An inlined fold or loop body: what its host keeps in registers across trips. */
  readonly loop?: LoopHost;
}

interface LoopHost {
  /**
   * The carried read (see `CarriedRead`): the read (or, guarded, its select) is the scalar key
   * `key`, and after the store `set` the stored value is written to `key`.
   */
  readonly carry?: CarryHost;
  /**
   * Induction variables: each `mul p1 K` node of the body (K loop-invariant) -> the key that
   * holds p1 * K, which the host steps by K after every trip instead of multiplying.
   */
  readonly steps: ReadonlyMap<string, string>;
}

interface CarryHost {
  readonly read: string;
  /** Nodes left without a reader once the carried read no longer loads (see `carryDead`). */
  readonly dead: ReadonlySet<string>;
  readonly set: string;
  readonly key: string;
  readonly type: 'u32' | 'bool';
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
  /** Every slot request of the dry pass, in order, for `#pack`. */
  readonly #requests: { key: string; bytes: number; alignment: number }[] = [];
  #slotBytes = 0;
  #outgoing = 0;
  #leaf = true;
  #saved: string[] = [];
  /** Exclusive upper bounds of scalar keys known at compile time (index range facts). */
  readonly #bounds = new Map<string, number>();
  /** Register-sharing hints: an inlined loop body's scalar result -> the loop state key. */
  readonly #shares = new Map<string, string>();
  /** Whether the body needs ecx (variable shift or rotate) or edx (division) as scratch. */
  #needCx = false;
  #needDx = false;
  /** Strict profile: the cold trap stubs this function uses, and the node-id strings it names. */
  readonly #stubs = new Set<NativeTrapKind>();
  readonly #nodeIds = new Set<string>();

  constructor(
    readonly fn: TypedFunc,
    readonly platform: X86Platform,
  ) {}

  #emit(...lines: string[]): void {
    if (this.#dry) return;
    for (const l of lines) this.out.push(l.endsWith(':') ? l : `\t${l}`);
  }

  #sym(name: string): string {
    return this.platform === 'darwin' ? `_a0_${name}` : `a0_${name}`;
  }

  #label(): string {
    this.#labels += 1;
    return `${this.platform === 'darwin' ? 'L' : '.L'}a0_${this.fn.name}_${this.#labels}`;
  }

  /** A label unique to this function for a trap stub, a string or a frame name. */
  #tag(tag: string): string {
    return `${this.platform === 'darwin' ? 'L' : '.L'}a0t${this.fn.name.length}_${this.fn.name}_${tag}`;
  }

  /** The cold stub raising `kind`; emitted after the function. */
  #stub(kind: NativeTrapKind): string {
    this.#stubs.add(kind);
    return this.#tag(kind === 'bounds' ? 'tb' : 'td');
  }

  /** The address of the shadow-stack state in `reg` (RIP-relative). */
  #state(reg: string): void {
    this.#emit(`leaq ${this.platform === 'darwin' ? '_a0_ts' : 'a0_ts'}(%rip), ${reg}`);
  }

  /** Push this function's frame on the shadow stack (uses rax, r10, r11 only). */
  #enter(): void {
    this.#state('%r10');
    this.#emit(
      'movq (%r10), %r11',
      'addq %r10, %r11',
      `leaq ${this.#tag('nm')}(%rip), %rax`,
      `movq %rax, ${FRAME_BASE}(%r11)`,
      `movq $0, ${FRAME_BASE + 8}(%r11)`,
      `addq $${FRAME_BYTES}, (%r10)`,
    );
  }

  /** Pop it (uses r10; the result registers are untouched). */
  #leave(): void {
    this.#state('%r10');
    this.#emit(`subq $${FRAME_BYTES}, (%r10)`);
  }

  /** Name the fold or loop this frame is iterating (`id`), or none (uses rax, r10, r11). */
  #markNode(id: string | undefined): void {
    this.#state('%r10');
    this.#emit('movq (%r10), %r11');
    if (id === undefined) this.#emit(`movq $0, ${FRAME_BASE - FRAME_BYTES + 8}(%r10,%r11)`);
    else {
      this.#nodeIds.add(id);
      this.#emit(
        `leaq ${this.#tag(`i${id}`)}(%rip), %rax`,
        `movq %rax, ${FRAME_BASE - FRAME_BYTES + 8}(%r10,%r11)`,
      );
    }
  }

  /** Record trip `reg` of the fold this frame is iterating (uses r10, r11). */
  #markTrip(reg: string): void {
    this.#state('%r10');
    this.#emit('movq (%r10), %r11', `movl ${reg}, ${FRAME_BASE - FRAME_BYTES + 16}(%r10,%r11)`);
  }

  /**
   * Strict: trap `bounds` unless idx < n. A literal index at or past n is an unconditional trap.
   * Uses r10 (or the home register of idx).
   */
  #checkBounds(idx: Val, n: number): void {
    const stub = this.#stub('bounds');
    if (idx.kind === 'lit') {
      this.#emit(`jmp ${stub}`);
      return;
    }
    this.#emit(`cmpl ${imm(n)}, ${this.#read(idx, '%r10d')}`, `jae ${stub}`);
  }

  // --- values, keys, homes -------------------------------------------------------------

  #alloc(key: string, bytes: number, alignment = 4): number {
    this.#slotBytes = align(this.#slotBytes, alignment);
    const off = this.#slotBytes;
    this.#slotBytes = align(this.#slotBytes + bytes, 4);
    this.#slots.set(key, off);
    this.#requests.push({ key, bytes, alignment });
    return off;
  }

  /**
   * Stack slot reuse: after the dry pass every slot's live range is known (its key's definition
   * to the last use of the key or of any alias of it, loop-carried uses already extended to the
   * loop's end by the dry pass), so slots whose ranges are disjoint share bytes. Ranges are
   * closed: a node reads its operands and writes its result at the same position, so a slot is
   * reused only from the position after its last use. The save area and the sret pointer live
   * for the whole function. Placement is first fit by start position at the lowest offset that
   * overlaps no live slot.
   */
  #pack(): void {
    const end = new Map<string, number>();
    const touch = (k: string, p: number): void => {
      const c = this.#canon(k);
      end.set(c, Math.max(end.get(c) ?? 0, p));
    };
    for (const [k, d] of this.#defs) touch(k, this.#last.get(k) ?? d.pos);
    const live = (k: string): [number, number] =>
      k === 'save' || k === 'sret'
        ? [0, Number.MAX_SAFE_INTEGER]
        : [this.#defs.get(k)?.pos ?? 0, end.get(k) ?? 0];
    const reqs = this.#requests
      .map((r, i) => ({ ...r, i, range: live(r.key) }))
      .sort((x, y) => x.range[0] - y.range[0] || x.i - y.i);
    // Sorted by start, a slot that ended before this start is free for every later one too.
    let placed: { off: number; top: number; end: number }[] = [];
    let total = 0;
    for (const r of reqs) {
      const [start, stop] = r.range;
      placed = placed.filter((b) => b.end >= start);
      const busy = [...placed].sort((x, y) => x.off - y.off);
      let off = 0;
      for (const b of busy) {
        if (align(off, r.alignment) + r.bytes <= b.off) break;
        off = Math.max(off, b.top);
      }
      off = align(off, r.alignment);
      placed.push({ off, top: off + r.bytes, end: stop });
      this.#slots.set(r.key, off);
      total = Math.max(total, off + r.bytes);
    }
    this.#slotBytes = total;
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

  /** Byte offset from rsp of a key's slot (aliases resolved). */
  #slot(key: string): number {
    const off = this.#slots.get(this.#canon(key));
    if (off === undefined) {
      if (this.#dry) return 0;
      throw new A0Error(`x86_64: no slot for ${key}`);
    }
    return this.#outgoing + off + this.#offset(key);
  }

  #def(key: string, type: Type): void {
    if (!this.#dry) return;
    this.#defs.set(key, { pos: this.#pos, type });
    if (!isScalar(type)) this.#alloc(key, 4 * words(type));
  }

  #defAlias(key: string, target: string, type: Type, offset = 0): void {
    if (!this.#dry) return;
    this.#defs.set(key, { pos: this.#pos, type });
    this.#aliasOff.set(key, offset + this.#offset(target));
    this.#alias.set(key, this.#canon(target));
  }

  #use(v: Val): void {
    if (!this.#dry || v.kind !== 'key') return;
    this.#last.set(v.key, this.#pos);
    for (const l of this.#loops) l.used.add(v.key);
  }

  #home(key: string): Home {
    if (this.#dry) return { slot: 0 };
    const reg = this.#regs.get(key);
    return reg === undefined ? { slot: this.#slot(key) } : { reg };
  }

  #resolve(env: Env, o: Operand): Val {
    switch (o.kind) {
      case 'u32':
        return { kind: 'lit', value: o.value, type: 'u32' };
      case 'bool':
        return { kind: 'lit', value: o.value ? 1 : 0, type: 'bool' };
      case 'param':
        return env.params[o.index] ?? refuse(`unknown parameter p${o.index}`);
      case 'node':
        if (env.loop !== undefined) {
          const { carry, steps } = env.loop;
          if (carry?.read === o.id) return { kind: 'key', key: carry.key, type: carry.type };
          const step = steps.get(o.id);
          if (step !== undefined) return { kind: 'key', key: step, type: 'u32' };
        }
        return {
          kind: 'key',
          key: `${env.prefix}n_${o.id}`,
          type: env.fn.types.get(o.id) ?? refuse(`unknown node ${o.id}`),
        };
    }
  }

  // --- low-level emission ----------------------------------------------------------------

  /** `off(base)` as an AT&T memory operand; `base` is a 64-bit register name. */
  #m(base: string, off: number): string {
    return off === 0 ? `(${base})` : `${off}(${base})`;
  }

  /** dst = src (registers or memory operands), skipped when identical. */
  #mov(src: string, dst: string): void {
    if (src !== dst) this.#emit(`movl ${src}, ${dst}`);
  }

  /** Copy `n` words from [src + so] to [dst + d] in 16-byte moves. Uses rax, r10, r11, xmm0. */
  #copy(dst: string, d: number, src: string, so: number, n: number): void {
    if (dst === src && d === so) return;
    if (n <= 32) {
      this.#straightCopy(dst, d, src, so, n);
      return;
    }
    // The 16-byte loop is the module's shared copy helper (`copyRuntime`): r10 and r11 point
    // past the bulk, rax counts up from minus its length to zero.
    const bytes = 16 * Math.floor(n / 4);
    this.#emit(`leaq ${this.#m(src, so + bytes)}, %r10`, `leaq ${this.#m(dst, d + bytes)}, %r11`);
    this.#emit(`movq ${imm(-bytes)}, %rax`, `call ${copyHelper(this.platform)}`);
    this.#straightCopy('%r11', 0, '%r10', 0, n % 4);
  }

  #straightCopy(dst: string, d: number, src: string, so: number, n: number): void {
    let k = 0;
    for (; n - k >= 4; k += 4)
      this.#emit(
        `movups ${this.#m(src, so + 4 * k)}, %xmm0`,
        `movups %xmm0, ${this.#m(dst, d + 4 * k)}`,
      );
    if (n - k >= 2) {
      this.#emit(`movq ${this.#m(src, so + 4 * k)}, %rax`, `movq %rax, ${this.#m(dst, d + 4 * k)}`);
      k += 2;
    }
    if (n - k === 1)
      this.#emit(`movl ${this.#m(src, so + 4 * k)}, %eax`, `movl %eax, ${this.#m(dst, d + 4 * k)}`);
  }

  /** Store the literal word `value` `n` times from [base + off]. Uses rax, r10, xmm0. */
  #fill(base: string, off: number, value: number, n: number): void {
    if (value === 0) this.#emit('xorps %xmm0, %xmm0');
    else this.#emit(`movl ${imm(value)}, %eax`, 'movd %eax, %xmm0', 'pshufd $0, %xmm0, %xmm0');
    const chunks = Math.floor(n / 4);
    if (chunks <= 8)
      for (let k = 0; k < chunks; k += 1)
        this.#emit(`movups %xmm0, ${this.#m(base, off + 16 * k)}`);
    else {
      const top = this.#label();
      this.#emit(`leaq ${this.#m(base, off)}, %r10`, 'xorl %eax, %eax', `${top}:`);
      this.#emit('movups %xmm0, (%r10,%rax)', 'addq $16, %rax');
      this.#emit(`cmpq ${imm(16 * chunks)}, %rax`, `jne ${top}`);
    }
    for (let k = 4 * chunks; k < n; k += 1)
      this.#emit(`movl ${imm(value)}, ${this.#m(base, off + 4 * k)}`);
  }

  /** Scalar `v` as an instruction source: its home register or slot, or `scratch` for a literal. */
  #operand(v: Val, scratch: string): string {
    if (v.kind === 'lit') {
      this.#emit(`movl ${imm(v.value)}, ${scratch}`);
      return scratch;
    }
    const home = this.#home(v.key);
    return 'reg' in home ? home.reg : this.#m('%rsp', home.slot);
  }

  /** Exclusive upper bound of scalar `v`, when known. */
  #bound(v: Val): number {
    if (v.kind === 'lit') return v.value + 1;
    return this.#bounds.get(v.key) ?? 2 ** 32;
  }

  /** A 32-bit register holding scalar `v`: its home register, or `scratch` after materializing. */
  #read(v: Val, scratch: string): string {
    if (v.kind === 'lit') {
      this.#emit(`movl ${imm(v.value)}, ${scratch}`);
      return scratch;
    }
    const home = this.#home(v.key);
    if ('reg' in home) return home.reg;
    this.#emit(`movl ${this.#m('%rsp', home.slot)}, ${scratch}`);
    return scratch;
  }

  /** dst = scalar `v`. */
  #into(dst: string, v: Val): void {
    this.#mov(this.#read(v, dst), dst);
  }

  /**
   * Write scalar `key` with `produce(d)`, which leaves the value in register `d` and must
   * cope with `d` being one of its own source registers (a home may be read and written by
   * the same node); a slot-homed value goes through eax.
   */
  #set(key: string, produce: (d: string) => void): void {
    const home = this.#home(key);
    if ('reg' in home) {
      produce(home.reg);
      return;
    }
    produce('%eax');
    this.#emit(`movl %eax, ${this.#m('%rsp', home.slot)}`);
  }

  /** Store `v` (any type) at [base + off]. */
  #place(v: Val, base: string, off: number): void {
    if (v.kind === 'lit') {
      this.#emit(`movl ${imm(v.value)}, ${this.#m(base, off)}`);
      return;
    }
    if (isScalar(v.type)) {
      this.#emit(`movl ${this.#read(v, '%eax')}, ${this.#m(base, off)}`);
      return;
    }
    this.#copy(base, off, '%rsp', this.#slot(v.key), words(v.type));
  }

  /**
   * The `index,scale` part of `(%rsp,index,scale)` addressing element (idx mod n): the index
   * is r10, or the index value's own home register when it is provably below n and was
   * written by a 32-bit instruction (upper half zero; incoming parameters are not). The mask
   * or division is dropped when the index is provably below n. Uses eax, edx, r10.
   */
  #scaledIndex(idx: Val, n: number, elemBytes: number, inRange = false): string {
    const sib = elemBytes === 2 || elemBytes === 4 || elemBytes === 8;
    const scale = sib ? `,${elemBytes}` : '';
    if (idx.kind === 'key' && (sib || elemBytes === 1) && this.#bound(idx) <= n) {
      const home = this.#home(idx.key);
      if ('reg' in home && !/^p\d+$/.test(idx.key)) return `${q(home.reg)}${scale}`;
    }
    if (n === 1 || (idx.kind === 'lit' && idx.value % n === 0)) this.#emit('xorl %r10d, %r10d');
    else if (idx.kind === 'lit') this.#emit(`movl ${imm(idx.value % n)}, %r10d`);
    else if (inRange || this.#bound(idx) <= n) this.#into('%r10d', idx);
    else if ((n & (n - 1)) === 0) {
      this.#into('%r10d', idx);
      this.#emit(`andl ${imm(n - 1)}, %r10d`);
    } else {
      this.#needDx = true;
      this.#into('%eax', idx);
      this.#emit('xorl %edx, %edx', `movl ${imm(n)}, %r10d`, 'divl %r10d', 'movl %edx, %r10d');
    }
    if (sib || elemBytes === 1) return `%r10${scale}`;
    if ((elemBytes & (elemBytes - 1)) === 0) this.#emit(`shlq ${imm(Math.log2(elemBytes))}, %r10`);
    else this.#emit(`imulq ${imm(elemBytes)}, %r10, %r10`);
    return '%r10';
  }

  /**
   * Set the flags for comparison `shape` (operands resolved in `env`) and return the condition
   * that is true when the comparison holds. Reads one operand through r10d.
   */
  #flags(env: Env, shape: Shape): string {
    if (shape.kind === 'test') {
      const y = this.#resolve(env, shape.y);
      this.#emit(`testl ${imm(shape.mask)}, ${this.#operand(y, '%r10d')}`);
      return shape.cc;
    }
    const a = this.#resolve(env, shape.a);
    const b = this.#resolve(env, shape.b);
    const ra = this.#read(a, '%r10d');
    const rb = b.kind === 'lit' ? imm(b.value) : this.#operand(b, '%r11d');
    this.#emit(`cmpl ${rb}, ${ra}`);
    return shape.cc;
  }

  /** The operands a comparison shape reads (for liveness and register conflicts). */
  #shapeVals(env: Env, shape: Shape): Val[] {
    return shape.kind === 'test'
      ? [this.#resolve(env, shape.y)]
      : [this.#resolve(env, shape.a), this.#resolve(env, shape.b)];
  }

  // --- calls and inlining ------------------------------------------------------------------

  /** A callee that can trap (strict) keeps its own shadow-stack frame: it is always a real call. */
  #inlinable(callee: TypedFunc, env: Env, site: Site): boolean {
    return inlinableAt(callee, env.depth, site);
  }

  /** Residual out-of-line call: arguments per the convention, result into `dst`. */
  #call(name: string, callee: TypedFunc, args: readonly Val[], dst: string): void {
    this.#leaf = false;
    const sret = !isPrimitive(callee.result);
    const { places, bytes } = argLayout(callee.params, sret);
    this.#outgoing = Math.max(this.#outgoing, bytes);
    for (const a of args) this.#use(a);
    // Homes are callee-saved here (the function is not a leaf), so writing the argument
    // registers in order disturbs no source.
    args.forEach((a, k) => {
      const place = places[k] as ArgPlace;
      if (place.reg !== undefined) {
        const r = ARG_REGS[place.reg] as string;
        if (a.kind === 'lit' || isScalar(a.type)) this.#into(r, a);
        else
          this.#emit(
            `${a.type === 'io' ? 'movq' : 'leaq'} ${this.#m('%rsp', this.#slot(a.key))}, ${q(r)}`,
          );
        return;
      }
      const at = this.#m('%rsp', place.stack as number);
      if (a.kind === 'lit' || isScalar(a.type)) this.#into('%eax', a);
      else
        this.#emit(
          `${a.type === 'io' ? 'movq' : 'leaq'} ${this.#m('%rsp', this.#slot(a.key))}, %rax`,
        );
      this.#emit(`movq %rax, ${at}`);
    });
    if (sret) this.#emit(`leaq ${this.#m('%rsp', this.#slot(dst))}, %rdi`);
    this.#emit(`call ${this.#sym(name)}`);
    if (callee.result === 'io') this.#emit(`movq %rax, ${this.#m('%rsp', this.#slot(dst))}`);
    else if (!sret) this.#set(dst, (d) => this.#mov('%eax', d));
  }

  #inline(
    env: Env,
    callee: TypedFunc,
    args: readonly Val[],
    ownedP0: boolean,
    result: string,
    type: Type,
    tag: string,
    sink: 'bind' | 'store',
    loop?: LoopHost,
  ): void {
    const carry = loop?.carry;
    const sub: Env = {
      fn: callee,
      prefix: `${env.prefix}${tag}.`,
      params: args,
      ownedP0,
      depth: env.depth + 1,
      ...(loop === undefined ? {} : { loop }),
    };
    if (this.#dry && carry !== undefined) {
      // The stored value takes the carried register when nothing reads the carried value after
      // it is defined (then writing the register at the store is no move at all).
      const v = (callee.nodes.find((m) => m.id === carry.set) as Node).args[2];
      const at = v?.kind === 'node' ? callee.nodes.findIndex((m) => m.id === v.id) : -1;
      const def = callee.nodes[at];
      if (
        v?.kind === 'node' &&
        def !== undefined &&
        def.op !== 'fold' &&
        def.op !== 'loop' &&
        lastRead(callee, new Set([carry.read])) <= at
      )
        this.#shares.set(`${sub.prefix}n_${v.id}`, carry.key);
    }
    this.#body(sub);
    this.#pos += 1;
    const ret = this.#resolve(sub, callee.ret);
    this.#use(ret);
    if (isScalar(type)) {
      const r = callee.ret;
      const at = r.kind === 'node' ? callee.nodes.findIndex((m) => m.id === r.id) : -1;
      const plan = planFor(callee);
      const readsState = (m: Node): boolean =>
        m.args.some((o) => o.kind === 'param' && o.index === 0);
      if (
        this.#dry &&
        sink === 'store' &&
        at >= 0 &&
        !['fold', 'loop'].includes((callee.nodes[at] as Node).op) &&
        !callee.nodes.some(
          (m, j) => readsState(m) && (j > at || plan.skip.has(m.id) || plan.fused.has(m.id)),
        )
      )
        this.#shares.set(`${sub.prefix}n_${r.kind === 'node' ? r.id : ''}`, result);
      if (sink === 'bind') this.#def(result, type);
      this.#set(result, (d) => this.#into(d, ret));
      return;
    }
    if (ret.kind !== 'key') refuse('an aggregate literal cannot be returned');
    if (sink === 'bind') {
      this.#defAlias(result, ret.key, type);
      return;
    }
    this.#copy('%rsp', this.#slot(result), '%rsp', this.#slot(ret.key), words(type));
  }

  /**
   * The register of the carried read of a fold or loop over the array state `key` (see
   * `CarriedRead`), set to what the read gives on trip 0: K when guarded, else the initial state's
   * element at the read's first index. Uses r10 (and eax, edx to reduce an index by a length that
   * is not a power of two).
   */
  #carry(
    env: Env,
    n: Node,
    callee: TypedFunc,
    key: string,
    t: Type,
    extras: readonly Val[],
  ): CarryHost | undefined {
    if (isPrimitive(t) || t.kind !== 'arr' || !isScalar(t.elem)) return undefined;
    const found = carriedRead(callee);
    if (found === undefined) return undefined;
    const ck = `${env.prefix}k_${n.id}`;
    const type = t.elem;
    const len = t.length;
    const extra = (k: number): Val => extras[k - 2] ?? refuse(`carried read of missing p${k}`);
    this.#def(ck, type);
    const g = found.guard;
    if (g !== undefined) {
      const k = g.k.kind === 'param' ? extra(g.k.index) : this.#resolve(env, g.k);
      this.#use(k);
      this.#set(ck, (d) => this.#into(d, k));
    } else {
      // Trip 0 of s * p1 + c + t * pK is c + t * pK.
      const { c, k, t: sign } = found.first;
      const base = this.#slot(key);
      if (sign === 0)
        this.#set(ck, (d) => this.#emit(`movl ${this.#m('%rsp', base + (c % len) * 4)}, ${d}`));
      else {
        const pk = extra(k);
        this.#use(pk);
        this.#into('%r10d', pk);
        if (sign < 0) this.#emit('negl %r10d');
        if (c !== 0) this.#emit(`addl ${imm(c)}, %r10d`);
        if ((len & (len - 1)) === 0) this.#emit(`andl ${imm(len - 1)}, %r10d`);
        else {
          this.#needDx = true;
          this.#emit('movl %r10d, %eax', 'xorl %edx, %edx', `movl ${imm(len)}, %r10d`);
          this.#emit('divl %r10d', 'movl %edx, %r10d');
        }
        this.#set(ck, (d) => this.#emit(`movl ${base}(%rsp,%r10,4), ${d}`));
      }
    }
    return {
      read: g?.select ?? found.get,
      dead: carryDead(callee, found),
      set: found.set,
      key: ck,
      type,
    };
  }

  /**
   * Induction variables of an inlined fold or loop body: every `mul p1 K` node with K
   * loop-invariant (a literal or an extra parameter) gets a key holding p1 * K, zero before trip
   * 0, which the loop advances by K after each trip; the body reads it in place of the product.
   * Nodes the carried read leaves dead are not stepped.
   */
  #steps(
    env: Env,
    n: Node,
    callee: TypedFunc,
    extras: readonly Val[],
    carry: CarryHost | undefined,
  ): { keys: Map<string, string>; by: { key: string; by: Val }[] } {
    const keys = new Map<string, string>();
    const by: { key: string; by: Val }[] = [];
    const isIndex = (o: Operand | undefined): boolean => o?.kind === 'param' && o.index === 1;
    for (const m of callee.nodes) {
      if (m.op !== 'mul' || carry?.dead.has(m.id) === true || carry?.read === m.id) continue;
      const [x, y] = m.args as [Operand, Operand];
      const k = isIndex(x) ? y : isIndex(y) ? x : undefined;
      let step: Val | undefined;
      if (k?.kind === 'u32') step = { kind: 'lit', value: k.value >>> 0, type: 'u32' };
      else if (k?.kind === 'param' && k.index >= 2) step = extras[k.index - 2];
      if (step === undefined) continue;
      const key = `${env.prefix}s_${n.id}_${m.id}`;
      this.#def(key, 'u32');
      this.#set(key, (d) => this.#emit(`xorl ${d}, ${d}`));
      keys.set(m.id, key);
      by.push({ key, by: step });
    }
    return { keys, by };
  }

  // --- nodes -------------------------------------------------------------------------------

  #body(env: Env): void {
    for (const [i, n] of env.fn.nodes.entries()) this.#node(env, n, i);
  }

  #node(env: Env, n: Node, index: number): void {
    if (env.loop === undefined) {
      this.#op(env, n, index);
      return;
    }
    const { carry, steps } = env.loop;
    // A carried read or an induction variable is the host's register (`#resolve`), and what only
    // the carried read read is dead.
    if (n.id === carry?.read || carry?.dead.has(n.id) === true || steps.has(n.id)) {
      this.#pos += 1;
      return;
    }
    this.#op(env, n, index);
    if (carry === undefined || n.id !== carry.set) return;
    // After the store, the stored value is what the next trip reads.
    const v = this.#resolve(env, n.args[2] as Operand);
    const reg: Val = { kind: 'key', key: carry.key, type: carry.type };
    this.#use(v);
    this.#use(reg);
    this.#set(carry.key, (d) => this.#into(d, v));
  }

  #op(env: Env, n: Node, index: number): void {
    const t = env.fn.types.get(n.id) ?? refuse(`untyped node ${n.id}`);
    const key = `${env.prefix}n_${n.id}`;
    const plan = planFor(env.fn);
    this.#pos += 1;
    // Absorbed by their single consumer (a rotate, a bit test, or selects), which reads their
    // operands itself.
    if (plan.skip.has(n.id) || plan.fused.has(n.id)) return;
    const vals = n.args.map((o) => this.#resolve(env, o));
    const [a, b, c] = vals;
    if (n.op !== 'fold' && n.op !== 'loop') for (const v of vals) this.#use(v);
    const scalar = (produce: (d: string) => void): void => {
      this.#def(key, t);
      this.#set(key, produce);
    };
    const bound = (limit: number): void => {
      if (limit < 2 ** 32) this.#bounds.set(key, limit);
    };
    /** Source of `b` for a two-operand instruction: an immediate, a register, or its slot. */
    const srcB = (): string =>
      b?.kind === 'lit' ? imm(b.value) : this.#operand(b as Val, '%r11d');
    /** d = a op b for a commutative two-operand instruction. */
    const bin = (insn: string): void => {
      const ra = this.#read(a as Val, '%r10d');
      const rb = srcB();
      scalar((d) => {
        if (d === ra) this.#emit(`${insn} ${rb}, ${d}`);
        else if (d === rb) this.#emit(`${insn} ${ra}, ${d}`);
        else this.#emit(`movl ${ra}, ${d}`, `${insn} ${rb}, ${d}`);
      });
    };
    // 32-bit shifts use the count modulo 32: A0's five-bit mask.
    const shift = (insn: string): void => {
      const ra = this.#read(a as Val, '%r10d');
      if (b?.kind === 'lit') {
        const k = b.value & 31;
        scalar((d) => {
          this.#mov(ra, d);
          if (k !== 0) this.#emit(`${insn} $${k}, ${d}`);
        });
        return;
      }
      this.#needCx = true;
      this.#into('%ecx', b as Val);
      scalar((d) => {
        this.#mov(ra, d);
        this.#emit(`${insn} %cl, ${d}`);
      });
    };
    const cmp = (): void => {
      const shape = plan.shapes.get(n.id) ?? refuse(`no comparison shape for ${n.id}`);
      const read = this.#shapeVals(env, shape).flatMap((v) => {
        if (v.kind !== 'key') return [];
        const h = this.#home(v.key);
        return 'reg' in h ? [h.reg] : [];
      });
      scalar((d) => {
        // Zeroing first (when d is not an operand) leaves setcc as the only byte write.
        if (!read.includes(d)) {
          this.#emit(`xorl ${d}, ${d}`);
          this.#emit(`set${this.#flags(env, shape)} ${low8(d)}`);
        } else this.#emit(`set${this.#flags(env, shape)} %al`, `movzbl %al, ${d}`);
      });
    };
    /** eax = a / b, edx = a mod b; a zero divisor takes the `zero` path with eax = a. */
    const divide = (zero: string[], nonzero: string[]): void => {
      this.#needDx = true;
      const rb = this.#read(b as Val, '%r11d');
      this.#into('%eax', a as Val);
      if (siteOf(env.fn, n) === 'divzero') {
        // Strict: a zero divisor traps before the division.
        this.#emit(`testl ${rb}, ${rb}`, `je ${this.#stub('divzero')}`, 'xorl %edx, %edx');
        this.#emit(`divl ${rb}`, ...nonzero);
        scalar((d) => this.#mov('%eax', d));
        return;
      }
      const z = this.#label();
      const done = this.#label();
      this.#emit(`testl ${rb}, ${rb}`, `je ${z}`, 'xorl %edx, %edx', `divl ${rb}`, ...nonzero);
      this.#emit(`jmp ${done}`, `${z}:`, ...zero, `${done}:`);
      scalar((d) => this.#mov('%eax', d));
    };
    const rot = plan.rots.get(n.id);
    if (rot !== undefined) {
      const x = this.#resolve(env, rot.x);
      this.#use(x);
      if (typeof rot.count === 'number') {
        const k = rot.count;
        const rx = this.#read(x, '%r10d');
        scalar((d) => {
          this.#mov(rx, d);
          this.#emit(`roll $${k}, ${d}`);
        });
        return;
      }
      const cnt = this.#resolve(env, rot.count);
      this.#use(cnt);
      this.#needCx = true;
      this.#into('%ecx', cnt);
      const rx = this.#read(x, '%r10d');
      scalar((d) => {
        this.#mov(rx, d);
        this.#emit(`${rot.left ? 'roll' : 'rorl'} %cl, ${d}`);
      });
      return;
    }
    const aggregateOf = (v: Val, what: string): { key: string; type: Type } => {
      if (v.kind !== 'key' || isPrimitive(v.type)) refuse(`${n.op} needs ${what}`);
      return { key: v.key, type: v.type };
    };
    switch (n.op) {
      case 'mov': {
        const v = a as Val;
        if (v.kind === 'key' && !isScalar(v.type)) this.#defAlias(key, v.key, t);
        else {
          bound(this.#bound(v));
          scalar((d) => this.#into(d, v));
        }
        return;
      }
      case 'add': {
        // Three-operand forms go through lea (no copy, flags untouched).
        const ra = this.#read(a as Val, '%r10d');
        const rb = srcB();
        scalar((d) => {
          if (d === ra) this.#emit(`addl ${rb}, ${d}`);
          else if (d === rb) this.#emit(`addl ${ra}, ${d}`);
          else if (b?.kind === 'lit') this.#emit(`leal ${b.value | 0}(${q(ra)}), ${d}`);
          else if (rb.startsWith('%')) this.#emit(`leal (${q(ra)},${q(rb)}), ${d}`);
          else this.#emit(`movl ${ra}, ${d}`, `addl ${rb}, ${d}`);
        });
        return;
      }
      case 'sub': {
        const ra = a?.kind === 'lit' ? imm(a.value) : this.#read(a as Val, '%r10d');
        const rb = srcB();
        scalar((d) => {
          if (d === ra) this.#emit(`subl ${rb}, ${d}`);
          else if (d === rb) this.#emit(`negl ${d}`, `addl ${ra}, ${d}`);
          else if (b?.kind === 'lit' && ra.startsWith('%'))
            this.#emit(`leal ${-b.value | 0}(${q(ra)}), ${d}`);
          else this.#emit(`movl ${ra}, ${d}`, `subl ${rb}, ${d}`);
        });
        return;
      }
      case 'mul': {
        if (b?.kind === 'lit') {
          const k = b.value >>> 0;
          const ra = this.#read(a as Val, '%r10d');
          const r = q(ra);
          scalar((d) => {
            if (k === 2) this.#emit(`leal (${r},${r}), ${d}`);
            else if (k === 3 || k === 5 || k === 9) this.#emit(`leal (${r},${r},${k - 1}), ${d}`);
            else if (k !== 0 && (k & (k - 1)) === 0) {
              this.#mov(ra, d);
              this.#emit(`shll $${Math.log2(k)}, ${d}`);
            } else this.#emit(`imull ${imm(k)}, ${ra}, ${d}`);
          });
          return;
        }
        bin('imull');
        return;
      }
      case 'and':
        bound(Math.min(this.#bound(a as Val), this.#bound(b as Val)));
        bin('andl');
        return;
      case 'or':
        bin('orl');
        return;
      case 'xor':
        bin('xorl');
        return;
      case 'shl':
        shift('shll');
        return;
      case 'shr':
        if (b?.kind === 'lit' && (b.value & 31) !== 0) bound(2 ** (32 - (b.value & 31)));
        shift('shrl');
        return;
      case 'div':
        // DIV traps on a zero divisor; A0 requires all ones.
        divide(['movl $-1, %eax'], []);
        return;
      case 'rem':
        // The remainder is in edx; a zero divisor gives the dividend (A0's rule), still in eax.
        if (b?.kind === 'lit' && b.value !== 0) bound(b.value);
        divide([], ['movl %edx, %eax']);
        return;
      case 'eq':
      case 'ne':
      case 'lt':
      case 'le':
      case 'gt':
      case 'ge':
        cmp();
        return;
      case 'select': {
        const cond = n.args[0] as Operand;
        const shape =
          cond.kind === 'node' && plan.fused.has(cond.id) ? plan.shapes.get(cond.id) : undefined;
        if (shape !== undefined) for (const v of this.#shapeVals(env, shape)) this.#use(v);
        /** Set the flags for the condition; the returned code is true when it holds. */
        const flags = (): string => {
          if (shape !== undefined) return this.#flags(env, shape);
          const rc = this.#read(a as Val, '%r10d');
          this.#emit(`testl ${rc}, ${rc}`);
          return 'ne';
        };
        if (isScalar(t)) {
          // cmov takes a register or memory source; literals are materialized before the
          // flags are set (a later movl leaves the flags alone).
          const rb = b?.kind === 'lit' ? this.#operand(b, '%r11d') : this.#operand(b as Val, '');
          const rc = c?.kind === 'lit' ? this.#operand(c, '%eax') : this.#operand(c as Val, '');
          scalar((d) => {
            const cc = flags();
            if (d === rb) this.#emit(`cmov${NOT_CC[cc]}l ${rc}, ${d}`);
            else {
              this.#mov(rc, d);
              this.#emit(`cmov${cc}l ${rb}, ${d}`);
            }
          });
          return;
        }
        this.#def(key, t);
        this.#emit(
          `leaq ${this.#m('%rsp', this.#slot(aggregateOf(b as Val, 'a value').key))}, %rax`,
          `leaq ${this.#m('%rsp', this.#slot(aggregateOf(c as Val, 'a value').key))}, %r11`,
        );
        this.#emit(`cmov${flags()}q %rax, %r11`);
        this.#copy('%rsp', this.#slot(key), '%r11', 0, words(t));
        return;
      }
      case 'arr':
      case 'rec': {
        this.#def(key, t);
        if (deadLiteral(env.fn, index)) return;
        let off = this.#slot(key);
        const first = vals[0];
        if (
          vals.length >= 8 &&
          first?.kind === 'lit' &&
          vals.every((v) => v.kind === 'lit' && v.value === first.value)
        ) {
          this.#fill('%rsp', off, first.value, vals.length);
          return;
        }
        for (let i = 0; i < vals.length; ) {
          const v = vals[i] as Val;
          const w = words(v.type);
          let run = 1;
          if (v.kind === 'key' && w >= 4)
            while (
              vals[i + run]?.kind === 'key' &&
              (vals[i + run] as Val & { key: string }).key === v.key
            )
              run += 1;
          this.#place(v, '%rsp', off);
          // A run of one aggregate repeated: the later copies replicate the first with one
          // forward copy (each 16-byte read is at least one element behind the writes).
          if (run > 1) this.#copy('%rsp', off + 4 * w, '%rsp', off, (run - 1) * w);
          off += 4 * w * run;
          i += run;
        }
        return;
      }
      case 'get': {
        const src = aggregateOf(a as Val, 'an array');
        const at = src.type;
        if (isPrimitive(at) || at.kind !== 'arr') refuse('get needs an array');
        const ew = words(at.elem);
        const base = this.#slot(src.key);
        // Strict: an index at or past the length traps instead of wrapping.
        const checked = siteOf(env.fn, n) === 'bounds';
        if (checked) this.#checkBounds(b as Val, at.length);
        if (b?.kind === 'lit') {
          const off = base + (b.value % at.length) * ew * 4;
          if (isScalar(t)) scalar((d) => this.#emit(`movl ${this.#m('%rsp', off)}, ${d}`));
          else {
            // A borrowed read of a literal element: named in place, not copied.
            this.#defAlias(key, src.key, t, (b.value % at.length) * ew * 4);
          }
          return;
        }
        const scale = this.#scaledIndex(b as Val, at.length, ew * 4, checked);
        if (isScalar(t)) scalar((d) => this.#emit(`movl ${base}(%rsp,${scale}), ${d}`));
        else {
          this.#def(key, t);
          this.#emit(`leaq ${base}(%rsp,${scale}), %r11`);
          this.#copy('%rsp', this.#slot(key), '%r11', 0, ew);
        }
        return;
      }
      case 'set': {
        const src = aggregateOf(a as Val, 'an array');
        const at = src.type;
        if (isPrimitive(at) || at.kind !== 'arr') refuse('set needs an array');
        const ew = words(at.elem);
        // Strict: the index is checked before anything is copied or written.
        const checked = siteOf(env.fn, n) === 'bounds';
        if (checked) this.#checkBounds(b as Val, at.length);
        if (mutableHere(env.fn, n.args[0] as Operand, index, 0, env.ownedP0))
          this.#defAlias(key, src.key, t);
        else {
          this.#def(key, t);
          this.#copy('%rsp', this.#slot(key), '%rsp', this.#slot(src.key), words(at));
        }
        const dst = this.#slot(key);
        if (b?.kind === 'lit') {
          this.#place(c as Val, '%rsp', dst + (b.value % at.length) * ew * 4);
          return;
        }
        const scale = this.#scaledIndex(b as Val, at.length, ew * 4, checked);
        const v = c as Val;
        if (v.kind === 'lit' || isScalar(v.type)) {
          const src = v.kind === 'lit' ? imm(v.value) : this.#read(v, '%eax');
          this.#emit(`movl ${src}, ${dst}(%rsp,${scale})`);
          return;
        }
        this.#emit(`leaq ${dst}(%rsp,${scale}), %r11`);
        this.#place(v, '%r11', 0);
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
          if (isScalar(t)) scalar((d) => this.#emit(`movl ${this.#m('%rsp', from)}, ${d}`));
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
          this.#copy('%rsp', this.#slot(key), '%rsp', this.#slot(src.key), words(rt));
        }
        this.#place(c as Val, '%rsp', this.#slot(key) + off);
        return;
      }
      case 'call': {
        const name = n.callee as string;
        const callee = env.fn.calls.get(name) ?? refuse(`unknown callee ${name}`);
        if (this.#inlinable(callee, env, 'call')) {
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
        /** Induction keys and the loop-invariant step each one advances by after a trip. */
        let stepping: readonly { key: string; by: Val }[] = [];
        const state: Val = { kind: 'key', key, type: t };
        const cval: Val = { kind: 'key', key: counter, type: 'u32' };
        this.#use(init);
        for (const e of extras) this.#use(e);
        const run =
          n.op === 'fold' &&
          count.kind === 'lit' &&
          count.value >= 4 &&
          this.#inlinable(callee, env, 'loop')
            ? fillRun(env.fn, n)
            : undefined;
        // The initial value is dead when every element is written before any trip reads it.
        const deadInit = overwritesState(env.fn, n);
        if (run !== undefined && this.#sseRegisters(run) !== undefined) {
          if (
            init.kind === 'key' &&
            mutableHere(env.fn, n.args[1] as Operand, index, 1, env.ownedP0)
          )
            this.#defAlias(key, init.key, t);
          else {
            this.#def(key, t);
            if (!deadInit) this.#place(init, '%rsp', this.#slot(key));
          }
          this.#sseFill(run, key, extras);
          this.#pos += 1;
          this.#use(state);
          return;
        }
        if (isScalar(t)) scalar((d) => this.#into(d, init));
        else if (
          init.kind === 'key' &&
          mutableHere(env.fn, n.args[1] as Operand, index, 1, env.ownedP0)
        )
          this.#defAlias(key, init.key, t);
        else {
          this.#def(key, t);
          if (!deadInit) this.#place(init, '%rsp', this.#slot(key));
        }
        // An inlined body keeps its carried read and its induction variables in registers.
        let host: LoopHost | undefined;
        if (this.#inlinable(callee, env, 'loop')) {
          const carry = this.#carry(env, n, callee, key, t, extras);
          const steps = this.#steps(env, n, callee, extras, carry);
          host = { ...(carry === undefined ? {} : { carry }), steps: steps.keys };
          stepping = steps.by;
        }
        this.#def(counter, 'u32');
        if (count.kind === 'lit') this.#bounds.set(counter, count.value);
        this.#set(counter, (d) => this.#emit(`xorl ${d}, ${d}`));
        this.#loops.push({ start: this.#pos, used: new Set() });
        const top = this.#label();
        const done = this.#label();
        // Strict: a body that can trap runs under a marked frame, so a trap names this fold and
        // its trip (`at=f.n trip=i`); the mark is cleared when the loop ends.
        const marked = callTraps(env.fn, n);
        if (marked) this.#markNode(n.id);
        // Rotated loop: one guard for a count that may be zero, then the test at the bottom
        // (one taken branch per trip).
        this.#use(count);
        this.#use(cval);
        if (count.kind === 'lit') {
          if (count.value === 0) this.#emit(`jmp ${done}`);
        } else {
          const lim = this.#operand(count, '');
          this.#emit(lim.startsWith('%') ? `testl ${lim}, ${lim}` : `cmpl $0, ${lim}`);
          this.#emit(`je ${done}`);
        }
        this.#emit(`${top}:`);
        if (marked) this.#markTrip(this.#read(cval, '%eax'));
        const args: Val[] = [state, cval, ...extras];
        if (pred !== undefined) {
          const pkey = `${env.prefix}c_${n.id}`;
          if (this.#inlinable(pred, env, 'loop'))
            this.#inline(env, pred, args, false, pkey, 'bool', `${n.id}.p`, 'bind');
          else {
            this.#def(pkey, 'bool');
            this.#call(n.pred as string, pred, args, pkey);
          }
          const pv: Val = { kind: 'key', key: pkey, type: 'bool' };
          this.#use(pv);
          const rp = this.#read(pv, '%eax');
          this.#emit(`testl ${rp}, ${rp}`, `je ${done}`);
        }
        if (this.#inlinable(callee, env, 'loop'))
          this.#inline(env, callee, args, true, key, t, n.id, 'store', host);
        else this.#call(name, callee, args, key);
        for (const { key: k, by } of stepping) {
          const v: Val = { kind: 'key', key: k, type: 'u32' };
          this.#use(v);
          this.#use(by);
          const cur = this.#read(v, '%eax');
          const step = by.kind === 'lit' ? imm(by.value) : this.#operand(by, '%r11d');
          this.#set(k, (d) => {
            this.#mov(cur, d);
            this.#emit(`addl ${step}, ${d}`);
          });
        }
        this.#use(cval);
        this.#use(count);
        const cr = this.#read(cval, '%eax');
        this.#set(counter, (d) => {
          this.#mov(cr, d);
          this.#emit(`addl $1, ${d}`);
        });
        const ci = this.#read(cval, '%r10d');
        const limit = count.kind === 'lit' ? imm(count.value) : this.#operand(count, '');
        this.#emit(`cmpl ${limit}, ${ci}`, `jb ${top}`, `${done}:`);
        if (marked) this.#markNode(undefined);
        this.#pos += 1;
        this.#use(state);
        this.#use(cval);
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
      // The checked ops: the `(value, ok)` record, written into the node's slot. Nothing traps.
      case 'cadd':
      case 'csub':
      case 'cmul':
      case 'cdiv':
      case 'crem':
      case 'cget':
        this.#checked(n, key, t, vals);
        return;
      case 'read':
      case 'write':
      case 'puts':
        this.#io(env, n, key, t, vals);
        return;
    }
  }

  /**
   * `read`, `write` and `puts` through the module's io helpers (see the file comment): the
   * token's address goes in r11 and comes back unchanged, so the result token is that address.
   */
  #io(env: Env, n: Node, key: string, t: Type, vals: readonly Val[]): void {
    const [a, b] = vals as [Val, Val | undefined];
    if (a.kind !== 'key' || a.type !== 'io') refuse(`${n.op} needs an io token`);
    this.#def(key, t);
    if (n.op === 'read') {
      const helper = siteOf(env.fn, n) === 'input' ? 'sread' : 'read';
      this.#emit(`movq ${this.#m('%rsp', this.#slot(a.key))}, %r11`);
      this.#emit(`call ${ioHelper(this.platform, helper)}`);
      const at = this.#slot(key);
      this.#emit(`movl %eax, ${this.#m('%rsp', at)}`, `movq %r11, ${this.#m('%rsp', at + 4)}`);
      return;
    }
    if (n.op === 'write') {
      this.#into('%eax', b as Val);
      this.#emit(`movq ${this.#m('%rsp', this.#slot(a.key))}, %r11`);
      this.#emit(`call ${ioHelper(this.platform, 'write')}`);
    } else {
      const arr = b?.kind === 'key' ? b : refuse('puts needs an array');
      if (isPrimitive(arr.type) || arr.type.kind !== 'arr') refuse('puts needs an array');
      this.#emit(`leaq ${this.#m('%rsp', this.#slot(arr.key))}, %r10`);
      this.#emit(`movl ${imm(arr.type.length)}, %eax`);
      this.#emit(`movq ${this.#m('%rsp', this.#slot(a.key))}, %r11`);
      this.#emit(`call ${ioHelper(this.platform, 'puts')}`);
    }
    this.#emit(`movq %r11, ${this.#m('%rsp', this.#slot(key))}`);
  }

  /** `value` in eax and `ok` in r11d are stored as the two words of the record `key`. */
  #storeRecord(key: string, t: Type): void {
    this.#def(key, t);
    const at = this.#slot(key);
    this.#emit(`movl %eax, ${this.#m('%rsp', at)}`, `movl %r11d, ${this.#m('%rsp', at + 4)}`);
  }

  #checked(n: Node, key: string, t: Type, vals: readonly Val[]): void {
    const [a, b] = vals as [Val, Val];
    if (n.op === 'cget') {
      const src = a.kind === 'key' && !isPrimitive(a.type) ? a : refuse('cget needs an array');
      const at = src.type;
      if (isPrimitive(at) || at.kind !== 'arr' || !isPrimitive(at.elem))
        refuse('cget needs an array of scalars');
      const base = this.#slot(src.key);
      if (b.kind === 'lit') {
        if (b.value < at.length) this.#emit(`movl ${this.#m('%rsp', base + 4 * b.value)}, %eax`);
        else this.#emit('xorl %eax, %eax');
        this.#emit(`movl $${b.value < at.length ? 1 : 0}, %r11d`);
        this.#storeRecord(key, t);
        return;
      }
      const out = this.#label();
      const done = this.#label();
      this.#emit(`cmpl ${imm(at.length)}, ${this.#read(b, '%r10d')}`, `jae ${out}`);
      const scale = this.#scaledIndex(b, at.length, 4, true);
      this.#emit(`movl ${base}(%rsp,${scale}), %eax`, 'movl $1, %r11d', `jmp ${done}`);
      this.#emit(`${out}:`, 'xorl %eax, %eax', 'xorl %r11d, %r11d', `${done}:`);
      this.#storeRecord(key, t);
      return;
    }
    if (n.op === 'cdiv' || n.op === 'crem') {
      this.#needDx = true;
      const rb = this.#read(b, '%r11d');
      this.#into('%eax', a);
      const zero = this.#label();
      const done = this.#label();
      this.#emit(`testl ${rb}, ${rb}`, `je ${zero}`, 'xorl %edx, %edx', `divl ${rb}`);
      if (n.op === 'crem') this.#emit('movl %edx, %eax');
      this.#emit('movl $1, %r11d', `jmp ${done}`);
      this.#emit(`${zero}:`, 'xorl %eax, %eax', 'xorl %r11d, %r11d', `${done}:`);
      this.#storeRecord(key, t);
      return;
    }
    if (n.op === 'cmul') {
      this.#needDx = true;
      const rb = b.kind === 'lit' ? '%r11d' : this.#operand(b, '%r11d');
      if (b.kind === 'lit') this.#emit(`movl ${imm(b.value)}, %r11d`);
      this.#into('%eax', a);
      this.#emit(`mull ${rb}`, 'testl %edx, %edx', 'sete %r11b', 'movzbl %r11b, %r11d');
      this.#storeRecord(key, t);
      return;
    }
    // cadd, csub: the carry (or borrow) flag says the exact result did not fit.
    const rb = b.kind === 'lit' ? imm(b.value) : this.#operand(b, '%r11d');
    this.#into('%eax', a);
    this.#emit(
      `${n.op === 'cadd' ? 'addl' : 'subl'} ${rb}, %eax`,
      'setae %r11b',
      'movzbl %r11b, %r11d',
    );
    this.#storeRecord(key, t);
  }

  // --- SSE2 fill runs -----------------------------------------------------------------------

  /**
   * xmm registers for a fill run (optimize.ts `fillRun`): one per uniform operand (literal or
   * extra parameter) and per body node; undefined when they do not fit. Shift distances are
   * immediates (literal) or a count register holding the parameter mod 32.
   */
  #sseRegisters(
    run: FillRun,
  ):
    | { uniform: Map<string, string>; counts: Map<number, string>; nodes: Map<string, string> }
    | undefined {
    const uniform = new Map<string, string>();
    const counts = new Map<number, string>();
    const nodes = new Map<string, string>();
    let next = SSE_FIRST;
    const take = (): string | undefined => (next <= SSE_LAST ? `%xmm${next++}` : undefined);
    const need = (o: Operand): boolean => {
      if (o.kind === 'node' || (o.kind === 'param' && o.index === 1)) return true;
      const k = formatUniform(o);
      if (uniform.has(k)) return true;
      const r = take();
      if (r === undefined) return false;
      uniform.set(k, r);
      return true;
    };
    for (const m of run.nodes) {
      if (SSE_OP[m.op] === undefined && m.op !== 'mul') return undefined;
      const [a, b] = m.args as [Operand, Operand];
      if (!need(a)) return undefined;
      if (m.op === 'shl' || m.op === 'shr') {
        if (b.kind === 'param' && !counts.has(b.index)) {
          const r = take();
          if (r === undefined) return undefined;
          counts.set(b.index, r);
        }
      } else if (!need(b)) return undefined;
      const r = take();
      if (r === undefined) return undefined;
      nodes.set(m.id, r);
    }
    if (!need(run.value)) return undefined;
    return { uniform, counts, nodes };
  }

  /**
   * Elements 0..count-1 of the array `key` from a fill run, four lanes per trip in xmm
   * registers (SSE2 only: 32-bit multiplies are two pmuludq on the even and odd lanes). A
   * remainder of count mod 4 elements is one more group stored lane by lane (the extra lanes
   * are pure and total, so computing them is unobservable). Uses rax, r10, r11, xmm1-xmm15.
   */
  #sseFill(run: FillRun, key: string, extras: readonly Val[]): void {
    const regs = this.#sseRegisters(run);
    if (regs === undefined) refuse('internal: fill run registers');
    const reg = (o: Operand): string => {
      if (o.kind === 'node') return regs.nodes.get(o.id) as string;
      if (o.kind === 'param' && o.index === 1) return '%xmm1';
      return regs.uniform.get(formatUniform(o)) as string;
    };
    const extra = (i: number): Val => extras[i - 2] ?? refuse(`fill run reads missing p${i}`);
    for (const e of extras) this.#use(e);
    // Preheader: lane indices {0, 1, 2, 3}, step {4, 4, 4, 4}, uniform operands broadcast.
    this.#emit(
      'movabsq $4294967296, %rax',
      'movq %rax, %xmm1',
      'movabsq $12884901890, %rax',
      'movq %rax, %xmm2',
      'punpcklqdq %xmm2, %xmm1',
      'movl $4, %eax',
      'movd %eax, %xmm2',
      'pshufd $0, %xmm2, %xmm2',
    );
    for (const [k, r] of regs.uniform) {
      const [kind, v] = k.split(':') as [string, string];
      if (kind === 'u' && Number(v) === 0) this.#emit(`pxor ${r}, ${r}`);
      else {
        const src = kind === 'u' ? imm(Number(v)) : this.#operand(extra(Number(v)), '%eax');
        this.#emit(`movl ${src}, %eax`, `movd %eax, ${r}`, `pshufd $0, ${r}, ${r}`);
      }
    }
    for (const [p, r] of regs.counts)
      this.#emit(
        `movl ${this.#operand(extra(p), '%eax')}, %eax`,
        'andl $31, %eax',
        `movd %eax, ${r}`,
      );
    const lanes = (): void => {
      for (const m of run.nodes) {
        const d = regs.nodes.get(m.id) as string;
        const [a, b] = m.args as [Operand, Operand];
        const ra = reg(a);
        if (m.op === 'mul') {
          // Even lanes: pmuludq of lanes 0 and 2; odd lanes: the same after a 32-bit shift.
          const rb = reg(b);
          this.#emit(
            `movdqa ${ra}, ${d}`,
            `pmuludq ${rb}, ${d}`,
            `pshufd $245, ${ra}, %xmm14`,
            `pshufd $245, ${rb}, %xmm15`,
            'pmuludq %xmm15, %xmm14',
            `pshufd $232, ${d}, ${d}`,
            'pshufd $232, %xmm14, %xmm14',
            `punpckldq %xmm14, ${d}`,
          );
          continue;
        }
        const insn = SSE_OP[m.op] as string;
        this.#emit(`movdqa ${ra}, ${d}`);
        if (m.op === 'shl' || m.op === 'shr') {
          if (b.kind === 'u32') {
            if ((b.value & 31) !== 0) this.#emit(`${insn} $${b.value & 31}, ${d}`);
          } else this.#emit(`${insn} ${regs.counts.get((b as { index: number }).index)}, ${d}`);
        } else this.#emit(`${insn} ${reg(b)}, ${d}`);
      }
    };
    const out = reg(run.value);
    const groups = Math.floor(run.count / 4);
    this.#emit(`leaq ${this.#m('%rsp', this.#slot(key))}, %r10`);
    if (groups === 1) {
      lanes();
      this.#emit(`movups ${out}, (%r10)`);
    } else {
      const top = this.#label();
      this.#emit(`movl ${imm(groups)}, %r11d`, `${top}:`);
      lanes();
      this.#emit(
        `movups ${out}, (%r10)`,
        'addq $16, %r10',
        'paddd %xmm2, %xmm1',
        'subl $1, %r11d',
        `jne ${top}`,
      );
    }
    const rest = run.count % 4;
    if (rest === 0) return;
    if (groups === 1) this.#emit('addq $16, %r10', 'paddd %xmm2, %xmm1');
    lanes();
    for (let k = 0; k < rest; k += 1) {
      this.#emit(`movd ${out}, %eax`, `movl %eax, ${4 * k}(%r10)`);
      if (k + 1 < rest) this.#emit(`psrldq $4, ${out}`);
    }
  }

  // --- register allocation ---------------------------------------------------------------

  /**
   * Linear scan over definition order: scalars get callee-saved homes; a leaf also uses the
   * caller-saved edi, esi, r8d, r9d, and edx/ecx when nothing in the body needs them as
   * scratch. `retKey`, defined by the last node and only returned, is computed straight into
   * eax.
   */
  #allocate(places: readonly ArgPlace[], retKey: string | undefined): void {
    const leafHomes = [
      ...LEAF_ARG_HOMES,
      ...(this.#needDx ? [] : ['%edx']),
      ...(this.#needCx ? [] : ['%ecx']),
    ];
    const pool = this.#leaf ? [...leafHomes, ...CALLEE_SAVED] : CALLEE_SAVED;
    const keys = [...this.#defs.entries()]
      .filter(([k, d]) => isScalar(d.type) && !this.#alias.has(k))
      .sort((x, y) => x[1].pos - y[1].pos);
    const busy = new Map<string, number>();
    for (const [key, d] of keys) {
      if (key === retKey) {
        this.#regs.set(key, '%eax');
        continue;
      }
      const last = this.#last.get(key) ?? d.pos;
      for (const [r, l] of busy) if (l <= d.pos) busy.delete(r);
      // A loop body's result shares the state's register (see #inline): the state is not
      // read between the result's definition and the store that ends the trip.
      const target = this.#shares.get(key);
      const shared = target === undefined ? undefined : this.#regs.get(target);
      if (shared !== undefined && (busy.get(shared) ?? -1) >= last) {
        this.#regs.set(key, shared);
        continue;
      }
      let reg: string | undefined;
      const p = /^p(\d+)$/.exec(key);
      if (this.#leaf && p !== null) {
        const arrival = places[Number(p[1])]?.reg;
        const r = arrival === undefined ? undefined : ARG_REGS[arrival];
        if (r !== undefined && leafHomes.includes(r) && !busy.has(r)) reg = r;
      }
      if (reg === undefined) reg = pool.find((r) => !busy.has(r));
      if (reg === undefined) continue;
      busy.set(reg, last);
      this.#regs.set(key, reg);
    }
    const used = new Set([...this.#regs.values()].filter((r) => CALLEE_SAVED.includes(r)));
    this.#saved = CALLEE_SAVED.filter((r) => used.has(r)).map(q);
  }

  /** Sequentialize register-to-register moves whose sources may be other moves' targets. */
  #parallelMove(moves: { src: string; dst: string }[]): void {
    const pending = moves.filter((m) => m.src !== m.dst);
    while (pending.length > 0) {
      const i = pending.findIndex((m) => !pending.some((o) => o !== m && o.src === m.dst));
      if (i >= 0) {
        const [m] = pending.splice(i, 1) as [{ src: string; dst: string }];
        this.#emit(`movl ${m.src}, ${m.dst}`);
        continue;
      }
      // Every target is still a source: break the cycle through eax.
      const m = pending[0] as { src: string; dst: string };
      this.#emit(`movl ${m.src}, %eax`);
      m.src = '%eax';
    }
  }

  /** After the function: its cold trap stubs, its name, and the ids of the folds it marks. */
  #coldPaths(framed: boolean): void {
    const trap = this.platform === 'darwin' ? '_a0_trap' : 'a0_trap';
    for (const kind of ['bounds', 'divzero'] as const)
      if (this.#stubs.has(kind))
        this.out.push(
          `${this.#tag(kind === 'bounds' ? 'tb' : 'td')}:`,
          `\tmovl $${trapIndex(kind)}, %eax`,
          `\tjmp ${trap}`,
        );
    const text = (tag: string, value: string): void => {
      this.out.push(`${this.#tag(tag)}:`, `\t.asciz ${JSON.stringify(value)}`);
    };
    if (framed) text('nm', this.fn.name);
    for (const id of this.#nodeIds) text(`i${id}`, id);
  }

  // --- function -------------------------------------------------------------------------

  emit(): string {
    const fn = this.fn;
    const env: Env = {
      fn,
      prefix: '',
      params: fn.params.map((t, i) => ({ kind: 'key', key: `p${i}`, type: t })),
      ownedP0: true,
      depth: 0,
    };
    const sret = !isPrimitive(fn.result);
    const { places } = argLayout(fn.params, sret);
    // Pass 1 (dry): positions, liveness, aliases, aggregate slots, residual-call needs.
    this.#dry = true;
    this.#pos = 0;
    for (const [i, t] of fn.params.entries()) this.#def(`p${i}`, t);
    this.#body(env);
    this.#pos += 1;
    const ret = this.#resolve(env, fn.ret);
    this.#use(ret);
    // The returned scalar is computed into eax when the last node defines it (nothing runs
    // between that node and the return; a loop keeps eax as scratch, so it is excluded).
    const last = fn.nodes.at(-1);
    const retKey =
      isScalar(fn.result) &&
      last !== undefined &&
      fn.ret.kind === 'node' &&
      fn.ret.id === last.id &&
      last.op !== 'fold' &&
      last.op !== 'loop' &&
      ret.kind === 'key'
        ? ret.key
        : undefined;
    this.#allocate(places, retKey);
    for (const [k, d] of this.#defs)
      if (isScalar(d.type) && !this.#regs.has(k) && !this.#alias.has(k)) this.#alloc(k, 4);
    if (this.#saved.length > 0) this.#alloc('save', 8 * this.#saved.length, 8);
    if (sret) this.#alloc('sret', 8, 8);
    this.#pack();
    this.#outgoing = align(this.#outgoing, 16);
    const frame = this.#outgoing + align(this.#slotBytes, 16);
    // Pass 2: emission.
    this.#dry = false;
    this.out = [];
    this.#labels = 0;
    this.#pos = 0;
    this.#loops = [];
    const sym = this.#sym(fn.name);
    this.out.push(`\t.globl ${sym}`, '\t.p2align 4');
    if (this.platform === 'linux') this.out.push(`\t.type ${sym},@function`);
    this.out.push(`${sym}:`);
    this.#emit('pushq %rbp', 'movq %rsp, %rbp');
    if (frame > 4096) {
      // Probe one page at a time so the guard page is never skipped.
      const pages = Math.floor(frame / 4096);
      const probe = this.#label();
      this.#emit(`movl ${imm(pages)}, %eax`, `${probe}:`);
      this.#emit('subq $4096, %rsp', 'movq $0, (%rsp)', 'decl %eax', `jne ${probe}`);
      if (frame % 4096 > 0) this.#emit(`subq $${frame % 4096}, %rsp`);
    } else if (frame > 0) this.#emit(`subq $${frame}, %rsp`);
    for (const [k, r] of this.#saved.entries())
      this.#emit(`movq ${r}, ${this.#m('%rsp', this.#slot('save') + 8 * k)}`);
    if (sret) this.#emit(`movq %rdi, ${this.#m('%rsp', this.#slot('sret'))}`);
    // Strict: a function that can trap keeps a frame on the shadow stack (rax, r10, r11 only).
    const framed = mayTrapFn(fn);
    if (framed) this.#enter();
    const incoming = (i: number): number => frame + 16 + (places[i]?.stack as number);
    // Incoming aggregates are copied first (the copy uses rax, r10, r11, xmm0 only, so the
    // argument registers survive), then scalars move to their homes.
    fn.params.forEach((t, i) => {
      const place = places[i] as ArgPlace;
      if (isScalar(t)) return;
      if (t === 'io') {
        // A token arrives as the address itself.
        let src: string;
        if (place.reg !== undefined) src = q(ARG_REGS[place.reg] as string);
        else {
          this.#emit(`movq ${this.#m('%rsp', incoming(i))}, %r11`);
          src = '%r11';
        }
        this.#emit(`movq ${src}, ${this.#m('%rsp', this.#slot(`p${i}`))}`);
        return;
      }
      let base: string;
      if (place.reg !== undefined) base = q(ARG_REGS[place.reg] as string);
      else {
        this.#emit(`movq ${this.#m('%rsp', incoming(i))}, %r11`);
        base = '%r11';
      }
      this.#copy('%rsp', this.#slot(`p${i}`), base, 0, words(t));
    });
    const moves: { src: string; dst: string }[] = [];
    fn.params.forEach((t, i) => {
      const place = places[i] as ArgPlace;
      // A scalar nobody reads is left where it arrived: moving it could clobber a live one.
      if (!isScalar(t) || !this.#last.has(`p${i}`)) return;
      const home = this.#home(`p${i}`);
      if (place.reg === undefined) {
        // Stack scalars: one eightbyte each; bools carry their value in the low byte.
        const at = this.#m('%rsp', incoming(i));
        this.#set(`p${i}`, (d) => {
          this.#emit(t === 'bool' ? `movzbl ${at}, ${d}` : `movl ${at}, ${d}`);
        });
        return;
      }
      const r = ARG_REGS[place.reg] as string;
      if (t === 'bool') this.#emit(`andl $1, ${r}`);
      if ('reg' in home) {
        moves.push({ src: r, dst: home.reg });
        return;
      }
      this.#emit(`movl ${r}, ${this.#m('%rsp', home.slot)}`);
    });
    this.#parallelMove(moves);
    this.#body(env);
    this.#pos += 1;
    if (fn.result === 'io') {
      if (ret.kind !== 'key') refuse('an io result must be a token');
      this.#emit(`movq ${this.#m('%rsp', this.#slot(ret.key))}, %rax`);
    } else if (!sret) this.#into('%eax', ret);
    else {
      this.#emit(`movq ${this.#m('%rsp', this.#slot('sret'))}, %r11`);
      this.#place(ret, '%r11', 0);
      this.#emit(`movq ${this.#m('%rsp', this.#slot('sret'))}, %rax`);
    }
    for (const [k, r] of this.#saved.entries())
      this.#emit(`movq ${this.#m('%rsp', this.#slot('save') + 8 * k)}, ${r}`);
    if (framed) this.#leave();
    // rsp is unchanged when the frame is empty.
    if (frame > 0) this.#emit('movq %rbp, %rsp');
    this.#emit('popq %rbp', 'ret');
    this.out = forwardStores(this.out);
    if (this.platform === 'linux') this.out.push(`\t.size ${sym}, .-${sym}`);
    this.#coldPaths(framed);
    return this.out.join('\n');
  }
}

const STORE = /^\t(mov[lq]) (%\w+), (-?\d*\(%rsp\))$/;

/**
 * Store-to-load forwarding: a reload of the stack slot the previous instruction stored a
 * register into, at the same width, reads the register instead (dropped when it is the same
 * register). Adjacent lines have no label between them, and a move changes no flags.
 */
function forwardStores(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const st = STORE.exec(out.at(-1) ?? '');
    if (st !== null) {
      const [, op, reg, mem] = st;
      const load = `\t${op} ${mem}, `;
      if (line.startsWith(load)) {
        const dst = line.slice(load.length);
        if (/^%\w+$/.test(dst)) {
          if (dst !== reg) out.push(`\t${op} ${reg}, ${dst}`);
          continue;
        }
      }
    }
    out.push(line);
  }
  return out;
}

/** The module-local label of the shared copy helper (a local label, like the io helpers). */
function copyHelper(platform: X86Platform): string {
  return `${platform === 'darwin' ? 'L' : '.L'}a0copy`;
}

/**
 * The copy helper, when `bodies` call it: copies -rax bytes (a positive multiple of 16) from
 * r10 - (-rax) to r11 - (-rax) in 16-byte moves, rax counting up to zero. Only rax, xmm0 and
 * the flags change; r10 and r11 are kept (they point past the copied bytes).
 */
function copyRuntime(bodies: readonly string[], platform: X86Platform): string {
  const label = copyHelper(platform);
  if (!bodies.some((b) => b.includes(label))) return '';
  return [
    '\t.p2align 4',
    `${label}:`,
    // An odd number of 16-byte blocks moves one first; then two per trip.
    '\ttestb $16, %al',
    '\tje 1f',
    '\tmovups (%r10,%rax), %xmm0',
    '\tmovups %xmm0, (%r11,%rax)',
    '\taddq $16, %rax',
    '\tje 2f',
    '1:\tmovups (%r10,%rax), %xmm0',
    '\tmovups %xmm0, (%r11,%rax)',
    '\tmovups 16(%r10,%rax), %xmm0',
    '\tmovups %xmm0, 16(%r11,%rax)',
    '\taddq $32, %rax',
    '\tjne 1b',
    '2:\tret',
  ].join('\n');
}

type IoHelper = 'read' | 'sread' | 'write' | 'puts';
const IO_HELPERS: readonly IoHelper[] = ['read', 'sread', 'write', 'puts'];

/** The module-local label of an io helper (a local label: no A0 function can take its name). */
function ioHelper(platform: X86Platform, which: IoHelper): string {
  return `${platform === 'darwin' ? 'L' : '.L'}a0io_${which}`;
}

/**
 * The io helpers `bodies` call, for io structs of `io.input` input and `io.output` output words (the
 * C runtime's semantics, src/backends.ts `cIoRuntime`). Calling convention: token address in
 * r11 (preserved), value or length in eax (read returns the word in eax), element address in
 * r10 (puts); only rax, r10 and the flags change. `sread` (strict) traps `input` instead of
 * reading 0 past the input.
 */
function ioRuntime(
  bodies: readonly string[],
  platform: X86Platform,
  io: { readonly input: number; readonly output: number } | undefined,
): string {
  const text = bodies.join('\n');
  const used = new Set(IO_HELPERS.filter((h) => text.includes(ioHelper(platform, h))));
  if (used.size === 0) return '';
  if (io === undefined) refuse('a module that uses io needs its io capacities');
  const inCap = io.input;
  const outCap = io.output;
  if (used.has('puts')) used.add('write');
  const nin = 4 * inCap;
  const pos = nin + 4;
  const out = pos + 4;
  const nout = out + 4 * outCap;
  const trap = platform === 'darwin' ? '_a0_trap' : 'a0_trap';
  const lines: string[] = [];
  for (const h of ['read', 'sread'] as const) {
    if (!used.has(h)) continue;
    lines.push(
      '\t.p2align 4',
      `${ioHelper(platform, h)}:`,
      `\tmovl ${pos}(%r11), %eax`,
      `\tcmpl ${nin}(%r11), %eax`,
      '\tjae 1f',
      `\tcmpl $${inCap}, %eax`,
      '\tjae 1f',
      '\tleal 1(%rax), %r10d',
      `\tmovl %r10d, ${pos}(%r11)`,
      '\tmovl (%r11,%rax,4), %eax',
      '\tret',
      ...(h === 'read'
        ? ['1:\txorl %eax, %eax', '\tret']
        : [`1:\tmovl $${trapIndex('input')}, %eax`, `\tjmp ${trap}`]),
    );
  }
  if (used.has('write'))
    lines.push(
      '\t.p2align 4',
      `${ioHelper(platform, 'write')}:`,
      `\tmovl ${nout}(%r11), %r10d`,
      `\tcmpl $${outCap}, %r10d`,
      '\tjae 1f',
      `\tmovl %eax, ${out}(%r11,%r10,4)`,
      '\tincl %r10d',
      `\tmovl %r10d, ${nout}(%r11)`,
      '1:\tret',
    );
  if (used.has('puts'))
    lines.push(
      '\t.p2align 4',
      `${ioHelper(platform, 'puts')}:`,
      '\tpushq %rcx',
      '\tpushq %rdx',
      '\tmovq %r10, %rdx',
      '\tmovl %eax, %ecx',
      `\tcall ${ioHelper(platform, 'write')}`,
      '\ttestl %ecx, %ecx',
      '\tje 2f',
      '1:\tmovl (%rdx), %eax',
      `\tcall ${ioHelper(platform, 'write')}`,
      '\taddq $4, %rdx',
      '\tdecl %ecx',
      '\tjne 1b',
      '2:\tpopq %rdx',
      '\tpopq %rcx',
      '\tret',
    );
  return lines.join('\n');
}

/** Emit one function as x86-64 assembly (a `.globl a0_<name>` block, `_a0_` on macOS). */
export function emitX86_64Function(
  fn: TypedFunc,
  platform: X86Platform = HOST_X86_PLATFORM,
): string {
  return emitFused(fn, (f) => new FunctionEmitter(f, platform).emit());
}

/** Assemble function blocks into one .s module for `clang -x assembler` / `as`. */
export function assembleX86_64(
  bodies: readonly string[],
  compilerVersion: string,
  platform: X86Platform = HOST_X86_PLATFORM,
  trap?: TrapModule,
  /** io struct capacities in words (src/backends.ts C_IO_INPUT_CAPACITY / C_IO_OUTPUT_CAPACITY). */
  io?: { readonly input: number; readonly output: number },
): string {
  const head =
    platform === 'darwin' ? '\t.section __TEXT,__text,regular,pure_instructions' : '\t.text';
  const tail =
    platform === 'darwin' ? '.subsections_via_symbols' : '\t.section .note.GNU-stack,"",@progbits';
  const runtime = trap === undefined ? '' : `${x86TrapRuntime(trap, platform)}\n\n`;
  const helpers = [copyRuntime(bodies, platform), ioRuntime(bodies, platform, io)]
    .filter((t) => t !== '')
    .map((t) => `${t}\n\n`)
    .join('');
  return `# Generated by A0 ${compilerVersion}. x86-64 (${platform}) assembly, System V AMD64 ABI, AT&T syntax; exact u32/bool semantics.\n${head}\n\n${bodies.join('\n\n')}\n\n${helpers}${runtime}${tail}\n`;
}
