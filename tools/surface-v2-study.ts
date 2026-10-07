/**
 * Surface v2 study (RESEARCH, deterministic, no model, no network): where the o200k tokens of A0 go,
 * what a candidate canonical spelling ("v2", tools/surface-v2.ts) would write the same programs in,
 * and what that would do to the token-axis ledger entries. Nothing here changes the language.
 *
 *   bun tools/surface-v2-study.ts [--out=results/surface-v2.json]
 *
 * Sections written to the report:
 *   anatomy      per-spelling o200k token counts of the 10 token kernels in canonical, dense, v2 and the
 *                C, Rust, Python and TypeScript versions of the same kernels
 *   totals       tokens of the 10 token kernels, the 19 timed kernels, the corpus programs (examples,
 *                compiler, site, seed, generated) in canonical, dense and every v2 variant, and the rank of
 *                each among the 49 languages of results/lang-axes.json
 *   roundtrip    canonical -> v2 -> canonical over every program, exact and normalised, per variant, with a
 *                mutation control that must fail
 *   ledger       how many of the 377 recorded tokens-kernel losses each form would close at the o200k counts
 *   edits        tokens of the sealed task sets' source programs and reference edits in each form
 *   failures     recorded model failures by class, dense against canonical, from results/*.json
 *   cost         the edit-session cost model (tokens per accepted edit) with v2's sensitivity
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getEncoding } from 'js-tiktoken';
import {
  formatProgram,
  type Program,
  parse,
  type TypedFunc,
  validateFunction,
} from '../src/core.js';
import { type Arities, formatDense, normalizeProgram } from '../src/dense.js';
import { link, parseFile } from '../src/link.js';
import { generateCorpus } from './corpus.js';
import { denseOf } from './dense-tokens.js';
import { KERNELS } from './exec-bench-kernels.js';
import { LANGUAGES } from './exec-bench-languages.js';
import { MORE_LANGUAGES } from './exec-bench-languages-more.js';
import { reportJson } from './scrub-results.js';
import { canonicalOfV2, formatV2, inferResults, normalizeV2, type V2Style } from './surface-v2.js';

const enc = getEncoding('o200k_base');
const pieces = (s: string): string[] => enc.encode(s).map((i) => enc.decode([i]));
const tok = (s: string): number => enc.encode(s).length;

export const TOKEN_KERNELS = [
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
] as const;

/** The v2 variants measured (the first is the proposal). */
export const VARIANTS: readonly { id: string; what: string; style: V2Style; measureOnly?: true }[] =
  [
    {
      id: 'v2',
      what: 'the proposal: compact, infix with no precedence, nested single-use values, result type inferred',
      style: { inferResult: true },
    },
    {
      id: 'v2-explicit-result',
      what: 'the proposal with `-> T` written for a non-u32 result',
      style: {},
    },
    {
      id: 'v2-spaced',
      what: 'the proposal with spaces around operators, after commas and around `=`',
      style: { inferResult: true, spaced: true },
    },
    {
      id: 'v2-call-only',
      what: 'every operation a call `add(a,b)` (no infix)',
      style: { inferResult: true, infix: false },
    },
    {
      id: 'v2-p0',
      what: 'parameters spelled p0, p1 (as canonical) instead of A, B',
      style: { inferResult: true, letters: false },
      measureOnly: true,
    },
    {
      id: 'v2-no-nest',
      what: 'one operation per statement (no nesting)',
      style: { inferResult: true, nest: false },
    },
    {
      id: 'v2-ret-end',
      what: 'with `ret` and `end` kept',
      style: { inferResult: true, implicitRet: false },
      measureOnly: true,
    },
  ];

// ---------------------------------------------------------------- programs

interface Unit {
  readonly name: string;
  /** canonical text as counted (kernels: the exec-bench text; others: the canonical form) */
  readonly canonical: string;
  readonly program: Program;
  /** callee types from files the unit uses, for result inference */
  readonly known: ReadonlyMap<string, TypedFunc>;
  /** parameter counts of functions of used files (what the dense converter needs) */
  readonly arities?: Arities;
}

