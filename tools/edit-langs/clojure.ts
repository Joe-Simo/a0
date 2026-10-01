/**
 * Clojure: u32 values are longs masked with bit-and 0xFFFFFFFF after every operation that can
 * leave the range (products use unchecked-multiply, so they wrap mod 2^64 and the low 32 bits
 * stay exact); records and u32x4 arrays are vectors. The candidate is the namespace file
 * mod.clj, loaded by the driver script in a single JVM run via the clojure CLI.
 */

import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Type, Value } from '../../src/core.js';
import { findJava, runTool } from '../../src/toolchain.js';
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

const M = '0xFFFFFFFF';
const LOAD_FAILED = 3;

function literal(v: Value, t: Type | undefined): string {
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return String(v);
  const fields = recordFields(t);
  return `[${Array.from(v as ArrayLike<Value>, (x, i) => literal(x, fields[i])).join(' ')}]`;
}

function render(expr: string, t: Type | undefined): string {
  const fields = recordFields(t);
  if (fields.length > 0)
    return `(str "[" ${fields.map((ft, i) => render(`(nth ${expr} ${i})`, ft)).join(' "," ')} "]")`;
  return `(str ${expr})`;
}

function driver(tests: readonly LangCase[], typed: Parameters<LangSpec['driver']>[1]): string {
  const body = tests
    .map((t, i) => {
      const { params, result } = signature(typed, t.fn);
      const args = t.args.map((a, k) => literal(a, params[k])).join(' ');
      return `(let [v (mod/${t.fn}${args.length > 0 ? ` ${args}` : ''})]\n  (println (str "R${i} " ${render('v', result)})))`;
    })
    .join('\n');
  return `(try\n  (load-file "mod.clj")\n  (catch Throwable e\n    (binding [*out* *err*] (println (str "load failed: " e)))\n    (System/exit ${LOAD_FAILED})))\n${body}\n(println "DONE")\n(flush)\n(shutdown-agents)\n`;
}

