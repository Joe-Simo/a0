/**
 * Racket 9 CS: u32 values are exact integers masked with bitwise-and after every operation that
 * can leave the range (fixnums are 62-bit, bignums exact); records and u32x4 arrays are vectors.
 * The candidate module (racket/base, provide all-defined-out) is first run alone with racket
 * (raco make is not installed), so read and syntax errors surface at the build step; the driver requires it.
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

function literal(v: Value): string {
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? '#t' : '#f';
  return `#(${Array.from(v as ArrayLike<Value>, literal).join(' ')})`;
}

function render(expr: string, t: Type | undefined): string {
  if (t === 'bool') return `(fb ${expr})`;
  const fields = recordFields(t);
  if (fields.length > 0)
    return `(string-append "[" ${fields
      .map((ft, i) => render(`(vector-ref ${expr} ${i})`, ft))
      .join(' "," ')} "]")`;
  return `(number->string ${expr})`;
}

function driver(tests: readonly LangCase[], typed: Parameters<LangSpec['driver']>[1]): string {
  const body = tests
    .map((t, i) => {
      const { result } = signature(typed, t.fn);
      const args = t.args.map(literal).join(' ');
      return `(let ((v (${t.fn} ${args})))\n  (display (string-append "R${i} " ${render('v', result)} "\\n")))`;
    })
    .join('\n');
  return `#lang racket/base\n(require "mod.rkt")\n(define (fb v) (if v "true" "false"))\n${body}\n(display "DONE\\n")\n`;
}

const M = 'M';

const B: LangSpec['b'] = {
  'b-fits-inclusive': {
    source: '(define (fits a b)\n  (< a b))\n',
    reference: '(define (fits a b)\n  (<= a b))\n',
  },
  'b-sumfrom-eight': {
    source: `(define (sumfrom x)\n  (let ((s x))\n    (do ((i 0 (+ i 1))) ((>= i 5))\n      (set! s (bitwise-and (+ s i) ${M})))\n    s))\n`,
    reference: `(define (sumfrom x)\n  (let ((s x))\n    (do ((i 0 (+ i 1))) ((>= i 8))\n      (set! s (bitwise-and (+ s i) ${M})))\n    s))\n`,
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
    reference: `(define (avgfloor a b)\n  (bitwise-and (+ (bitwise-and a b) (arithmetic-shift (bitwise-xor a b) -1)) ${M}))\n`,
  },
  'b-sumsq-array': {
    source: `(define (sumsq a)\n  (let ((s 0))\n    (do ((i 0 (+ i 1))) ((>= i 4))\n      (set! s (bitwise-and (+ s (vector-ref a (modulo i 4))) ${M})))\n    s))\n`,
    reference: `(define (sumsq a)\n  (let ((s 0))\n    (do ((i 0 (+ i 1))) ((>= i 4))\n      (let ((x (vector-ref a (modulo i 4))))\n        (set! s (bitwise-and (+ s (* x x)) ${M}))))\n    s))\n`,
  },
  'b-inrange-inclusive': {
    source: '(define (inrange x lo hi)\n  (and (> x lo) (< x hi)))\n',
    reference: '(define (inrange x lo hi)\n  (and (>= x lo) (<= x hi)))\n',
  },
  'b-bounds-largest': {
    source: `(define (bounds a)\n  (let ((lo ${M}) (hi 0))\n    (do ((i 0 (+ i 1))) ((>= i 4))\n      (let ((x (vector-ref a (modulo i 4))))\n        (when (< x lo) (set! lo x))\n        (when (< x hi) (set! hi x))))\n    (vector lo hi)))\n`,
    reference: `(define (bounds a)\n  (let ((lo ${M}) (hi 0))\n    (do ((i 0 (+ i 1))) ((>= i 4))\n      (let ((x (vector-ref a (modulo i 4))))\n        (when (< x lo) (set! lo x))\n        (when (> x hi) (set! hi x))))\n    (vector lo hi)))\n`,
  },
  'b-checksum-poly': {
    source: `(define (checksum a)\n  (let ((h 0))\n    (do ((i 0 (+ i 1))) ((>= i 4))\n      (set! h (bitwise-xor h (vector-ref a (modulo i 4)))))\n    h))\n`,
    reference: `(define (checksum a)\n  (let ((h 7))\n    (do ((i 0 (+ i 1))) ((>= i 4))\n      (set! h (bitwise-and (+ (* h 31) (vector-ref a (modulo i 4))) ${M})))\n    h))\n`,
  },
  'b-norm2-dot': {
    source: `(define (dot a b)\n  (let ((s 0))\n    (do ((i 0 (+ i 1))) ((>= i 4))\n      (set! s (bitwise-and (+ s (* (vector-ref a (modulo i 4)) (vector-ref b (modulo i 4)))) ${M})))\n    s))\n`,
    reference: `(define (dot a b)\n  (let ((s 0))\n    (do ((i 0 (+ i 1))) ((>= i 4))\n      (set! s (bitwise-and (+ s (* (vector-ref a (modulo i 4)) (vector-ref b (modulo i 4)))) ${M})))\n    s))\n(define (norm2 a)\n  (dot a a))\n`,
  },
  'b-pctof-limit': {
    source: '(define (limit x lo hi)\n  (let ((b (if (< x lo) lo x)))\n    (if (> b hi) hi b)))\n',
    reference: `(define (limit x lo hi)\n  (let ((b (if (< x lo) lo x)))\n    (if (> b hi) hi b)))\n(define (pctof part whole)\n  (let* ((n (bitwise-and (* part 100) ${M}))\n         (q (if (= whole 0) ${M} (quotient n whole))))\n    (limit q 0 100)))\n`,
  },
  'b-hamming-popcnt': {
    source: `(define (popcnt x)\n  (let ((s 0))\n    (do ((i 0 (+ i 1))) ((>= i 32))\n      (set! s (bitwise-and (+ s (bitwise-and (arithmetic-shift x (- i)) 1)) ${M})))\n    s))\n`,
    reference: `(define (popcnt x)\n  (let ((s 0))\n    (do ((i 0 (+ i 1))) ((>= i 32))\n      (set! s (bitwise-and (+ s (bitwise-and (arithmetic-shift x (- i)) 1)) ${M})))\n    s))\n(define (hamming a b)\n  (popcnt (bitwise-xor a b)))\n`,
  },
};

export const RACKET: LangSpec = {
  semantics:
    'Integers are unsigned 32-bit but Racket integers are exact and unbounded: mask every arithmetic result with (bitwise-and ... M) where M is #xFFFFFFFF (already defined), mask shift counts to 5 bits; comparisons are unsigned. Division by zero gives 4294967295; remainder by zero gives the dividend. Arrays and records are vectors. The file is a racket/base module that provides all its definitions and must compile with racket.',
  head: /^\(define \(([^\s()]+)/,
  file: (body) => `#lang racket/base\n(provide (all-defined-out))\n(define M #xFFFFFFFF)\n${body}`,
  b: B,
  driver,
  compileLabel: 'racket',
  async buildAndRun(dir, source, drv) {
    const racket = tool('racket', 'A0_RACKET', ['/opt/homebrew/bin/racket']);
    await writeFile(join(dir, 'mod.rkt'), source, 'utf8');
    await writeFile(join(dir, 'driver.rkt'), drv, 'utf8');
    const build = runTool(racket, ['mod.rkt'], { cwd: dir, timeoutMs: BUILD_MS });
    if (!build.ok) return failure('racket', build);
    const run = runTool(racket, ['driver.rkt'], { cwd: dir, timeoutMs: RUN_MS });
    if (!run.ok) return failure('run', run);
    return { stdout: run.stdout };
  },
};
