/**
 * Deterministic per-language axes over the full exec-bench language set: A0, the exec-bench
 * core baselines (C, Rust, JavaScript) and every table language (tools/exec-bench-languages.ts
 * and exec-bench-languages-more.ts), on the same kernel programs exec-bench runs.
 *
 * Axes (results/lang-axes.json):
 *   tokens     o200k_base tokens of each kernel's source (what a model writes to produce the
 *              function, and reads to edit it) and of the whole runnable program file, for
 *              every kernel with a source in that language. Counted, not timed.
 *   validation per edit, on a warm project directory: the edited file is rewritten with one
 *              appended comment line (a real content change, so content-hash caches such as
 *              Go's and Zig's recompile), then
 *                checkMs     the language's own static step: its build (compile, type-check),
 *                            or its toolchain checker when it has no build step (py_compile,
 *                            ruby -c, php -l, perl -c); null when the toolchain has none;
 *                checkRunMs  check plus everything needed to run once and the one-iteration
 *                            run itself, whose checksum must equal the A0 result or the row is
 *                            dropped (the validation of a language with no static step).
 *              Samples are interleaved: every round visits every (language, kernel) once, in an
 *              order rotated by the round; the 1-minute load average is recorded per round.
 *   startup    not re-measured here: exec-bench already times one-iteration process launch for
 *              every table language (results/exec-benchmark.json startup*Ms).
 *
 * A missing toolchain is recorded as not-installed; a failing step keeps its error text and has
 * no number. Nothing is estimated.
 *
 * Usage: bun run lang-axes [-- options]
 *   --langs=a,b      only these language ids (a0 and a0node always run)
 *   --kernels=a,b    timed kernels (default affine,branchy,arrfill)
 *   --rounds=N       timed rounds (default 5)
 *   --work=DIR       build root (default: a fresh directory under the OS temp dir)
 *   --out=PATH       report path (default results/lang-axes.json)
 *   --tokens-only    recompute only the tokens axis and merge it into the existing report
 *                    (no toolchain runs; the validation timings stay as recorded)
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { cpus, homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { getEncoding } from 'js-tiktoken';
import { compile } from '../src/backends.js';
import { parseAndValidate } from '../src/core.js';
import { findClang, runTool } from '../src/toolchain.js';
import { denseOf } from './dense-tokens.js';
import { a0TokenText, cDriver, KERNELS, type Kernel, rustDriver } from './exec-bench-kernels.js';
import {
  type Cmd,
  LANGUAGES as CORE_LANGUAGES,
  type Family,
  type KernelName,
  type Language,
  type Toolchain,
  versionLine,
} from './exec-bench-languages.js';
import { MORE_LANGUAGES } from './exec-bench-languages-more.js';
import { buildNativeCheck, NATIVE_A0 } from './native-check.js';
import { loadGate, waitQuiet } from './quiet.js';
import { writeReport } from './scrub-results.js';
import { loadSource, systemLoad, systemLoadTriple } from './system-load.js';

const TABLE: readonly Language[] = [...CORE_LANGUAGES, ...MORE_LANGUAGES];
/** The kernels results/exec-benchmark.json reports, the set every chart uses. */
const EXEC_KERNELS: readonly KernelName[] = [
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

/** Line-comment spelling per language, used to make the per-sample edit. */
const COMMENT: Readonly<Record<string, (text: string) => string>> = (() => {
  const slash = (t: string): string => `// ${t}`;
  const hash = (t: string): string => `# ${t}`;
  const semi = (t: string): string => `; ${t}`;
  const pct = (t: string): string => `% ${t}`;
  const dash = (t: string): string => `-- ${t}`;
  const out: Record<string, (text: string) => string> = {
    a0: hash,
    a0node: hash,
    c: slash,
    rust: slash,
  };
  out.js = slash;
  for (const id of 'typescript cpp objc java kotlin go swift zig csharp fsharp dart scala groovy d v odin vala haxe gleam pascal php'.split(
    ' ',
  ))
    out[id] = slash;
  for (const id of 'python ruby perl tcl r julia elixir nim crystal'.split(' ')) out[id] = hash;
  for (const id of 'clojure racket commonlisp guile chicken'.split(' ')) out[id] = semi;
  for (const id of 'erlang prolog'.split(' ')) out[id] = pct;
  for (const id of 'lua haskell'.split(' ')) out[id] = dash;
  out.ocaml = (t) => `(* ${t} *)`;
  out.vb = (t) => `' ${t}`;
  out.fortran = (t) => `! ${t}`;
  out.cobol = (t) => `*> ${t}`;
  out.smalltalk = (t) => `"${t}"`;
  out.forth = (t) => `\\ ${t}`;
  return out;
})();

interface Cli {
  readonly langs: ReadonlySet<string> | null;
  readonly kernels: readonly KernelName[];
  readonly rounds: number;
  readonly work: string | null;
  readonly out: string;
  readonly tokensOnly: boolean;
}

function parseCli(argv: readonly string[]): Cli {
  let langs: Set<string> | null = null;
  let kernels: KernelName[] = ['affine', 'branchy', 'arrfill'];
  let rounds = 5;
  let work: string | null = null;
  let out = join('results', 'lang-axes.json');
  let tokensOnly = false;
  for (const a of argv) {
    const [key, value = ''] = a.split('=', 2) as [string, string?];
    const list = value.split(',').filter((v) => v.length > 0);
    if (key === '--langs') langs = new Set(list);
    else if (key === '--kernels') {
      const bad = list.filter((k) => !EXEC_KERNELS.includes(k as KernelName));
      if (bad.length > 0) throw new Error(`unknown kernel(s): ${bad.join(', ')}`);
      kernels = list as KernelName[];
    } else if (key === '--rounds') rounds = Math.max(1, Number(value) || 5);
    else if (key === '--work') work = value;
    else if (key === '--out') out = value;
    else if (key === '--tokens-only') tokensOnly = true;
    else throw new Error(`unknown option ${a}`);
  }
  return { langs, kernels, rounds, work, out, tokensOnly };
}

const CLI = parseCli(process.argv.slice(2));
const RUST_FLAGS = ['-C', 'opt-level=3', '-C', 'target-cpu=native'];

/** One validation step: an executable and its arguments. */
interface Step {
  readonly cmd: string;
  readonly args: readonly string[];
}

/** A language as this tool drives it: files to write, the static step, what running needs. */
interface Subject {
  readonly id: string;
  readonly label: string;
  readonly family: Family | 'a0';
  readonly toolchain: string | null;
  /** Relative path of the file an edit touches. */
  readonly file: string;
  readonly kernelSource: (k: Kernel) => string | undefined;
  readonly program: (k: Kernel, src: string) => string;
  readonly extraFiles: (dir: string) => Readonly<Record<string, string>>;
  /** Static step (build or checker); null when the toolchain has none. */
  readonly check: ((dir: string) => readonly Step[]) | null;
  readonly checkKind: string;
  /** Steps after the static step that running needs (none for most languages). */
  readonly toRun: (dir: string) => readonly Step[];
  readonly run: (dir: string) => Step;
  readonly env: NodeJS.ProcessEnv;
  readonly output: 'stdout' | 'stderr';
  readonly missing?: string;
  /**
   * The run step also checks (one process: front end, then the run), so checkRunMs is that
   * step alone; checkMs is the separate static step.
   */
  readonly fused?: boolean;
}

const node = process.execPath;
const A0_CLI = join(process.cwd(), 'dist', 'src', 'cli.js');
const A0_NATIVE = join(process.cwd(), NATIVE_A0);

function jsDriver(k: Kernel): string {
  const args = Array.from({ length: k.arity }, (_, i) => `a${i}`);
  return `${k.js}
const iters = Number(process.argv[2] ?? '1');
let s = 0x9e3779b9;
let acc = 0;
const t0 = process.hrtime.bigint();
for (let i = 0; i < iters; i++) {
  ${args.map((a) => `s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; const ${a} = s;`).join(' ')}
  acc = (acc ^ ${k.name}(${args.join(', ')})) >>> 0;
}
const ns = Number(process.hrtime.bigint() - t0) / iters;
console.log(ns.toFixed(4) + ' ' + acc);
`;
}

function baselines(clang: string | undefined, rustc: string | undefined): Subject[] {
  const common = { extraFiles: () => ({}), env: process.env, output: 'stdout' as const };
  const nodeVersion = `node ${process.version}`;
  return [
    {
      ...common,
      id: 'a0',
      label: 'A0',
      family: 'a0',
      toolchain:
        "native a0 (dist/native/a0: the self-hosted front end compiled by A0's C backend, with the host driver tools/native/a0.c evaluating the checked IR); no Node and no C compiler at run time",
      file: 'kernel.a0',
      kernelSource: (k) => k.a0,
      program: (_k, src) => `${src}\n`,
      check: (dir) => [{ cmd: A0_NATIVE, args: ['check', join(dir, 'kernel.a0')] }],
      checkKind: 'a0 check (native self-hosted lexer, parser and checker; cold process, no Node)',
      toRun: () => [],
      // One process checks, then runs: `a0 bench` runs the front end before the call.
      run: (dir) => ({
        cmd: A0_NATIVE,
        args: ['bench', join(dir, 'kernel.a0'), basename(dir), '1'],
      }),
      fused: true,
    },
    {
      ...common,
      id: 'a0node',
      label: 'A0 (Node CLI)',
      family: 'a0',
      toolchain: `a0 CLI (dist/src/cli.js) on ${nodeVersion}; clang for the native run`,
      file: 'kernel.a0',
      kernelSource: (k) => k.a0,
      program: (_k, src) => `${src}\n`,
      check: (dir) => [{ cmd: node, args: [A0_CLI, 'check', join(dir, 'kernel.a0')] }],
      checkKind:
        'a0 check (TypeScript parse and type-check, cold Node CLI process; the previous A0 path)',
      toRun: (dir) =>
        clang === undefined
          ? []
          : [
              {
                cmd: node,
                args: [A0_CLI, 'emit', 'c', join(dir, 'kernel.a0'), join(dir, 'kernel.c')],
              },
              {
                cmd: clang,
                args: ['-std=c11', '-O2', '-o', join(dir, 'bench'), join(dir, 'main.c')],
              },
            ],
      run: (dir) => ({ cmd: join(dir, 'bench'), args: ['1'] }),
      ...(clang === undefined ? { missing: 'clang not found (needed for the native run)' } : {}),
    },
    {
      ...common,
      id: 'c',
      label: 'C',
      family: 'compiled-native',
      toolchain: clang === undefined ? null : versionLine(clang, ['--version']),
      file: 'bench.c',
      kernelSource: (k) => k.c,
      program: (k, src) =>
        `#include <stdint.h>\n${src}\n${cDriver(() => `hw_${k.name}(ARGS)`, k.arity)}`,
      check: (dir) => [
        {
          cmd: clang ?? 'clang',
          args: ['-std=c11', '-O2', '-o', join(dir, 'bench'), join(dir, 'bench.c')],
        },
      ],
      checkKind: 'build (clang -O2, as exec-bench)',
      toRun: () => [],
      run: (dir) => ({ cmd: join(dir, 'bench'), args: ['1'] }),
      ...(clang === undefined ? { missing: 'clang not found' } : {}),
    },
    {
      ...common,
      id: 'rust',
      label: 'Rust',
      family: 'compiled-native',
      toolchain: rustc === undefined ? null : versionLine(rustc, ['--version']),
      file: 'bench.rs',
      kernelSource: (k) => k.rust,
      program: (k) => rustDriver(k),
      check: (dir) => [
        {
          cmd: rustc ?? 'rustc',
          args: [...RUST_FLAGS, '-o', join(dir, 'bench'), join(dir, 'bench.rs')],
        },
      ],
      checkKind: 'build (rustc opt-level=3 target-cpu=native, as exec-bench)',
      toRun: () => [],
      run: (dir) => ({ cmd: join(dir, 'bench'), args: ['1'] }),
      ...(rustc === undefined ? { missing: 'rustc not found' } : {}),
    },
    {
      ...common,
      id: 'js',
      label: 'JavaScript',
      family: 'jit',
      toolchain: nodeVersion,
      file: 'bench.mjs',
      kernelSource: (k) => k.js,
      program: (k) => jsDriver(k),
      check: (dir) => [{ cmd: node, args: ['--check', join(dir, 'bench.mjs')] }],
      checkKind: 'node --check (syntax only)',
      toRun: () => [],
      run: (dir) => ({ cmd: node, args: [join(dir, 'bench.mjs'), '1'] }),
    },
  ];
}

const toStep = ([cmd, args]: Cmd): Step => ({ cmd, args });

function tableSubject(lang: Language, tool: Toolchain | undefined): Subject {
  const t = tool as Toolchain;
  const staticStep = lang.build ?? lang.check;
  return {
    id: lang.id,
    label: lang.label,
    family: lang.family,
    toolchain: tool?.version ?? null,
    file: lang.file,
    kernelSource: (k) => lang.kernels[k.name],
    program: (k, src) => lang.program(k, src),
    extraFiles: (dir) => (tool === undefined ? {} : (lang.extraFiles?.(dir, t) ?? {})),
    check: staticStep === undefined ? null : (dir) => staticStep(dir, t).map(toStep),
    checkKind:
      lang.build !== undefined
        ? 'build (as exec-bench)'
        : lang.check !== undefined
          ? 'toolchain checker (no build step)'
          : 'none: the toolchain has no static check; validated only by running',
    toRun: () => [],
    run: (dir) => toStep(lang.run(dir, t, '1')),
    env: { ...process.env, ...(tool === undefined ? {} : (lang.env?.(t) ?? {})) },
    output: lang.output === 'stderr' ? 'stderr' : 'stdout',
    ...(tool === undefined ? { missing: `${lang.label} toolchain not installed` } : {}),
  };
}

// ---------------------------------------------------------------- tokens

const enc = getEncoding('o200k_base');
const tok = (s: string): number => enc.encode(s).length;

interface TokenRow {
  readonly kernel: number;
  readonly program: number;
}

/**
 * A0's dense view of the same kernels (src/dense.ts, after `normalizeProgram`: the same behavior,
 * nodes ordered and named for the dense text). The ledger and the rank use these counts for A0's
 * source; the canonical counts above stay as recorded.
 */
function denseTokenRow(): Record<string, unknown> {
  const kernels: Record<string, TokenRow> = {};
  let sumKernel = 0;
  let sumProgram = 0;
  const ratios: number[] = [];
  for (const k of KERNELS) {
    if (!EXEC_KERNELS.includes(k.name)) continue;
    const text = denseOf(a0TokenText(k));
    const row = { kernel: tok(text), program: tok(`${text}\n`) };
    kernels[k.name] = row;
    sumKernel += row.kernel;
    sumProgram += row.program;
    ratios.push(row.kernel / tok(a0TokenText(k)));
  }
  return {
    meaning:
      'o200k tokens of the dense text of each kernel (src/dense.ts) after normalizeProgram: same behavior as the canonical kernel, nodes ordered and named for the dense form; canonical -> dense -> canonical is lossless, tools/dense-tokens.ts measures every feature.',
    sumKernelTokens: sumKernel,
    sumProgramTokens: sumProgram,
    kernelTokensOverCanonicalGeomean: Math.exp(
      ratios.reduce((a, r) => a + Math.log(r), 0) / ratios.length,
    ),
    kernels,
  };
}

function tokenAxis(subjects: readonly Subject[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const a0Kernel = new Map(KERNELS.map((k) => [k.name, tok(a0TokenText(k))]));
  // A0 through the Node CLI is the same source as A0: one token row.
  for (const s of subjects.filter((x) => x.id !== 'a0node')) {
    const perKernel: Record<string, TokenRow | { status: 'no-source' }> = {};
    const ratios: number[] = [];
    let sumKernel = 0;
    let sumProgram = 0;
    let covered = 0;
    for (const k of KERNELS) {
      if (!EXEC_KERNELS.includes(k.name)) continue;
      const src = s.family === 'a0' ? a0TokenText(k) : s.kernelSource(k);
      if (src === undefined) {
        perKernel[k.name] = { status: 'no-source' };
        continue;
      }
      const row = { kernel: tok(src), program: tok(s.program(k, src)) };
      perKernel[k.name] = row;
      sumKernel += row.kernel;
      sumProgram += row.program;
      covered += 1;
      ratios.push(row.kernel / (a0Kernel.get(k.name) ?? 1));
    }
    out[s.id] = {
      label: s.label,
      family: s.family,
      kernelsCovered: covered,
      sumKernelTokens: sumKernel,
      sumProgramTokens: sumProgram,
      kernelTokensOverA0Geomean:
        ratios.length === 0
          ? null
          : Math.exp(ratios.reduce((a, r) => a + Math.log(r), 0) / ratios.length),
      kernels: perKernel,
      ...(s.id === 'a0' ? { dense: denseTokenRow() } : {}),
    };
  }
  addDenseRank(out);
  return out;
}

interface RankRow {
  readonly family?: unknown;
  readonly kernelsCovered?: number;
  readonly sumKernelTokens?: number;
  readonly kernels?: Record<string, { kernel?: number }>;
  dense?: Record<string, unknown> & { sumKernelTokens: number; kernels: Record<string, TokenRow> };
}

/** Rank of A0 (canonical and dense) among every language that wrote all the kernels, and per kernel. */
function addDenseRank(rows: Record<string, unknown>): void {
  const a0 = rows.a0 as RankRow | undefined;
  const dense = a0?.dense;
  if (a0 === undefined || dense === undefined) return;
  const others = Object.entries(rows).filter(
    ([id, v]) => id !== 'a0' && (v as RankRow).kernelsCovered === EXEC_KERNELS.length,
  ) as [string, RankRow][];
  const sums = others.map(([, v]) => v.sumKernelTokens ?? 0);
  const rankOf = (mine: number): number => 1 + sums.filter((x) => x < mine).length;
  const best = (name: string): { lang: string; tokens: number } => {
    let pick = { lang: '', tokens: Number.POSITIVE_INFINITY };
    for (const [id, v] of Object.entries(rows)) {
      const t = (v as RankRow).kernels?.[name]?.kernel;
      if (id !== 'a0' && typeof t === 'number' && t < pick.tokens) pick = { lang: id, tokens: t };
    }
    return pick;
  };
  const perKernel: Record<string, unknown> = {};
  for (const [name, row] of Object.entries(dense.kernels)) {
    const b = best(name);
    const canonical = a0.kernels?.[name]?.kernel ?? 0;
    perKernel[name] = {
      canonical,
      dense: row.kernel,
      best: b.tokens,
      bestLanguage: b.lang,
      denseOverBest: Number((row.kernel / b.tokens).toFixed(3)),
      canonicalOverBest: Number((canonical / b.tokens).toFixed(3)),
    };
  }
  const bestSum = Object.values(perKernel).reduce<number>(
    (n, v) => n + (v as { best: number }).best,
    0,
  );
  dense.vsBest = {
    languagesRanked: others.length + 1,
    canonicalRank: rankOf(a0.sumKernelTokens ?? 0),
    denseRank: rankOf(dense.sumKernelTokens),
    bestSingleLanguageSum: Math.min(...sums),
    sumOfPerKernelBests: bestSum,
    denseOverBestSingleLanguage: Number((dense.sumKernelTokens / Math.min(...sums)).toFixed(3)),
    denseOverPerKernelBests: Number((dense.sumKernelTokens / bestSum).toFixed(3)),
    perKernel,
  };
}

// ---------------------------------------------------------------- validation timing

/** A0 result for one iteration of the common driver (xorshift32 inputs, xor accumulator). */
async function expectedOneIteration(k: Kernel): Promise<string> {
  const text = compile(parseAndValidate(k.a0), 'js').text;
  const mod = (await import(
    `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`
  )) as Record<string, (...a: number[]) => number>;
  const f = mod[k.name];
  if (f === undefined) throw new Error(`${k.name}: emitted JS has no export`);
  let s = 0x9e3779b9;
  const a: number[] = [];
  for (let i = 0; i < k.arity; i += 1) {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    a.push(s);
  }
  return String(f(...a) >>> 0);
}

function readChecksum(s: Subject, r: { stdout: string; stderr: string }): string | undefined {
  const text = s.output === 'stderr' ? r.stderr : r.stdout;
  const line = text
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[0-9.eE+-]+ [0-9]+$/.test(l))
    .pop();
  return line?.split(' ')[1];
}

interface Job {
  readonly s: Subject;
  readonly k: Kernel;
  readonly dir: string;
  readonly base: string;
  readonly expected: string;
  readonly check: number[];
  readonly checkRun: number[];
}

interface JobFailure {
  readonly status: 'not-installed' | 'no-source' | 'failed';
  readonly detail: string;
}
type JobResult =
  | { readonly status: 'measured'; readonly checkMs: number[]; readonly checkRunMs: number[] }
  | JobFailure;

function runSteps(steps: readonly Step[], job: Job): string | null {
  for (const st of steps) {
    const r = runTool(st.cmd, st.args, { cwd: job.dir, env: job.s.env, timeoutMs: 900_000 });
    if (!r.ok) return `${st.cmd} ${st.args.join(' ')}: ${(r.stderr || r.stdout).slice(-1200)}`;
  }
  return null;
}

async function edit(job: Job, n: number): Promise<void> {
  const comment = COMMENT[job.s.id];
  if (comment === undefined) throw new Error(`${job.s.id}: no comment spelling`);
  await writeFile(join(job.dir, job.s.file), `${job.base}\n${comment(`edit ${n}`)}\n`, 'utf8');
}

/** One timed sample: edit, static step, then what running needs and the run. */
async function sample(job: Job, n: number): Promise<string | null> {
  await edit(job, n);
  const t0 = performance.now();
  const checkSteps = job.s.check?.(job.dir) ?? [];
  const e1 = runSteps(checkSteps, job);
  const t1 = performance.now();
  if (e1 !== null) return e1;
  const e2 = runSteps(job.s.toRun(job.dir), job);
  if (e2 !== null) return e2;
  const run = job.s.run(job.dir);
  const tRun = performance.now();
  const r = runTool(run.cmd, run.args, { cwd: job.dir, env: job.s.env, timeoutMs: 600_000 });
  const t2 = performance.now();
  if (!r.ok) return `run: ${(r.stderr || r.stdout).slice(-1200)}`;
  const got = readChecksum(job.s, r);
  if (got !== job.expected) return `checksum ${got ?? '(none)'} != A0 ${job.expected}`;
  if (job.s.check !== null) job.check.push(t1 - t0);
  job.checkRun.push(job.s.fused === true ? t2 - tRun : t2 - t0);
  return null;
}

async function prepare(s: Subject, k: Kernel, root: string): Promise<Job | JobFailure> {
  if (s.missing !== undefined) return { status: 'not-installed', detail: s.missing };
  const src = s.family === 'a0' ? a0TokenText(k) : s.kernelSource(k);
  if (src === undefined)
    return { status: 'no-source', detail: `${s.label}: no ${k.name} kernel written` };
  const dir = join(root, s.id, k.name);
  await mkdir(dirname(join(dir, s.file)), { recursive: true });
  const base = s.program(k, src).replace(/\n+$/, '');
  for (const [name, text] of Object.entries(s.extraFiles(dir)))
    await writeFile(join(dir, name), text, 'utf8');
  if (s.family === 'a0')
    await writeFile(
      join(dir, 'main.c'),
      `#include "kernel.c"\n${cDriver(() => `a0_${k.name}(ARGS)`, k.arity)}`,
      'utf8',
    );
  const job: Job = {
    s,
    k,
    dir,
    base,
    expected: await expectedOneIteration(k),
    check: [],
    checkRun: [],
  };
  // Untimed warm-up sample: first build of the project directory, and the edit and checksum
  // are proven to work before any timing.
  const err = await sample(job, 0);
  job.check.length = 0;
  job.checkRun.length = 0;
  if (err !== null) return { status: 'failed', detail: err };
  return job;
}

const median = (a: readonly number[]): number => {
  const s = [...a].sort((p, q) => p - q);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

/** Recompute only the tokens axis and merge it into the existing report. */
async function tokensOnly(): Promise<void> {
  const subjects = [
    ...baselines(undefined, undefined).filter(
      (b) => b.family === 'a0' || CLI.langs === null || CLI.langs.has(b.id),
    ),
    ...TABLE.filter((l) => CLI.langs === null || CLI.langs.has(l.id)).map((l) =>
      tableSubject(l, undefined),
    ),
  ];
  const report = JSON.parse(await readFile(CLI.out, 'utf8')) as Record<string, unknown>;
  report.tokens = tokenAxis(subjects);
  report.tokensGeneratedAt = new Date().toISOString();
  await writeReport(CLI.out, report);
  process.stderr.write(`merged tokens into ${CLI.out}\n`);
}

async function main(): Promise<void> {
  if (CLI.tokensOnly) return tokensOnly();
  const clang = findClang().path;
  const rustcPath = join(homedir(), '.cargo', 'bin', 'rustc');
  const rustc = runTool(rustcPath, ['--version']).ok ? rustcPath : undefined;
  const table = TABLE.filter((l) => CLI.langs === null || CLI.langs.has(l.id)).map((l) =>
    tableSubject(l, l.find()),
  );
  const subjects = [
    ...baselines(clang, rustc).filter(
      (b) => b.family === 'a0' || CLI.langs === null || CLI.langs.has(b.id),
    ),
    ...table,
  ];
  for (const s of subjects)
    process.stderr.write(`${s.id.padEnd(11)} ${s.missing ?? s.toolchain ?? ''}\n`);
  await readFile(A0_CLI).catch(() => {
    throw new Error(`${A0_CLI} missing: run the build first`);
  });
  const nativeBuild = await buildNativeCheck();
  process.stderr.write(`built ${NATIVE_A0} in ${nativeBuild.ms} ms\n`);

  const tokens = tokenAxis(subjects);

  const root = CLI.work ?? (await mkdtemp(join(tmpdir(), 'a0-lang-axes-')));
  await mkdir(root, { recursive: true });
  const kernels = KERNELS.filter((k) => CLI.kernels.includes(k.name));
  const results = new Map<string, JobResult>();
  const jobs: Job[] = [];
  for (const s of subjects)
    for (const k of kernels) {
      process.stderr.write(`prepare ${s.id}/${k.name}\n`);
      const j = await prepare(s, k, root);
      if ('s' in j) jobs.push(j);
      else {
        results.set(`${s.id}/${k.name}`, j);
        if (j.status !== 'not-installed' && j.status !== 'no-source')
          process.stderr.write(`  ${j.status}: ${j.detail.split('\n')[0]?.slice(0, 200)}\n`);
      }
    }

  const load: { round: number; loadavg: number[]; loadSource: string }[] = [];
  const failedJobs = new Set<Job>();
  const failures = new Map<Job, string>();
  for (let round = 1; round <= CLI.rounds; round += 1) {
    waitQuiet();
    load.push({ round, loadavg: systemLoadTriple(), loadSource: loadSource() });
    const live = jobs.filter((j) => !failedJobs.has(j));
    const shift = live.length === 0 ? 0 : ((round - 1) * 7) % live.length;
    const order = [...live.slice(shift), ...live.slice(0, shift)];
    process.stderr.write(`round ${round}/${CLI.rounds}, load ${systemLoad().toFixed(1)}\n`);
    for (const j of order) {
      const err = await sample(j, round);
      if (err !== null) {
        failedJobs.add(j);
        failures.set(j, err);
      }
    }
  }
  load.push({ round: CLI.rounds + 1, loadavg: systemLoadTriple(), loadSource: loadSource() });
  for (const j of jobs) {
    const key = `${j.s.id}/${j.k.name}`;
    const err = failures.get(j);
    results.set(
      key,
      err === undefined
        ? { status: 'measured', checkMs: j.check, checkRunMs: j.checkRun }
        : { status: 'failed', detail: err },
    );
  }
  if (CLI.work === null) await rm(root, { recursive: true, force: true });

  const validation: Record<string, unknown> = {};
  for (const s of subjects) {
    const perKernel: Record<string, unknown> = {};
    const checkMed: number[] = [];
    const runMed: number[] = [];
    let status = 'measured';
    let detail: string | undefined;
    for (const k of kernels) {
      const r = results.get(`${s.id}/${k.name}`);
      if (r === undefined) continue;
      if (r.status !== 'measured') {
        perKernel[k.name] = r;
        status = r.status;
        detail = r.detail;
        continue;
      }
      const c = r.checkMs.length > 0 ? median(r.checkMs) : null;
      const cr = median(r.checkRunMs);
      if (c !== null) checkMed.push(c);
      runMed.push(cr);
      perKernel[k.name] = {
        checkMedianMs: c,
        checkRunMedianMs: cr,
        checkMs: r.checkMs,
        checkRunMs: r.checkRunMs,
      };
    }
    const measured = runMed.length === kernels.length;
    validation[s.id] = {
      label: s.label,
      family: s.family,
      toolchain: s.toolchain,
      checkKind: s.checkKind,
      status: measured ? 'measured' : status,
      ...(measured || detail === undefined ? {} : { detail: detail.slice(0, 600) }),
      checkMedianMs: measured && checkMed.length > 0 ? median(checkMed) : null,
      checkRunMedianMs: measured ? median(runMed) : null,
      kernels: perKernel,
    };
  }

  const count = (o: Record<string, unknown>, pred: (v: Record<string, unknown>) => boolean) =>
    Object.values(o).filter((v) => pred(v as Record<string, unknown>)).length;
  const others = subjects.filter((s) => s.family !== 'a0').length;
  const report = {
    generatedAt: new Date().toISOString(),
    tool: 'tools/lang-axes.ts',
    platform: `${process.platform} ${process.arch}`,
    cpus: cpus().length,
    node: process.version,
    meaning:
      'Deterministic axes over the exec-bench language set on the exec-bench kernel programs. tokens: o200k_base (js-tiktoken) tokens of each kernel source as written in the exec-bench tables (kernel) and of the whole runnable program file including its driver (program); A0 kernel and program are the same text; A0 noop is counted as its identity text (a0TokenSource, docs/history/2026-10-09-noop-token-identity-declaration.md), the timed noop keeps its redundant ops. validation: per edit on a warm project directory, the edited file gets one appended comment line; checkMs is the static step (build, or the toolchain checker for a language with no build step; null when none exists), checkRunMs is the static step plus what running needs plus a one-iteration run whose checksum must equal the A0 result (A0 native: one `a0 bench FILE K 1` process that runs the front end and then evaluates the checked IR; a0node: the Node CLI check, `emit c` and clang). Medians per kernel over the rounds, then the median over kernels. Wall-clock under the recorded load; samples interleaved across all (language, kernel) pairs, order rotated per round. Startup is not re-measured here (results/exec-benchmark.json). Cold processes throughout: no language server or daemon is kept running (A0 included).',
    load: {
      perRound: load,
      note: 'os.loadavg() (a CPU-utilisation estimate on Windows, see loadSource) at the start of each round and after the last; a 1-minute value above the CPU count means the timings were taken on a loaded machine and are comparable only within this run.',
    },
    rounds: CLI.rounds,
    loadGate: loadGate(),
    timedKernels: kernels.map((k) => k.name),
    tokenKernels: EXEC_KERNELS,
    coverage: {
      languagesBesideA0: others,
      tokens: count(tokens, (v) => v.family !== 'a0' && (v.kernelsCovered as number) > 0),
      checkRun: count(validation, (v) => v.family !== 'a0' && v.status === 'measured'),
      check: count(validation, (v) => v.family !== 'a0' && v.checkMedianMs !== null),
      notInstalled: Object.entries(validation)
        .filter(([, v]) => (v as { status: string }).status === 'not-installed')
        .map(([id]) => id),
      failed: Object.entries(validation)
        .filter(([, v]) => (v as { status: string }).status === 'failed')
        .map(([id]) => id),
    },
    tokens,
    validation,
  };
  await mkdir(dirname(CLI.out), { recursive: true });
  await writeReport(CLI.out, report);
  process.stderr.write(`wrote ${CLI.out}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