/** Dense text after normalizeProgram, as dense-tokens.ts counts it; undefined when the converter refuses. */
function denseText(u: Unit): string | undefined {
  try {
    return formatDense(normalizeProgram(u.program), { known: u.arities ?? new Map() }).trimEnd();
  } catch {
    return undefined;
  }
}

const trackedA0 = (): string[] =>
  execSync('git ls-files "*.a0"', { encoding: 'utf8' })
    .split('\n')
    .filter((f) => f !== '' && !f.startsWith('corpus/reject'));

async function scopeOf(path: string, src: string): Promise<Map<string, TypedFunc>> {
  const own = new Set(parse(src).functions.map((f) => f.name));
  if (/^use "/m.test(src)) {
    try {
      const l = await link(resolve(path), async (p) => readFileSync(p, 'utf8'));
      return new Map(
        l.program.functions.filter((f) => !own.has(f.name)).map((f) => [f.name, f] as const),
      );
    } catch {
      return new Map();
    }
  }
  const chunk = /^seed\/chunks\/(\d+)\.a0$/.exec(path);
  if (chunk !== null && Number(chunk[1]) > 0) {
    // the chunks are one program cut into files (each repeats the type function): type what types
    // on its own, function by function, the earlier chunks first
    const scope = new Map<string, TypedFunc>();
    for (let n = 0; n < Number(chunk[1]); n += 1) {
      const text = readFileSync(`seed/chunks/${String(n).padStart(2, '0')}.a0`, 'utf8');
      for (const f of parse(text).functions) {
        try {
          scope.set(f.name, validateFunction(f, scope));
        } catch {
          // a function the checker refuses on its own stays out of scope
        }
      }
    }
    return scope;
  }
  return new Map();
}

async function units(): Promise<{ kernels10: Unit[]; kernels19: Unit[]; corpus: Unit[] }> {
  const kernels19: Unit[] = KERNELS.map((k) => ({
    name: k.name,
    canonical: k.a0,
    program: parse(k.a0),
    known: new Map(),
  }));
  const kernels10 = kernels19.filter((u) => (TOKEN_KERNELS as readonly string[]).includes(u.name));
  const corpus: Unit[] = [];
  for (const f of trackedA0()) {
    const src = readFileSync(f, 'utf8');
    const program = parse(src);
    const { known: arities } = await parseFile(f, async (p) => readFileSync(p, 'utf8'));
    corpus.push({
      name: f,
      canonical: formatProgram(program),
      program,
      known: await scopeOf(f, src),
      arities,
    });
  }
  const gen = generateCorpus();
  const program: Program = { functions: gen.functions };
  corpus.push({
    name: 'generated corpus (48 functions)',
    canonical: formatProgram(program),
    program,
    known: new Map(),
  });
  return { kernels10, kernels19, corpus };
}

const sumOf = (us: readonly Unit[], f: (u: Unit) => string): number =>
  us.reduce((n, u) => n + tok(f(u).trimEnd()), 0);
const v2Of = (u: Unit, style: V2Style, normalized: boolean): string =>
  formatV2(normalized ? normalizeV2(u.program) : u.program, style);

// ---------------------------------------------------------------- anatomy

const OPWORDS = new Set([
  'mov',
  'add',
  'sub',
  'mul',
  'and',
  'or',
  'xor',
  'shl',
  'shr',
  'eq',
  'ne',
  'lt',
  'le',
  'gt',
  'ge',
  'select',
  'call',
  'fold',
  'loop',
  'arr',
  'rec',
  'get',
  'set',
  'at',
  'put',
  'read',
  'write',
  'div',
  'rem',
  'puts',
]);

function categoryOf(piece: string, prev: string | undefined): string {
  if (piece.includes('\n'))
    return piece.replace(/[^\n]/g, '').length > 1 ? 'blank line' : 'newline';
  const core = piece.replace(/[^A-Za-z0-9_]/g, '');
  if (core === '') return /^[\s]*->[\s]*$/.test(piece) ? 'keyword (->)' : 'punctuation or operator';
  if (core === 'fn' || core === 'ret' || core === 'end') return `keyword (${core})`;
  if (OPWORDS.has(core)) return 'operation name';
  if (core === 'u' || (core === '32' && prev?.trim() === 'u') || /^u32$/.test(core))
    return 'type u32';
  if (/^x\d+$/.test(core) || (/^\d+$/.test(core) && /x$/.test(prev?.trim() ?? '')))
    return 'type array';
  if (/^p$/.test(core) || (/^\d+$/.test(core) && prev?.trim() === 'p'))
    return 'parameter p0.. (canonical)';
  if (/^[A-Z]\d*$/.test(core)) return 'parameter letter';
  if (/^\d+$/.test(core)) return 'number literal';
  return 'name (id, function, fragment)';
}

