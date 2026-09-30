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
 */

import {
  containsIo,
  evalOp,
  formatOperand,
  isPrimitive,
  isScalar,
  type Node,
  type Operand,
  run,
  type Type,
  type TypedFunc,
  type TypedProgram,
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

/** Return a replacement operand if the node folds/simplifies to an existing value. */
function simplify(node: Node, fn: TypedFunc, defs: ReadonlyMap<string, Node>): Operand | undefined {
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
      value = run(callee, values, { fuel: FOLD_EVAL_LIMIT }); // pure, total, and fuel-bounded
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
      if (def?.op === 'arr' && b?.kind === 'u32') return def.args[b.value % def.args.length];
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

/** Scalar calls of pure, scalar-only functions up to this many nodes are inlined in the IR. */
const INLINE_CALL_NODES = 16;
/** Folds with a literal trip count up to this many are fully unrolled in the IR... */
const UNROLL_TRIPS = 8;
/** ...when the body has at most this many nodes and the unrolled copy at most UNROLL_NODES. */
const UNROLL_BODY_NODES = 256;
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
      callee.nodes.length <= INLINE_CALL_NODES &&
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
      count.value > 0 &&
      count.value <= UNROLL_TRIPS &&
      init !== undefined &&
      callee.nodes.length <= UNROLL_BODY_NODES &&
      callee.nodes.length * count.value <= UNROLL_NODES &&
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
  const work = [...body.nodes].reverse();
  while (work.length > 0) {
    const node = work.pop() as Node;
    const rewritten: Node = { ...node, args: node.args.map(resolve) };
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
function forwardAggregates(body: Body): Body | undefined {
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
    const next = forwardAggregates(body);
    if (next === undefined) break;
    body = pass(fn, next);
  }
  const view: TypedFunc = { ...fn, types: body.types, calls: body.calls };
  const anchored = body.nodes.some((n) => isEffectful(n, view));
  const nodes = anchored ? body.nodes : schedule(body.nodes, body.ret);
  const used = new Set(nodes.flatMap((n) => [n.callee, n.pred]));
  const scope = new Map([...body.calls].filter(([name]) => used.has(name)));
  const optimized = validateFunction(
    { name: fn.name, params: fn.params, result: fn.result, nodes, ret: body.ret },
    scope,
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
  return { program: validate({ functions }), stats: { before, after } };
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
 * with p0 used nowhere else (no trip reads the state; trips 0..length-1 write every index).
 * The initial value is then dead: its zero fill (or copy into the state) can be skipped.
 */
export function overwritesState(fn: TypedFunc, node: Node): boolean {
  if (node.op !== 'fold') return false;
  const arr = arrayOf(fn.types.get(node.id));
  const count = node.args[0];
  const body = fn.calls.get(node.callee ?? '');
  if (arr === undefined || count?.kind !== 'u32' || count.value < arr.length || body === undefined)
    return false;
  return storeOnly(body) !== undefined;
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
  if (node.op !== 'fold') return undefined;
  const arr = arrayOf(fn.types.get(node.id));
  const count = node.args[0];
  const body = fn.calls.get(node.callee ?? '');
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
  const eligible = (n: Node): boolean =>
    isScalar(fn.types.get(n.id) ?? 'io') && !isEffectful(n, fn) && !isRet(n.id) && !owner.has(n.id);
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
