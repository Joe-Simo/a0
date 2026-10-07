/**
 * The native `a0`: the self-hosted front end (compiler/check.a0 linked with parse.a0 and
 * lex.a0, io fronts `checkio` and `irio`) compiled by A0's own toolchain (the C backend, as in
 * bootstrap stage 1, then clang -O2 for the host) with the host driver tools/native/a0.c into
 * `dist/native/a0`, an executable that needs no Node and no C compiler at run time:
 *   a0 check FILE            ok or the diagnostic; exit code = diagnostic code (0 ok, 1 parse,
 *                            2 structure, 3 type, 4 limit; 64 usage or unreadable file, 65 the
 *                            linked program over the front end's 16384-byte limit)
 *   a0 run FILE FN ARGS      the result as the TypeScript CLI prints it
 *   a0 bench FILE FN N       N calls on the exec-bench xorshift32 inputs: "ns checksum"
 *   a0 calls FILE            calls on stdin in the test-driver protocol of tools/verify.ts
 * `use` lines are linked as src/link.ts links them; the evaluator runs the checked word IR.
 * An unknown name (a type, a node, a callee, a fold or loop body, a loop predicate) also prints the
 * code of its row in the diagnostics table and, when one is close, what it probably meant
 * (compiler/suggest.a0, entry suggestio: the rule of src/diagnostics.ts spellingSuggestion).
 *
 * Verification (writes results/native-check.json):
 * - diagnostics: every source of the front-end set (tools/front-end-sources.ts), the ill-typed
 *   programs of tools/ref-check.ts, the corpus closures and the exec-bench kernels, each through
 *   `a0 check` as a file: (code, function, node) must equal the TypeScript reference checker's
 *   (refCheckWords) on the text the TypeScript linker builds;
 * - evaluator: every corpus function (with what it reaches), the kernels and the examples
 *   through `a0 calls`: every result and io output must equal the BigInt oracle's;
 * - commands: `a0 run` must print what src/cli.ts prints, `a0 bench` must give the reference
 *   checksum over the same inputs as the exec-bench drivers;
 * - linking: small projects (diamond, cycle, outside the root, missing file, a name in two
 *   files, over the front end's limit) against src/link.ts;
 * - check time by source size.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { compile } from '../src/backends.js';
import {
  A0Error,
  formatProgram,
  parseAndValidate,
  run,
  type TypedFunc,
  type TypedProgram,
  type Value,
} from '../src/core.js';
import { link } from '../src/link.js';
import { findClang, findGcc, runTool } from '../src/toolchain.js';
import {
  type Case,
  CORPUS_FUNCTIONS,
  CORPUS_SEED,
  closure,
  closures,
  generateCases,
  generateCorpus,
  INPUT_SEED,
} from './corpus.js';
import { KERNELS } from './exec-bench-kernels.js';
import { frontEndSources, UNKNOWN_NAMES } from './front-end-sources.js';
import { ILL_TYPED, NONE, refCheckWords } from './ref-check.js';
import { FRONT_END_SOURCE_LIMIT, refSuggest } from './ref-parse.js';
import { scrubText } from './scrub-results.js';

export const NATIVE_DIR = join('dist', 'native');
export const NATIVE_A0 = join(NATIVE_DIR, 'a0');

/**
 * Output words of the front end: irio writes 4 header words, then every table of the word IR
 * with its count. The tables of a source within the front-end limit (DESIGN.md 7a capacities:
 * types 8320 triples, tlist 8320, 3072 node types, pool 16512, 8192 syms, 820 fns, 2730 nodes,
 * 16384 operands) fit in 2^18 words.
 */
const OUTPUT_WORDS = 1 << 18;

/** The words after `A0` of each rule `suggestio` reports, as the executable prints them. */
const RULE_TEXT: Readonly<Record<number, string>> = {
  1: 'unknown type',
  101: 'undefined node',
  102: 'unknown callee',
  103: 'unknown fold or loop body',
  104: 'unknown loop predicate',
};

/**
 * The line the executable prints for the words of `suggestio` on `src`, or null for rule 0:
 * `A0102 unknown callee 'mull': did you mean 'mul'?`.
 */
