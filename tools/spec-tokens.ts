/**
 * What spec lines cost in tokens: the `ex` lines of a function (0, 1 or 3 of them) in the canonical
 * and the dense text, in o200k_base and cl100k_base, per function and per 40-function view.
 *
 * Programs: examples/*.a0 (the kernels and the life program), the twelve set-B starting programs,
 * and the 40-function project program of set C (the view a model reads at project scale). The
 * examples are the function's own results on deterministic small inputs (the reference
 * interpreter computes the expected value; a model writes about the same shape of line), so every
 * counted program validates, which the tool checks. No model is called.
 *
 * Usage: bun run spec-tokens   (writes results/spec-tokens.json through writeReport)
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getEncoding } from 'js-tiktoken';
import {
  type Func,
  formatFunction,
  formatProgram,
  type Program,
  parse,
  parseAndValidate,
  run,
  type Type,
  type TypedFunc,
  type Value,
} from '../src/core.js';
import { formatDense, formatDenseFunction, normalizeProgram } from '../src/dense.js';
import { litOf, withSpec } from '../src/spec.js';
import { TASKS_A } from './ai-edit-tasks-a.js';
import { TASKS_B } from './ai-edit-tasks-b.js';
import { buildTasksC } from './ai-edit-tasks-c.js';
import { writeReport } from './scrub-results.js';

const o200k = getEncoding('o200k_base');
const cl100k = getEncoding('cl100k_base');
type Pair = { o200k: number; cl100k: number };
const count = (s: string): Pair => ({
  o200k: o200k.encode(s).length,
  cl100k: cl100k.encode(s).length,
});

/** Deterministic generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function exValue(type: Type, next: () => number): Value {
  if (type === 'u32') return Math.floor(next() * 100);
  if (type === 'bool') return next() < 0.5;
  if (type === 'io') throw new Error('io parameter');
  if (type.kind === 'arr')
    return Array.from({ length: type.length }, () => exValue(type.elem, next));
  return type.fields.map((f) => exValue(f, next));
}

const hash = (s: string): number => {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h;
};

/** Up to `k` distinct examples of `fn`: deterministic inputs, results from the interpreter. */
function examplesOf(fn: TypedFunc, k: number): { args: Value[]; result: Value }[] {
  const next = rng(hash(fn.name));
  const out: { args: Value[]; result: Value }[] = [];
  const seen = new Set<string>();
  for (let tries = 0; tries < 200 && out.length < k; tries += 1) {
    const args = fn.params.map((t) => exValue(t, next));
    try {
      const result = run(fn, args, { fuel: 5000 });
      const key = JSON.stringify(args);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ args, result });
    } catch {
      // a trap or a fuel stop: not an example
    }
  }
  return out;
}

interface Unit {
  readonly name: string;
  readonly source: string;
}

/** A program with `k` examples on each function that can have them. */
function withExamples(source: string, k: number): Program {
  const typed = parseAndValidate(source);
  const program = parse(source);
  const funcs: Func[] = program.functions.map((fn) => {
    const t = typed.byName.get(fn.name) as TypedFunc;
    if (k === 0 || t.params.some((p) => p === 'io') || t.result === 'io') return fn;
    const exs = examplesOf(t, k).map((e) => ({
      args: e.args.map((a, i) => litOf(a, t.params[i] as Type)),
      result: litOf(e.result, t.result),
    }));
    return exs.length === 0 ? fn : withSpec(fn, { examples: exs });
  });
  return { ...program, functions: funcs };
}

const KS = [0, 1, 3] as const;

function load(): Unit[] {
  const units: Unit[] = [];
  for (const f of ['kernels.a0', 'life.a0'])
    units.push({ name: `examples/${f}`, source: readFileSync(join('examples', f), 'utf8') });
  for (const t of TASKS_B) units.push({ name: t.id, source: t.a0Source });
  return units;
}

interface Row {
  readonly fn: string;
  readonly unit: string;
  readonly requested: number;
  readonly exampleLines: number;
  readonly canonical: Pair;
  readonly dense: Pair;
}