const B: LangSpec['b'] = {
  'b-fits-inclusive': {
    source: '(defn fits [a b]\n  (< a b))\n',
    reference: '(defn fits [a b]\n  (<= a b))\n',
  },
  'b-sumfrom-eight': {
    source: `(defn sumfrom [x]\n  (loop [i 0 s x]\n    (if (< i 5)\n      (recur (inc i) (bit-and (+ s i) ${M}))\n      s)))\n`,
    reference: `(defn sumfrom [x]\n  (loop [i 0 s x]\n    (if (< i 8)\n      (recur (inc i) (bit-and (+ s i) ${M}))\n      s)))\n`,
  },
  'b-rot8-constant': {
    source: `(defn rot8 [x]\n  (bit-and (bit-or (bit-shift-left x 8) (bit-shift-right x 23)) ${M}))\n`,
    reference: `(defn rot8 [x]\n  (bit-and (bit-or (bit-shift-left x 8) (bit-shift-right x 24)) ${M}))\n`,
  },
  'b-onlyone-xor': {
    source: '(defn onlyone [a b]\n  (or a b))\n',
    reference: '(defn onlyone [a b]\n  (not= a b))\n',
  },
  'b-avgfloor-nowrap': {
    source: `(defn avgfloor [a b]\n  (bit-shift-right (bit-and (+ a b) ${M}) 1))\n`,
    reference: '(defn avgfloor [a b]\n  (+ (bit-and a b) (bit-shift-right (bit-xor a b) 1)))\n',
  },
  'b-sumsq-array': {
    source: `(defn sumsq [a]\n  (loop [i 0 s 0]\n    (if (< i 4)\n      (recur (inc i) (bit-and (+ s (nth a i)) ${M}))\n      s)))\n`,
    reference: `(defn sumsq [a]\n  (loop [i 0 s 0]\n    (if (< i 4)\n      (recur (inc i) (bit-and (+ s (unchecked-multiply (nth a i) (nth a i))) ${M}))\n      s)))\n`,
  },
  'b-inrange-inclusive': {
    source: '(defn inrange [x lo hi]\n  (and (> x lo) (< x hi)))\n',
    reference: '(defn inrange [x lo hi]\n  (and (>= x lo) (<= x hi)))\n',
  },
  'b-bounds-largest': {
    source: `(defn bounds [a]\n  (loop [i 0 lo ${M} hi 0]\n    (if (< i 4)\n      (let [x (nth a i)]\n        (recur (inc i) (if (< x lo) x lo) (if (< x hi) x hi)))\n      [lo hi])))\n`,
    reference: `(defn bounds [a]\n  (loop [i 0 lo ${M} hi 0]\n    (if (< i 4)\n      (let [x (nth a i)]\n        (recur (inc i) (if (< x lo) x lo) (if (> x hi) x hi)))\n      [lo hi])))\n`,
  },
  'b-checksum-poly': {
    source:
      '(defn checksum [a]\n  (loop [i 0 h 0]\n    (if (< i 4)\n      (recur (inc i) (bit-xor h (nth a i)))\n      h)))\n',
    reference: `(defn checksum [a]\n  (loop [i 0 h 7]\n    (if (< i 4)\n      (recur (inc i) (bit-and (+ (unchecked-multiply h 31) (nth a i)) ${M}))\n      h)))\n`,
  },
  'b-norm2-dot': {
    source: `(defn dot [a b]\n  (loop [i 0 s 0]\n    (if (< i 4)\n      (recur (inc i) (bit-and (+ s (unchecked-multiply (nth a i) (nth b i))) ${M}))\n      s)))\n`,
    reference: `(defn dot [a b]\n  (loop [i 0 s 0]\n    (if (< i 4)\n      (recur (inc i) (bit-and (+ s (unchecked-multiply (nth a i) (nth b i))) ${M}))\n      s)))\n(defn norm2 [a]\n  (dot a a))\n`,
  },
  'b-pctof-limit': {
    source: '(defn limit [x lo hi]\n  (let [b (if (< x lo) lo x)]\n    (if (> b hi) hi b)))\n',
    reference: `(defn limit [x lo hi]\n  (let [b (if (< x lo) lo x)]\n    (if (> b hi) hi b)))\n(defn pctof [part whole]\n  (let [n (bit-and (unchecked-multiply part 100) ${M})\n        q (if (= whole 0) ${M} (quot n whole))]\n    (limit q 0 100)))\n`,
  },
  'b-hamming-popcnt': {
    source: `(defn popcnt [x]\n  (loop [i 0 s 0]\n    (if (< i 32)\n      (recur (inc i) (bit-and (+ s (bit-and (bit-shift-right x i) 1)) ${M}))\n      s)))\n`,
    reference: `(defn popcnt [x]\n  (loop [i 0 s 0]\n    (if (< i 32)\n      (recur (inc i) (bit-and (+ s (bit-and (bit-shift-right x i) 1)) ${M}))\n      s)))\n(defn hamming [a b]\n  (popcnt (bit-xor a b)))\n`,
  },
};

export const CLOJURE: LangSpec = {
  semantics: `Integers are unsigned 32-bit held in Clojure longs: mask every arithmetic result with (bit-and ... ${M}) and shift counts to 5 bits; multiply with unchecked-multiply; comparisons are on the masked values. Division by zero gives 4294967295; remainder by zero gives the dividend. u32x4 arrays and records are vectors. The file is the namespace mod (ns mod), loaded by a driver script with load-file.`,
  head: /^\(defn ([a-z_][A-Za-z0-9_-]*) /,
  file: (body) => `(ns mod)\n\n${body}`,
  b: B,
  driver,
  compileLabel: 'clojure',
  async buildAndRun(dir, source, drv) {
    const clj = tool('clojure', 'A0_CLOJURE', ['/opt/homebrew/bin/clojure']);
    await writeFile(join(dir, 'mod.clj'), source, 'utf8');
    await writeFile(join(dir, 'driver.clj'), drv, 'utf8');
    const java = findJava().path;
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (java !== undefined && env.JAVA_HOME === undefined) env.JAVA_HOME = dirname(dirname(java));
    // One JVM launch: the driver loads mod.clj (exit code 3 on a read/compile error), then runs.
    const r = runTool(clj, ['-M', join(dir, 'driver.clj')], {
      cwd: dir,
      env,
      timeoutMs: Math.max(BUILD_MS, RUN_MS),
    });
    if (r.status === LOAD_FAILED) return failure('clojure', r);
    if (!r.ok) return failure('run', r);
    return { stdout: r.stdout };
  },
};
