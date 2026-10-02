/**
 * Proof of spec-line contracts with Z3 (`a0 check --prove`; never on an edit and never in `validate`).
 *
 * For a function with `pre` and/or `post` the question is the one a contract asks: is there an input
 * that satisfies `pre` and breaks `post`? The function, `pre` and `post` are encoded over 32-bit
 * bitvectors by the same symbolic evaluator the optimizer proof uses (src/z3enc.ts: arrays
 * element-wise, `index mod N`, calls inlined, fold and loop with a literal count unrolled to the
 * same bound), `pre` is asserted, and the negation of `post` is checked. The answer is
 *
 *   proved     no such input exists (unsat), for every u32 and bool input and every array of the
 *              declared length;
 *   disproved  an input exists (A0717): the model is turned into concrete arguments and the
 *              reference interpreter runs them; only a failure the interpreter confirms is reported;
 *   unknown    outside the scope, over the bounds, a solver timeout, or a model the interpreter does
 *              not confirm (A0718, a note with the reason).
 *
 * Under the strict profile a trap is a failure: the contract holds only when, for every input that
 * satisfies `pre`, the function does not trap, `post` does not trap, and `post` is true; a `pre` that
 * traps is itself a failure (the example check says the same: "pre cannot be evaluated"). The kinds
 * are the optimizer proof's (bounds, divzero, input), in node order. Nothing here is compiled or
 * emitted: a program without spec lines is never touched.
 */

import {
  A0Error,
  containsIo,
  LIMITS,
  run,
  type Type,
  type TypedFunc,
  type TypedProgram,
  type Value,
} from './core.js';
import { type Diagnostic, diag, formatTrap, type TrapKind } from './diagnostics.js';
import { formatLit, litOf, typedContracts } from './spec.js';
import { type Bool, outOfScope, type SVal } from './z3enc.js';

/** The longest array a contract proof encodes (elements), per parameter. */
export const PROVE_ARRAY_CAP = 16;
/** The most scalar leaves a parameter list may have (arrays and records flattened). */
export const PROVE_LEAF_CAP = 64;
/** Solver time per function (milliseconds), unless the caller chooses another. */
export const PROVE_TIMEOUT_MS = 10_000;

export type ContractStatus = 'proved' | 'disproved' | 'unknown';

export interface ContractResult {
  readonly fn: string;
  readonly status: ContractStatus;
  /** Which lines were proved: `pre post`, `post`, ... */
  readonly lines: readonly ('pre' | 'post')[];
  /** A0717 for `disproved`, A0718 for `unknown`; undefined when proved. */
  readonly diagnostic?: Diagnostic;
  /** The diagnostic as an error value (for `formatDiagnostic`). */
  readonly error?: A0Error;
  /** The confirmed counterexample, as `p0=5 p1=[1;2]` (disproved only). */
  readonly inputs?: string;
  /** Why the proof is not complete (unknown only). */
  readonly reason?: string;
  readonly ms: number;
}

export interface ProveOptions {
  readonly timeoutMs?: number;
  /** Only these functions (by name); default: every function that has a pre or a post. */
  readonly only?: readonly string[];
}

const leafCount = (t: Type): number =>
  t === 'u32' || t === 'bool' || t === 'io'
    ? 1
    : t.kind === 'arr'
      ? t.length * leafCount(t.elem)
      : t.fields.reduce((n, f) => n + leafCount(f), 0);

/** Why the signature of `fn` is over the bounds, or undefined. */
function overBounds(fn: TypedFunc): string | undefined {
  const arrays = (t: Type): number =>
    typeof t === 'string'
      ? 0
      : t.kind === 'arr'
        ? Math.max(t.length, arrays(t.elem))
        : Math.max(0, ...t.fields.map(arrays));
  for (const [i, t] of fn.params.entries()) {
    const n = arrays(t);
    if (n > PROVE_ARRAY_CAP)
      return `p${i} has an array of ${n} elements, over the bound of ${PROVE_ARRAY_CAP}`;
  }
  const leaves = fn.params.reduce((n, t) => n + leafCount(t), 0);
  if (leaves > PROVE_LEAF_CAP)
    return `the parameters have ${leaves} scalar values, over the bound of ${PROVE_LEAF_CAP}`;
  return undefined;
}

const unknown = (fn: string, lines: ContractResult['lines'], reason: string, ms = 0) => {
  const error = diag('A0718', [fn, reason]);
  return { fn, status: 'unknown', lines, diagnostic: error.toJSON(), error, reason, ms } as const;
};

/** The interpreter value of a model, by the shape of `t`. */
function modelValue(t: Type, s: SVal, model: { eval: (e: never, completion: boolean) => unknown }) {
  const walk = (ty: Type, v: SVal): Value => {
    if (ty === 'u32') return Number((model.eval(v as never, true) as { value(): bigint }).value());
    if (ty === 'bool') return String(model.eval(v as never, true)) === 'true';
    const items = v as SVal[];
    return ty === 'io'
      ? 0
      : ty.kind === 'arr'
        ? items.map((x) => walk(ty.elem, x))
        : items.map((x, i) => walk(ty.fields[i] as Type, x));
  };
  return walk(t, s);
}

