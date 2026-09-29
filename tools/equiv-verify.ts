/**
 * Translation validation for the optimizer: for every corpus function inside the stated
 * scope, prove with Z3 (32-bit bitvectors) that the optimized function equals the source
 * function on all inputs, or produce a counterexample. This replaces sampling with proof
 * where the scope allows; outside the scope the differential corpus remains the evidence.
 *
 * Scope (stated as Alive2 states its own): intra-procedural, values without io.
 *  - params, result, and every node typed u32, bool, or arrays/records of those
 *    (aggregates are encoded element-wise; array indexing is `index mod N` as in the
 *    language, so every access is total);
 *  - ops mov add sub mul and or xor shl shr div rem eq lt select arr rec get set at put;
 *  - call: the callee is inlined (it must itself be in scope);
 *  - fold and loop with a literal trip count of at most UNROLL_CAP: unrolled (a loop's
 *    predicate gates each unrolled step, so early exit is exact);
 *  - excluded: io, variable-count fold/loop, effectful nodes (read/write/puts).
 * Division by zero follows the language: div yields all ones, rem yields the dividend.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { init } from 'z3-solver';
import type { Operand, Type, TypedFunc, TypedProgram } from '../src/core.js';
import { optimize } from '../src/optimize.js';
import { CORPUS_SEED, corpusSha256, generateCorpus } from './corpus.js';

const UNROLL_CAP = 64;
const TIMEOUT_MS = 20_000;
const SCALAR_OPS = new Set([
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
  'lt',
  'select',
  'arr',
  'rec',
  'get',
  'set',
  'at',
  'put',
  'call',
  'fold',
  'loop',
]);

/** A type is in scope when it carries no io token. */
function inScopeType(t: Type | undefined): boolean {
  if (t === undefined || t === 'io') return false;
  if (t === 'u32' || t === 'bool') return true;
  if (t.kind === 'arr') return inScopeType(t.elem);
  return t.fields.every(inScopeType);
}

