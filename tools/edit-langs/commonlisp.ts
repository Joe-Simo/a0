/**
 * Common Lisp (SBCL): u32 values are unbounded integers masked with (logand ... #xFFFFFFFF)
 * after every operation that can leave the range; booleans are t/nil, records and u32x4
 * arrays are simple vectors. The candidate is compiled with compile-file (a reader error or
 * a full warning fails the build), then loaded with the driver.
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

const lispString = (s: string): string => `"${s.replace(/[\\"]/g, '\\$&')}"`;

function literal(v: Value, t: Type | undefined): string {
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 't' : 'nil';
  const fields = recordFields(t);
  return `(vector ${Array.from(v as ArrayLike<Value>, (x, i) => literal(x, fields[i])).join(' ')})`;
}

function render(expr: string, t: Type | undefined): string {
  if (t === 'bool') return `(fb ${expr})`;
  const fields = recordFields(t);
  if (fields.length > 0)
    return `(format nil "[~{~A~^,~}]" (list ${fields
      .map((ft, i) => render(`(aref ${expr} ${i})`, ft))
      .join(' ')}))`;
  return `(fu ${expr})`;
}

function driver(tests: readonly LangCase[], typed: Parameters<LangSpec['driver']>[1]): string {
  const body = tests
    .map((t, i) => {
      const { params, result } = signature(typed, t.fn);
      const args = t.args.map((a, k) => literal(a, params[k])).join(' ');
      return `(let ((v (${t.fn}${args.length > 0 ? ` ${args}` : ''})))\n  (format t "R${i} ~A~%" ${render('v', result)}))`;
    })
    .join('\n');
  return `(defun fu (v) (format nil "~D" v))\n(defun fb (v) (if v "true" "false"))\n\n${body}\n(format t "DONE~%")\n`;
}

const B: LangSpec['b'] = {
  'b-fits-inclusive': {
    source: '(defun fits (a b)\n  (< a b))\n',
    reference: '(defun fits (a b)\n  (<= a b))\n',
  },
  'b-sumfrom-eight': {
    source: `(defun sumfrom (x)\n  (let ((s x))\n    (dotimes (i 5)\n      (setf s (logand (+ s i) ${M})))\n    s))\n`,
    reference: `(defun sumfrom (x)\n  (let ((s x))\n    (dotimes (i 8)\n      (setf s (logand (+ s i) ${M})))\n    s))\n`,
  },
  'b-rot8-constant': {
    source: `(defun rot8 (x)\n  (logand (logior (ash x 8) (ash x -23)) ${M}))\n`,
    reference: `(defun rot8 (x)\n  (logand (logior (ash x 8) (ash x -24)) ${M}))\n`,
  },
  'b-onlyone-xor': {
    source: '(defun onlyone (a b)\n  (or a b))\n',
    reference: '(defun onlyone (a b)\n  (not (eq a b)))\n',
  },
  'b-avgfloor-nowrap': {
    source: `(defun avgfloor (a b)\n  (ash (logand (+ a b) ${M}) -1))\n`,
    reference: '(defun avgfloor (a b)\n  (+ (logand a b) (ash (logxor a b) -1)))\n',
  },
  'b-sumsq-array': {
    source: `(defun sumsq (a)\n  (let ((s 0))\n    (dotimes (i 4)\n      (setf s (logand (+ s (aref a (mod i 4))) ${M})))\n    s))\n`,
    reference: `(defun sumsq (a)\n  (let ((s 0))\n    (dotimes (i 4)\n      (let ((x (aref a (mod i 4))))\n        (setf s (logand (+ s (* x x)) ${M}))))\n    s))\n`,
  },
  'b-inrange-inclusive': {
    source: '(defun inrange (x lo hi)\n  (and (> x lo) (< x hi)))\n',
    reference: '(defun inrange (x lo hi)\n  (and (>= x lo) (<= x hi)))\n',
  },
  'b-bounds-largest': {
    source: `(defun bounds (a)\n  (let ((lo ${M}) (hi 0))\n    (dotimes (i 4)\n      (let ((x (aref a (mod i 4))))\n        (when (< x lo) (setf lo x))\n        (when (< x hi) (setf hi x))))\n    (vector lo hi)))\n`,
    reference: `(defun bounds (a)\n  (let ((lo ${M}) (hi 0))\n    (dotimes (i 4)\n      (let ((x (aref a (mod i 4))))\n        (when (< x lo) (setf lo x))\n        (when (> x hi) (setf hi x))))\n    (vector lo hi)))\n`,
  },
  'b-checksum-poly': {
    source: `(defun checksum (a)\n  (let ((h 0))\n    (dotimes (i 4)\n      (setf h (logand (logxor h (aref a (mod i 4))) ${M})))\n    h))\n`,
    reference: `(defun checksum (a)\n  (let ((h 7))\n    (dotimes (i 4)\n      (setf h (logand (+ (* h 31) (aref a (mod i 4))) ${M})))\n    h))\n`,
  },
  'b-norm2-dot': {
    source: `(defun dot (a b)\n  (let ((s 0))\n    (dotimes (i 4)\n      (setf s (logand (+ s (* (aref a (mod i 4)) (aref b (mod i 4)))) ${M})))\n    s))\n`,
    reference: `(defun dot (a b)\n  (let ((s 0))\n    (dotimes (i 4)\n      (setf s (logand (+ s (* (aref a (mod i 4)) (aref b (mod i 4)))) ${M})))\n    s))\n(defun norm2 (a)\n  (dot a a))\n`,
  },
  'b-pctof-limit': {
    source: '(defun limit (x lo hi)\n  (let ((b (if (< x lo) lo x)))\n    (if (> b hi) hi b)))\n',
    reference: `(defun limit (x lo hi)\n  (let ((b (if (< x lo) lo x)))\n    (if (> b hi) hi b)))\n(defun pctof (part whole)\n  (let* ((n (logand (* part 100) ${M}))\n         (q (if (= whole 0) ${M} (floor n whole))))\n    (limit q 0 100)))\n`,
  },
  'b-hamming-popcnt': {
    source: `(defun popcnt (x)\n  (let ((s 0))\n    (dotimes (i 32)\n      (setf s (logand (+ s (logand (ash x (- i)) 1)) ${M})))\n    s))\n`,
    reference: `(defun popcnt (x)\n  (let ((s 0))\n    (dotimes (i 32)\n      (setf s (logand (+ s (logand (ash x (- i)) 1)) ${M})))\n    s))\n(defun hamming (a b)\n  (popcnt (logxor a b)))\n`,
  },
};

/** Compiles mod.lisp to mod.fasl; any reader error or full warning exits non-zero. */
const buildScript = (src: string, out: string): string =>
  `(handler-case
    (multiple-value-bind (fasl warnings failed)
        (compile-file ${lispString(src)} :output-file ${lispString(out)})
      (declare (ignore warnings))
      (when (or (null fasl) failed)
        (format *error-output* "compilation failed~%")
        (sb-ext:exit :code 1 :abort t)))
  (error (e)
    (format *error-output* "error: ~A~%" e)
    (sb-ext:exit :code 1 :abort t)))
`;

