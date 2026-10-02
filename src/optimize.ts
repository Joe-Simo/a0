/**
 * Semantics-preserving optimizations on the typed graph:
 *  - exact constant propagation (using the reference evaluator),
 *  - safe algebraic identities on u32 and bool,
 *  - common-subexpression elimination (structural),
 *  - removal of nodes unreachable from the result.
 *
 * Every rewrite is valid for all inputs under the exact v0.1 semantics (wrapping
 * arithmetic, logical shifts, pure total operations). The result is re-validated.
 * Optimizations produce a derived function; the editable source is untouched.
 *
 * Under `profile strict` the same rewrites must also preserve WHEN the program traps: every
 * rewrite keeps the value AND the trap condition. A node that can trap (a `get`/`set` whose
 * index is not provably below the length, a `div`/`rem` whose divisor is not provably nonzero, a
 * `read`, or a call/fold/loop of a callee that can) is anchored like an effect: never removed,
 * never folded into a value that hides its trap, never reordered, never inlined (the trap line
 * names the frame and the call chain, which inlining would change). Sites proved safe by a
 * small bounds analysis (`strictSite`) are ordinary pure nodes again.
 */

import {
  A0Error,
  containsIo,
  evalOp,
  formatOperand,
  isPrimitive,
  isScalar,
  LIMITS,
  type Node,
  type Operand,
  run,
  type Type,
  type TypedFunc,
  type TypedProgram,
  typeEquals,
  type Value,
  validate,
  validateFunction,
} from './core.js';

function sameOperand(a: Operand, b: Operand): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'node':
      return a.id === (b as typeof a).id;
    case 'param':
      return a.index === (b as typeof a).index;
    case 'u32':
      return a.value === (b as typeof a).value;
    case 'bool':
      return a.value === (b as typeof a).value;
  }
}

const isConst = (o: Operand): o is Extract<Operand, { kind: 'u32' | 'bool' }> =>
  o.kind === 'u32' || o.kind === 'bool';
const isU32 = (o: Operand, v: number): boolean => o.kind === 'u32' && o.value === v;
const isBool = (o: Operand, v: boolean): boolean => o.kind === 'bool' && o.value === v;

/** A value known while two operands are equal: a literal, or the operands' common value. */
type AtEq = { readonly lit: number | boolean } | { readonly common: true };

/**
 * What `o` evaluates to under the assumption that `x` and `y` are equal, when that is a literal
 * (or the shared value itself): `x - y` is 0, `x < y` is false, `x ^ y` is 0, and so on through
 * the pure scalar nodes that compute `o`. Exact for every input where `x == y`; used to drop a
 * select that only repeats what its other arm already yields when the compared values are
 * equal (`select (x == y) 0 (abs-diff x y)` is the abs-diff). Bounded depth, scalar ops only.
 */
