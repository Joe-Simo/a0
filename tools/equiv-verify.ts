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
 * Strict profile (`profile strict`): the same scope, and the proof is of "equal value AND equal
 * trap". Every site that traps under strict (a `get`/`set` index at or past the length, a `div`
 * or `rem` by zero, a `read` past the modelled input) records its trap kind under its path
 * condition into a symbolic first-trap code (0 none, 1 bounds, 2 divzero, 3 input); two sides
 * are equivalent when the first-trap codes are equal and, where neither traps, the results and
 * the stream are equal. A rewrite that drops a dead `get`, reorders two trapping nodes, or folds
 * a zero divisor into a value is therefore a counterexample. The trap's fn/at/trip/chain are not
 * modelled (the proof inlines calls and unrolls folds); the optimizer keeps them by never
 * inlining, unrolling or fusing a body that can trap, and the runtime tests compare the full line.
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

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseAndValidate, type TypedFunc, type TypedProgram, validate } from '../src/core.js';
import { optimize } from '../src/optimize.js';
import {
  createEncoder,
  IO_WORDS,
  type IoSym,
  outOfScope,
  type SVal,
  TIMEOUT_MS,
  UNROLL_CAP,
} from '../src/z3enc.js';
import { CORPUS_SEED, corpusSha256, generateCorpus } from './corpus.js';
import { writeReport } from './scrub-results.js';

/**
 * Strict-profile kernels, one per rule of the strict optimizer: a dead get and a dead div keep
 * their traps, two traps keep their order, a select evaluates both arms, a zero divisor and an
 * out-of-range literal index are never folded to a value, proved-safe sites stay ordinary, a
 * trapping callee is not inlined or unrolled, a strict `read` past the input traps.
 */
const STRICT_KERNELS = `profile strict
fn dead_get u32 -> u32
a arr 1 2 3
b get a p0
ret 7
end
fn dead_div u32 -> u32
a div 1 p0
ret 5
end
fn order u32 u32 -> u32
d div 1 p0
a arr 1 2
g get a p1
r add d g
ret r
end
fn arms u32 -> u32
a arr 1 2
b get a p0
c select true 7 b
ret c
end
fn zero_div u32 -> u32
a div 7 0
b add a p0
ret b
end
fn lit_oob u32 -> u32
a arr 1 2 3
b get a 5
c add b p0
ret c
end
fn set_oob u32 -> u32
a arr 1 2 3
b set a 3 9
c get b p0
ret c
end
fn safe_mask u32 -> u32
a arr 10 20 30 40
m and p0 3
b get a m
c rem p0 3
d arr 1 2 3
e get d c
f div p0 8
g add b e
h add g f
ret h
end
fn safe_or u32 u32 -> u32
d or p1 1
r div p0 d
ret r
end
fn leaf u32 u32 -> u32
a arr 1 2 3
b get a p1
c add p0 b
ret c
end
fn unrolled u32 -> u32
r fold leaf 3 p0
ret r
end
fn unrolled_oob u32 -> u32
r fold leaf 4 p0
ret r
end
fn inlined u32 -> u32
r call leaf p0 7
ret r
end
fn read1 io -> u32
a read p0
v at a 0
ret v
end
fn read3 io -> u32
a read p0
v at a 0
t at a 1
b read t
w at b 0
u at b 1
c read u
x at c 0
s add v w
r add s x
ret r
end
fn pred u32 u32 -> bool
c lt p0 100
ret c
end
fn loop_oob u32 -> u32
r loop pred leaf 5 p0
ret r
end
`;

