/**
 * Translation validation for the optimizer: for every corpus function inside the stated
 * scope, prove with Z3 (32-bit bitvectors) that the optimized function equals the source
 * function on all inputs, or produce a counterexample. This replaces sampling with proof
 * where the scope allows; outside the scope the differential corpus remains the evidence.
 *
 * Scope (stated as Alive2 states its own): intra-procedural, values plus a bounded io model.
 *  - params, result, and every node typed u32, bool, io, or arrays/records of those
 *    (aggregates are encoded element-wise; array indexing is `index mod N` as in the
 *    language, so every access is total);
 *  - ops mov add sub mul and or xor shl shr div rem eq lt select arr rec get set at put
 *    read write puts;
 *  - call: the callee is inlined (it must itself be in scope);
 *  - fold and loop with a literal trip count of at most UNROLL_CAP: unrolled (a loop's
 *    predicate gates each unrolled step, so early exit is exact; effects inside a stopped
 *    iteration are guarded off, as the interpreter never runs them);
 *  - excluded: variable-count fold/loop.
 * Division by zero follows the language: div yields all ones, rem yields the dividend.
 *
 * Bounded io model (mirrors the reference interpreter's shared IoState): the input is a
 * symbolic sequence of IO_WORDS 32-bit words; `read` yields input[pos] (0 once pos reaches
 * IO_WORDS, the language's exhausted-input rule) and advances pos while pos < IO_WORDS;
 * `write v` appends v to the output; `puts a` appends a's length then every element. The
 * output is a fixed-capacity buffer (one slot per static emit site) with a symbolic length,
 * so guarded emits inside loops stay exact. The token value itself carries no data: as in
 * the interpreter, every token of one evaluation denotes the same stream, and effects happen
 * in node order. Two sides are equivalent when result values agree AND the output lengths,
 * every output word below that length, and the final read position agree. A proof covers
 * every input prefix of at most IO_WORDS words; longer inputs are outside the bound.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { init } from 'z3-solver';
import type { Operand, Type, TypedFunc, TypedProgram } from '../src/core.js';
import { optimize } from '../src/optimize.js';
import { CORPUS_SEED, corpusSha256, generateCorpus } from './corpus.js';

const UNROLL_CAP = 64;
/** Bound on the modelled input stream (words). */
const IO_WORDS = 8;
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
  'le',
  'gt',
  'ge',
  'ne',
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
  'read',
  'write',
  'puts',
]);