const units = load();
const perFunction: Row[] = [];
for (const unit of units) {
  for (const k of KS) {
    const program = withExamples(unit.source, k);
    // the program with its examples must still validate (the examples hold)
    parseAndValidate(formatProgram(program));
    const dense = normalizeProgram(program);
    for (const fn of program.functions) {
      const dfn = dense.functions.find((f) => f.name === fn.name);
      perFunction.push({
        fn: fn.name,
        unit: unit.name,
        requested: k,
        exampleLines: fn.spec?.examples.length ?? 0,
        canonical: count(formatFunction(fn)),
        dense: dfn === undefined ? { o200k: 0, cl100k: 0 } : count(formatDenseFunction(dfn, dense)),
      });
    }
  }
}

const r2 = (x: number): number => Math.round(x * 100) / 100;
const mean = (xs: Pair[]): Pair => ({
  o200k: r2(xs.reduce((a, b) => a + b.o200k, 0) / xs.length),
  cl100k: r2(xs.reduce((a, b) => a + b.cl100k, 0) / xs.length),
});
// Mean per function by the number of example lines the function carries; the cost of the lines
// is the difference to the same functions with none (functions that could carry examples only).
const carrying = new Set(
  perFunction
    .filter((r) => r.requested === 3 && r.exampleLines > 0)
    .map((r) => `${r.unit}/${r.fn}`),
);
const sub = (a: Pair, b: Pair): Pair => ({
  o200k: r2(a.o200k - b.o200k),
  cl100k: r2(a.cl100k - b.cl100k),
});
const base = perFunction.filter((r) => r.requested === 0 && carrying.has(`${r.unit}/${r.fn}`));
const perFunctionMean = Object.fromEntries(
  KS.map((k) => {
    const rows = perFunction.filter((r) => r.requested === k && carrying.has(`${r.unit}/${r.fn}`));
    const c = mean(rows.map((r) => r.canonical));
    const d = mean(rows.map((r) => r.dense));
    return [
      `${k}`,
      {
        functions: rows.length,
        meanExampleLines: r2(rows.reduce((a, r) => a + r.exampleLines, 0) / rows.length),
        canonical: c,
        dense: d,
        canonicalAddedPerFunction: sub(c, mean(base.map((r) => r.canonical))),
        denseAddedPerFunction: sub(d, mean(base.map((r) => r.dense))),
      },
    ];
  }),
);

// The 40-function view: set C's project program.
const project = buildTasksC(TASKS_A, TASKS_B, 40)[0];
if (project === undefined) throw new Error('no set C task');
const view40 = KS.map((k) => {
  const program = withExamples(project.a0Source, k);
  parseAndValidate(formatProgram(program));
  return {
    exLinesPerFunction: k,
    functions: program.functions.length,
    functionsWithExamples: program.functions.filter((f) => f.spec !== undefined).length,
    canonical: count(formatProgram(program)),
    dense: count(formatDense(normalizeProgram(program))),
  };
});
const v0 = view40[0];
const withDelta = view40.map((v) => ({
  ...v,
  canonicalAdded: v0 === undefined ? null : sub(v.canonical, v0.canonical),
  denseAdded: v0 === undefined ? null : sub(v.dense, v0.dense),
}));

await writeReport(join('results', 'spec-tokens.json'), {
  generatedAt: new Date().toISOString(),
  note: 'o200k_base and cl100k_base local js-tiktoken counts (not the vendor tokenizer). Examples are the interpreter results of the function on deterministic small inputs; every counted program validates. No model was called.',
  programs: units.map((u) => u.name),
  view40Program: 'set C project program (40 functions, tools/ai-edit-tasks-c.ts)',
  perFunctionMeanByRequestedExampleLines: perFunctionMean,
  view40: withDelta,
  perFunction,
});
process.stdout.write(`${JSON.stringify({ perFunctionMean, view40: withDelta }, null, 1)}\n`);
