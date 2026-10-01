/**
 * Prolog (SWI-Prolog): functions are predicates with a trailing output argument; u32 values
 * are unbounded integers masked with /\ 0xFFFFFFFF after every operation that can leave the
 * range; booleans are the atoms true/false, records and u32x4 arrays are lists. The candidate
 * is loaded on its own (load errors are reported), then consulted by the driver.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Value } from '../../src/core.js';
import { runTool } from '../../src/toolchain.js';
import { BUILD_MS, failure, type LangCase, type LangSpec, RUN_MS, tool } from './spec.js';

const M = '0xFFFFFFFF';

function literal(v: Value): string {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return `[${Array.from(v as ArrayLike<Value>, literal).join(',')}]`;
}

function driver(tests: readonly LangCase[]): string {
  const body = tests
    .map((t, i) => {
      const args = t.args.map((a) => `${literal(a)}, `).join('');
      return `    ${t.fn}(${args}R${i}),\n    format("R${i} ~w~n", [R${i}]),`;
    })
    .join('\n');
  return `:- initialization(main, main).\n\nmain :-\n    consult('mod.pl'),\n${body}\n    format("DONE~n").\n`;
}

/**
 * `foldl` over 0..n. Arrays and numbers the step reads travel in the fold state as
 * `v(Globals)-Acc`, so the lambda has no free variables (yall goal expansion needs that).
 */
const loop = (n: number, step: string, init: string, globals = ''): string => {
  const g = globals === '' ? '' : `v(${globals})-`;
  const blank = globals === '' ? '' : `v(${globals.replace(/\w+/g, '_')})-`;
  return `    numlist(0, ${n}, Is),\n    foldl([I, ${g}S0, ${g}S]>>(${step}), Is, ${g}${init}, ${blank}R).\n`;
};

