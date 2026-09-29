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
  evalOp,
  formatOperand,
  type Node,
  type Operand,
  run,
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
function simplify(node: Node, fn: TypedFunc): Operand | undefined {
  const [a, b, c] = node.args;
  if (node.args.every(isConst)) {
    const values = node.args.map(
      (arg) => (arg as Extract<Operand, { kind: 'u32' | 'bool' }>).value,
    );
    let value: Value;
    if (node.op === 'call') {
      const callee = fn.calls.get(node.callee ?? '');
      if (callee === undefined) return undefined;
      value = run(callee, values); // pure and total: folding a constant call is exact
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
      let state: Value = init;
      for (let i = 0; i < count; i += 1) {
        if (pred !== undefined && run(pred, [state, i, ...extra]) !== true) break;
        state = run(body, [state, i, ...extra]);
      }
      value = state;
    } else {
      value = evalOp(node.op, values);
    }
    return typeof value === 'boolean' ? { kind: 'bool', value } : { kind: 'u32', value };
  }
  if (a === undefined) return undefined;
  switch (node.op) {
    case 'call':
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
    case 'xor':
      if (b === undefined) return undefined;
      if (isU32(b, 0)) return a;
      if (isU32(a, 0)) return b;
      if (node.op === 'xor' && sameOperand(a, b)) return { kind: 'u32', value: 0 };
      if (node.op === 'or' && sameOperand(a, b)) return a;
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
    case 'select':
      if (b === undefined || c === undefined) return undefined;
      if (isBool(a, true)) return b;
      if (isBool(a, false)) return c;
      if (sameOperand(b, c)) return b;
      return undefined;
  }
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

export function optimizeFunction(fn: TypedFunc): { fn: TypedFunc; stats: OptimizeStats } {
  const subst = new Map<string, Operand>();
  const resolve = (o: Operand): Operand => {
    let cur = o;
    for (let guard = 0; guard < fn.nodes.length + 1; guard += 1) {
      if (cur.kind !== 'node') return cur;
      const next = subst.get(cur.id);
      if (next === undefined) return cur;
      cur = next;
    }
    return cur;
  };
  const cse = new Map<string, string>();
  const kept: Node[] = [];
  for (const node of fn.nodes) {
    const rewritten: Node = { ...node, args: node.args.map(resolve) };
    const simple = simplify(rewritten, fn);
    if (simple !== undefined) {
      subst.set(node.id, simple);
      continue;
    }
    const key = cseKey(rewritten);
    const prior = cse.get(key);
    if (prior !== undefined) {
      subst.set(node.id, { kind: 'node', id: prior });
      continue;
    }
    cse.set(key, node.id);
    kept.push(rewritten);
  }
  const ret = resolve(fn.ret);
  // Dead-code elimination: keep only nodes reachable from the result.
  const live = new Set<string>();
  const mark = (o: Operand): void => {
    if (o.kind === 'node') live.add(o.id);
  };
  mark(ret);
  for (let i = kept.length - 1; i >= 0; i -= 1) {
    const node = kept[i];
    if (node !== undefined && live.has(node.id)) node.args.forEach(mark);
  }
  const nodes = kept.filter((n) => live.has(n.id));
  const optimized = validateFunction({ ...fn, nodes, ret }, fn.calls);
  return { fn: optimized, stats: { before: fn.nodes.length, after: nodes.length } };
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