function anatomy(texts: readonly string[]): {
  total: number;
  top: [string, number][];
  byCategory: Record<string, number>;
} {
  const counts = new Map<string, number>();
  const cat: Record<string, number> = {};
  let total = 0;
  for (const t of texts) {
    const ps = pieces(t);
    ps.forEach((p, i) => {
      total += 1;
      counts.set(p, (counts.get(p) ?? 0) + 1);
      const c = categoryOf(p, ps[i - 1]);
      cat[c] = (cat[c] ?? 0) + 1;
    });
  }
  return {
    total,
    top: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30),
    byCategory: cat,
  };
}

function otherLanguageKernels(lang: string): string[] | undefined {
  const all = [...LANGUAGES, ...MORE_LANGUAGES];
  const l = all.find((x) => x.id === lang);
  if (l === undefined) return undefined;
  return TOKEN_KERNELS.map((n) => (l.kernels as Record<string, string | undefined>)[n] ?? '');
}

// ---------------------------------------------------------------- sealed sets

const V2_PRIMER =
  'A0: reply whole functions: `fn f(A,B)`, lines `name=expr`, last line is the result; `-fn f` removes. expr: C operators, nested ones parenthesised `(A*B)+1`: + - * / % & | ^ << >> == != < <= > >=; calls select(c,a,b) get(a,i) set(a,i,v) at(r,k) put(r,k,v) rec(a,b) fold(f,n,s,a..) (s=f(s,i,a..) for i<n) f(a). [a,b] [0;8]. `fn f(A:u32x4)` types.';

const SET_FILES = [
  'a',
  'b',
  'd',
  'e',
  'f',
  'g',
  'h',
  'i',
  'j',
  'k',
  'l',
  'm',
  'n',
  'o',
  'p',
  'q',
  'r',
  's',
  't',
  'u',
  'v',
  'w',
];

interface EditTask {
  readonly id: string;
  readonly a0Source: string;
  readonly reference: { readonly a0: string };
}

const changedLines = (before: string, after: string): string => {
  const have = new Map<string, number>();
  for (const l of before.split('\n')) have.set(l, (have.get(l) ?? 0) + 1);
  const out: string[] = [];
  for (const l of after.split('\n')) {
    const n = have.get(l) ?? 0;
    if (n > 0) have.set(l, n - 1);
    else if (l !== '') out.push(l);
  }
  return out.join('\n');
};

