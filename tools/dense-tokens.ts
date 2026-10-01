/**
 * Where the o200k tokens of an A0 program go, and what the dense view (src/dense.ts) saves.
 *
 * For the benchmark kernels and a sample of the corpus (examples, compiler, site, seed, the
 * generated corpus) this tool counts o200k_base tokens of
 *   canonical     the canonical text (what A0 needs today),
 *   dense exact   the dense text of the program as it is (lossless: same ids, same node order),
 *   dense         the dense text of the program after `normalizeProgram` (same behavior, nodes
 *                 ordered and named for the dense form; what a model writing dense text writes),
 * attributes every token to the construct it belongs to (header, types, ids, parameters,
 * operations, literals, newlines, ...), and ablates each dense feature by printing the same
 * programs with that one feature off (`DenseStyle`), so `saved` is what the feature buys.
 *
 * Usage: bun run dense-tokens [-- --out=results/dense-tokens.json]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getEncoding } from 'js-tiktoken';
import { formatProgram, OPS, type Program, parse } from '../src/core.js';
import { type Arities, type DenseStyle, formatDense, normalizeProgram } from '../src/dense.js';
import { parseFile } from '../src/link.js';
import { generateCorpus } from './corpus.js';
import { KERNELS } from './exec-bench-kernels.js';
import { reportJson } from './scrub-results.js';

const enc = getEncoding('o200k_base');
export const tokens = (s: string): number => enc.encode(s).length;

/** The kernels lang-axes reports. */
export const TOKEN_KERNELS: readonly string[] = [
  'affine',
  'rotl',
  'clamp',
  'mix',
  'ident',
  'noop',
  'chain3',
  'branchy',
  'arrfill',
  'loop64',
];

const OPSET = new Set<string>([...OPS, 'udiv', 'urem', '<<', '>>']);
const NUMBER = /^(0|[1-9][0-9]*)$/;

function classify(
  word: string,
  c: { afterFn: boolean; first: boolean; canonical: boolean },
): string {
  if (c.afterFn) return 'fn name';
  if (word === 'fn') return 'fn keyword';
  if (word === 'end') return 'end';
  if (word === 'ret') return 'ret';
  if (word === '->') return 'arrow';
  if (/^(u32|bool|io|_)(x[0-9]+)*$/.test(word) || /^\(.*\)$/.test(word)) return 'types';
  if (NUMBER.test(word) || word === 'true' || word === 'false') return 'literal';
  if (/^p[0-9]+$/.test(word) || /^[A-Z]$/.test(word)) return 'parameter';
  if (OPSET.has(word)) return 'operation';
  if (c.canonical && c.first) return 'id definition';
  if (/^\$?[a-z][a-z0-9_]*$/.test(word)) return 'id reference';
  return 'punctuation';
}

/** Tokens of `text` per construct: a token takes the class of the word it (or its space) starts. */
export function attribute(text: string, canonical: boolean): Record<string, number> {
  const label: string[] = new Array<string>(text.length).fill('newline');
  let off = 0;
  for (const line of text.split('\n')) {
    const words: { w: string; at: number }[] = [];
    for (const m of line.matchAll(/\S+/g)) words.push({ w: m[0], at: m.index ?? 0 });
    words.forEach(({ w, at }, wi) => {
      let c = classify(w, {
        afterFn: wi === 1 && words[0]?.w === 'fn',
        first: wi === 0,
        canonical,
      });
      const before = words[wi - 1]?.w;
      if (
        !canonical &&
        c === 'id reference' &&
        (before === 'fold' || before === 'loop' || before === 'call')
      )
        c = 'callee name';
      if (canonical && wi === 2 && c === 'id reference' && !OPSET.has(words[1]?.w ?? ''))
        c = 'callee name';
      for (let k = 0; k < w.length; k += 1) label[off + at + k] = c;
      for (let b = at - 1; b >= 0 && line[b] === ' '; b -= 1) label[off + b] = c;
    });
    off += line.length + 1;
  }
  const out: Record<string, number> = {};
  let pos = 0;
  for (const id of enc.encode(text)) {
    const c = label[pos] ?? 'newline';
    out[c] = (out[c] ?? 0) + 1;
    pos += enc.decode([id]).length;
  }
  return out;
}

function addTo(into: Record<string, number>, from: Record<string, number>): void {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
}

/** The dense text of a canonical source as a model writing dense text writes it. */
export function denseOf(source: string): string {
  return formatDense(normalizeProgram(parse(source))).trimEnd();
}

interface Unit {
  readonly name: string;
  readonly canonical: string;
  readonly program: Program;
  readonly known: Arities;
}