function atEqual(
  o: Operand,
  x: Operand,
  y: Operand,
  fn: TypedFunc,
  defs: ReadonlyMap<string, Node>,
  depth = 0,
): AtEq | undefined {
  if (isConst(o)) return { lit: o.value };
  if (sameOperand(o, x) || sameOperand(o, y))
    return isConst(x) ? { lit: x.value } : isConst(y) ? { lit: y.value } : { common: true };
  const def = o.kind === 'node' ? defs.get(o.id) : undefined;
  if (def === undefined || depth >= 6 || def.callee !== undefined) return undefined;
  const t = fn.types.get(def.id);
  if (t === undefined || !isScalar(t)) return undefined;
  const vals = def.args.map((arg) => atEqual(arg, x, y, fn, defs, depth + 1));
  const [p, q, r] = vals;
  if (def.op === 'select') {
    if (p === undefined || !('lit' in p)) return undefined;
    return p.lit === true ? q : r;
  }
  if (p === undefined || q === undefined) return undefined;
  if ('lit' in p && 'lit' in q) {
    try {
      const v = evalOp(def.op, [p.lit, q.lit]);
      return typeof v === 'number' || typeof v === 'boolean' ? { lit: v } : undefined;
    } catch {
      return undefined;
    }
  }
  if ('common' in p && 'common' in q) {
    switch (def.op) {
      case 'sub':
      case 'xor':
        return { lit: 0 };
      case 'ne':
      case 'lt':
      case 'gt':
        return { lit: false };
      case 'eq':
      case 'le':
      case 'ge':
        return { lit: true };
      case 'and':
      case 'or':
        return { common: true };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Strict profile: which nodes can trap
// ---------------------------------------------------------------------------

const U32_TOP = 0xffff_ffff;

/** Largest value `o` can take in an execution that reaches it (a bound, not exact). */
function upperBound(o: Operand, defs: ReadonlyMap<string, Node>, depth = 0): number {
  if (o.kind === 'u32') return o.value;
  if (o.kind !== 'node' || depth > 8) return U32_TOP;
  const n = defs.get(o.id);
  if (n === undefined) return U32_TOP;
  const [x, y, z] = n.args;
  const ub = (q: Operand | undefined): number =>
    q === undefined ? U32_TOP : upperBound(q, defs, depth + 1);
  switch (n.op) {
    case 'mov':
      return ub(x);
    case 'and':
      return Math.min(ub(x), ub(y));
    case 'rem':
      return Math.min(ub(x), Math.max(ub(y) - 1, 0));
    case 'div':
      return y?.kind === 'u32' && y.value > 0 ? Math.floor(ub(x) / y.value) : ub(x);
    case 'shr':
      return y?.kind === 'u32' ? ub(x) >>> (y.value & 31) : ub(x);
    case 'select':
      return Math.max(ub(y), ub(z));
    case 'add': {
      const s = ub(x) + ub(y);
      return s <= U32_TOP ? s : U32_TOP;
    }
    case 'mul': {
      const p = ub(x) * ub(y);
      return p <= U32_TOP ? p : U32_TOP;
    }
    case 'or':
    case 'xor': {
      const m = Math.max(ub(x), ub(y));
      return m === 0 ? 0 : 2 ** (32 - Math.clz32(m)) - 1;
    }
    default:
      return U32_TOP;
  }
}

/** Is `o` provably nonzero in an execution that reaches it? */
function nonZero(o: Operand, defs: ReadonlyMap<string, Node>, depth = 0): boolean {
  if (o.kind === 'u32') return o.value !== 0;
  if (o.kind !== 'node' || depth > 8) return false;
  const n = defs.get(o.id);
  if (n === undefined) return false;
  const [x, y, z] = n.args;
  const nz = (q: Operand | undefined): boolean => q !== undefined && nonZero(q, defs, depth + 1);
  switch (n.op) {
    case 'mov':
      return nz(x);
    case 'or':
      return nz(x) || nz(y);
    case 'select':
      return nz(y) && nz(z);
    case 'add':
      // x + y does not wrap and one side is at least 1: the sum is at least 1.
      return (
        x !== undefined &&
        y !== undefined &&
        upperBound(x, defs, depth + 1) + upperBound(y, defs, depth + 1) <= U32_TOP &&
        (nz(x) || nz(y))
      );
    default:
      return false;
  }
}

export type StrictSite = 'bounds' | 'divzero' | 'input';

/**
 * The trap `node` can raise itself under `profile strict`, or undefined when it cannot: an index
 * proved below the array length, a divisor proved nonzero, and every op that never traps.
 * `defs` maps node ids to their nodes (the function's, or the optimizer's working set).
 */
export function strictSite(
  fn: Pick<TypedFunc, 'params' | 'types'>,
  node: Node,
  defs: ReadonlyMap<string, Node>,
): StrictSite | undefined {
  const [a, b] = node.args;
  switch (node.op) {
    case 'get':
    case 'set': {
      if (a === undefined || b === undefined) return 'bounds';
      const t =
        a.kind === 'param'
          ? fn.params[a.index]
          : a.kind === 'node'
            ? fn.types.get(a.id)
            : undefined;
      if (t === undefined || isPrimitive(t) || t.kind !== 'arr') return 'bounds';
      return upperBound(b, defs) < t.length ? undefined : 'bounds';
    }
    case 'div':
    case 'rem':
      return b !== undefined && nonZero(b, defs) ? undefined : 'divzero';
    case 'read':
      return 'input';
    default:
      return undefined;
  }
}

const nodesById = (nodes: readonly Node[]): Map<string, Node> =>
  new Map(nodes.map((n) => [n.id, n]));

const DEFS = new WeakMap<TypedFunc, ReadonlyMap<string, Node>>();

/** The nodes of `fn` by id (memoized), the `defs` the strict analyses take. */
export function nodeDefs(fn: TypedFunc): ReadonlyMap<string, Node> {
  const have = DEFS.get(fn);
  if (have !== undefined) return have;
  const d = nodesById(fn.nodes);
  DEFS.set(fn, d);
  return d;
}

/** The strict trap a node of `fn` can raise itself, or undefined (also for a canonical `fn`). */
export function siteOf(fn: TypedFunc, node: Node): StrictSite | undefined {
  return fn.profile === 'strict' ? strictSite(fn, node, nodeDefs(fn)) : undefined;
}

/** Can the call, fold or loop `node` of `fn` trap through its body or predicate? */
export function callTraps(fn: TypedFunc, node: Node): boolean {
  return (
    (node.op === 'call' || node.op === 'fold' || node.op === 'loop') &&
    mayTrapNode(fn, node, nodeDefs(fn))
  );
}

/**
 * Can `node` trap, itself or through a callee? Only a strict function has traps; a call, fold
 * or loop can trap exactly when its body or predicate can.
 */
export function mayTrapNode(
  fn: Pick<TypedFunc, 'params' | 'types' | 'calls' | 'profile'>,
  node: Node,
  defs: ReadonlyMap<string, Node>,
): boolean {
  if (fn.profile !== 'strict') return false;
  if (node.op === 'call' || node.op === 'fold' || node.op === 'loop') {
    return [node.callee, node.pred].some((c) => {
      const f = c === undefined ? undefined : fn.calls.get(c);
      return f !== undefined && mayTrapFn(f);
    });
  }
  return strictSite(fn, node, defs) !== undefined;
}

const MAY_TRAP = new WeakMap<TypedFunc, boolean>();

/** Can a call of `fn` trap? (False for every canonical function.) */
export function mayTrapFn(fn: TypedFunc): boolean {
  if (fn.profile !== 'strict') return false;
  const known = MAY_TRAP.get(fn);
  if (known !== undefined) return known;
  const defs = nodesById(fn.nodes);
  const r = fn.nodes.some((n) => mayTrapNode(fn, n, defs));
  MAY_TRAP.set(fn, r);
  return r;
}

/** Raised by the folding evaluator when strict semantics would trap: the node is left alone. */
class StrictStop extends Error {}
const stopStrict = (): never => {
  throw new StrictStop('strict trap');
};

/** Return a replacement operand if the node folds/simplifies to an existing value. */
function simplify(node: Node, fn: TypedFunc, defs: ReadonlyMap<string, Node>): Operand | undefined {
  const strict = fn.profile === 'strict';
  const [a, b, c] = node.args;
  if (node.args.every(isConst)) {
    // Aggregate results have no literal form; only scalar-valued constant nodes fold.
    const resultT = fn.types.get(node.id);
    if (resultT !== undefined && !isScalar(resultT)) return undefined;
    const values = node.args.map(
      (arg) => (arg as Extract<Operand, { kind: 'u32' | 'bool' }>).value,
    );
    let value: Value;
    if (node.op === 'call') {
      const callee = fn.calls.get(node.callee ?? '');
      if (callee === undefined) return undefined;
      if (strict) {
        // A call that traps for these arguments keeps its trap: the node stays.
        try {
          value = run(callee, values, { fuel: FOLD_EVAL_LIMIT });
        } catch (e) {
          if (e instanceof A0Error) return undefined;
          throw e;
        }
      } else value = run(callee, values, { fuel: FOLD_EVAL_LIMIT }); // pure, total, and fuel-bounded
    } else if (node.op === 'fold' || node.op === 'loop') {
      const body = fn.calls.get(node.callee ?? '');
      const pred = node.op === 'loop' ? fn.calls.get(node.pred ?? '') : undefined;
      if (node.op === 'loop' && pred === undefined) return undefined;
      const [count, init, ...extra] = values;
      // Bounded compile-time evaluation only; large trip counts stay as loops.
      if (
        body === undefined ||
        typeof count !== 'number' ||
        count > FOLD_EVAL_LIMIT ||
        init === undefined
      )
        return undefined;
      if (Array.isArray(init) || extra.some((v) => Array.isArray(v))) return undefined;
      let state: Value = init;
      const fuel = { fuel: FOLD_EVAL_LIMIT * 64 };
      try {
        for (let i = 0; i < count; i += 1) {
          if (pred !== undefined && run(pred, [state, i, ...extra], fuel) !== true) break;
          state = run(body, [state, i, ...extra], fuel);
        }
      } catch {
        return undefined; // too expensive to evaluate at compile time; keep the loop
      }
      value = state;
    } else if (strict) {
      // Under strict a zero divisor stays a trap, never the canonical value.
      try {
        value = evalOp(node.op, values, stopStrict);
      } catch (e) {
        if (e instanceof StrictStop) return undefined;
        throw e;
      }
    } else {
      value = evalOp(node.op, values);
    }
    if (typeof value === 'boolean') return { kind: 'bool', value };
    if (typeof value === 'number') return { kind: 'u32', value };
    return undefined;
  }
  if (a === undefined) return undefined;
  switch (node.op) {
    case 'call':
    case 'arr':
    case 'rec':
      return undefined;
    case 'get': {
      // get of a directly built array with a literal index is that element.
      const def = a.kind === 'node' ? defs.get(a.id) : undefined;
      // Strict: an index past the end traps instead of wrapping, so only an in-range one folds.
      if (def?.op === 'arr' && b?.kind === 'u32' && (!strict || b.value < def.args.length))
        return def.args[b.value % def.args.length];
      return undefined;
    }
    case 'at': {
      const def = a.kind === 'node' ? defs.get(a.id) : undefined;
      if (def?.op === 'rec' && b?.kind === 'u32') return def.args[b.value];
      return undefined;
    }
    case 'set':
    case 'put':
      return undefined;
    case 'fold':
    case 'loop': {
      // Zero iterations yield the initial state exactly.
      if (b !== undefined && isU32(a, 0)) return b;
      return undefined;
    }
    case 'mov':
      return a;
    case 'add':
    case 'or':
    case 'xor': {
      if (b === undefined) return undefined;
      if (fn.types.get(node.id) === 'bool') {
        // Logical identities: x or false = x, x or true = true, x xor false = x, x xor x = false.
        const isB = (o: Operand, v: boolean): boolean => o.kind === 'bool' && o.value === v;
        if (isB(b, false)) return a;
        if (isB(a, false)) return b;
        if (node.op === 'or' && (isB(a, true) || isB(b, true)))
          return { kind: 'bool', value: true };
        if (node.op === 'xor' && sameOperand(a, b)) return { kind: 'bool', value: false };
        if (node.op === 'or' && sameOperand(a, b)) return a;
        return undefined;
      }
      if (isU32(b, 0)) return a;
      if (isU32(a, 0)) return b;
      if (node.op === 'xor' && sameOperand(a, b)) return { kind: 'u32', value: 0 };
      if (node.op === 'or' && sameOperand(a, b)) return a;
      return undefined;
    }
    case 'div':
      if (b !== undefined && isU32(b, 1)) return a;
      return undefined;
    case 'rem':
      if (b !== undefined && isU32(b, 1)) return { kind: 'u32', value: 0 };
      return undefined;
    case 'puts':
      return undefined;
    case 'sub':
      if (b === undefined) return undefined;
      if (isU32(b, 0)) return a;
      if (sameOperand(a, b)) return { kind: 'u32', value: 0 };
      return undefined;
    case 'mul':
      if (b === undefined) return undefined;
      if (isU32(b, 1)) return a;
      if (isU32(a, 1)) return b;
      if (isU32(a, 0) || isU32(b, 0)) return { kind: 'u32', value: 0 };
      return undefined;
    case 'and':
      if (b === undefined) return undefined;
      if (fn.types.get(node.id) === 'bool') {
        const isB = (o: Operand, v: boolean): boolean => o.kind === 'bool' && o.value === v;
        if (isB(a, false) || isB(b, false)) return { kind: 'bool', value: false };
        if (isB(b, true)) return a;
        if (isB(a, true)) return b;
        if (sameOperand(a, b)) return a;
        return undefined;
      }
      if (isU32(a, 0) || isU32(b, 0)) return { kind: 'u32', value: 0 };
      if (isU32(b, 0xffff_ffff)) return a;
      if (isU32(a, 0xffff_ffff)) return b;
      if (sameOperand(a, b)) return a;
      return undefined;
    case 'shl':
    case 'shr':
      if (b === undefined) return undefined;
      if (b.kind === 'u32' && (b.value & 31) === 0) return a;
      if (isU32(a, 0)) return { kind: 'u32', value: 0 };
      return undefined;
    case 'eq':
      if (b !== undefined && sameOperand(a, b)) return { kind: 'bool', value: true };
      return undefined;
    case 'lt':
      if (b !== undefined && sameOperand(a, b)) return { kind: 'bool', value: false };
      if (b !== undefined && isU32(b, 0)) return { kind: 'bool', value: false };
      if (isU32(a, 0xffff_ffff)) return { kind: 'bool', value: false };
      return undefined;
    case 'gt':
      if (b !== undefined && sameOperand(a, b)) return { kind: 'bool', value: false };
      if (isU32(a, 0)) return { kind: 'bool', value: false };
      if (b !== undefined && isU32(b, 0xffff_ffff)) return { kind: 'bool', value: false };
      return undefined;
    case 'le':
      if (b !== undefined && sameOperand(a, b)) return { kind: 'bool', value: true };
      if (isU32(a, 0)) return { kind: 'bool', value: true };
      if (b !== undefined && isU32(b, 0xffff_ffff)) return { kind: 'bool', value: true };
      return undefined;
    case 'ge':
      if (b !== undefined && sameOperand(a, b)) return { kind: 'bool', value: true };
      if (b !== undefined && isU32(b, 0)) return { kind: 'bool', value: true };
      if (isU32(a, 0xffff_ffff)) return { kind: 'bool', value: true };
      return undefined;
    case 'ne':
      if (b !== undefined && sameOperand(a, b)) return { kind: 'bool', value: false };
      return undefined;
    case 'select':
      if (b === undefined || c === undefined) return undefined;
      if (isBool(a, true)) return b;
      if (isBool(a, false)) return c;
      if (sameOperand(b, c)) return b;
      {
        // select (x == y) K v is v when v is already K at x == y (and the mirrored `ne` form).
        const cond = a.kind === 'node' ? defs.get(a.id) : undefined;
        const [x, y] = cond?.args ?? [];
        if ((cond?.op === 'eq' || cond?.op === 'ne') && x !== undefined && y !== undefined) {
          const [lit, other] = cond.op === 'eq' ? [b, c] : [c, b];
          if (isConst(lit)) {
            const at = atEqual(other, x, y, fn, defs);
            if (at !== undefined && 'lit' in at && at.lit === lit.value) return other;
          }
        }
      }
      return undefined;
  }
}

/** Effectful: read/write, or any operand or the result carries an io token. */
function isEffectful(node: Node, fn: TypedFunc): boolean {
  if (node.op === 'read' || node.op === 'write' || node.op === 'puts') return true;
  // Only calls/iterations can perform effects; token extraction (`at`), `rec`, `put`, `mov`
  // are pure and may be dropped when unused (the effects already happened upstream).
  if (node.op !== 'call' && node.op !== 'fold' && node.op !== 'loop') return false;
  const t = fn.types.get(node.id);
  if (t !== undefined && containsIo(t)) return true;
  return node.args.some((a) => {
    if (a.kind === 'param') return containsIo(fn.params[a.index] ?? 'u32');
    if (a.kind === 'node') return containsIo(fn.types.get(a.id) ?? 'u32');
    return false;
  });
}

/** Unsigned division/remainder by a literal power of two becomes a shift/mask (exact). */
function strengthReduce(node: Node): Node {
  const b = node.args[1];
  if ((node.op !== 'div' && node.op !== 'rem') || b === undefined || b.kind !== 'u32') return node;
  const v = b.value;
  if (v === 0 || (v & (v - 1)) !== 0) return node;
  const k = 31 - Math.clz32(v);
  return node.op === 'div'
    ? { ...node, op: 'shr', args: [node.args[0] as Operand, { kind: 'u32', value: k }] }
    : { ...node, op: 'and', args: [node.args[0] as Operand, { kind: 'u32', value: v - 1 }] };
}

/**
 * Demand-driven order for a pure body: each node is placed just before its first consumer
 * (a post-order walk from the result, operands left to right), so a value's live range
 * starts where it is needed instead of where the source happened to write it. Functions
 * with an in-place update candidate (`set`/`put`) keep their order: moving a read of the
 * container past the update would force a copy. Pure nodes only, so any topological order
 * has the same meaning.
 */
function schedule(nodes: readonly Node[], ret: Operand): readonly Node[] {
  if (nodes.some((n) => n.op === 'set' || n.op === 'put')) return nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const placed = new Set<string>();
  const out: Node[] = [];
  // Iterative post-order (bodies can be long chains).
  const visit = (root: Operand): void => {
    if (root.kind !== 'node' || placed.has(root.id)) return;
    const stack: { n: Node; k: number }[] = [];
    const first = byId.get(root.id);
    if (first === undefined) return;
    stack.push({ n: first, k: 0 });
    placed.add(first.id);
    while (stack.length > 0) {
      const top = stack[stack.length - 1] as { n: Node; k: number };
      const arg = top.n.args[top.k];
      if (arg === undefined) {
        out.push(top.n);
        stack.pop();
        continue;
      }
      top.k += 1;
      if (arg.kind !== 'node' || placed.has(arg.id)) continue;
      const d = byId.get(arg.id);
      if (d === undefined) continue;
      placed.add(d.id);
      stack.push({ n: d, k: 0 });
    }
  };
  visit(ret);
  for (const n of nodes) visit({ kind: 'node', id: n.id });
  return out;
}

/** Maximum trip count the optimizer evaluates at compile time. */
const FOLD_EVAL_LIMIT = 4096;

function commutative(op: Node['op']): boolean {
  return op === 'add' || op === 'mul' || op === 'and' || op === 'or' || op === 'xor' || op === 'eq';
}

function cseKey(node: Node): string {
  const args = node.args.map(formatOperand);
  if (commutative(node.op)) args.sort();
  return `${node.op}${node.pred !== undefined ? ` ${node.pred}` : ''}${node.callee !== undefined ? ` ${node.callee}` : ''} ${args.join(' ')}`;
}

export interface OptimizeStats {
  readonly before: number;
  readonly after: number;
}

/**
 * Cost model of the IR transformations, the one Rust's MIR inliner uses: an instruction costs
 * 5, a call (or a loop, which is one) 25. There is no one-call bonus: every backend emits each
 * function it is given, so inlining the only call site removes no code.
 */
const INSTR_COST = 5;
const CALL_COST = 25;
const irCost = (nodes: readonly Node[]): number =>
  nodes.reduce(
    (sum, n) =>
      sum + (n.op === 'call' || n.op === 'fold' || n.op === 'loop' ? CALL_COST : INSTR_COST),
    0,
  );
/** Scalar calls of pure, scalar-only functions costing up to this are inlined in the IR. */
const INLINE_THRESHOLD = 16 * INSTR_COST;
/** Folds with a literal trip count up to this many are fully unrolled in the IR... */
const UNROLL_TRIPS = 8;
/** ...when the body costs at most UNROLL_BODY_COST and the unrolled copy at most UNROLL_COST. */
const UNROLL_BODY_COST = 256 * INSTR_COST;
const UNROLL_COST = 2048 * INSTR_COST;
const UNROLL_NODES = 2048;
/** Values of an unrolled body stay below this many words (never an arena-sized value). */
const UNROLL_STATE_WORDS = 64;

function typeWords(t: Type): number {
  if (isPrimitive(t)) return 1;
  if (t.kind === 'arr') return t.length * typeWords(t.elem);
  return t.fields.reduce((n, f) => n + typeWords(f), 0);
}

const funcHasIo = (f: TypedFunc): boolean =>
  containsIo(f.result) || f.params.some(containsIo) || [...f.types.values()].some(containsIo);

/** Working state of one function: its nodes with their types and the callees they name. */
interface Body {
  readonly nodes: readonly Node[];
  readonly ret: Operand;
  readonly types: Map<string, Type>;
  readonly calls: Map<string, TypedFunc>;
}

/** Fresh node identifiers that collide with no identifier already in use. */
class Names {
  readonly #taken: Set<string>;
  #next = 0;
  constructor(taken: Iterable<string>) {
    this.#taken = new Set(taken);
  }
  fresh(): string {
    for (;;) {
      const id = `o_${(this.#next++).toString(36)}`;
      if (!this.#taken.has(id)) {
        this.#taken.add(id);
        return id;
      }
    }
  }
}

/**
 * Copy `callee`'s nodes into `out` with fresh identifiers, its parameters bound to `args`;
 * returns the operand its result maps to. Exact: the callees inlined are pure and total.
 */
function inlineInto(
  callee: TypedFunc,
  args: readonly Operand[],
  out: Node[],
  into: { types: Map<string, Type>; calls: Map<string, TypedFunc> },
  names: Names,
): Operand {
  const map = new Map<string, Operand>();
  const sub = (o: Operand): Operand => {
    if (o.kind === 'param') return args[o.index] as Operand;
    if (o.kind === 'node') return map.get(o.id) ?? o;
    return o;
  };
  for (const n of callee.nodes) {
    const id = names.fresh();
    const { text: _text, ...rest } = n;
    out.push({ ...rest, id, args: n.args.map(sub) });
    into.types.set(id, callee.types.get(n.id) ?? 'u32');
    map.set(n.id, { kind: 'node', id });
  }
  for (const [name, f] of callee.calls) into.calls.set(name, f);
  return sub(callee.ret);
}

/**
 * A fold step that is one square-matrix product: the state is an n x n u32 array (row-major) and
 * every trip multiplies it by one loop-invariant matrix, taken from an extra parameter, on the
 * right (`S x M`) or on the left (`M x S`). Recognized from the body's dataflow alone: each
 * result element must be a sum of n products of one state element and one element of the
 * extra array, in the index pattern of the matrix product, and nothing else.
 */
interface MatrixStep {
  readonly n: number;
  readonly side: 'right' | 'left';
  /** Index of the invariant matrix among the callee's parameters. */
  readonly param: number;
}

function matrixStep(callee: TypedFunc): MatrixStep | undefined {
  const t = callee.result;
  if (isPrimitive(t) || t.kind !== 'arr' || t.elem !== 'u32') return undefined;
  const n = Math.round(Math.sqrt(t.length));
  if (n < 2 || n * n !== t.length) return undefined;
  if (!typeEquals(callee.params[0] ?? 'u32', t)) return undefined;
  const defs = new Map(callee.nodes.map((x) => [x.id, x]));
  const ret = callee.ret.kind === 'node' ? defs.get(callee.ret.id) : undefined;
  if (ret?.op !== 'arr' || ret.args.length !== t.length) return undefined;
  type Terms = Map<number, { param: number; index: number }>;
  const element = (o: Operand): { param: number; index: number } | undefined => {
    const d = o.kind === 'node' ? defs.get(o.id) : undefined;
    const [src, idx] = d?.args ?? [];
    if (d?.op !== 'get' || src?.kind !== 'param' || idx?.kind !== 'u32') return undefined;
    const arrT = callee.params[src.index];
    if (arrT === undefined || isPrimitive(arrT) || arrT.kind !== 'arr' || idx.value >= arrT.length)
      return undefined;
    return { param: src.index, index: idx.value };
  };
  const terms = (o: Operand): Terms | undefined => {
    const d = o.kind === 'node' ? defs.get(o.id) : undefined;
    if (d === undefined) return undefined;
    const [x, y] = d.args;
    if (x === undefined || y === undefined) return undefined;
    if (d.op === 'mul') {
      for (const [s, m] of [
        [x, y],
        [y, x],
      ] as const) {
        const st = element(s);
        const me = element(m);
        if (st?.param === 0 && me !== undefined && me.param >= 2) return new Map([[st.index, me]]);
      }
      return undefined;
    }
    if (d.op !== 'add') return undefined;
    const l = terms(x);
    const r = terms(y);
    if (l === undefined || r === undefined) return undefined;
    for (const [k, v] of r) {
      if (l.has(k)) return undefined;
      l.set(k, v);
    }
    return l;
  };
  const rows: Terms[] = [];
  for (const o of ret.args) {
    const f = terms(o);
    if (f === undefined || f.size !== n) return undefined;
    rows.push(f);
  }
  for (const side of ['right', 'left'] as const) {
    let param = -1;
    let ok = true;
    for (let i = 0; i < t.length && ok; i += 1) {
      const r = Math.floor(i / n);
      const c = i % n;
      for (let k = 0; k < n && ok; k += 1) {
        const have = (rows[i] as Terms).get(side === 'right' ? r * n + k : k * n + c);
        const want = side === 'right' ? k * n + c : r * n + k;
        if (have === undefined || have.index !== want || (param >= 0 && have.param !== param))
          ok = false;
        else param = have.param;
      }
    }
    if (ok) return { n, side, param };
  }
  return undefined;
}

/** Matrix products needed for the trips-th power by squaring and one product per set bit. */
const matrixPowerProducts = (trips: number): number =>
  31 - Math.clz32(trips) + (trips.toString(2).match(/1/g) ?? []).length;

/**
 * `fold` of a matrix-product step over `trips` trips is `S x M^trips` (matrix product is
 * associative and distributes over wrapping u32 add and mul, so this is exact): square M and
 * multiply by the set bits of the trip count, `log2 + popcount` products instead of `trips`.
 * Returns the result array's operand, or undefined when that would not be cheaper.
 */
function matrixPower(
  step: MatrixStep,
  trips: number,
  state: Operand,
  matrix: Operand,
  out: Node[],
  into: { types: Map<string, Type>; calls: Map<string, TypedFunc> },
  names: Names,
  arrType: Type,
): Operand | undefined {
  const { n } = step;
  const products = matrixPowerProducts(trips);
  if (products >= trips || products * 2 * n * n * n > UNROLL_NODES) return undefined;
  const emit = (op: Node['op'], args: Operand[]): Operand => {
    const id = names.fresh();
    out.push({ id, op, args });
    into.types.set(id, 'u32');
    return { kind: 'node', id };
  };
  const elements = (src: Operand): Operand[] =>
    Array.from({ length: n * n }, (_, i) => emit('get', [src, { kind: 'u32', value: i }]));
  const product = (x: readonly Operand[], y: readonly Operand[]): Operand[] => {
    const z: Operand[] = [];
    for (let r = 0; r < n; r += 1)
      for (let c = 0; c < n; c += 1) {
        let sum: Operand | undefined;
        for (let k = 0; k < n; k += 1) {
          const m = emit('mul', [x[r * n + k] as Operand, y[k * n + c] as Operand]);
          sum = sum === undefined ? m : emit('add', [sum, m]);
        }
        z.push(sum as Operand);
      }
    return z;
  };
  let acc = elements(state);
  let pow = elements(matrix);
  for (let left = trips; left > 0; left >>= 1) {
    if ((left & 1) === 1) acc = step.side === 'right' ? product(acc, pow) : product(pow, acc);
    if (left > 1) pow = product(pow, pow);
  }
  const id = names.fresh();
  out.push({ id, op: 'arr', args: acc });
  into.types.set(id, arrType);
  return { kind: 'node', id };
}

/**
 * Inline small pure scalar calls and fully unroll short literal-count folds, so literals and
 * the index of each trip reach the caller's folding (constant folding across calls; a small
 * fixed array built by such a fold then becomes an `arr` of its element values).
 */
function expand(body: Body): Body {
  const names = new Names(body.types.keys());
  const rename = new Map<string, Operand>();
  const r = (o: Operand): Operand => (o.kind === 'node' ? (rename.get(o.id) ?? o) : o);
  const out: Node[] = [];
  const types = new Map(body.types);
  const calls = new Map(body.calls);
  let changed = false;
  for (const node0 of body.nodes) {
    const node: Node = { ...node0, args: node0.args.map(r) };
    const callee = node.callee === undefined ? undefined : calls.get(node.callee);
    if (
      node.op === 'call' &&
      callee !== undefined &&
      irCost(callee.nodes) <= INLINE_THRESHOLD &&
      !mayTrapFn(callee) &&
      isScalar(callee.result) &&
      callee.params.every(isScalar) &&
      [...callee.types.values()].every(isScalar)
    ) {
      rename.set(node.id, inlineInto(callee, node.args, out, { types, calls }, names));
      changed = true;
      continue;
    }
    const [count, init, ...extra] = node.args;
    if (
      node.op === 'fold' &&
      callee !== undefined &&
      count?.kind === 'u32' &&
      init !== undefined &&
      count.value >= 3 &&
      !mayTrapFn(callee) &&
      !funcHasIo(callee) &&
      [callee.result, ...callee.types.values()].every((t) => typeWords(t) <= UNROLL_STATE_WORDS)
    ) {
      const step = matrixStep(callee);
      const m = step === undefined ? undefined : extra[step.param - 2];
      const powered =
        step === undefined || m === undefined
          ? undefined
          : matrixPower(step, count.value, init, m, out, { types, calls }, names, callee.result);
      if (powered !== undefined) {
        rename.set(node.id, powered);
        changed = true;
        continue;
      }
    }
    if (
      node.op === 'fold' &&
      callee !== undefined &&
      count?.kind === 'u32' &&
      count.value > 0 &&
      count.value <= UNROLL_TRIPS &&
      !mayTrapFn(callee) &&
      init !== undefined &&
      irCost(callee.nodes) <= UNROLL_BODY_COST &&
      irCost(callee.nodes) * count.value <= UNROLL_COST &&
      !funcHasIo(callee) &&
      [callee.result, ...callee.types.values()].every((t) => typeWords(t) <= UNROLL_STATE_WORDS)
    ) {
      let state = init;
      for (let k = 0; k < count.value; k += 1)
        state = inlineInto(
          callee,
          [state, { kind: 'u32', value: k }, ...extra],
          out,
          { types, calls },
          names,
        );
      rename.set(node.id, state);
      changed = true;
      continue;
    }
    out.push(node);
  }
  return changed ? { nodes: out, ret: r(body.ret), types, calls } : body;
}

/** Uses of each node among `nodes` and the result. */
function useCounts(nodes: readonly Node[], ret: Operand): Map<string, number> {
  const uses = new Map<string, number>();
  const add = (o: Operand): void => {
    if (o.kind === 'node') uses.set(o.id, (uses.get(o.id) ?? 0) + 1);
  };
  for (const n of nodes) n.args.forEach(add);
  add(ret);
  return uses;
}

const u32 = (v: number): Operand => ({ kind: 'u32', value: v >>> 0 });
const ASSOC: ReadonlySet<Node['op']> = new Set(['add', 'mul', 'and', 'or', 'xor']);

function combine(op: Node['op'], x: number, y: number): number {
  switch (op) {
    case 'add':
      return (x + y) >>> 0;
    case 'mul':
      return Math.imul(x, y) >>> 0;
    case 'and':
      return (x & y) >>> 0;
    case 'or':
      return (x | y) >>> 0;
    default:
      return (x ^ y) >>> 0;
  }
}

/**
 * Reassociation of u32 chains with literals (exact in wrapping arithmetic): `(x op K1) op K2`
 * is `x op (K1 op K2)` for add/mul/and/or/xor; `(x + K1) * K2` is `x*K2 + K1*K2`; `(x + K) + y`
 * and `(x + K) + (x + K)` move the literal outward to meet the next one. Rewrites whose inner
 * node has other uses are skipped (they would add work). `sub` is left as written: backends
 * match `sub p1 1` (previous element) and `sub 32 m` (rotates).
 * Returns the replacement node and the new nodes to place before it.
 */
function reassociate(
  node: Node,
  defs: ReadonlyMap<string, Node>,
  types: ReadonlyMap<string, Type>,
  uses: ReadonlyMap<string, number>,
  names: Names,
): { pre: Node[]; node: Node } | undefined {
  if (types.get(node.id) !== 'u32') return undefined;
  const [a, b] = node.args;
  if (a === undefined || b === undefined) return undefined;
  if (!ASSOC.has(node.op)) return undefined;
  const withLiteral = (o: Operand, n: number): { def: Node; x: Operand; k: number } | undefined => {
    if (o.kind !== 'node' || (uses.get(o.id) ?? 0) !== n) return undefined;
    const def = defs.get(o.id);
    if (def === undefined || types.get(def.id) !== 'u32') return undefined;
    const [x, y] = def.args;
    if (x === undefined || y === undefined) return undefined;
    if (y.kind === 'u32' && x.kind !== 'u32') return { def, x, k: y.value };
    if (x.kind === 'u32' && y.kind !== 'u32') return { def, x: y, k: x.value };
    return undefined;
  };
  const lit = b.kind === 'u32' ? b : a.kind === 'u32' ? a : undefined;
  if (lit !== undefined) {
    const d = withLiteral(lit === b ? a : b, 1);
    if (d === undefined) return undefined;
    if (d.def.op === node.op)
      return { pre: [], node: { ...node, args: [d.x, u32(combine(node.op, d.k, lit.value))] } };
    if (node.op === 'mul' && d.def.op === 'add') {
      const id = names.fresh();
      return {
        pre: [{ id, op: 'mul', args: [d.x, lit] }],
        node: { ...node, op: 'add', args: [{ kind: 'node', id }, u32(Math.imul(d.k, lit.value))] },
      };
    }
    return undefined;
  }
  if (node.op !== 'add') return undefined;
  if (a.kind === 'node' && b.kind === 'node' && a.id === b.id) {
    // (x + K) + (x + K) = (x + x) + 2K: the inner node's two uses are both here.
    const d = withLiteral(a, 2);
    if (d === undefined || d.def.op !== 'add') return undefined;
    const id = names.fresh();
    return {
      pre: [{ id, op: 'add', args: [d.x, d.x] }],
      node: { ...node, args: [{ kind: 'node', id }, u32(2 * d.k)] },
    };
  }
  for (const [p, q] of [
    [a, b],
    [b, a],
  ] as const) {
    const d = withLiteral(p, 1);
    if (d === undefined || d.def.op !== 'add') continue;
    const id = names.fresh();
    return {
      pre: [{ id, op: 'add', args: [d.x, q] }],
      node: { ...node, args: [{ kind: 'node', id }, u32(d.k)] },
    };
  }
  return undefined;
}

/** One folding / reassociation / CSE / dead-code pass over a body. */
function pass(fn: TypedFunc, body: Body): Body {
  const types = new Map(body.types);
  const view: TypedFunc = { ...fn, types, calls: body.calls };
  const names = new Names(types.keys());
  const uses = useCounts(body.nodes, body.ret);
  const subst = new Map<string, Operand>();
  const resolve = (o: Operand): Operand => {
    let cur = o;
    for (;;) {
      if (cur.kind !== 'node') return cur;
      const next = subst.get(cur.id);
      if (next === undefined) return cur;
      cur = next;
    }
  };
  const cse = new Map<string, string>();
  const kept: Node[] = [];
  const defs = new Map<string, Node>();
  const anchored = new Set<string>();
  const strict = fn.profile === 'strict';
  // Count nodes kept as values: see `keepCount`.
  const counts = new Set<string>();
  /**
   * A variable trip count that constant propagation would turn into a literal stays a value
   * (a `mov` of that literal) when the literal would put the loop over the static compute bound
   * (LIMITS.maxStaticIterations): the source program was valid because its count is bounded by
   * fuel at run time, and optimization must not make it invalid.
   */
  const keepCount = (node: Node, args: Operand[]): Operand[] => {
    const src = node.args[0];
    const lit = args[0];
    if ((node.op !== 'fold' && node.op !== 'loop') || src?.kind !== 'node' || lit?.kind !== 'u32')
      return args;
    const body = fn.calls.get(node.callee ?? '');
    if (body === undefined) return args;
    if (lit.value * optimizedCallee(body).literalIterations <= LIMITS.maxStaticIterations)
      return args;
    if (!counts.has(src.id)) {
      counts.add(src.id);
      const mov: Node = { id: src.id, op: 'mov', args: [lit] };
      kept.push(mov);
      defs.set(src.id, mov);
    }
    return [src, ...args.slice(1)];
  };
  const work = [...body.nodes].reverse();
  while (work.length > 0) {
    const node = work.pop() as Node;
    const rewritten: Node = { ...node, args: keepCount(node, node.args.map(resolve)) };
    // Effectful nodes are anchored: never folded, merged, or removed; their order is
    // fixed by token data dependencies (each token is consumed once).
    if (isEffectful(node, view)) {
      kept.push(rewritten);
      defs.set(node.id, rewritten);
      anchored.add(node.id);
      continue;
    }
    const simple = simplify(rewritten, view, defs);
    if (simple !== undefined) {
      subst.set(node.id, simple);
      continue;
    }
    const re = reassociate(rewritten, defs, types, uses, names);
    if (re !== undefined) {
      for (const p of re.pre) {
        types.set(p.id, 'u32');
        uses.set(p.id, 1);
      }
      work.push(re.node, ...[...re.pre].reverse());
      continue;
    }
    const reduced = strengthReduce(rewritten);
    // Aggregate literals are fresh allocations: merging two of them would make one value
    // shared, and every backend then copies it on update instead of writing in place.
    // Keeping them separate costs nothing (the literal is built once either way).
    if (reduced.op !== 'arr' && reduced.op !== 'rec') {
      const key = cseKey(reduced);
      const prior = cse.get(key);
      if (prior !== undefined) {
        subst.set(node.id, { kind: 'node', id: prior });
        continue;
      }
      cse.set(key, node.id);
    }
    kept.push(reduced);
    defs.set(node.id, reduced);
    // Strict: a node that can still trap is anchored like an effect (kept, in order).
    if (strict && mayTrapNode(view, reduced, defs)) anchored.add(node.id);
  }
  const ret = resolve(body.ret);
  // Dead-code elimination: keep only nodes reachable from the result.
  const live = new Set<string>();
  const mark = (o: Operand): void => {
    if (o.kind === 'node') live.add(o.id);
  };
  mark(ret);
  for (const id of anchored) live.add(id);
  for (let i = kept.length - 1; i >= 0; i -= 1) {
    const node = kept[i];
    if (node !== undefined && live.has(node.id)) node.args.forEach(mark);
  }
  return { nodes: kept.filter((n) => live.has(n.id)), ret, types, calls: body.calls };
}

/**
 * Scalar replacement of small aggregates: a `set`/`put` with a literal index on an `arr`/`rec`
 * literal that nothing else uses is that literal with one operand replaced (exact under value
 * semantics), so element reads with literal indices then fold to the stored values.
 */
function forwardAggregates(body: Body, strict: boolean): Body | undefined {
  const uses = useCounts(body.nodes, body.ret);
  const defs = new Map<string, Node>();
  let changed = false;
  const nodes = body.nodes.map((n) => {
    defs.set(n.id, n);
    const [target, index, value] = n.args;
    if ((n.op !== 'set' && n.op !== 'put') || target?.kind !== 'node' || index?.kind !== 'u32')
      return n;
    const def = defs.get(target.id);
    if (def === undefined || (uses.get(target.id) ?? 0) !== 1 || value === undefined) return n;
    if (!(n.op === 'set' ? def.op === 'arr' : def.op === 'rec')) return n;
    // Strict: a `set` index past the end traps instead of wrapping, so it is not a store.
    if (strict && n.op === 'set' && index.value >= def.args.length) return n;
    const k = n.op === 'set' ? index.value % def.args.length : index.value;
    const out: Node = { id: n.id, op: def.op, args: def.args.map((a, i) => (i === k ? value : a)) };
    defs.set(n.id, out);
    changed = true;
    return out;
  });
  return changed ? { ...body, nodes } : undefined;
}

export function optimizeFunction(fn: TypedFunc): { fn: TypedFunc; stats: OptimizeStats } {
  // Whole program: callees are optimized first, so IR inlining and the backends that inline
  // (arm64, x86-64, wasm) see the optimized bodies, not the source ones.
  const calls = new Map([...fn.calls].map(([name, callee]) => [name, optimizedCallee(callee)]));
  let body = pass(fn, expand({ nodes: fn.nodes, ret: fn.ret, types: new Map(fn.types), calls }));
  for (let round = 0; round < 8; round += 1) {
    const next = forwardAggregates(body, fn.profile === 'strict');
    if (next === undefined) break;
    body = pass(fn, next);
  }
  const view: TypedFunc = { ...fn, types: body.types, calls: body.calls };
  const defs = nodesById(body.nodes);
  // Effects and strict traps fix the order of nodes: only a function with neither is scheduled.
  const anchored = body.nodes.some((n) => isEffectful(n, view) || mayTrapNode(view, n, defs));
  const nodes = anchored ? body.nodes : schedule(body.nodes, body.ret);
  const used = new Set(nodes.flatMap((n) => [n.callee, n.pred]));
  const scope = new Map([...body.calls].filter(([name]) => used.has(name)));
  const optimized = validateFunction(
    { name: fn.name, params: fn.params, result: fn.result, nodes, ret: body.ret },
    scope,
    undefined,
    fn.profile,
  );
  return { fn: optimized, stats: { before: fn.nodes.length, after: nodes.length } };
}

const OPTIMIZED = new WeakMap<TypedFunc, TypedFunc>();

function optimizedCallee(fn: TypedFunc): TypedFunc {
  const have = OPTIMIZED.get(fn);
  if (have !== undefined) return have;
  const done = optimizeFunction(fn).fn;
  OPTIMIZED.set(fn, done);
  return done;
}

export function optimize(program: TypedProgram): { program: TypedProgram; stats: OptimizeStats } {
  let before = 0;
  let after = 0;
  const functions = program.functions.map((fn) => {
    const r = optimizeFunction(fn);
    before += r.stats.before;
    after += r.stats.after;
    return r.fn;
  });
  return {
    program: validate({
      ...(program.profile === 'strict' ? { profile: 'strict' as const } : {}),
      functions,
    }),
    stats: { before, after },
  };
}

// ---------------------------------------------------------------------------
// Shared analyses for backends. The IR has no control flow and no vector type; these name
// the shapes a backend may lower specially, with the exact conditions that make it exact.
// ---------------------------------------------------------------------------

const arrayOf = (t: Type | undefined): { length: number; elem: Type } | undefined =>
  t !== undefined && !isPrimitive(t) && t.kind === 'arr' ? t : undefined;

/** The `set p0 p1 v` result node of a body that uses p0 only as that node's target. */
function storeOnly(body: TypedFunc): Node | undefined {
  const ret = body.ret;
  if (ret.kind !== 'node') return undefined;
  const set = body.nodes.find((n) => n.id === ret.id);
  if (set?.op !== 'set') return undefined;
  const [target, index] = set.args;
  if (target?.kind !== 'param' || target.index !== 0) return undefined;
  if (index?.kind !== 'param' || index.index !== 1) return undefined;
  for (const n of body.nodes)
    for (const [k, a] of n.args.entries())
      if (a.kind === 'param' && a.index === 0 && !(n === set && k === 0)) return undefined;
  return set;
}

/**
 * Does the fold `node` overwrite every element of its array state before anything reads it?
 * True when its trip count is a literal at least the array length and its body is `set p0 p1 v`
 * with p0 otherwise read only by guarded previous-element reads (no trip observes an element it
 * did not write; trips 0..length-1 write every index).
 * The initial value is then dead: its zero fill (or copy into the state) can be skipped.
 */
export function overwritesState(fn: TypedFunc, node: Node): boolean {
  if (node.op !== 'fold') return false;
  const arr = arrayOf(fn.types.get(node.id));
  const count = node.args[0];
  const body = fn.calls.get(node.callee ?? '');
  if (arr === undefined || count?.kind !== 'u32' || count.value < arr.length || body === undefined)
    return false;
  // Guarded previous-element reads observe only elements this fold wrote (guardedPrevReads).
  return producerShape(body) !== undefined;
}

/** Element-wise u32 operations whose lanes are independent (shift amounts stay uniform). */
export const LANE_OPS: ReadonlySet<Node['op']> = new Set([
  'add',
  'sub',
  'mul',
  'and',
  'or',
  'xor',
  'shl',
  'shr',
]);

/**
 * A fill run: a fold whose trips i = 0 .. count-1 store f(i, extras) at index i of a u32 array,
 * f built only from LANE_OPS over the index, loop-invariant scalar extras and literals, and
 * count a literal no larger than the array (no index wraps). Trips are independent, so a
 * backend may compute and store several consecutive elements at once (wasm simd128 i32x4,
 * NEON .4s, SSE2 epi32) and finish the remainder one element at a time. `nodes` are the body
 * nodes computing the stored `value`, in body order.
 */
export interface FillRun {
  readonly body: TypedFunc;
  readonly nodes: readonly Node[];
  readonly value: Operand;
  readonly count: number;
}

export function fillRun(fn: TypedFunc, node: Node): FillRun | undefined {
  return fillRunIn(fn.types, fn.calls, node);
}

function fillRunIn(
  types: ReadonlyMap<string, Type>,
  calls: ReadonlyMap<string, TypedFunc>,
  node: Node,
): FillRun | undefined {
  if (node.op !== 'fold') return undefined;
  const arr = arrayOf(types.get(node.id));
  const count = node.args[0];
  const body = calls.get(node.callee ?? '');
  if (arr === undefined || arr.elem !== 'u32' || body === undefined) return undefined;
  if (count?.kind !== 'u32' || count.value === 0 || count.value > arr.length) return undefined;
  const set = storeOnly(body);
  if (set === undefined) return undefined;
  const scalarParam = (i: number): boolean => i >= 1 && body.params[i] === 'u32';
  const uniform = (o: Operand): boolean =>
    o.kind === 'u32' || (o.kind === 'param' && o.index >= 2 && scalarParam(o.index));
  const nodes = body.nodes.filter((n) => n !== set);
  for (const n of nodes) {
    if (!LANE_OPS.has(n.op) || body.types.get(n.id) !== 'u32') return undefined;
    for (const [k, a] of n.args.entries()) {
      if (a.kind === 'bool') return undefined;
      if (a.kind === 'param' && !scalarParam(a.index)) return undefined;
      if ((n.op === 'shl' || n.op === 'shr') && k === 1 && !uniform(a)) return undefined;
    }
  }
  const value = set.args[2];
  if (value === undefined || value.kind === 'bool') return undefined;
  if (value.kind === 'param' && !scalarParam(value.index)) return undefined;
  return { body, nodes, value, count: count.value };
}

/** Rough cost of evaluating a node, for deciding when a select arm is worth a branch. */
function nodeCost(op: Node['op']): number {
  if (op === 'call' || op === 'fold' || op === 'loop') return 16;
  if (op === 'div' || op === 'rem') return 8;
  if (op === 'mul') return 3;
  return 1;
}

/** A select arm whose own nodes cost at least this much (see nodeCost) gets its own path. */
export const LAZY_ARM_COST = 8;

/**
 * Lazy select arms. For each scalar `select c a b`, the pure scalar nodes needed only by arm a
 * (or only by arm b); when one arm's nodes cost at least LAZY_ARM_COST, a backend may branch
 * on c and evaluate each arm's nodes on its own path only (exact: the nodes are pure and
 * total, and nothing else reads them). `owner` maps each such node to its select; `arms` gives
 * each select's two node lists in body order. Selects are taken in body order and a node is
 * owned once, so a select inside an outer arm keeps its own arms (emitted when it is).
 */
export function lazyArms(fn: TypedFunc): {
  owner: ReadonlyMap<string, string>;
  arms: ReadonlyMap<string, readonly [readonly string[], readonly string[]]>;
} {
  const owner = new Map<string, string>();
  const arms = new Map<string, readonly [readonly string[], readonly string[]]>();
  const byId = new Map(fn.nodes.map((n) => [n.id, n]));
  const index = new Map(fn.nodes.map((n, i) => [n.id, i]));
  const users = new Map<string, string[]>();
  for (const n of fn.nodes)
    for (const a of n.args)
      if (a.kind === 'node') users.set(a.id, [...(users.get(a.id) ?? []), n.id]);
  const isRet = (id: string): boolean => fn.ret.kind === 'node' && fn.ret.id === id;
  const defs = nodeDefs(fn);
  // Under strict a node that can trap is not total: a select still evaluates both arms.
  const eligible = (n: Node): boolean =>
    isScalar(fn.types.get(n.id) ?? 'io') &&
    !isEffectful(n, fn) &&
    !mayTrapNode(fn, n, defs) &&
    !isRet(n.id) &&
    !owner.has(n.id);
  for (const s of fn.nodes) {
    if (s.op !== 'select' || !isScalar(fn.types.get(s.id) ?? 'io')) continue;
    const [c, x, y] = s.args;
    const same = (p: Operand | undefined, q: Operand | undefined): boolean =>
      p?.kind === 'node' && q?.kind === 'node' && p.id === q.id;
    const cone = (arm: Operand | undefined, other: Operand | undefined): string[] => {
      if (arm?.kind !== 'node' || same(arm, other) || same(arm, c)) return [];
      const root = byId.get(arm.id);
      if (root === undefined || !eligible(root)) return [];
      if ((users.get(root.id) ?? []).some((u) => u !== s.id)) return [];
      const set = new Set([root.id]);
      // Walk back from the root: a node joins when every one of its users is already in.
      for (let i = (index.get(root.id) ?? 0) - 1; i >= 0; i -= 1) {
        const n = fn.nodes[i] as Node;
        const us = users.get(n.id) ?? [];
        if (eligible(n) && us.length > 0 && us.every((u) => set.has(u))) set.add(n.id);
      }
      return fn.nodes.filter((n) => set.has(n.id)).map((n) => n.id);
    };
    const a = cone(x, y);
    const b = cone(y, x);
    const cost = (ids: readonly string[]): number =>
      ids.reduce((n, id) => n + nodeCost((byId.get(id) as Node).op), 0);
    if (Math.max(cost(a), cost(b)) < LAZY_ARM_COST) continue;
    for (const id of [...a, ...b]) owner.set(id, s.id);
    arms.set(s.id, [a, b]);
  }
  return { owner, arms };
}

// ---------------------------------------------------------------------------
// Producer-consumer loop fusion
// ---------------------------------------------------------------------------

const isParamOp = (o: Operand | undefined, i: number): boolean =>
  o?.kind === 'param' && o.index === i;

/** Prefix of every fused body's name: a backend that must inline it can check its output. */
export const FUSED_PREFIX = 'zfuse';

/** A fused body may recompute a producer's element at non-counter indices up to this cost. */
const FUSE_RECOMPUTE_COST = 4;
/** Fused bodies stay within every inlining backend's body limit. */
const FUSE_MAX_NODES = 48;

/**
 * Reads `get p0 (p1 - 1)` whose value is used only where p1 != 0: every user is a select on
 * `eq p1 0` holding the read in its false arm (or on `ne p1 0`, in its true arm). At trip
 * i >= 1 the read is element i-1, which trip i-1 wrote; at trip 0 its value is discarded, so
 * the state's initial contents are never observed through it. Undefined when p0 has another
 * element read that is not of this form.
 */
function guardedPrevReads(body: TypedFunc): Set<string> | undefined {
  const defs = new Map(body.nodes.map((n) => [n.id, n]));
  const users = new Map<string, { n: Node; k: number }[]>();
  for (const n of body.nodes)
    for (const [k, a] of n.args.entries())
      if (a.kind === 'node') users.set(a.id, [...(users.get(a.id) ?? []), { n, k }]);
  const zeroTest = (o: Operand | undefined, op: 'eq' | 'ne'): boolean => {
    const d = o?.kind === 'node' ? defs.get(o.id) : undefined;
    if (d?.op !== op) return false;
    const [x, y] = d.args as [Operand, Operand];
    return (isParamOp(x, 1) && isU32(y, 0)) || (isParamOp(y, 1) && isU32(x, 0));
  };
  const out = new Set<string>();
  for (const n of body.nodes) {
    if (n.op !== 'get' || !isParamOp(n.args[0], 0) || isParamOp(n.args[1], 1)) continue;
    const j = n.args[1];
    const d = j?.kind === 'node' ? defs.get(j.id) : undefined;
    const [x, y] = (d?.args ?? []) as Operand[];
    const prev =
      (d?.op === 'sub' && isParamOp(x, 1) && y !== undefined && isU32(y, 1)) ||
      (d?.op === 'add' &&
        ((isParamOp(x, 1) && y !== undefined && isU32(y, 0xffff_ffff)) ||
          (isParamOp(y, 1) && x !== undefined && isU32(x, 0xffff_ffff))));
    if (!prev || (body.ret.kind === 'node' && body.ret.id === n.id)) return undefined;
    const ok = (users.get(n.id) ?? []).every(
      ({ n: u, k }) =>
        u.op === 'select' &&
        ((k === 2 && zeroTest(u.args[0], 'eq')) || (k === 1 && zeroTest(u.args[0], 'ne'))),
    );
    if (!ok) return undefined;
    out.add(n.id);
  }
  return out;
}

/**
 * An array-producing fold body: `ret` is `set p0 p1 v`, and p0 is otherwise read only by
 * guarded previous-element reads (see guardedPrevReads). `pure` when there are none: element
 * i is then a function of i and the extras alone.
 */
function producerShape(
  body: TypedFunc,
): { set: Node; prev: ReadonlySet<string>; pure: boolean } | undefined {
  const ret = body.ret;
  const set = ret.kind === 'node' ? body.nodes.find((n) => n.id === ret.id) : undefined;
  if (set?.op !== 'set' || !isParamOp(set.args[0], 0) || !isParamOp(set.args[1], 1))
    return undefined;
  const prev = guardedPrevReads(body);
  if (prev === undefined) return undefined;
  for (const n of body.nodes)
    for (const [k, a] of n.args.entries())
      if (isParamOp(a, 0) && k === 0 ? !(n === set || prev.has(n.id)) : isParamOp(a, 0))
        return undefined;
  return { set, prev, pure: prev.size === 0 };
}

/** Builds a fused body: copies of callee nodes under fresh ids with operand substitution. */
class BodyBuilder {
  readonly nodes: Node[] = [];
  #next = 0;
  add(op: Node['op'], args: readonly Operand[]): Operand {
    const id = `f${(this.#next++).toString(36)}`;
    this.nodes.push({ id, op, args });
    return { kind: 'node', id };
  }
  /**
   * Copy `body`'s nodes except `skip`; `param` maps its parameters and `swap` may replace a
   * node by an existing operand. Returns the operand map for the copy.
   */
  copy(
    body: TypedFunc,
    param: (i: number) => Operand,
    swap: (n: Node, map: (o: Operand) => Operand) => Operand | undefined,
    skip?: Node,
  ): (o: Operand) => Operand {
    const ids = new Map<string, Operand>();
    const map = (o: Operand): Operand => {
      if (o.kind === 'param') return param(o.index);
      if (o.kind === 'node') {
        const m = ids.get(o.id);
        if (m === undefined) throw new Error(`internal: fused body lost node ${o.id}`);
        return m;
      }
      return o;
    };
    for (const n of body.nodes) {
      if (n === skip) continue;
      const replaced = swap(n, map);
      if (replaced !== undefined) {
        ids.set(n.id, replaced);
        continue;
      }
      const id = `f${(this.#next++).toString(36)}`;
      const { callee, pred } = n;
      this.nodes.push({
        id,
        op: n.op,
        args: n.args.map(map),
        ...(callee === undefined ? {} : { callee }),
        ...(pred === undefined ? {} : { pred }),
      });
      ids.set(n.id, { kind: 'node', id });
    }
    return map;
  }
}

const bodyCost = (nodes: readonly Node[]): number => nodes.reduce((s, n) => s + nodeCost(n.op), 0);

/**
 * Producer-consumer loop fusion. `A = fold f1 N1 z e1...` builds a u32 array of length L
 * with f1 of producerShape (trip i writes element i and nothing else) and N1 <= L, and A's
 * only use is operand k of `C = fold f2 N2 s e2...`. Then A is never materialized:
 *  - k >= 2, f1 pure: each `get pk x` in f2 becomes f1's element expression at x (at p1 when
 *    x is the counter and N2 <= N1; at x mod L when N1 = L and the recomputation is cheap);
 *  - k = 1 (A is C's initial state), f1 pure, N1 = N2 = L, f2 writes element i at trip i and
 *    reads its state only at p1 (still A[i] = f1(i): no earlier trip wrote index i) or through
 *    guarded previous-element reads (its own writes): `get p0 p1` becomes f1(p1), and C starts
 *    from f1's initial state, which it now overwrites before any read observes it;
 *  - k >= 2, f1 a recurrence (guarded previous reads), f2 with scalar state reading A only at
 *    p1, N2 <= N1: one fold carries (C's state, f1's previous element) as a record.
 * Exact under value semantics: A is immutable, unshared and has no identity, so nothing can
 * observe that it was not stored. Fused bodies are named FUSED_PREFIX... and are not program
 * functions: a backend applying this must inline them (and fall back when it does not).
 */
export function fuseLoops(fn: TypedFunc, options: FuseOptions = {}): TypedFunc | undefined {
  // Strict: fusion re-indexes reads modulo the length and drops the producer's own traps.
  if (funcHasIo(fn) || fn.profile === 'strict') return undefined;
  let cur = fn;
  let changed = false;
  for (let round = 0; round < 8; round += 1) {
    const next = fuseOnce(cur, options);
    if (next === undefined) break;
    cur = next;
    changed = true;
  }
  return changed ? cur : undefined;
}

/**
 * Emit `fn` with its loops fused (see fuseLoops) when the emitter inlined every fused body:
 * an output that still names one (an out-of-line call) is discarded for the unfused form.
 */
export function emitFused(
  fn: TypedFunc,
  emit: (f: TypedFunc) => string,
  options: FuseOptions = {},
): string {
  const fused = fuseLoops(fn, options);
  if (fused === undefined) return emit(fn);
  const out = emit(fused);
  return out.includes(FUSED_PREFIX) ? emit(fn) : out;
}

/**
 * `recordState`: also fuse a recurrence producer, which makes the fused fold's state a
 * (state, previous element) record; only worth it where small record state stays in registers
 * or locals (wasm keeps it in locals; the native backends store it every trip).
 */
export interface FuseOptions {
  readonly recordState?: boolean;
}

interface FuseSite {
  readonly fn: TypedFunc;
  readonly consumer: Node;
  readonly body2: TypedFunc;
  readonly k: number;
  readonly producer: Node;
  readonly body1: TypedFunc;
  readonly shape: { set: Node; prev: ReadonlySet<string>; pure: boolean };
  readonly length: number;
  readonly n1: number;
  readonly n2: number;
}

function fuseOnce(fn: TypedFunc, options: FuseOptions): TypedFunc | undefined {
  const uses = useCounts(fn.nodes, fn.ret);
  const defs = new Map(fn.nodes.map((n) => [n.id, n]));
  for (const consumer of fn.nodes) {
    if (consumer.op !== 'fold') continue;
    const n2 = consumer.args[0];
    const body2 = fn.calls.get(consumer.callee ?? '');
    if (n2?.kind !== 'u32' || body2 === undefined || funcHasIo(body2)) continue;
    for (let k = 1; k < consumer.args.length; k += 1) {
      const a = consumer.args[k] as Operand;
      if (a.kind !== 'node' || uses.get(a.id) !== 1) continue;
      const producer = defs.get(a.id);
      if (producer?.op !== 'fold') continue;
      const body1 = fn.calls.get(producer.callee ?? '');
      const n1 = producer.args[0];
      const arr = arrayOf(fn.types.get(producer.id));
      if (body1 === undefined || n1?.kind !== 'u32' || arr === undefined || arr.elem !== 'u32')
        continue;
      if (n1.value > arr.length || funcHasIo(body1)) continue;
      const shape = producerShape(body1);
      if (shape === undefined) continue;
      const site: FuseSite = {
        fn,
        consumer,
        body2,
        k,
        producer,
        body1,
        shape,
        length: arr.length,
        n1: n1.value,
        n2: n2.value,
      };
      const fused =
        k === 1
          ? fuseIntoState(site)
          : shape.pure
            ? fuseExtra(site)
            : options.recordState === true
              ? fuseRecurrence(site)
              : undefined;
      if (fused !== undefined) return fused;
    }
  }
  return undefined;
}

/** Validate a fused body (undefined when it exceeds FUSE_MAX_NODES). */
function finishBody(
  site: FuseSite,
  b: BodyBuilder,
  params: readonly Type[],
  result: Type,
  ret: Operand,
): TypedFunc | undefined {
  if (b.nodes.length > FUSE_MAX_NODES) return undefined;
  let i = 0;
  while (site.fn.calls.has(`${FUSED_PREFIX}${i}`)) i += 1;
  const calls = new Map([...site.body2.calls, ...site.body1.calls]);
  const body = validateFunction(
    { name: `${FUSED_PREFIX}${i}`, params, result, nodes: b.nodes, ret },
    calls,
  );
  // Clean up the copies (dead guarded-read indices, repeated subexpressions).
  return optimizeFunction(body).fn;
}

/** fn with the producer removed and the consumer replaced by `replacement`. */
function rewriteTop(site: FuseSite, replacement: readonly Node[], fused: TypedFunc): TypedFunc {
  const { fn } = site;
  const nodes: Node[] = [];
  for (const n of fn.nodes) {
    if (n === site.producer) continue;
    if (n === site.consumer) nodes.push(...replacement);
    else nodes.push(n);
  }
  // Drop what only the producer used (its initial literal, for instance).
  const live = new Set<string>();
  const mark = (o: Operand): void => {
    if (o.kind === 'node') live.add(o.id);
  };
  mark(fn.ret);
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const n = nodes[i] as Node;
    if (live.has(n.id)) n.args.forEach(mark);
  }
  const kept = nodes.filter((n) => live.has(n.id));
  const calls = new Map(fn.calls);
  calls.set(fused.name, fused);
  const used = new Set(kept.flatMap((n) => [n.callee, n.pred]));
  return validateFunction(
    { name: fn.name, params: fn.params, result: fn.result, nodes: kept, ret: fn.ret },
    new Map([...calls].filter(([name]) => used.has(name))),
  );
}

/** Is parameter k of `body` read only as the array of `get` nodes? */
function readByGetOnly(body: TypedFunc, k: number): boolean {
  if (isParamOp(body.ret, k)) return false;
  return body.nodes.every((n) =>
    n.args.every((o, j) => !isParamOp(o, k) || (n.op === 'get' && j === 0)),
  );
}

/** The producer's element at `index` (p1 itself, or any index reduced mod the length). */
function elementBuilder(
  site: FuseSite,
  b: BodyBuilder,
  extraBase: number,
): (index: Operand) => Operand {
  const { body1, shape, length } = site;
  const cache = new Map<string, Operand>();
  return (index) => {
    const key = formatOperand(index);
    const have = cache.get(key);
    if (have !== undefined) return have;
    let idx = index;
    if (!isParamOp(index, 1)) {
      if (length === 1) idx = { kind: 'u32', value: 0 };
      else if ((length & (length - 1)) === 0)
        idx = b.add('and', [index, { kind: 'u32', value: length - 1 }]);
      else idx = b.add('rem', [index, { kind: 'u32', value: length }]);
    }
    const map = b.copy(
      body1,
      (i) => (i === 1 ? idx : { kind: 'param', index: extraBase + i - 2 }),
      () => undefined,
      shape.set,
    );
    const v = map(shape.set.args[2] as Operand);
    cache.set(key, v);
    return v;
  };
}

function fuseExtra(site: FuseSite): TypedFunc | undefined {
  const { consumer, body2, k, producer, body1, shape, length, n1, n2 } = site;
  if (!readByGetOnly(body2, k)) return undefined;
  const gets = body2.nodes.filter((n) => n.op === 'get' && isParamOp(n.args[0], k));
  const atCounter = gets.every((g) => isParamOp(g.args[1], 1));
  if (atCounter ? n2 > n1 : n1 !== length) return undefined;
  const others = new Set(
    gets.filter((g) => !isParamOp(g.args[1], 1)).map((g) => formatOperand(g.args[1] as Operand)),
  );
  const cost = bodyCost(body1.nodes.filter((n) => n !== shape.set));
  if (others.size * cost > FUSE_RECOMPUTE_COST) return undefined;
  // Fused parameters: C's without pk, then the producer's extras.
  const b = new BodyBuilder();
  const element = elementBuilder(site, b, body2.params.length - 1);
  const map2 = b.copy(
    body2,
    (i) => ({ kind: 'param', index: i < k ? i : i - 1 }),
    (n, map) =>
      n.op === 'get' && isParamOp(n.args[0], k) ? element(map(n.args[1] as Operand)) : undefined,
  );
  const params = [...body2.params.filter((_, i) => i !== k), ...body1.params.slice(2)];
  const fused = finishBody(site, b, params, body2.result, map2(body2.ret));
  if (fused === undefined) return undefined;
  const args = [...consumer.args.filter((_, i) => i !== k), ...producer.args.slice(2)];
  return rewriteTop(site, [{ ...consumer, callee: fused.name, args }], fused);
}

function fuseIntoState(site: FuseSite): TypedFunc | undefined {
  const { consumer, body2, producer, body1, shape, length, n1, n2 } = site;
  if (!shape.pure || n1 !== length || n2 !== length) return undefined;
  if (consumer.args.slice(2).some((o) => sameOperand(o, consumer.args[1] as Operand)))
    return undefined;
  const ret = body2.ret;
  const set = ret.kind === 'node' ? body2.nodes.find((n) => n.id === ret.id) : undefined;
  if (set?.op !== 'set' || !isParamOp(set.args[0], 0) || !isParamOp(set.args[1], 1))
    return undefined;
  const prev = guardedPrevReads(body2);
  if (prev === undefined) return undefined;
  const atCounter = (n: Node): boolean =>
    n.op === 'get' && isParamOp(n.args[0], 0) && isParamOp(n.args[1], 1);
  for (const n of body2.nodes)
    for (const [j, o] of n.args.entries())
      if (isParamOp(o, 0) && !(j === 0 && (n === set || prev.has(n.id) || atCounter(n))))
        return undefined;
  if (!body2.nodes.some(atCounter)) return undefined;
  const b = new BodyBuilder();
  const element = elementBuilder(site, b, body2.params.length);
  const map2 = b.copy(
    body2,
    (i) => ({ kind: 'param', index: i }),
    (n) => (atCounter(n) ? element({ kind: 'param', index: 1 }) : undefined),
  );
  const params = [...body2.params, ...body1.params.slice(2)];
  const fused = finishBody(site, b, params, body2.result, map2(body2.ret));
  if (fused === undefined) return undefined;
  const args = [
    consumer.args[0] as Operand,
    producer.args[1] as Operand,
    ...consumer.args.slice(2),
    ...producer.args.slice(2),
  ];
  return rewriteTop(site, [{ ...consumer, callee: fused.name, args }], fused);
}

function fuseRecurrence(site: FuseSite): TypedFunc | undefined {
  const { fn, consumer, body2, k, producer, body1, shape, n1, n2 } = site;
  const s2 = body2.params[0];
  if (n2 > n1 || s2 === undefined || !isPrimitive(s2) || s2 === 'io') return undefined;
  if (!readByGetOnly(body2, k)) return undefined;
  const gets = body2.nodes.filter((n) => n.op === 'get' && isParamOp(n.args[0], k));
  if (!gets.every((g) => isParamOp(g.args[1], 1))) return undefined;
  const b = new BodyBuilder();
  const state = b.add('at', [
    { kind: 'param', index: 0 },
    { kind: 'u32', value: 0 },
  ]);
  const carried = b.add('at', [
    { kind: 'param', index: 0 },
    { kind: 'u32', value: 1 },
  ]);
  const extraBase = body2.params.length - 1;
  const map1 = b.copy(
    body1,
    (i) => (i === 1 ? { kind: 'param', index: 1 } : { kind: 'param', index: extraBase + i - 2 }),
    (n) => (shape.prev.has(n.id) ? carried : undefined),
    shape.set,
  );
  const element = map1(shape.set.args[2] as Operand);
  const map2 = b.copy(
    body2,
    (i) => (i === 0 ? state : { kind: 'param', index: i < k ? i : i - 1 }),
    (n) => (n.op === 'get' && isParamOp(n.args[0], k) ? element : undefined),
  );
  const pair = b.add('rec', [map2(body2.ret), element]);
  const recT: Type = { kind: 'rec', fields: [s2, 'u32'] };
  const params = [
    recT,
    ...body2.params.slice(1).filter((_, i) => i + 1 !== k),
    ...body1.params.slice(2),
  ];
  const fused = finishBody(site, b, params, recT, pair);
  if (fused === undefined) return undefined;
  const taken = new Set(fn.nodes.map((n) => n.id));
  const freshTop = (base: string): string => {
    let i = 0;
    while (taken.has(`${base}${i}`)) i += 1;
    taken.add(`${base}${i}`);
    return `${base}${i}`;
  };
  const initId = freshTop('zfi');
  const foldId = freshTop('zff');
  const args: Operand[] = [
    consumer.args[0] as Operand,
    { kind: 'node', id: initId },
    ...consumer.args.slice(2).filter((_, i) => i + 2 !== k),
    ...producer.args.slice(2),
  ];
  return rewriteTop(
    site,
    [
      { id: initId, op: 'rec', args: [consumer.args[1] as Operand, { kind: 'u32', value: 0 }] },
      { id: foldId, op: 'fold', callee: fused.name, args },
      {
        id: consumer.id,
        op: 'at',
        args: [
          { kind: 'node', id: foldId },
          { kind: 'u32', value: 0 },
        ],
      },
    ],
    fused,
  );
}