export function suggestionLine(words: readonly number[], src: string): string | null {
  const [rule, mode, len, start, nlen] = words as [number, number, number, number, number];
  if (rule === 0) return null;
  const name = Buffer.from(src)
    .subarray(start, start + nlen)
    .toString('latin1');
  const guess = String.fromCharCode(...words.slice(5, 5 + len));
  const tail =
    mode === 1
      ? `: did you mean '${guess}'?`
      : mode === 2
        ? ': defined later, so move it above'
        : '';
  return `A${String(rule).padStart(4, '0')} ${RULE_TEXT[rule] ?? 'unknown name'} '${name}'${tail}`;
}

const LIGHT_KERNELS = KERNELS.filter((k) => k.iterScale === undefined);

/** The host side of the executable: linking, the commands, the IR evaluator (C, no A0). */
const DRIVER = join('tools', 'native', 'a0.c');

/** Compile the self-hosted front end and the driver to dist/native/a0. */
export async function buildNativeCheck(): Promise<{ ms: number; cBytes: number; fns: number }> {
  // clang where there is one (the release runners), else gcc (a Windows machine with MSYS2)
  const clang = findClang().path ?? findGcc().path;
  if (clang === undefined) throw new Error('neither clang nor gcc found');
  const t0 = performance.now();
  const program = (await link('compiler/native.a0', (p) => readFile(p, 'utf8'))).program;
  const c = compile(program, 'c', {
    ioInputCapacity: FRONT_END_SOURCE_LIMIT + 1100,
    ioOutputCapacity: OUTPUT_WORDS,
  }).text;
  await mkdir(NATIVE_DIR, { recursive: true });
  await writeFile(join(NATIVE_DIR, 'checker.c'), c, 'utf8');
  await writeFile(join(NATIVE_DIR, 'main.c'), await readFile(DRIVER, 'utf8'), 'utf8');
  const r = runTool(
    clang,
    [
      '-std=c11',
      '-O2',
      '-Wall',
      '-Wextra',
      '-Wno-unused-parameter',
      `-DA0_FRONT_END_LIMIT=${FRONT_END_SOURCE_LIMIT}u`,
      // Less for dyld to map and for the process to page in (the binary halves).
      ...(process.platform === 'darwin'
        ? ['-Wl,-dead_strip', '-Wl,-no_function_starts', '-Wl,-no_data_in_code_info']
        : []),
      '-o',
      'a0',
      'main.c',
    ],
    { cwd: NATIVE_DIR, timeoutMs: 600_000 },
  );
  if (!r.ok) throw new Error(`native a0 build failed:\n${r.stderr.slice(0, 4000)}`);
  return {
    ms: Math.round(performance.now() - t0),
    cBytes: Buffer.byteLength(c),
    fns: program.functions.length,
  };
}

interface Row {
  readonly label: string;
  readonly bytes: number;
  readonly expected: [number, number, number];
  readonly got: [number, number, number] | null;
  readonly ms: number;
  readonly ok: boolean;
  /** The suggestion line the reference predicts for a token error, and the one printed (null: none). */
  readonly suggestion: { readonly expected: string | null; readonly got: string | null } | null;
}

async function sources(): Promise<[string, string][]> {
  const corpus = generateCorpus(CORPUS_SEED, CORPUS_FUNCTIONS);
  const out: [string, string][] = [
    ...(await frontEndSources()),
    ...ILL_TYPED.map(([l, s]): [string, string] => [`ill-typed/${l}`, s]),
    ...UNKNOWN_NAMES.map(([id, s], k): [string, string] => [`unknown-name/${id}-${k}`, s]),
    ...closures('corpus', corpus).filter(([, s]) => Buffer.byteLength(s) <= FRONT_END_SOURCE_LIMIT),
    ...KERNELS.map((k): [string, string] => [`kernel/${k.name}`, k.a0]),
  ];
  return out;
}

/** The native diagnostic: stdout `ok`, or stderr naming function and node (or token). */
function parseDiagnostic(status: number, stderr: string): [number, number, number] | null {
  if (status === 0) return [0, 0, 0];
  const fnNode = /error (\d+) in function (\d+) at node (\d+)/.exec(stderr);
  if (fnNode !== null) return [Number(fnNode[1]), Number(fnNode[2]), Number(fnNode[3])];
  const tok = /error (\d+) at token (\d+)/.exec(stderr);
  if (tok !== null) return [Number(tok[1]), NONE, Number(tok[2])];
  return null;
}