/** Run the interpreter on a candidate counterexample: the failure it shows, or undefined. */
function confirm(
  fn: TypedFunc,
  pre: TypedFunc | undefined,
  post: TypedFunc | undefined,
  args: readonly Value[],
): string | undefined | 'unconfirmed' {
  const budget = new Set<TrapKind>(['fuel', 'iter', 'io']);
  const attempt = <T>(thunk: () => T): { ok: T } | { trap: string } | 'budget' => {
    try {
      return { ok: thunk() };
    } catch (e) {
      if (!(e instanceof A0Error)) throw e;
      if (e.trap !== undefined && !budget.has(e.trap.kind)) return { trap: formatTrap(e.trap) };
      if (e.trap === undefined && e.id !== 'A0701') return { trap: e.detail };
      return 'budget';
    }
  };
  const opts = { fuel: LIMITS.defaultFuel };
  if (pre !== undefined) {
    const p = attempt(() => run(pre, args, opts));
    if (p === 'budget') return 'unconfirmed';
    if ('trap' in p) return `pre traps: ${p.trap}`;
    if (p.ok !== true) return 'unconfirmed';
  }
  const r = attempt(() => run(fn, args, opts));
  if (r === 'budget') return 'unconfirmed';
  if ('trap' in r) return `${fn.name} traps: ${r.trap}`;
  if (post === undefined) return 'unconfirmed';
  const q = attempt(() => run(post, [...args, r.ok], opts));
  if (q === 'budget') return 'unconfirmed';
  if ('trap' in q) return `post traps: ${q.trap}`;
  if (q.ok === true) return 'unconfirmed';
  return `post does not hold, the result is ${formatLit(litOf(r.ok, fn.result))}`;
}

/**
 * Prove or refute the contracts of every function of `program` that has a `pre` or a `post`.
 * Resolves with one result per such function, in program order.
 */
export async function proveContracts(
  program: TypedProgram,
  options: ProveOptions = {},
): Promise<ContractResult[]> {
  const timeoutMs = options.timeoutMs ?? PROVE_TIMEOUT_MS;
  const results: ContractResult[] = [];
  let enc: Awaited<ReturnType<typeof import('./z3enc.js').createEncoder>> | undefined;
  for (const fn of program.functions) {
    const spec = fn.spec;
    if (spec === undefined || (spec.pre === undefined && spec.post === undefined)) continue;
    if (options.only !== undefined && !options.only.includes(fn.name)) continue;
    const lines = [
      ...(spec.pre === undefined ? [] : (['pre'] as const)),
      ...(spec.post === undefined ? [] : (['post'] as const)),
    ];
    if ([...fn.params, fn.result].some(containsIo)) {
      results.push(unknown(fn.name, lines, 'the function takes or returns io'));
      continue;
    }
    const { pre, post } = typedContracts(fn, program.byName);
    let why = overBounds(fn);
    for (const [f, label] of [
      [fn, fn.name],
      [pre, 'pre'],
      [post, 'post'],
    ] as const) {
      if (why !== undefined || f === undefined) continue;
      const w = outOfScope(f, program);
      if (w !== undefined) why = `${label}: ${w}`;
    }
    if (why !== undefined) {
      results.push(unknown(fn.name, lines, `outside the proof scope (${why})`));
      continue;
    }
    const { createEncoder } = await import('./z3enc.js');
    enc ??= await createEncoder();
    const { Z, check, bv, scalar, fresh, freshIo, freshTrap, evalFn } = enc;
    const start = performance.now();
    const params: SVal[] = fn.params.map((t, i) => fresh(t, `p${i}`));
    const ctx = () => ({ io: freshIo('io'), guard: null, trap: freshTrap() });
    const preCtx = ctx();
    const fnCtx = ctx();
    const postCtx = ctx();
    const preHolds: Bool =
      pre === undefined ? Z.Bool.val(true) : (scalar(evalFn(pre, program, params, preCtx)) as Bool);
    const result = evalFn(fn, program, params, fnCtx);
    const postHolds: Bool =
      post === undefined
        ? Z.Bool.val(true)
        : (scalar(evalFn(post, program, [...params, result], postCtx)) as Bool);
    const trapped = (c: { trap: { kind: ReturnType<typeof bv> } }): Bool => c.trap.kind.neq(bv(0));
    const violation = trapped(preCtx).or(
      preHolds.and(trapped(fnCtx).or(trapped(postCtx)).or(postHolds.not())),
    );
    const solver = new Z.Solver();
    solver.set('timeout', timeoutMs);
    solver.add(violation);
    const verdict = check(solver);
    const ms = performance.now() - start;
    if (verdict === 'unsat') {
      results.push({ fn: fn.name, status: 'proved', lines, ms });
    } else if (verdict === 'unknown') {
      results.push(
        unknown(
          fn.name,
          lines,
          `the solver gave up (${solver.reasonUnknown()}) after ${Math.round(ms)} ms, limit ${timeoutMs} ms`,
          ms,
        ),
      );
    } else {
      const model = solver.model();
      const args = params.map((p, i) => modelValue(fn.params[i] as Type, p, model));
      const failure = confirm(fn, pre, post, args);
      if (failure === undefined || failure === 'unconfirmed') {
        results.push(
          unknown(
            fn.name,
            lines,
            'the solver found an input that the reference interpreter does not confirm',
            ms,
          ),
        );
      } else {
        const inputs = args
          .map((a, i) => `p${i}=${formatLit(litOf(a, fn.params[i] as Type))}`)
          .join(' ');
        const error = diag('A0717', [
          fn.name,
          `${inputs === '' ? '(no inputs)' : inputs}: ${failure}`,
        ]);
        results.push({
          fn: fn.name,
          status: 'disproved',
          lines,
          diagnostic: error.toJSON(),
          error,
          inputs,
          ms,
        });
      }
    }
  }
  return results;
}