const ABLATIONS: readonly {
  readonly name: string;
  readonly what: string;
  readonly style: DenseStyle;
}[] = [
  {
    name: 'prefix nesting',
    what: 'a value used once is its own statement, not nested',
    style: { nest: false },
  },
  { name: 'implicit ids', what: 'every statement carries its id', style: { implicitIds: false } },
  {
    name: 'implicit types',
    what: 'every header lists its parameter types and `-> u32` (as canonical does)',
    style: { implicitTypes: false },
  },
  { name: 'parameter letters', what: 'p0, p1, p2 instead of A, B, C', style: { letters: false } },
  { name: 'shift symbols', what: 'shl and shr instead of << and >>', style: { symbols: false } },
  { name: 'repeat arrays', what: '[0 0 0 0 0 0 0 0] instead of [0;8]', style: { repeat: false } },
  {
    name: 'joined header',
    what: 'a one-statement function on its fn line',
    style: { join: false },
  },
  {
    name: 'implicit result',
    what: '`ret` before the last statement and `end` after the function',
    style: { implicitRet: false },
  },
];

function render(u: Unit, style: DenseStyle): string {
  return formatDense(normalizeProgram(u.program), { known: u.known, style }).trimEnd();
}

async function main(): Promise<void> {
  const out =
    process.argv.find((a) => a.startsWith('--out='))?.slice(6) ??
    join('results', 'dense-tokens.json');
  const kernels: Unit[] = KERNELS.filter((k) => TOKEN_KERNELS.includes(k.name)).map((k) => ({
    name: k.name,
    canonical: k.a0,
    program: parse(k.a0),
    known: new Map(),
  }));
  const corpus: Unit[] = [];
  for (const f of [
    'examples/life.a0',
    'compiler/lex.a0',
    'site/ui.a0',
    'seed/chunks/00.a0',
    'site/gen/sgcalc.a0',
  ]) {
    const { program, known } = await parseFile(f, async (p) => readFileSync(p, 'utf8'));
    corpus.push({ name: f, canonical: readFileSync(f, 'utf8'), program, known });
  }
  const generated = generateCorpus();
  corpus.push({
    name: 'generated corpus (48 functions)',
    canonical: formatProgram({ functions: generated.functions }),
    program: { functions: generated.functions },
    known: new Map(),
  });

  const rows = (units: readonly Unit[]) =>
    units.map((u) => {
      const canonical = tokens(u.canonical);
      return {
        name: u.name,
        canonical,
        denseExact: tokens(formatDense(u.program, { known: u.known }).trimEnd()),
        dense: tokens(render(u, {})),
      };
    });
  const sum = (
    r: readonly { canonical: number; denseExact: number; dense: number }[],
    k: 'canonical' | 'denseExact' | 'dense',
  ): number => r.reduce((n, x) => n + x[k], 0);
  const kernelRows = rows(kernels);
  const corpusRows = rows(corpus);

  const attribution: Record<string, Record<string, Record<string, number>>> = {};
  for (const [name, units] of [
    ['kernels', kernels],
    ['corpus', corpus],
  ] as const) {
    const a: Record<string, Record<string, number>> = { canonical: {}, denseExact: {}, dense: {} };
    for (const u of units) {
      addTo(a.canonical as Record<string, number>, attribute(u.canonical, true));
      addTo(
        a.denseExact as Record<string, number>,
        attribute(formatDense(u.program, { known: u.known }).trimEnd(), false),
      );
      addTo(a.dense as Record<string, number>, attribute(render(u, {}), false));
    }
    attribution[name] = a;
  }

  const ablation = ABLATIONS.map((ab) => {
    const delta = (units: readonly Unit[]): number =>
      units.reduce((n, u) => n + tokens(render(u, ab.style)) - tokens(render(u, {})), 0);
    return {
      name: ab.name,
      what: ab.what,
      kernelsSaved: delta(kernels),
      corpusSaved: delta(corpus),
    };
  });

  const report = {
    generatedAt: new Date().toISOString(),
    tool: 'tools/dense-tokens.ts',
    tokenizer: 'o200k_base (js-tiktoken)',
    meaning:
      "canonical: today's text. denseExact: the dense text of the same program (lossless, same ids and node order). dense: the dense text after normalizeProgram (behavior unchanged; node order and ids chosen for the dense form), what a model writing dense text writes. attribution: tokens per construct summed over the set. ablation: tokens each dense feature saves (the same programs printed with that one feature off, minus the dense text).",
    kernels: kernelRows,
    kernelTotals: {
      canonical: sum(kernelRows, 'canonical'),
      denseExact: sum(kernelRows, 'denseExact'),
      dense: sum(kernelRows, 'dense'),
    },
    corpus: corpusRows,
    corpusTotals: {
      canonical: sum(corpusRows, 'canonical'),
      denseExact: sum(corpusRows, 'denseExact'),
      dense: sum(corpusRows, 'dense'),
    },
    attribution,
    ablation,
  };
  writeFileSync(out, reportJson(report), 'utf8');
  process.stderr.write(`wrote ${out}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exit(1);
  });
}