async function main(): Promise<void> {
  const enc = await createEncoder();
  const { Z, check, bv, fresh, freshIo, freshTrap, evalFn, same, sameIo, leaves, showIo } = enc;

  const source = generateCorpus(CORPUS_SEED);
  const optimized = optimize(source).program;
  interface Result {
    fn: string;
    status: 'proved' | 'counterexample' | 'unknown' | 'out-of-scope';
    detail: string | null;
    ms: number;
  }
  const results: Result[] = [];
  /**
   * Prove each function of `src` equal to its optimized form in `opt`. Under the strict profile
   * the claim is "equal first-trap code, and where neither traps, equal value and stream".
   */
  const proveAll = (src: TypedProgram, opt: TypedProgram, out: Result[], tag = ''): void => {
    const strictRun = src.profile === 'strict';
    for (const fn of src.functions) {
      const name = `${tag}${fn.name}`;
      const why = outOfScope(fn, src);
      if (why !== undefined) {
        out.push({ fn: name, status: 'out-of-scope', detail: why, ms: 0 });
        continue;
      }
      const o = opt.byName.get(fn.name) as TypedFunc;
      const whyOpt = outOfScope(o, opt);
      if (whyOpt !== undefined) {
        out.push({ fn: name, status: 'out-of-scope', detail: `optimized: ${whyOpt}`, ms: 0 });
        continue;
      }
      const start = performance.now();
      const params: SVal[] = fn.params.map((t, i) => fresh(t, `p${i}`));
      const withIo = fn.params.includes('io');
      // Both sides read the same symbolic input words; each has its own position and output.
      const ioL = freshIo('io');
      const ioR: IoSym = { ...freshIo('io'), input: ioL.input };
      const trapL = freshTrap();
      const trapR = freshTrap();
      const lhs = evalFn(fn, src, params, { io: ioL, guard: null, trap: trapL });
      const rhs = evalFn(o, opt, params, { io: ioR, guard: null, trap: trapR });
      const solver = new Z.Solver();
      solver.set('timeout', TIMEOUT_MS);
      const values = withIo ? same(lhs, rhs).and(sameIo(ioL, ioR)) : same(lhs, rhs);
      const equal = strictRun
        ? trapL.kind.eq(trapR.kind).and(trapL.kind.eq(bv(0)).implies(values))
        : values;
      solver.add(equal.not());
      const verdict = check(solver);
      const ms = performance.now() - start;
      if (verdict === 'unsat') {
        out.push({ fn: name, status: 'proved', detail: null, ms });
      } else if (verdict === 'sat') {
        const model = solver.model();
        const parts = params
          .flatMap(leaves)
          .map((p) => `${p.toString()}=${model.eval(p).toString()}`);
        if (strictRun)
          parts.push(
            `trap source=${model.eval(trapL.kind).toString()} optimized=${model.eval(trapR.kind).toString()}`,
          );
        if (withIo) {
          parts.push(`input=[${ioL.input.map((w) => model.eval(w).toString()).join(',')}]`);
          parts.push(`source: ${showIo(ioL, model)}`, `optimized: ${showIo(ioR, model)}`);
        }
        out.push({ fn: name, status: 'counterexample', detail: parts.join(' '), ms });
      } else {
        out.push({
          fn: name,
          status: 'unknown',
          detail: `solver returned unknown (${solver.reasonUnknown()}) after ${ms.toFixed(0)} ms, timeout ${TIMEOUT_MS} ms`,
          ms,
        });
      }
    }
  };
  proveAll(source, optimized, results);

  // The strict profile: the same corpus under `profile strict` (almost every function now has a
  // trap site: its get/set indices and div/rem divisors are arbitrary), plus kernels written to
  // exercise each strict rule of the optimizer (dead get, dead div, order of two traps, select
  // arms, proved-safe sites, a zero divisor or an out-of-range index in a literal, io).
  const strictCorpus = validate({ profile: 'strict', functions: source.functions });
  const strictKernels = parseAndValidate(STRICT_KERNELS);
  const strictResults: Result[] = [];
  proveAll(strictCorpus, optimize(strictCorpus).program, strictResults, 'strict:');
  proveAll(strictKernels, optimize(strictKernels).program, strictResults, 'kernel:');

  // Self-check: a deliberately wrong "optimization" must produce a counterexample, or the
  // checker is not looking at the right thing. Two mutations: the first add/sub/xor/and/or/mul
  // node of the first in-scope io-free function swapped to another op, and the first `write`
  // of the first in-scope io function dropped (its stream must then differ).
  const mutable = new Set(['add', 'sub', 'xor', 'and', 'or', 'mul']);
  const mutateIn = (program: TypedProgram, fn: TypedFunc, nodes: TypedFunc['nodes']): string => {
    const params: SVal[] = fn.params.map((t, i) => fresh(t, `p${i}`));
    const ioL = freshIo('io');
    const ioR: IoSym = { ...freshIo('io'), input: ioL.input };
    const trapL = freshTrap();
    const trapR = freshTrap();
    const lhs = evalFn(fn, program, params, { io: ioL, guard: null, trap: trapL });
    const rhs = evalFn({ ...fn, nodes }, program, params, { io: ioR, guard: null, trap: trapR });
    const solver = new Z.Solver();
    solver.set('timeout', TIMEOUT_MS);
    solver.add(
      fn.profile === 'strict'
        ? trapL.kind
            .eq(trapR.kind)
            .and(trapL.kind.eq(bv(0)).implies(same(lhs, rhs).and(sameIo(ioL, ioR))))
            .not()
        : same(lhs, rhs).and(sameIo(ioL, ioR)).not(),
    );
    return check(solver);
  };
  const mutate = (fn: TypedFunc, nodes: TypedFunc['nodes']): string => mutateIn(source, fn, nodes);
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
  // Strict: dropping a dead `get` keeps every value and changes the trap, so it must not be proved.
  const deadGet = strictKernels.byName.get('dead_get');
  if (deadGet !== undefined) {
    const k = deadGet.nodes.findIndex((n) => n.op === 'get');
    selfChecks.push({
      fn: deadGet.name,
      mutation: `node ${k} get dropped (strict)`,
      verdict: mutateIn(
        strictKernels,
        deadGet,
        deadGet.nodes.filter((_, i) => i !== k),
      ),
    });
  }
  const selfCheckOk = selfChecks.length === 3 && selfChecks.every((c) => c.verdict === 'sat');

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
    strict: {
      scope:
        'the strict profile: the corpus under `profile strict` and hand-written kernels for each rule of the strict optimizer. Equivalence is first-trap code equal (0 none, 1 bounds, 2 divzero, 3 input, in node order) and, where neither side traps, result values, output stream and read position equal. The trap line fields fn/at/trip/chain are not modelled here; the optimizer keeps them by never inlining, unrolling or fusing a body that can trap, and test/strict-targets.test.ts compares the whole line.',
      summary: {
        functions: strictResults.length,
        proved: strictResults.filter((r) => r.status === 'proved').length,
        counterexample: strictResults.filter((r) => r.status === 'counterexample').length,
        unknown: strictResults.filter((r) => r.status === 'unknown').length,
        outOfScope: strictResults.filter((r) => r.status === 'out-of-scope').length,
      },
      results: strictResults,
    },
  };
  await mkdir('results', { recursive: true });
  await writeReport(join('results', 'equivalence.json'), report);
  for (const r of [...results, ...strictResults])
    process.stdout.write(
      `${r.fn.padEnd(6)} ${r.status.padEnd(15)} ${r.ms.toFixed(0).padStart(6)} ms${r.detail === null ? '' : `  ${r.detail}`}\n`,
    );
  process.stdout.write(
    `self-check (mutations yield counterexamples): ${selfCheckOk ? 'ok' : 'FAILED'} ${JSON.stringify(selfChecks)}\n${JSON.stringify(report.summary)}\nstrict ${JSON.stringify(report.strict.summary)}\n`,
  );
  if (report.summary.counterexample > 0 || report.strict.summary.counterexample > 0 || !selfCheckOk)
    process.exit(1);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