export const COMMONLISP: LangSpec = {
  semantics: `Integers are unbounded: mask every arithmetic result with (logand ... ${M}), mask shift counts to 5 bits (logand n 31); comparisons are unsigned. Booleans are t and nil; u32x4 arrays and records are simple vectors. Division by zero gives 4294967295; remainder by zero gives the dividend. The file must compile with SBCL (compile-file) without warnings.`,
  head: /^\(defun ([a-z][a-z0-9-]*) /,
  file: (body) => body,
  b: B,
  driver,
  compileLabel: 'sbcl',
  async buildAndRun(dir, source, drv) {
    const sbcl = tool('sbcl', 'A0_SBCL', ['/opt/homebrew/bin/sbcl', '/usr/local/bin/sbcl']);
    const mod = join(dir, 'mod.lisp');
    const fasl = join(dir, 'mod.fasl');
    const build = join(dir, 'build.lisp');
    await writeFile(mod, source, 'utf8');
    await writeFile(join(dir, 'driver.lisp'), drv, 'utf8');
    await writeFile(build, buildScript(mod, fasl), 'utf8');
    const flags = ['--noinform', '--non-interactive', '--no-userinit', '--no-sysinit'];
    const c = runTool(sbcl, [...flags, '--load', build], { cwd: dir, timeoutMs: BUILD_MS });
    if (!c.ok) return failure('sbcl', c);
    const run = runTool(sbcl, [...flags, '--load', fasl, '--load', join(dir, 'driver.lisp')], {
      cwd: dir,
      timeoutMs: RUN_MS,
    });
    if (!run.ok) return failure('run', run);
    return { stdout: run.stdout };
  },
};