/** The expected line of a case in the test-driver protocol (tools/verify.ts). */
const fmt = (v: Value): string => (typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
const expectedLine = (c: Case): string =>
  [fmt(c.expected), ...(c.expectedOutput ?? []).map(String)].join(' ');

/** A case as a protocol line: function index, scalar arguments, then the io input. */
function caseLine(index: number, c: Case): string {
  const tokens = [String(index), ...c.args.map(fmt)];
  if (c.input !== undefined) tokens.push(String(c.input.length), ...c.input.map(String));
  return tokens.join(' ');
}

interface EvalRow {
  readonly label: string;
  readonly cases: number;
  readonly failures: readonly string[];
  /** Rejected by the self-hosted front end and the reference checker alike. */
  readonly skipped: boolean;
}

/**
 * The evaluator on programs with oracle results: every function of the corpus (with the
 * functions it reaches, as one file), the exec-bench kernels and the examples, driven by
 * `a0 calls` with the cases of tools/corpus.ts generateCases (the BigInt oracle's results).
 */
async function evaluatorRows(dir: string): Promise<EvalRow[]> {
  const programs: [string, TypedProgram][] = [];
  const corpus = generateCorpus();
  for (const f of corpus.functions)
    programs.push([`corpus/${f.name}`, parseAndValidate(closure(corpus.functions, f.name))]);
  // The kernels doing one call of at most a few hundred operations (the BigInt oracle of the
  // iteration-scaled ones takes minutes per case set).
  for (const k of LIGHT_KERNELS) programs.push([`kernel/${k.name}`, parseAndValidate(k.a0)]);
  for (const f of ['kernels.a0', 'life.a0'])
    programs.push([f, parseAndValidate(await readFile(join('examples', f), 'utf8'))]);
  const rows: EvalRow[] = [];
  for (const [i, [label, program]] of programs.entries()) {
    const text = formatProgram(program);
    // Outside the self-hosted front end's language (e.g. bool arrays in a header): the native
    // check rejects it as the reference checker does (diagnostic rows), so it has no run.
    if (refCheckWords(text)[1] !== 0) {
      rows.push({ label, cases: 0, failures: [], skipped: true });
      continue;
    }
    const root = label.startsWith('corpus/') ? label.slice('corpus/'.length) : undefined;
    const cases = generateCases(program, INPUT_SEED, root === undefined ? 10 : 100).filter(
      (c) => root === undefined || c.functionName === root,
    );
    const index = new Map(program.functions.map((f, k) => [f.name, k] as const));
    const file = join(dir, `eval${i}.a0`);
    await writeFile(file, text, 'utf8');
    const input = `${cases.map((c) => caseLine(index.get(c.functionName) as number, c)).join('\n')}\n`;
    const r = runTool(NATIVE_A0, ['calls', file], { input });
    const got = r.stdout.trim().split('\n');
    const failures: string[] = [];
    if (!r.ok) failures.push(`exit ${r.status}: ${r.stderr.slice(0, 400)}`);
    else
      cases.forEach((c, k) => {
        if (got[k] !== expectedLine(c))
          failures.push(
            `${c.functionName}(${c.args.map(fmt).join(',')}) expected ${expectedLine(c)} got ${got[k] ?? '<missing>'}`,
          );
      });
    rows.push({ label, cases: cases.length, failures: failures.slice(0, 10), skipped: false });
  }
  return rows;
}

interface CommandRow {
  readonly label: string;
  readonly expected: string;
  readonly got: string;
  readonly ok: boolean;
}

/** The exec-bench drivers' input generator (tools/exec-bench-kernels.ts cDriver). */
const xorshift = (s: number): number => {
  let x = s;
  x ^= x << 13;
  x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5;
  return x >>> 0;
};

/**
 * `a0 run` against the TypeScript CLI's output (String of the reference value) on the first
 * cases of every kernel, and `a0 bench` against the reference over the same xorshift32 inputs
 * the exec-bench drivers use (the checksum; the time is not compared).
 */
async function commandRows(dir: string): Promise<CommandRow[]> {
  const rows: CommandRow[] = [];
  for (const k of LIGHT_KERNELS) {
    const program = parseAndValidate(k.a0);
    const fn = program.byName.get(k.name) as TypedFunc;
    const file = join(dir, `cmd-${k.name}.a0`);
    await writeFile(file, `${k.a0}\n`, 'utf8');
    for (const c of generateCases(program, INPUT_SEED, 3)
      .filter((c) => c.functionName === k.name)
      .slice(0, 3)) {
      const r = runTool(NATIVE_A0, ['run', file, k.name, ...c.args.map(String)]);
      const expected = String(run(fn, c.args));
      const got = r.ok ? r.stdout.trim() : `exit ${r.status}: ${r.stderr.trim()}`;
      rows.push({
        label: `run ${k.name} ${c.args.join(' ')}`,
        expected,
        got,
        ok: got === expected,
      });
    }
    const iters = 1000;
    let s = 0x9e3779b9;
    let acc = 0;
    for (let i = 0; i < iters; i += 1) {
      const args: number[] = [];
      for (let a = 0; a < k.arity; a += 1) {
        s = xorshift(s);
        args.push(s);
      }
      acc = (acc ^ (run(fn, args, { fuel: 1e12 }) as number)) >>> 0;
    }
    const r = runTool(NATIVE_A0, ['bench', file, k.name, String(iters)]);
    const got = r.ok
      ? (r.stdout.trim().split(' ')[1] ?? '')
      : `exit ${r.status}: ${r.stderr.trim()}`;
    rows.push({
      label: `bench ${k.name} ${iters}`,
      expected: String(acc),
      got,
      ok: got === String(acc),
    });
  }
  return rows;
}

/** An A0Error's diagnostic category as the native exit code (64: an unreadable file). */
const EXIT: Readonly<Record<string, number>> = { parse: 1, structure: 2, type: 3, limit: 4 };

const oneFn = (name: string, body: string): string => `fn ${name} u32 -> u32\n${body}\nend\n`;

/** Projects of the linking check: files, entry function, arguments. */
const LINK_PROJECTS: readonly [string, Readonly<Record<string, string>>, string, string[]][] = [
  [
    'diamond',
    {
      'main.a0': `use "lib/b.a0"\nuse "c.a0"\n${oneFn('top', 'x call bb p0\ny call cc x\nret y')}`,
      'lib/b.a0': `use "../c.a0"\n${oneFn('bb', 'x call cc p0\nr add x 1\nret r')}`,
      'c.a0': oneFn('cc', 'r mul p0 3\nret r'),
    },
    'top',
    ['5'],
  ],
  [
    'cycle',
    {
      'main.a0': `use "b.a0"\n${oneFn('top', 'ret p0')}`,
      'b.a0': `use "main.a0"\n${oneFn('bb', 'ret p0')}`,
    },
    'top',
    ['1'],
  ],
  [
    'outside-root',
    { 'main.a0': `use "../../../../README.md"\n${oneFn('top', 'ret p0')}` },
    'top',
    ['1'],
  ],
  ['missing', { 'main.a0': `use "nope.a0"\n${oneFn('top', 'ret p0')}` }, 'top', ['1']],
  [
    'duplicate',
    { 'main.a0': `use "b.a0"\n${oneFn('top', 'ret p0')}`, 'b.a0': oneFn('top', 'ret p0') },
    'top',
    ['1'],
  ],
  [
    'over-limit',
    {
      'main.a0': `use "big.a0"\n${oneFn('top', 'ret p0')}`,
      'big.a0': Array.from({ length: 4000 }, (_, i) => oneFn(`f${i}`, 'r add p0 1\nret r')).join(
        '',
      ),
    },
    'top',
    ['1'],
  ],
];

/**
 * `use` linking: each project of LINK_PROJECTS under dist/native/link through the TypeScript
 * linker (src/link.ts, then the reference `run`) and through the native `a0 run`: the result,
 * or the exit code of the diagnostic's category, must agree. A linked program over the front
 * end's 16384 bytes is refused natively (exit 65), where the TypeScript linker allows 1 MiB.
 */
async function linkRows(): Promise<CommandRow[]> {
  const rows: CommandRow[] = [];
  for (const [label, files, fnName, args] of LINK_PROJECTS) {
    const dir = join(NATIVE_DIR, 'link', label);
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), text, 'utf8');
    }
    const entry = join(dir, 'main.a0');
    let expected: string;
    try {
      const program = (await link(entry, (p) => readFile(p, 'utf8'))).program;
      expected = String(run(program.byName.get(fnName) as TypedFunc, args.map(Number)));
    } catch (e) {
      if (e instanceof A0Error) expected = `exit ${EXIT[e.code] ?? '?'}`;
      else if ((e as NodeJS.ErrnoException).code === 'ENOENT') expected = 'exit 64';
      else throw e;
    }
    // One linked text for the self-hosted front end: a name in two files is its duplicate-name
    // parse error (code 1), where src/link.ts reports the clash between files (structure).
    if (label === 'duplicate' && expected === 'exit 2') expected = 'exit 1';
    if (label === 'over-limit') expected = 'exit 65';
    const r = runTool(NATIVE_A0, ['run', entry, fnName, ...args]);
    const got = r.ok ? r.stdout.trim() : `exit ${r.status}`;
    rows.push({ label: `link ${label}`, expected, got, ok: got === expected });
  }
  return rows;
}