async function editTokens(): Promise<Record<string, unknown>> {
  const style: V2Style = { inferResult: true };
  const sets: Record<string, Record<string, number>> = {};
  const total: Record<string, number> = {};
  let tasks = 0;
  let skipped = 0;
  const add = (set: string, key: string, n: number): void => {
    const row = sets[set] ?? {};
    sets[set] = row;
    row[key] = (row[key] ?? 0) + n;
    total[key] = (total[key] ?? 0) + n;
  };
  for (const s of SET_FILES) {
    let mod: Record<string, unknown>;
    try {
      mod = (await import(`./ai-edit-tasks-${s}.js`)) as Record<string, unknown>;
    } catch {
      continue;
    }
    for (const v of Object.values(mod)) {
      if (!Array.isArray(v)) continue;
      for (const t of v as EditTask[]) {
        if (typeof t?.a0Source !== 'string' || typeof t?.reference?.a0 !== 'string') continue;
        try {
          const before = parse(t.a0Source);
          const after = parse(t.reference.a0);
          const cb = formatProgram(before);
          const ca = formatProgram(after);
          const vb = formatV2(normalizeV2(before), style).trimEnd();
          const va = formatV2(normalizeV2(after), style).trimEnd();
          const vbx = formatV2(before, style).trimEnd();
          const vax = formatV2(after, style).trimEnd();
          const db = formatDense(normalizeProgram(before)).trimEnd();
          const da = formatDense(normalizeProgram(after)).trimEnd();
          add(s, 'tasks', 1);
          add(s, 'canonicalSource', tok(cb));
          add(s, 'canonicalReference', tok(ca));
          add(s, 'canonicalChangedLines', tok(changedLines(cb, ca)));
          add(s, 'denseSource', tok(db));
          add(s, 'denseReference', tok(da));
          add(s, 'denseChangedLines', tok(changedLines(db, da)));
          add(s, 'v2Source', tok(vb));
          add(s, 'v2Reference', tok(va));
          add(s, 'v2ChangedLines', tok(changedLines(vb, va)));
          add(s, 'v2ExactSource', tok(vbx));
          add(s, 'v2ExactReference', tok(vax));
          add(s, 'v2ExactChangedLines', tok(changedLines(vbx, vax)));
          tasks += 1;
        } catch {
          skipped += 1;
        }
      }
    }
  }
  return {
    note: 'Per sealed task set (tools/ai-edit-tasks-*.ts, read only): tokens of the source program and the reference whole-function edit in canonical, dense (normalised) and v2 (normalised; "Exact" keeps the task ids). ChangedLines: the lines of the reference that are not in the source (what a line edit costs). Sets c (projects) are not included. Nothing in those files is changed.',
    tasks,
    skipped,
    total,
    sets,
  };
}

// ---------------------------------------------------------------- main report