/** Why a function is outside the proof scope, or undefined when it is inside. */
function outOfScope(
  fn: TypedFunc,
  program: TypedProgram,
  seen = new Set<string>(),
): string | undefined {
  if (seen.has(fn.name)) return 'recursive call graph';
  seen.add(fn.name);
  for (const node of fn.nodes) {
    if (!SCALAR_OPS.has(node.op)) return `op ${node.op}`;
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
  const { Context, em } = await init();
  const Z = Context('a0');
  /**
   * Synchronous check through the wasm export. The high-level `solver.check()` runs Z3 on a
   * worker pthread while this thread stays idle, and the binding's FinalizationRegistry then
   * releases garbage-collected terms (Z3_dec_ref) against the same context from this thread:
   * with the term volume of the io functions that race aborted about half of the runs (heap
   * corruption / OOM inside Z3). One thread, one context: no race. The solver's timeout still
   * fires (Z3 keeps its own timer).
   */
  const wasm = em as { _Z3_solver_check: (ctx: number, solver: number) => number };
  const check = (solver: InstanceType<typeof Z.Solver>): 'sat' | 'unsat' | 'unknown' => {
    const code = wasm._Z3_solver_check(Z.ptr as unknown as number, solver.ptr as unknown as number);
    return code === -1 ? 'unsat' : code === 1 ? 'sat' : 'unknown';
  };
  type BV = ReturnType<typeof Z.BitVec.const<32>>;
  type Bool = ReturnType<typeof Z.Bool.const>;
  type Sym = BV | Bool;
  /** The io token: a data-free marker, since the stream state lives in the evaluation. */
  const TOKEN: unique symbol = Symbol('io');
  type Token = typeof TOKEN;
  /** Symbolic value: a scalar, the io token, or an aggregate as a list of symbolic values. */
  type SVal = Sym | Token | SVal[];
  const bv = (n: number): BV => Z.BitVec.val(n, 32);
  const isBV = (v: Sym): v is BV => 'add' in v;
  const scalar = (v: SVal): Sym => v as Sym;
  const agg = (v: SVal): SVal[] => v as SVal[];

  /** Symbolic io stream state, shared by every token of one evaluation. */
  // Position and length stay concrete numbers while every effect so far was unconditional
  // (straight-line code); they become bitvector terms once an effect happens under a symbolic
  // guard (inside an unrolled loop) and stay symbolic from then on.
  interface IoSym {
    readonly input: readonly BV[];
    pos: BV | number;
    len: BV | number;
    readonly out: BV[];
  }
  const freshIo = (name: string): IoSym => ({
    input: Array.from({ length: IO_WORDS }, (_, i) => Z.BitVec.const(`${name}_in${i}`, 32)),
    pos: 0,
    len: 0,
    out: [],
  });
  const asBV = (n: BV | number): BV => (typeof n === 'number' ? bv(n) : n);
  /** Evaluation context: the stream state and the path condition under which effects happen
   *  (null when unconditional). */
  interface Ctx {
    readonly io: IoSym;
    readonly guard: Bool | null;
  }
  /** Append one word under the guard: a new slot is opened, the word lands at index len. */
  const emit = (ctx: Ctx, word: BV): void => {
    const { io, guard } = ctx;
    if (guard === null && typeof io.len === 'number') {
      io.out.push(word);
      io.len += 1;
      return;
    }
    const len = asBV(io.len);
    const g = guard ?? Z.Bool.val(true);
    io.out.push(bv(0));
    for (let i = 0; i < io.out.length; i += 1)
      io.out[i] = Z.If(g.and(len.eq(bv(i))), word, io.out[i] as BV);
    io.len = Z.If(g, len.add(bv(1)), len);
  };
  /** Read one word under the guard: input[pos], 0 once exhausted; pos advances while < IO_WORDS. */
  const readWord = (ctx: Ctx): BV => {
    const { io, guard } = ctx;
    if (guard === null && typeof io.pos === 'number') {
      const v = io.pos < IO_WORDS ? (io.input[io.pos] as BV) : bv(0);
      if (io.pos < IO_WORDS) io.pos += 1;
      return v;
    }
    const pos = asBV(io.pos);
    const g = guard ?? Z.Bool.val(true);
    let v = bv(0);
    for (let i = IO_WORDS - 1; i >= 0; i -= 1) v = Z.If(pos.eq(bv(i)), io.input[i] as BV, v);
    io.pos = Z.If(g.and(pos.ult(bv(IO_WORDS))), pos.add(bv(1)), pos);
    return v;
  };

  /** Fresh symbols for a parameter of type `t`, named by path. */
  const fresh = (t: Type, name: string): SVal => {
    if (t === 'u32') return Z.BitVec.const(name, 32);
    if (t === 'bool') return Z.Bool.const(name);
    if (t === 'io') return TOKEN;
    if (t.kind === 'arr')
      return Array.from({ length: t.length }, (_, i) => fresh(t.elem, `${name}_${i}`));
    return t.fields.map((f, i) => fresh(f, `${name}_${i}`));
  };
  const ite = (c: Bool, a: SVal, b: SVal): SVal => {
    if (Array.isArray(a)) return a.map((x, i) => ite(c, x, agg(b)[i] as SVal));
    if (a === TOKEN) return TOKEN;
    const s = scalar(a);
    return isBV(s) ? Z.If(c, s, scalar(b) as BV) : Z.If(c, s, scalar(b) as Bool);
  };
  const same = (a: SVal, b: SVal): Bool => {
    if (Array.isArray(a))
      return a
        .map((x, i) => same(x, agg(b)[i] as SVal))
        .reduce((p, q) => p.and(q), Z.Bool.val(true));
    if (a === TOKEN) return Z.Bool.val(true);
    const s = scalar(a);
    return isBV(s) ? s.eq(scalar(b) as BV) : s.eq(scalar(b) as Bool);
  };
  /** Same observable stream: equal output length, equal words below it, equal read position. */
  const sameIo = (a: IoSym, b: IoSym): Bool => {
    const lenA = asBV(a.len);
    let eq = lenA.eq(asBV(b.len)).and(asBV(a.pos).eq(asBV(b.pos)));
    const cap = Math.max(a.out.length, b.out.length);
    for (let i = 0; i < cap; i += 1) {
      const x = a.out[i] ?? bv(0);
      const y = b.out[i] ?? bv(0);
      eq = eq.and(bv(i).ult(lenA).implies(x.eq(y)));
    }
    return eq;
  };

  /** Symbolic evaluation of `fn` applied to symbolic arguments; calls and folds inline. */
  function evalFn(fn: TypedFunc, program: TypedProgram, args: readonly SVal[], ctx: Ctx): SVal {
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
          v = isBV(scalar(x)) ? X().and(Y()) : (scalar(x) as Bool).and(scalar(y) as Bool);
          break;
        case 'or':
          v = isBV(scalar(x)) ? X().or(Y()) : (scalar(x) as Bool).or(scalar(y) as Bool);
          break;
        case 'xor':
          v = isBV(scalar(x)) ? X().xor(Y()) : (scalar(x) as Bool).xor(scalar(y) as Bool);
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
          v = isBV(scalar(x)) ? X().eq(Y()) : (scalar(x) as Bool).eq(scalar(y) as Bool);
          break;
        case 'lt':
          v = X().ult(Y());
          break;
        case 'le':
          v = X().ule(Y());
          break;
        case 'gt':
          v = X().ugt(Y());
          break;
        case 'ge':
          v = X().uge(Y());
          break;
        case 'ne':
          v = isBV(scalar(x)) ? X().neq(Y()) : (scalar(x) as Bool).neq(scalar(y) as Bool);
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
        case 'read':
          v = [readWord(ctx), TOKEN];
          break;
        case 'write':
          emit(ctx, Y());
          v = TOKEN;
          break;
        case 'puts': {
          const arr = agg(y);
          emit(ctx, bv(arr.length));
          for (const e of arr) emit(ctx, scalar(e) as BV);
          v = TOKEN;
          break;
        }
        case 'call': {
          const callee = program.byName.get(node.callee ?? '') as TypedFunc;
          v = evalFn(callee, program, a, ctx);
          break;
        }
        case 'fold': {
          const callee = program.byName.get(node.callee ?? '') as TypedFunc;
          const count = lit(node.args[0]);
          let state = a[1] as SVal;
          const extra = a.slice(2);
          for (let i = 0; i < count; i += 1)
            state = evalFn(callee, program, [state, bv(i), ...extra], ctx);
          v = state;
          break;
        }
        case 'loop': {
          // Stops before iteration i when the predicate is false; once stopped it stays stopped.
          // The predicate runs only while still running, the body only when the predicate held,
          // so effects in either are guarded by the matching condition.
          const callee = program.byName.get(node.callee ?? '') as TypedFunc;
          const pred = program.byName.get(node.pred ?? '') as TypedFunc;
          const count = lit(node.args[0]);
          let state = a[1] as SVal;
          const extra = a.slice(2);
          let running: Bool | null = ctx.guard;
          for (let i = 0; i < count; i += 1) {
            const args: SVal[] = [state, bv(i), ...extra];
            const holds = scalar(
              evalFn(pred, program, args, { io: ctx.io, guard: running }),
            ) as Bool;
            const step: Bool = running === null ? holds : running.and(holds);
            running = step;
            const next = evalFn(callee, program, args, { io: ctx.io, guard: step });
            state = ite(step, next, state);
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

  const leaves = (v: SVal): Sym[] =>
    Array.isArray(v) ? v.flatMap(leaves) : v === TOKEN ? [] : [v];
  type Model = ReturnType<InstanceType<typeof Z.Solver>['model']>;
  /** Concrete stream outcome under a model: read position and the emitted words. */
  const showIo = (io: IoSym, model: Model): string => {
    const len = Number(model.eval(asBV(io.len)).toString());
    const out = io.out.slice(0, len).map((w) => model.eval(w).toString());
    return `pos=${model.eval(asBV(io.pos)).toString()} out=[${out.join(',')}]`;
  };

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
    const withIo = fn.params.includes('io');
    // Both sides read the same symbolic input words; each has its own position and output.
    const ioL = freshIo('io');
    const ioR: IoSym = { ...freshIo('io'), input: ioL.input };
    const lhs = evalFn(fn, source, params, { io: ioL, guard: null });
    const rhs = evalFn(opt, optimized, params, { io: ioR, guard: null });
    const solver = new Z.Solver();
    solver.set('timeout', TIMEOUT_MS);
    const equal = withIo ? same(lhs, rhs).and(sameIo(ioL, ioR)) : same(lhs, rhs);
    solver.add(equal.not());
    const verdict = check(solver);
    const ms = performance.now() - start;
    if (verdict === 'unsat') {
      results.push({ fn: fn.name, status: 'proved', detail: null, ms });
    } else if (verdict === 'sat') {
      const model = solver.model();
      const parts = params
        .flatMap(leaves)
        .map((p) => `${p.toString()}=${model.eval(p).toString()}`);
      if (withIo) {
        parts.push(`input=[${ioL.input.map((w) => model.eval(w).toString()).join(',')}]`);
        parts.push(`source: ${showIo(ioL, model)}`, `optimized: ${showIo(ioR, model)}`);
      }
      results.push({ fn: fn.name, status: 'counterexample', detail: parts.join(' '), ms });
    } else {
      results.push({
        fn: fn.name,
        status: 'unknown',
        detail: `solver returned unknown (${solver.reasonUnknown()}) after ${ms.toFixed(0)} ms, timeout ${TIMEOUT_MS} ms`,
        ms,
      });
    }
  }

  // Self-check: a deliberately wrong "optimization" must produce a counterexample, or the
  // checker is not looking at the right thing. Two mutations: the first add/sub/xor/and/or/mul
  // node of the first in-scope io-free function swapped to another op, and the first `write`
  // of the first in-scope io function dropped (its stream must then differ).
  const mutable = new Set(['add', 'sub', 'xor', 'and', 'or', 'mul']);
  const mutate = (fn: TypedFunc, nodes: TypedFunc['nodes']): string => {
    const params: SVal[] = fn.params.map((t, i) => fresh(t, `p${i}`));
    const ioL = freshIo('io');
    const ioR: IoSym = { ...freshIo('io'), input: ioL.input };
    const lhs = evalFn(fn, source, params, { io: ioL, guard: null });
    const rhs = evalFn({ ...fn, nodes }, source, params, { io: ioR, guard: null });
    const solver = new Z.Solver();
    solver.set('timeout', TIMEOUT_MS);
    solver.add(same(lhs, rhs).and(sameIo(ioL, ioR)).not());
    return check(solver);
  };
  const selfChecks: { fn: string; mutation: string; verdict: string }[] = [];
  for (const fn of source.functions) {
    if (outOfScope(fn, source) !== undefined || fn.params.includes('io')) continue;
    const k = fn.nodes.findIndex((n) => mutable.has(n.op));
    if (k < 0) continue;
    const swapped = fn.nodes[k]?.op === 'add' ? 'sub' : 'add';
    const nodes = fn.nodes.map((n, i) => (i === k ? { ...n, op: swapped as typeof n.op } : n));
    const verdict = mutate(fn, nodes);
    selfChecks.push({
      fn: fn.name,
      mutation: `node ${k} ${fn.nodes[k]?.op} -> ${swapped}`,
      verdict,
    });
    break;
  }
  for (const fn of source.functions) {
    if (outOfScope(fn, source) !== undefined || !fn.params.includes('io')) continue;
    const k = fn.nodes.findIndex((n) => n.op === 'write');
    if (k < 0) continue;
    // Replace the write with `mov` of its token: same types, the effect vanishes.
    const nodes = fn.nodes.map((n, i) =>
      i === k ? { ...n, op: 'mov' as const, args: n.args.slice(0, 1) } : n,
    );
    const verdict = mutate(fn, nodes);
    selfChecks.push({ fn: fn.name, mutation: `node ${k} write dropped`, verdict });
    break;
  }
  const selfCheckOk = selfChecks.length === 2 && selfChecks.every((c) => c.verdict === 'sat');

  const count = (s: string): number => results.filter((r) => r.status === s).length;
  const report = {
    generatedAt: new Date().toISOString(),
    solver: 'z3-solver (Z3 via WebAssembly), QF_BV, 32-bit',
    corpusSha256: corpusSha256(source),
    selfCheck: { ok: selfCheckOk, mutated: selfChecks },
    scope: `intra-procedural values (u32, bool, arrays and records of those, element-wise) plus a bounded io model: the input stream is ${IO_WORDS} symbolic 32-bit words (K = ${IO_WORDS}; reads past K yield 0 and stop advancing, the language's exhausted-input rule), write appends a word, puts appends the length then every element, effects happen in node order on one shared stream as in the reference interpreter. Ops mov add sub mul and or xor shl shr div rem eq lt select arr rec get set at put read write puts; call inlined; fold and loop with literal count <= ${UNROLL_CAP} unrolled (loop steps and their effects gated by the predicate). Equivalence: result values equal, output lengths equal, every output word below that length equal, final read position equal. Excluded: variable-count fold/loop. A proof covers all 2^(32n) value inputs and every input prefix of at most ${IO_WORDS} words; functions marked out-of-scope are covered only by the sampled differential corpus (results/verification.json).`,
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
    `self-check (mutations yield counterexamples): ${selfCheckOk ? 'ok' : 'FAILED'} ${JSON.stringify(selfChecks)}\n${JSON.stringify(report.summary)}\n`,
  );
  if (report.summary.counterexample > 0 || !selfCheckOk) process.exit(1);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