/** Median wall-clock ms of `a0 check` on the first n functions of the most-functions source. */
async function scaleRows(dir: string): Promise<{ bytes: number; ms: number }[]> {
  const many = (await frontEndSources()).find(([l]) => l.startsWith('fns'))?.[1] ?? '';
  const lines = many.split('\n');
  const out: { bytes: number; ms: number }[] = [];
  for (const fns of [88, 176, 355, 713]) {
    const src = `${lines.slice(0, fns * 3).join('\n')}\n`;
    const file = join(dir, `scale${fns}.a0`);
    await writeFile(file, src, 'utf8');
    const ms: number[] = [];
    for (let k = 0; k < 5; k += 1) {
      const t0 = performance.now();
      runTool(NATIVE_A0, ['check', file]);
      ms.push(performance.now() - t0);
    }
    ms.sort((a, b) => a - b);
    out.push({ bytes: Buffer.byteLength(src), ms: Math.round((ms[2] as number) * 10) / 10 });
  }
  return out;
}

async function diagnosticRows(dir: string): Promise<Row[]> {
  // Sources with `use "lex.a0"` link the compiler's lexer: the expectation is the reference
  // checker on the text the TypeScript linker builds.
  await writeFile(join(dir, 'lex.a0'), await readFile('compiler/lex.a0', 'utf8'), 'utf8');
  const rows: Row[] = [];
  for (const [i, [label, src]] of (await sources()).entries()) {
    const file = join(dir, `${i}.a0`);
    await writeFile(file, src, 'utf8');
    const linked = /^use /m.test(src) ? (await link(file, (p) => readFile(p, 'utf8'))).text : src;
    const words = refCheckWords(linked);
    const expected: [number, number, number] =
      words[1] === 0 ? [0, 0, 0] : [words[1] as number, words[2] as number, words[3] as number];
    const t0 = performance.now();
    const r = runTool(NATIVE_A0, ['check', file]);
    const ms = performance.now() - t0;
    const got = parseDiagnostic(r.status ?? -1, r.stderr);
    // A token error also carries the row of the diagnostics table and the suggestion.
    const tokenError = expected[0] !== 0 && expected[1] === NONE && expected[0] <= 2;
    const suggestion = tokenError
      ? {
          expected: suggestionLine(refSuggest(src, expected[2]), src),
          got:
            r.stderr
              .split('\n')
              .find((l) => /^A[0-9]{4} /.test(l))
              ?.trimEnd() ?? null,
        }
      : null;
    const ok =
      got?.every((v, k) => v === expected[k]) === true &&
      (suggestion === null || suggestion.expected === suggestion.got);
    rows.push({
      label,
      bytes: Buffer.byteLength(src),
      expected,
      got,
      ms: Math.round(ms * 10) / 10,
      ok,
      suggestion,
    });
    if (!ok)
      process.stdout.write(
        `  FAIL ${label}: expected ${expected.join(' ')}, got ${got?.join(' ') ?? r.stderr}${suggestion === null ? '' : ` (suggestion expected ${suggestion.expected}, got ${suggestion.got})`}\n`,
      );
  }
  return rows;
}