async function main(): Promise<void> {
  const out =
    process.argv.find((a) => a.startsWith('--out='))?.slice(6) ??
    join('results', 'surface-v2.json');
  const { kernels10, kernels19, corpus } = await units();
  const axes = JSON.parse(readFileSync('results/lang-axes.json', 'utf8')) as {
    tokens: Record<
      string,
      {
        sumKernelTokens: number;
        kernelsCovered: number;
        kernels: Record<string, { kernel: number }>;
        dense?: { sumKernelTokens: number; kernels: Record<string, { kernel: number }> };
      }
    >;
  };
  const others = Object.entries(axes.tokens).filter(
    ([id, v]) => id !== 'a0' && v.kernelsCovered === 10,
  );
  const rankOf = (sum: number): number =>
    1 + others.filter(([, v]) => v.sumKernelTokens < sum).length;
  const bestOther = Math.min(...others.map(([, v]) => v.sumKernelTokens));
  const bestOtherLang = others.find(([, v]) => v.sumKernelTokens === bestOther)?.[0] ?? '';
  const perKernelBest = Object.fromEntries(
    TOKEN_KERNELS.map((k) => {
      let b = { lang: '', tokens: Number.POSITIVE_INFINITY };
      for (const [id, v] of others) {
        const t = v.kernels[k]?.kernel;
        if (typeof t === 'number' && t < b.tokens) b = { lang: id, tokens: t };
      }
      return [k, b];
    }),
  );

  // ---- per-kernel token rows
  const kernelRows = TOKEN_KERNELS.map((name) => {
    const u = kernels10.find((x) => x.name === name) as Unit;
    const row: Record<string, unknown> = {
      kernel: name,
      canonical: tok(u.canonical),
      dense: tok(denseOf(u.canonical)),
    };
    for (const v of VARIANTS) row[v.id] = tok(v2Of(u, v.style, true).trimEnd());
    row['v2-exact-ids'] = tok(v2Of(u, VARIANTS[0]?.style ?? {}, false).trimEnd());
    row.bestOther = perKernelBest[name]?.tokens;
    row.bestOtherLanguage = perKernelBest[name]?.lang;
    return row;
  });

  // ---- totals
  const totals: Record<string, unknown> = {};
  const dense10 = kernels10.reduce((n, u) => n + tok(denseOf(u.canonical)), 0);
  const dense19 = kernels19.reduce((n, u) => n + tok(denseOf(u.canonical)), 0);
  totals.canonical = {
    kernels10: sumOf(kernels10, (u) => u.canonical),
    kernels19: sumOf(kernels19, (u) => u.canonical),
    corpus: sumOf(corpus, (u) => u.canonical),
    rank10: rankOf(sumOf(kernels10, (u) => u.canonical)),
  };
  totals.dense = {
    kernels10: dense10,
    kernels19: dense19,
    corpus: corpus.reduce((n, u) => n + tok(denseText(u) ?? u.canonical), 0),
    corpusDenseRefused: corpus.filter((u) => denseText(u) === undefined).map((u) => u.name),
    rank10: rankOf(dense10),
  };
  for (const v of VARIANTS) {
    const k10 = sumOf(kernels10, (u) => v2Of(u, v.style, true));
    totals[v.id] = {
      what: v.what,
      kernels10: k10,
      kernels10ExactIds: sumOf(kernels10, (u) => v2Of(u, v.style, false)),
      kernels19: sumOf(kernels19, (u) => v2Of(u, v.style, true)),
      kernels19ExactIds: sumOf(kernels19, (u) => v2Of(u, v.style, false)),
      corpusNormalized: sumOf(corpus, (u) => v2Of(u, v.style, true)),
      corpusExactIds: sumOf(corpus, (u) => v2Of(u, v.style, false)),
      rank10: rankOf(k10),
      languagesRanked: others.length + 1,
    };
  }

  // ---- C / Rust / JS on the 19 timed kernels
  const timedOthers = {
    c: KERNELS.reduce((n, k) => n + tok(k.c), 0),
    rust: KERNELS.reduce((n, k) => n + tok(k.rust), 0),
    js: KERNELS.reduce((n, k) => n + tok(k.js), 0),
  };

  // ---- roundtrip
  const roundtrip: Record<string, unknown> = {};
  const all = [...kernels19, ...corpus];
  for (const v of VARIANTS) {
    if (v.measureOnly === true) {
      roundtrip[v.id] = {
        note: 'measurement variant only: the parser reads the proposal spelling, this one is printed to count tokens',
      };
      continue;
    }
    let exact = 0;
    let normalized = 0;
    const failures: string[] = [];
    for (const u of all) {
      const back = (text: string): string => {
        const c = canonicalOfV2(text);
        return v.style.inferResult === true ? inferResults(c, u.known) : c;
      };
      try {
        if (formatProgram(parse(back(formatV2(u.program, v.style)))) === formatProgram(u.program))
          exact += 1;
        else failures.push(`${u.name} (exact)`);
        const n = normalizeV2(u.program);
        if (formatProgram(parse(back(formatV2(n, v.style)))) === formatProgram(n)) normalized += 1;
        else failures.push(`${u.name} (normalized)`);
      } catch (e) {
        failures.push(`${u.name}: ${(e as Error).message.slice(0, 90)}`);
      }
    }
    roundtrip[v.id] = {
      programs: all.length,
      exactLossless: exact,
      normalizedLossless: normalized,
      failures,
    };
  }
  // control: a mutated v2 text must not read back as the same program
  const control = (() => {
    const u = kernels10.find((x) => x.name === 'rotl') as Unit;
    const text = formatV2(normalizeV2(u.program), { inferResult: true });
    const mutated = text.replace('A<<B', 'A>>B');
    const same =
      formatProgram(parse(inferResults(canonicalOfV2(mutated)))) ===
      formatProgram(normalizeV2(u.program));
    let mixedRejected = false;
    try {
      canonicalOfV2('fn f(A,B,C)\nA+B*C\n');
    } catch {
      mixedRejected = true;
    }
    return {
      mutatedReadsBackAsSameProgram: same,
      mixedOperatorsWithoutParenthesesRejected: mixedRejected,
    };
  })();

  // ---- ledger flips
  const ledger = JSON.parse(readFileSync('results/loss-blockers.json', 'utf8')) as {
    entries: {
      axis: string;
      kernel: string;
      competitor: string;
      a0: number;
      other: number;
      blocker: string;
    }[];
  };
  const entries = ledger.entries.filter((e) => e.axis === 'tokens-kernel');
  const denseByKernel = Object.fromEntries(
    TOKEN_KERNELS.map((k) => [
      k,
      tok(denseOf((kernels10.find((u) => u.name === k) as Unit).canonical)),
    ]),
  );
  const flips = (perKernel: Record<string, number>): Record<string, unknown> => {
    let closed = 0;
    let strict = 0;
    const remaining: Record<string, number> = {};
    const closedByBlocker: Record<string, number> = {};
    for (const e of entries) {
      const mine = perKernel[e.kernel] ?? Number.POSITIVE_INFINITY;
      if (mine <= e.other) {
        closed += 1;
        closedByBlocker[e.blocker] = (closedByBlocker[e.blocker] ?? 0) + 1;
        if (mine < e.other) strict += 1;
      } else remaining[e.kernel] = (remaining[e.kernel] ?? 0) + 1;
    }
    return {
      entries: entries.length,
      closed,
      closedStrictlyBelow: strict,
      stillLosing: entries.length - closed,
      closedByBlocker,
      stillLosingByKernel: remaining,
    };
  };
  const ledgerOut: Record<string, unknown> = {
    note: 'A loss closes when the form writes the kernel in no more o200k tokens than the competitor (competitor counts unchanged, results/lang-axes.json). Ties close it (the ledger records a loss only above the competitor).',
    canonicalByKernel: Object.fromEntries(
      TOKEN_KERNELS.map((k) => [k, tok((kernels10.find((u) => u.name === k) as Unit).canonical)]),
    ),
    dense: { perKernel: denseByKernel, ...flips(denseByKernel) },
  };
  for (const v of VARIANTS) {
    const perKernel = Object.fromEntries(
      TOKEN_KERNELS.map((k) => [
        k,
        tok(v2Of(kernels10.find((u) => u.name === k) as Unit, v.style, true).trimEnd()),
      ]),
    );
    ledgerOut[v.id] = { perKernel, ...flips(perKernel) };
  }

  // ---- anatomy
  const cText = kernels10.map((u) => u.canonical);
  const anat: Record<string, unknown> = {
    canonical: anatomy(cText),
    dense: anatomy(kernels10.map((u) => denseOf(u.canonical))),
    v2: anatomy(kernels10.map((u) => v2Of(u, VARIANTS[0]?.style ?? {}, true).trimEnd())),
    c: anatomy(
      TOKEN_KERNELS.map((n) => (KERNELS.find((k) => k.name === n) as (typeof KERNELS)[number]).c),
    ),
    rust: anatomy(
      TOKEN_KERNELS.map(
        (n) => (KERNELS.find((k) => k.name === n) as (typeof KERNELS)[number]).rust,
      ),
    ),
  };
  for (const l of ['python', 'typescript']) {
    const t = otherLanguageKernels(l);
    if (t !== undefined) anat[l] = anatomy(t);
  }

  // ---- sealed task sets: source programs and reference edits in each form
  const editRows = await editTokens();

  // ---- the primer a v2 session would need, drafted and counted
  const primers = {
    v2Draft: V2_PRIMER,
    v2DraftO200k: tok(V2_PRIMER),
    recordedDenseD0: tok(readFileSync('experiments/primers/ablation/dense.D0.txt', 'utf8').trim()),
    recordedCanonKR3: tok(
      readFileSync('experiments/primers/ablation/canon.KR3.txt', 'utf8').trim(),
    ),
  };

  const report = {
    generatedAt: new Date().toISOString(),
    tool: 'tools/surface-v2-study.ts',
    tokenizer: 'o200k_base (js-tiktoken)',
    meaning:
      'Deterministic study of a candidate canonical spelling (v2). Token counts only: no model wrote any v2 text, so nothing here says whether models write it correctly. See docs/design/surface-v2.md.',
    languages: {
      ranked: others.length + 1,
      bestOtherLanguage: bestOtherLanguage(bestOtherLang),
      bestOtherSum: bestOther,
    },
    kernelRows,
    totals,
    timedKernelsOtherLanguages: timedOthers,
    perKernelBestOther: perKernelBest,
    roundtrip,
    control,
    ledger: ledgerOut,
    editTokens: editRows,
    primers,
    anatomy: anat,
  };
  writeFileSync(out, reportJson(report), 'utf8');
  process.stderr.write(`wrote ${out}\n`);
}

function bestOtherLanguage(x: string): string {
  return x;
}

if (
  import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}` ||
  process.argv[1]?.endsWith('surface-v2-study.ts')
) {
  main().catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exit(1);
  });
}