/** Why a function is outside the proof scope, or undefined when it is inside. */
function outOfScope(
  fn: TypedFunc,
  program: TypedProgram,
  seen = new Set<string>(),
): string | undefined {
  if (seen.has(fn.name)) return 'recursive call graph';
  seen.add(fn.name);
  if (!fn.params.every(inScopeType) || !inScopeType(fn.result)) return 'io in signature';
  for (const node of fn.nodes) {
    if (!SCALAR_OPS.has(node.op)) return `op ${node.op}`;
    if (!inScopeType(fn.types.get(node.id))) return `io-typed node ${node.id}`;
    if (node.op === 'call' || node.op === 'fold' || node.op === 'loop') {
      const callee = program.byName.get(node.callee ?? '');
      if (callee === undefined) return 'unresolved callee';
      if (node.op !== 'call') {
        const count = node.args[0];
        if (count === undefined || count.kind !== 'u32') return `variable-count ${node.op}`;
        if (count.value > UNROLL_CAP) return `${node.op} count ${count.value} exceeds unroll cap`;
      }
      const inner = outOfScope(callee, program, new Set(seen));
      if (inner !== undefined) return `callee ${callee.name}: ${inner}`;
      if (node.op === 'loop') {
        const pred = program.byName.get(node.pred ?? '');
        if (pred === undefined) return 'unresolved predicate';
        const innerP = outOfScope(pred, program, new Set(seen));
        if (innerP !== undefined) return `predicate ${pred.name}: ${innerP}`;
      }
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  const { Context } = await init();
  const Z = Context('a0');
  type BV = ReturnType<typeof Z.BitVec.const<32>>;
  type Bool = ReturnType<typeof Z.Bool.const>;
  type Sym = BV | Bool;
  /** Symbolic value: a scalar, or an aggregate as a list of symbolic values. */
  type SVal = Sym | SVal[];
  const bv = (n: number): BV => Z.BitVec.val(n, 32);
  const isBV = (v: Sym): v is BV => 'add' in v;
  const scalar = (v: SVal): Sym => v as Sym;
  const agg = (v: SVal): SVal[] => v as SVal[];

  /** Fresh symbols for a parameter of type `t`, named by path. */
  const fresh = (t: Type, name: string): SVal => {
    if (t === 'u32') return Z.BitVec.const(name, 32);
    if (t === 'bool') return Z.Bool.const(name);
    if (t === 'io') throw new Error('io is outside the proof scope');
    if (t.kind === 'arr')
      return Array.from({ length: t.length }, (_, i) => fresh(t.elem, `${name}_${i}`));
    return t.fields.map((f, i) => fresh(f, `${name}_${i}`));
  };
  const ite = (c: Bool, a: SVal, b: SVal): SVal => {
    if (Array.isArray(a)) return a.map((x, i) => ite(c, x, agg(b)[i] as SVal));
    const s = scalar(a);
    return isBV(s) ? Z.If(c, s, scalar(b) as BV) : Z.If(c, s, scalar(b) as Bool);
  };
  const same = (a: SVal, b: SVal): Bool => {
    if (Array.isArray(a))
      return a.map((x, i) => same(x, agg(b)[i] as SVal)).reduce((p, q) => p.and(q));
    const s = scalar(a);
    return isBV(s) ? s.eq(scalar(b) as BV) : s.eq(scalar(b) as Bool);
  };

  /** Symbolic evaluation of `fn` applied to symbolic arguments; calls and folds inline. */
  function evalFn(fn: TypedFunc, program: TypedProgram, args: readonly SVal[]): SVal {
    const env = new Map<string, SVal>();
    const operand = (o: Operand): SVal => {
      switch (o.kind) {
        case 'u32':
          return bv(o.value);
        case 'bool':
          return Z.Bool.val(o.value);
        case 'param':
          return args[o.index] as SVal;
        case 'node':
          return env.get(o.id) as SVal;
      }
    };
    const lit = (o: Operand | undefined): number => (o as { value: number }).value;
    for (const node of fn.nodes) {
      const a = node.args.map(operand);
      const x = a[0] as SVal;
      const y = a[1] as SVal;
      const X = (): BV => scalar(x) as BV;
      const Y = (): BV => scalar(y) as BV;
      let v: SVal;
      switch (node.op) {
        case 'mov':
          v = x;
          break;
        case 'add':
          v = X().add(Y());
          break;
        case 'sub':
          v = X().sub(Y());
          break;
        case 'mul':
          v = X().mul(Y());
          break;
        case 'and':
          v = X().and(Y());
          break;
        case 'or':
          v = X().or(Y());
          break;
        case 'xor':
          v = X().xor(Y());
          break;
        case 'shl':
          v = X().shl(Y().and(bv(31)));
          break;
        case 'shr':
          v = X().lshr(Y().and(bv(31)));
          break;
        case 'div':
          v = Z.If(Y().eq(bv(0)), bv(0xffff_ffff), X().udiv(Y()));
          break;
        case 'rem':
          v = Z.If(Y().eq(bv(0)), X(), X().urem(Y()));
          break;
        case 'eq':
          v = X().eq(Y());
          break;
        case 'lt':
          v = X().ult(Y());
          break;
        case 'select':
          v = ite(scalar(x) as Bool, y, a[2] as SVal);
          break;
        case 'arr':
        case 'rec':
          v = a;
          break;
        case 'get': {
          // index mod N, total: an If-chain over every position.
          const arr = agg(x);
          const idx = Y().urem(bv(arr.length));
          v = arr[arr.length - 1] as SVal;
          for (let i = arr.length - 2; i >= 0; i -= 1) v = ite(idx.eq(bv(i)), arr[i] as SVal, v);
          break;
        }
        case 'set': {
          const arr = agg(x);
          const idx = Y().urem(bv(arr.length));
          v = arr.map((e, i) => ite(idx.eq(bv(i)), a[2] as SVal, e));
          break;
        }
        case 'at':
          v = agg(x)[lit(node.args[1])] as SVal;
          break;
        case 'put': {
          const k = lit(node.args[1]);
          v = agg(x).map((e, i) => (i === k ? (a[2] as SVal) : e));
          break;
        }
        case 'call': {
          const callee = program.byName.get(node.callee ?? '') as TypedFunc;
          v = evalFn(callee, program, a);
          break;
        }
        case 'fold': {
          const callee = program.byName.get(node.callee ?? '') as TypedFunc;
          const count = lit(node.args[0]);
          let state = a[1] as SVal;
          const extra = a.slice(2);
          for (let i = 0; i < count; i += 1)
            state = evalFn(callee, program, [state, bv(i), ...extra]);
          v = state;
          break;
        }
        case 'loop': {
          // Stops before iteration i when the predicate is false; once stopped it stays stopped.
          const callee = program.byName.get(node.callee ?? '') as TypedFunc;
          const pred = program.byName.get(node.pred ?? '') as TypedFunc;
          const count = lit(node.args[0]);
          let state = a[1] as SVal;
          const extra = a.slice(2);
          let running: Bool = Z.Bool.val(true);
          for (let i = 0; i < count; i += 1) {
            const args = [state, bv(i), ...extra];
            running = running.and(scalar(evalFn(pred, program, args)) as Bool);
            state = ite(running, evalFn(callee, program, args), state);
          }
          v = state;
          break;
        }
        default:
          throw new Error(`op ${node.op} is outside the proof scope`);
      }
      env.set(node.id, v);
    }
    return operand(fn.ret);
  }

  const source = generateCorpus(CORPUS_SEED);
  const optimized = optimize(source).program;
  const results: {
    fn: string;
    status: 'proved' | 'counterexample' | 'unknown' | 'out-of-scope';
    detail: string | null;
    ms: number;
  }[] = [];
  for (const fn of source.functions) {
    const why = outOfScope(fn, source);
    if (why !== undefined) {
      results.push({ fn: fn.name, status: 'out-of-scope', detail: why, ms: 0 });
      continue;
    }
    const opt = optimized.byName.get(fn.name) as TypedFunc;
    const whyOpt = outOfScope(opt, optimized);
    if (whyOpt !== undefined) {
      results.push({ fn: fn.name, status: 'out-of-scope', detail: `optimized: ${whyOpt}`, ms: 0 });
      continue;
    }
    const start = performance.now();
    const params: SVal[] = fn.params.map((t, i) => fresh(t, `p${i}`));
    const lhs = evalFn(fn, source, params);
    const rhs = evalFn(opt, optimized, params);
    const solver = new Z.Solver();
    solver.set('timeout', TIMEOUT_MS);
    solver.add(same(lhs, rhs).not());
    const verdict = await solver.check();
    const ms = performance.now() - start;
    if (verdict === 'unsat') {
      results.push({ fn: fn.name, status: 'proved', detail: null, ms });
    } else if (verdict === 'sat') {
      const model = solver.model();
      const leaves = (v: SVal): Sym[] => (Array.isArray(v) ? v.flatMap(leaves) : [v]);
      const detail = params
        .flatMap(leaves)
        .map((p) => `${p.toString()}=${model.eval(p).toString()}`)
        .join(' ');
      results.push({ fn: fn.name, status: 'counterexample', detail, ms });
    } else {
      results.push({
        fn: fn.name,
        status: 'unknown',
        detail: `solver timeout ${TIMEOUT_MS} ms`,
        ms,
      });
    }
  }

  // Self-check: a deliberately wrong "optimization" (first add/sub/xor/and/or node of the first
  // in-scope function swapped to another op) must produce a counterexample, or the checker is
  // not looking at the right thing.
  const mutable = new Set(['add', 'sub', 'xor', 'and', 'or', 'mul']);
  let selfCheck: { fn: string; verdict: string } | null = null;
  for (const fn of source.functions) {
    if (outOfScope(fn, source) !== undefined) continue;
    const k = fn.nodes.findIndex((n) => mutable.has(n.op));
    if (k < 0) continue;
    const swapped = fn.nodes[k]?.op === 'add' ? 'sub' : 'add';
    const nodes = fn.nodes.map((n, i) => (i === k ? { ...n, op: swapped as typeof n.op } : n));
    const params: SVal[] = fn.params.map((t, i) => fresh(t, `p${i}`));
    const solver = new Z.Solver();
    solver.set('timeout', TIMEOUT_MS);
    solver.add(same(evalFn(fn, source, params), evalFn({ ...fn, nodes }, source, params)).not());
    const verdict = await solver.check();
    selfCheck = { fn: fn.name, verdict };
    break;
  }
  const selfCheckOk = selfCheck?.verdict === 'sat';

  const count = (s: string): number => results.filter((r) => r.status === s).length;
  const report = {
    generatedAt: new Date().toISOString(),
    solver: 'z3-solver (Z3 via WebAssembly), QF_BV, 32-bit',
    corpusSha256: corpusSha256(source),
    selfCheck: { ok: selfCheckOk, mutated: selfCheck },
    scope:
      'intra-procedural, io-free values (u32, bool, arrays and records of those, element-wise); ops mov add sub mul and or xor shl shr div rem eq lt select arr rec get set at put; call inlined; fold with literal count <= 64 unrolled. Excluded: io, loop, variable-count fold, read/write/puts. A proof here covers all 2^(32n) inputs of that function; functions marked out-of-scope are covered only by the sampled differential corpus (results/verification.json).',
    summary: {
      functions: results.length,
      proved: count('proved'),
      counterexample: count('counterexample'),
      unknown: count('unknown'),
      outOfScope: count('out-of-scope'),
    },
    results,
  };
  await mkdir('results', { recursive: true });
  await writeFile(
    join('results', 'equivalence.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  for (const r of results)
    process.stdout.write(
      `${r.fn.padEnd(6)} ${r.status.padEnd(15)} ${r.ms.toFixed(0).padStart(6)} ms${r.detail === null ? '' : `  ${r.detail}`}\n`,
    );
  process.stdout.write(
    `self-check (mutation yields counterexample): ${selfCheckOk ? 'ok' : 'FAILED'}\n${JSON.stringify(report.summary)}\n`,
  );
  if (report.summary.counterexample > 0 || !selfCheckOk) process.exit(1);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