async function main(): Promise<void> {
  const build = await buildNativeCheck();
  process.stdout.write(
    `built ${NATIVE_A0}: ${build.fns} functions, ${build.cBytes} C bytes, ${build.ms} ms\n`,
  );
  const dir = join(NATIVE_DIR, 'cases');
  await mkdir(dir, { recursive: true });
  const rows = await diagnosticRows(dir);
  const failed = rows.filter((r) => !r.ok);
  const rejected = rows.filter((r) => r.expected[0] !== 0).length;
  process.stdout.write(
    `${rows.length - failed.length}/${rows.length} sources agree with the reference checker (${rejected} rejected by it)\n`,
  );
  const evals = await evaluatorRows(dir);
  const evalCases = evals.reduce((n, r) => n + r.cases, 0);
  const evalFailed = evals.filter((r) => r.failures.length > 0);
  for (const r of evalFailed)
    process.stdout.write(`  FAIL eval ${r.label}:\n    ${r.failures.join('\n    ')}\n`);
  process.stdout.write(
    `evaluator: ${evals.length - evalFailed.length}/${evals.length} programs (${evals.filter((r) => r.skipped).length} outside the front end's language), ${evalCases} cases equal the oracle\n`,
  );
  const commands = await commandRows(dir);
  const linking = await linkRows();
  for (const r of [...commands, ...linking].filter((r) => !r.ok))
    process.stdout.write(`  FAIL ${r.label}: expected ${r.expected}, got ${r.got}\n`);
  process.stdout.write(
    `commands: ${commands.filter((r) => r.ok).length}/${commands.length} (run, bench); linking: ${linking.filter((r) => r.ok).length}/${linking.length}\n`,
  );
  const scale = await scaleRows(dir);
  process.stdout.write(
    `check time by size: ${scale.map((r) => `${r.bytes} B ${r.ms} ms`).join(', ')}\n`,
  );
  const allOk =
    failed.length === 0 &&
    evalFailed.length === 0 &&
    commands.every((r) => r.ok) &&
    linking.every((r) => r.ok);
  await mkdir('results', { recursive: true });
  await writeFile(
    'results/native-check.json',
    scrubText(
      `${JSON.stringify(
        {
          tool: 'bun run native-check (tools/native-check.ts)',
          executable: NATIVE_A0,
          build: {
            method:
              'compiler/native.a0 (compiler/check.a0 and compiler/suggest.a0 linked with parse.a0 and lex.a0; entries checkio, irio and suggestio) compiled by the A0 C backend (src/backends.ts), with the host driver tools/native/a0.c (linking, commands, IR evaluator), by clang -std=c11 -O2 for the host (arm64 on Apple silicon); no Node and no C compiler at run time',
            functions: build.fns,
            cBytes: build.cBytes,
            ms: build.ms,
            clang: findClang().version,
          },
          verification: {
            method:
              'each source is written to a file and checked by a separate `dist/native/a0 check FILE` process; its (code, function, node) must equal refCheckWords of tools/ref-check.ts on the text src/link.ts links (code 0: accepted)',
            sources: rows.length,
            agree: rows.length - failed.length,
            rejectedByReference: rejected,
            failed: failed.length,
            suggestions: {
              method:
                'for a token error (code 1 or 2) the executable also prints `A0nnnn ...` (compiler/suggest.a0 suggestio on the rejected token); that line must equal the one built from refSuggest (tools/ref-parse.ts)',
              checked: rows.filter((r) => r.suggestion !== null).length,
              printed: rows.filter((r) => r.suggestion?.got != null).length,
              agree: rows.filter(
                (r) => r.suggestion !== null && r.suggestion.expected === r.suggestion.got,
              ).length,
            },
          },
          evaluator: {
            method:
              'the IR evaluator of tools/native/a0.c through `a0 calls FILE` (the tools/verify.ts driver protocol): every corpus function with the functions it reaches, the exec-bench kernels and the examples; each result and io output must equal the BigInt oracle of tools/corpus.ts generateCases',
            programs: evals.length,
            skippedOutsideFrontEnd: evals.filter((r) => r.skipped).length,
            cases: evalCases,
            failedPrograms: evalFailed.length,
            rows: evals,
          },
          commands: {
            method:
              '`a0 run` output must equal String() of the reference `run` (what src/cli.ts prints); the `a0 bench K N` checksum must equal the reference over the exec-bench xorshift32 inputs',
            rows: commands,
          },
          linking: {
            method:
              'small projects through src/link.ts and the reference run, and through the native `a0 run`: the result, or the exit code of the diagnostic category, must agree; over-limit (152 KB) must be refused by `a0 run` (exit 65: the front end reads 131072 bytes) where the TypeScript linker accepts 1 MiB; `a0 check` checks it in chunks (tools/native-check-diff.ts)',
            rows: linking,
          },
          checkTimeBySize: {
            method:
              'median of 5 wall-clock `a0 check` processes on the first 88, 176, 355 and 713 functions of the most-functions source; machine load not controlled',
            rows: scale,
          },
          rows,
        },
        null,
        2,
      )}\n`,
    ),
    'utf8',
  );
  process.exit(allOk ? 0 : 1);
}

if (process.argv[1]?.endsWith('native-check.js'))
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
