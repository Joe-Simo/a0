/**
 * CHICKEN Scheme 6: u32 values are exact integers masked with bitwise-and #xFFFFFFFF after
 * every operation that can leave the range (fixnums are 62-bit and generic arithmetic promotes
 * to exact bignums, so products stay exact); records are pairs and u32x4 arrays are vectors.
 * The candidate is a compilation unit (csc -c lib.scm) linked with the driver.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Type, Value } from '../../src/core.js';
import { runTool } from '../../src/toolchain.js';
import {
  BUILD_MS,
  failure,
  type LangCase,
  type LangSpec,
  RUN_MS,
  recordFields,
  signature,
  tool,
} from './spec.js';

const M = '#xFFFFFFFF';

function literal(v: Value, t: Type | undefined): string {
  if (typeof v === 'boolean') return v ? '#t' : '#f';
  if (typeof v === 'number') return String(v);
  const fields = recordFields(t);
  const items = Array.from(v as ArrayLike<Value>, (x, i) => literal(x, fields[i]));
  if (fields.length === 2) return `(cons ${items.join(' ')})`;
  return `(vector ${items.join(' ')})`;
}

function render(expr: string, t: Type | undefined): string {
  if (t === 'bool') return `(if ${expr} "true" "false")`;
  const fields = recordFields(t);
  if (fields.length === 2) {
    return `(let ((r ${expr})) (string-append "[" ${render('(car r)', fields[0])} "," ${render('(cdr r)', fields[1])} "]"))`;
  }
  return `(number->string ${expr})`;
}

function driver(tests: readonly LangCase[], typed: Parameters<LangSpec['driver']>[1]): string {
  const body = tests
    .map((t, i) => {
      const { params, result } = signature(typed, t.fn);
      const args = t.args.map((a, k) => ` ${literal(a, params[k])}`).join('');
      return `(display (string-append "R${i} " ${render(`(${t.fn}${args})`, result)}))\n(newline)`;
    })
    .join('\n');
  return `(declare (uses lib))\n${body}\n(display "DONE")\n(newline)\n`;
}

const loop4 = (step: string): string =>
  `    (do ((i 0 (+ i 1)))\n        ((= i 4))\n      ${step})`;

const B: LangSpec['b'] = {
  'b-fits-inclusive': {
    source: '(define (fits a b)\n  (< a b))\n',
    reference: '(define (fits a b)\n  (<= a b))\n',
  },
  'b-sumfrom-eight': {
    source: `(define (sumfrom x)\n  (let ((s x))\n    (do ((i 0 (+ i 1)))\n        ((= i 5))\n      (set! s (bitwise-and (+ s i) ${M})))\n    s))\n`,
    reference: `(define (sumfrom x)\n  (let ((s x))\n    (do ((i 0 (+ i 1)))\n        ((= i 8))\n      (set! s (bitwise-and (+ s i) ${M})))\n    s))\n`,
  },
  'b-rot8-constant': {
    source: `(define (rot8 x)\n  (bitwise-and (bitwise-ior (arithmetic-shift x 8) (arithmetic-shift x -23)) ${M}))\n`,
    reference: `(define (rot8 x)\n  (bitwise-and (bitwise-ior (arithmetic-shift x 8) (arithmetic-shift x -24)) ${M}))\n`,
  },
  'b-onlyone-xor': {
    source: '(define (onlyone a b)\n  (or a b))\n',
    reference: '(define (onlyone a b)\n  (not (eq? a b)))\n',
  },
  'b-avgfloor-nowrap': {
    source: `(define (avgfloor a b)\n  (arithmetic-shift (bitwise-and (+ a b) ${M}) -1))\n`,
    reference:
      '(define (avgfloor a b)\n  (+ (bitwise-and a b) (arithmetic-shift (bitwise-xor a b) -1)))\n',
  },
  'b-sumsq-array': {
    source: `(define (sumsq a)\n  (let ((s 0))\n${loop4(`(set! s (bitwise-and (+ s (vector-ref a i)) ${M}))`)}\n    s))\n`,
    reference: `(define (sumsq a)\n  (let ((s 0))\n${loop4(`(set! s (bitwise-and (+ s (* (vector-ref a i) (vector-ref a i))) ${M}))`)}\n    s))\n`,
  },
  'b-inrange-inclusive': {
    source: '(define (inrange x lo hi)\n  (and (> x lo) (< x hi)))\n',
    reference: '(define (inrange x lo hi)\n  (and (>= x lo) (<= x hi)))\n',
  },
  'b-bounds-largest': {
    source: `(define (bounds a)\n  (let ((lo ${M}) (hi 0))\n${loop4('(let ((x (vector-ref a i)))\n        (if (< x lo) (set! lo x))\n        (if (< x hi) (set! hi x)))')}\n    (cons lo hi)))\n`,
    reference: `(define (bounds a)\n  (let ((lo ${M}) (hi 0))\n${loop4('(let ((x (vector-ref a i)))\n        (if (< x lo) (set! lo x))\n        (if (> x hi) (set! hi x)))')}\n    (cons lo hi)))\n`,
  },
  'b-checksum-poly': {
    source: `(define (checksum a)\n  (let ((h 0))\n${loop4('(set! h (bitwise-xor h (vector-ref a i)))')}\n    h))\n`,
    reference: `(define (checksum a)\n  (let ((h 7))\n${loop4(`(set! h (bitwise-and (+ (* h 31) (vector-ref a i)) ${M}))`)}\n    h))\n`,
  },
  'b-norm2-dot': {
    source: `(define (dot a b)\n  (let ((s 0))\n${loop4(`(set! s (bitwise-and (+ s (* (vector-ref a i) (vector-ref b i))) ${M}))`)}\n    s))\n`,
    reference: `(define (dot a b)\n  (let ((s 0))\n${loop4(`(set! s (bitwise-and (+ s (* (vector-ref a i) (vector-ref b i))) ${M}))`)}\n    s))\n(define (norm2 a)\n  (dot a a))\n`,
  },
  'b-pctof-limit': {
    source: '(define (limit x lo hi)\n  (let ((b (if (< x lo) lo x)))\n    (if (> b hi) hi b)))\n',
    reference: `(define (limit x lo hi)\n  (let ((b (if (< x lo) lo x)))\n    (if (> b hi) hi b)))\n(define (pctof part whole)\n  (let* ((n (bitwise-and (* part 100) ${M}))\n         (q (if (= whole 0) ${M} (quotient n whole))))\n    (limit q 0 100)))\n`,
  },
  'b-hamming-popcnt': {
    source: `(define (popcnt x)\n  (let ((s 0))\n    (do ((i 0 (+ i 1)))\n        ((= i 32))\n      (set! s (bitwise-and (+ s (bitwise-and (arithmetic-shift x (- i)) 1)) ${M})))\n    s))\n`,
    reference: `(define (popcnt x)\n  (let ((s 0))\n    (do ((i 0 (+ i 1)))\n        ((= i 32))\n      (set! s (bitwise-and (+ s (bitwise-and (arithmetic-shift x (- i)) 1)) ${M})))\n    s))\n(define (hamming a b)\n  (popcnt (bitwise-xor a b)))\n`,
  },
};

export const CHICKEN: LangSpec = {
  semantics: `Integers are unsigned 32-bit values held as exact integers (fixnums are 62-bit and arithmetic promotes to bignums): mask every result that can leave the range with (bitwise-and v #xFFFFFFFF), mask shift counts to 5 bits where the text does; comparisons are unsigned; records are pairs (cons lo hi) and u32x4 values are vectors (vector-ref a i). Division by zero gives 4294967295; remainder by zero gives the dividend. The file is lib.scm, compiled as the unit lib (csc -c lib.scm); its definitions are called from the driver.`,
  head: /^\(define \(([^\s()]+)/,
  file: (body) => `(declare (unit lib))\n(import (chicken bitwise))\n${body}`,
  b: B,
  driver,
  compileLabel: 'csc',
  async buildAndRun(dir, source, drv) {
    const csc = tool('csc', 'A0_CSC', ['/opt/homebrew/bin/csc']);
    await writeFile(join(dir, 'lib.scm'), source, 'utf8');
    await writeFile(join(dir, 'driver.scm'), drv, 'utf8');
    const lib = runTool(csc, ['-O0', '-c', 'lib.scm', '-o', 'lib.o'], {
      cwd: dir,
      timeoutMs: BUILD_MS,
    });
    if (!lib.ok) return failure('csc', lib);
    const build = runTool(csc, ['-O0', 'driver.scm', 'lib.o', '-o', 'prog'], {
      cwd: dir,
      timeoutMs: BUILD_MS,
    });
    if (!build.ok) return failure('csc', build);
    const run = runTool(join(dir, 'prog'), [], { cwd: dir, timeoutMs: RUN_MS });
    if (!run.ok) return failure('run', run);
    return { stdout: run.stdout };
  },
};