const B: LangSpec['b'] = {
  'b-fits-inclusive': {
    source: 'fits(A, B, R) :-\n    ( A < B -> R = true ; R = false ).\n',
    reference: 'fits(A, B, R) :-\n    ( A =< B -> R = true ; R = false ).\n',
  },
  'b-sumfrom-eight': {
    source: `sumfrom(X, R) :-\n${loop(4, `S is (S0 + I) /\\ ${M}`, 'X')}`,
    reference: `sumfrom(X, R) :-\n${loop(7, `S is (S0 + I) /\\ ${M}`, 'X')}`,
  },
  'b-rot8-constant': {
    source: `rot8(X, R) :-\n    R is ((X << 8) \\/ (X >> 23)) /\\ ${M}.\n`,
    reference: `rot8(X, R) :-\n    R is ((X << 8) \\/ (X >> 24)) /\\ ${M}.\n`,
  },
  'b-onlyone-xor': {
    source: 'onlyone(A, B, R) :-\n    ( ( A == true ; B == true ) -> R = true ; R = false ).\n',
    reference: 'onlyone(A, B, R) :-\n    ( A \\== B -> R = true ; R = false ).\n',
  },
  'b-avgfloor-nowrap': {
    source: `avgfloor(A, B, R) :-\n    R is ((A + B) /\\ ${M}) >> 1.\n`,
    reference: 'avgfloor(A, B, R) :-\n    R is (A /\\ B) + ((A xor B) >> 1).\n',
  },
  'b-sumsq-array': {
    source: `sumsq(A, R) :-\n${loop(3, `nth0(I, A, X), S is (S0 + X) /\\ ${M}`, '0', 'A')}`,
    reference: `sumsq(A, R) :-\n${loop(3, `nth0(I, A, X), S is (S0 + X * X) /\\ ${M}`, '0', 'A')}`,
  },
  'b-inrange-inclusive': {
    source: 'inrange(X, Lo, Hi, R) :-\n    ( X > Lo, X < Hi -> R = true ; R = false ).\n',
    reference: 'inrange(X, Lo, Hi, R) :-\n    ( X >= Lo, X =< Hi -> R = true ; R = false ).\n',
  },
  'b-bounds-largest': {
    source: `bounds(A, R) :-\n    numlist(0, 3, Is),\n    foldl([I, v(A)-Lo0-Hi0, v(A)-Lo-Hi]>>(nth0(I, A, X), ( X < Lo0 -> Lo = X ; Lo = Lo0 ), ( X < Hi0 -> Hi = X ; Hi = Hi0 )), Is, v(A)-${M}-0, v(_)-Lo1-Hi1),\n    R = [Lo1, Hi1].\n`,
    reference: `bounds(A, R) :-\n    numlist(0, 3, Is),\n    foldl([I, v(A)-Lo0-Hi0, v(A)-Lo-Hi]>>(nth0(I, A, X), ( X < Lo0 -> Lo = X ; Lo = Lo0 ), ( X > Hi0 -> Hi = X ; Hi = Hi0 )), Is, v(A)-${M}-0, v(_)-Lo1-Hi1),\n    R = [Lo1, Hi1].\n`,
  },
  'b-checksum-poly': {
    source: `checksum(A, R) :-\n${loop(3, 'nth0(I, A, X), S is S0 xor X', '0', 'A')}`,
    reference: `checksum(A, R) :-\n${loop(3, `nth0(I, A, X), S is (S0 * 31 + X) /\\ ${M}`, '7', 'A')}`,
  },
  'b-norm2-dot': {
    source: `dot(A, B, R) :-\n${loop(3, `nth0(I, A, X), nth0(I, B, Y), S is (S0 + X * Y) /\\ ${M}`, '0', 'A, B')}`,
    reference: `dot(A, B, R) :-\n${loop(3, `nth0(I, A, X), nth0(I, B, Y), S is (S0 + X * Y) /\\ ${M}`, '0', 'A, B')}norm2(A, R) :-\n    dot(A, A, R).\n`,
  },
  'b-pctof-limit': {
    source:
      'limit(X, Lo, Hi, R) :-\n    ( X < Lo -> B = Lo ; B = X ),\n    ( B > Hi -> R = Hi ; R = B ).\n',
    reference: `limit(X, Lo, Hi, R) :-\n    ( X < Lo -> B = Lo ; B = X ),\n    ( B > Hi -> R = Hi ; R = B ).\npctof(Part, Whole, R) :-\n    N is (Part * 100) /\\ ${M},\n    ( Whole =:= 0 -> Q = ${M} ; Q is N // Whole ),\n    limit(Q, 0, 100, R).\n`,
  },
  'b-hamming-popcnt': {
    source: `popcnt(X, R) :-\n${loop(31, `S is (S0 + ((X >> I) /\\ 1)) /\\ ${M}`, '0', 'X')}`,
    reference: `popcnt(X, R) :-\n${loop(31, `S is (S0 + ((X >> I) /\\ 1)) /\\ ${M}`, '0', 'X')}hamming(A, B, R) :-\n    X is A xor B,\n    popcnt(X, R).\n`,
  },
};

export const PROLOG: LangSpec = {
  semantics: `Predicates take their arguments followed by an output argument (e.g. fits(A, B, R)); u32 values are unbounded integers, so mask every arithmetic result with /\\ ${M} and shift counts to 5 bits where needed; comparisons are unsigned. Booleans are the atoms true and false, u32x4 arrays and pairs are lists. Division by zero gives 4294967295; remainder by zero gives the dividend. The file is loaded by SWI-Prolog 10 (swipl) as a module-less file and must load without errors.`,
  head: /^([a-z][A-Za-z0-9_]*)\(/,
  file: (body) =>
    `:- use_module(library(apply)).\n:- use_module(library(lists)).\n:- use_module(library(yall)).\n\n${body}`,
  b: B,
  driver,
  compileLabel: 'swipl',
  async buildAndRun(dir, source, drv) {
    const swipl = tool('swipl', 'A0_SWIPL', ['/opt/homebrew/bin/swipl']);
    await writeFile(join(dir, 'mod.pl'), source, 'utf8');
    await writeFile(join(dir, 'driver.pl'), drv, 'utf8');
    const check = runTool(swipl, ['-q', '--on-error=status', '-g', 'halt', join(dir, 'mod.pl')], {
      cwd: dir,
      timeoutMs: BUILD_MS,
    });
    if (!check.ok || /error/i.test(check.stderr)) return failure('swipl', check);
    const run = runTool(swipl, ['-q', join(dir, 'driver.pl')], { cwd: dir, timeoutMs: RUN_MS });
    if (!run.ok) return failure('run', run);
    return { stdout: run.stdout };
  },
};
