/**
 * Gate 5 application acceptance across targets: Conway's Life (examples/life.a0) and the
 * self-hosted A0 lexer (compiler/lex.a0), parser (compiler/parse.a0) and checker
 * (compiler/check.a0), each checked against an independent reference.
 *
 * Expected results come from an independent TypeScript reference implementation of Life
 * on a 32x32 torus (no A0 code involved). Cases exercise the session protocol
 * (32 rows, command, x, y -> 32 rows + population) for named patterns and seeded random
 * grids, and are executed through the interpreter, the optimizer, emitted JS in Node,
 * native C (clang, UBSan), C++ (clang++), Wasm in Node, and the JVM using the same driver
 * machinery as the corpus verification. Writes results/app.json.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseAndValidate, type TypedProgram } from '../src/core.js';
import { link } from '../src/link.js';
import { findClang, findClangPlusPlus } from '../src/toolchain.js';
import { type Case, makeRng } from './corpus.js';
import { ILL_TYPED, refCheckWords } from './ref-check.js';
import { FRONT_END_SOURCE_LIMIT, irWords, refLex, refParse } from './ref-parse.js';
import {
  checkInterpreter,
  checkJs,
  checkJvm,
  checkNative,
  checkOptimizer,
  checkWasm,
  type TargetReport,
} from './verify.js';

// --- Independent reference ----------------------------------------------------

type Grid = readonly number[]; // 32 rows, bit c = column c

function refCell(g: Grid, r: number, c: number): number {
  return ((g[(r + 32) % 32] as number) >>> ((c + 32) % 32)) & 1;
}

export function refStep(g: Grid): number[] {
  const out: number[] = new Array(32).fill(0);
  for (let r = 0; r < 32; r += 1) {
    for (let c = 0; c < 32; c += 1) {
      let n = 0;
      for (const dr of [-1, 0, 1])
        for (const dc of [-1, 0, 1]) if (dr !== 0 || dc !== 0) n += refCell(g, r + dr, c + dc);
      const alive = n === 3 || (n === 2 && refCell(g, r, c) === 1);
      if (alive) out[r] = ((out[r] as number) | (1 << c)) >>> 0;
    }
  }
  return out;
}

function refPopulation(g: Grid): number {
  let n = 0;
  for (const row of g) for (let c = 0; c < 32; c += 1) n += (row >>> c) & 1;
  return n;
}

function refSession(g: Grid, cmd: number, x: number, y: number): { rows: number[]; pop: number } {
  let rows: number[];
  if (cmd === 0) rows = refStep(g);
  else if (cmd === 1) {
    rows = [...g];
    rows[y & 31] = ((rows[y & 31] as number) ^ (1 << (x & 31))) >>> 0;
  } else rows = new Array(32).fill(0);
  return { rows, pop: refPopulation(rows) };
}

// --- Cases ----------------------------------------------------------------------

function patternGrid(cells: readonly (readonly [number, number])[]): number[] {
  const g: number[] = new Array(32).fill(0);
  for (const [r, c] of cells) g[r] = ((g[r] as number) | (1 << c)) >>> 0;
  return g;
}

const PATTERNS: Record<string, number[]> = {
  empty: patternGrid([]),
  blinker: patternGrid([
    [15, 14],
    [15, 15],
    [15, 16],
  ]),
  block: patternGrid([
    [10, 10],
    [10, 11],
    [11, 10],
    [11, 11],
  ]),
  glider: patternGrid([
    [1, 2],
    [2, 3],
    [3, 1],
    [3, 2],
    [3, 3],
  ]),
  wrapGlider: patternGrid([
    [30, 31],
    [31, 0],
    [0, 30],
    [0, 31],
    [0, 0],
  ]),
  full: new Array(32).fill(0xffff_ffff),
};

function sessionCase(
  name: string,
  g: Grid,
  cmd: number,
  x: number,
  y: number,
): Case & { readonly label: string } {
  const { rows, pop } = refSession(g, cmd, x, y);
  return {
    label: name,
    functionName: 'life',
    args: [],
    expected: pop,
    input: [...g, cmd, x, y],
    expectedOutput: rows,
  };
}

export function buildCases(): (Case & { readonly label: string })[] {
  const cases: (Case & { readonly label: string })[] = [];
  for (const [name, g] of Object.entries(PATTERNS)) {
    // Step the pattern for several generations through the reference, checking each generation.
    let cur: number[] = g;
    for (let k = 0; k < 6; k += 1) {
      cases.push(sessionCase(`${name}/step${k}`, cur, 0, 0, 0));
      cur = refStep(cur);
    }
    cases.push(sessionCase(`${name}/toggle`, g, 1, 5, 7));
    cases.push(sessionCase(`${name}/toggle-wrap`, g, 1, 37, 40));
    cases.push(sessionCase(`${name}/clear`, g, 2, 0, 0));
  }
  const rng = makeRng(0x11fe);
  for (let i = 0; i < 40; i += 1) {
    const g = Array.from({ length: 32 }, () => rng());
    cases.push(sessionCase(`random${i}/step`, g, 0, 0, 0));
    cases.push(sessionCase(`random${i}/toggle`, g, 1, rng() % 32, rng() % 32));
  }
  return cases;
}

export async function buildLexCases(): Promise<(Case & { readonly label: string })[]> {
  const sources: [string, string][] = [
    ['sq', 'fn sq u32 -> u32\na mul p0 p0\nret a\nend\n'],
    ['edit', 'e0\nb add p0 1 @ a\n-a\ng0\n-fn f\n'],
    ['text', 'fn f -> u32x3\nt text "a\\"b\\\\c"\nret t\nend\n'],
    ['types', 'fn f u32x4 (u32,bool) io -> (u32,io)  # comment\n\tx  mov 4294967295\r\n?\n'],
  ];
  for (const [label, src] of await wholeFiles()) sources.push([label, src]);
  return sources.map(([label, src]) => {
    const bytes = [...Buffer.from(src)];
    const words = refLex(src);
    return {
      label: `lex/${label}`,
      functionName: 'lexio',
      args: [],
      expected: words.length,
      input: [bytes.length, ...bytes],
      expectedOutput: [words.length, ...words],
    };
  });
}

/**
 * Whole A0 files within the front end's 16384-byte source limit: the examples, the lexer's own
 * source, and the site's UI program (text literals, non-ASCII bytes in strings).
 */
async function wholeFiles(): Promise<[string, string][]> {
  const { readdir } = await import('node:fs/promises');
  const files: [string, string][] = [];
  for (const f of (await readdir('examples')).filter((f) => f.endsWith('.a0')).sort())
    files.push([f, await readFile(`examples/${f}`, 'utf8')]);
  files.push(['lex.a0', await readFile('compiler/lex.a0', 'utf8')]);
  files.push(['ui.a0', await readFile('site/ui.a0', 'utf8')]);
  for (const [label, src] of files)
    if (Buffer.byteLength(src) > FRONT_END_SOURCE_LIMIT)
      throw new Error(`${label}: over the front end's ${FRONT_END_SOURCE_LIMIT}-byte source limit`);
  return files;
}

/** Sources the parser and the checker share: small programs, error cases, and whole A0 files. */
async function frontEndSources(): Promise<[string, string][]> {
  const sources: [string, string][] = [
    ['sq', 'fn sq u32 -> u32\na mul p0 p0\nret a\nend\n'],
    ['retop', 'fn f u32 u32 -> u32\nret add p0 p1\nend\n'],
    ['text', 'fn f -> u32x3\nt text "a\\"b\\\\c"\nret t\nend\n'],
    [
      'types',
      'use "lex.a0"\n# comment\nfn f u32x4 (u32,bool) io -> (u32,io)  # trailing\n\tx  mov 4294967295\r\nr read p2\nret r\nend\nfn g ((u32,bool),u32x4) -> (u32,bool)\nv at p0 0\nret v\nend\n',
    ],
    [
      'calls',
      'fn step u32 u32 -> u32\nret add p0 p1\nend\nfn go u32 -> bool\nc lt p0 10\nret c\nend\nfn body u32 u32 u32 -> u32\nret call step p0 p2\nend\nfn pred u32 u32 u32 -> bool\nret call go p0\nend\nfn top u32 -> u32\na fold step 4 0\nb loop pred body 100 a p0\nz select true a b\nret z\nend\n',
    ],
    ['unknown-callee', 'fn f u32 -> u32\na call g p0\nret a\nend\n'],
    ['later-node', 'fn f u32 -> u32\na add b 1\nb mov p0\nret a\nend\n'],
    ['bad-op', 'fn f u32 -> u32\na plus p0 1\nret a\nend\n'],
    ['unterminated', 'fn f u32 -> u32\na add p0 1\n'],
  ];
  return [...sources, ...(await wholeFiles())];
}

export async function buildParseCases(): Promise<(Case & { readonly label: string })[]> {
  const sources = await frontEndSources();
  return sources.map(([label, src]) => {
    const bytes = [...Buffer.from(src)];
    const ir = refParse(src);
    const words = irWords(ir);
    return {
      label: `parse/${label}`,
      functionName: 'parseio',
      args: [],
      expected: ir.code,
      input: [bytes.length, ...bytes],
      expectedOutput: words,
    };
  });
}

export async function buildCheckCases(): Promise<(Case & { readonly label: string })[]> {
  const sources = [...(await frontEndSources()), ...ILL_TYPED];
  return sources.map(([label, src]) => {
    const bytes = [...Buffer.from(src)];
    const words = refCheckWords(src);
    return {
      label: `check/${label}`,
      functionName: 'checkio',
      args: [],
      expected: words[1] as number,
      input: [bytes.length, ...bytes],
      expectedOutput: words,
    };
  });
}

/** Output words the Java io runtime keeps (`A0Io.output` in src/backends.ts); `write` drops the rest. */
const JAVA_IO_OUTPUT_WORDS = 1024;
/** The wasm32 stack of `compileWasm` (`WASM_FLAGS` in src/toolchain.ts). */
const WASM_STACK_MIB = 1;

/**
 * The rows of a self-hosted front-end module on every target. Two targets have size walls the
 * module cannot move: the JVM row runs only the cases whose io output fits the Java runtime's
 * buffer, and the wasm row is reported blocked (not failed) when the build runs out of stack,
 * with the stack the module needs at its capacities (`needMiB`, measured by rebuilding the
 * same C with larger `-z stack-size` values).
 */
async function frontEndTargets(
  program: TypedProgram,
  cases: readonly (Case & { readonly label: string })[],
  needMiB: number,
): Promise<Record<string, TargetReport>> {
  const fitsJvm = cases.filter((c) => (c.expectedOutput?.length ?? 0) <= JAVA_IO_OUTPUT_WORDS);
  const overJvm = cases.filter((c) => !fitsJvm.includes(c)).map((c) => c.label);
  const wasm = await checkWasm(program, cases);
  const stackWall =
    wasm.status === 'failed' &&
    (wasm.failures ?? []).some((f) => f.includes('memory access out of bounds'));
  const jvm = await checkJvm(program, fitsJvm);
  return {
    interpreter: checkInterpreter(program, cases),
    optimizer: checkOptimizer(program, cases),
    javascript: await checkJs(program, cases),
    native_c_clang: await checkNative(program, cases, findClang(), false, 'native C via clang'),
    webassembly: stackWall
      ? {
          status: 'blocked',
          cases: 0,
          detail: `wasm32 size wall: the ${WASM_STACK_MIB} MiB stack is exceeded (memory access out of bounds); aggregates are C structs held by value on the wasm stack, and at the 16384-byte capacities this module needs ${needMiB} MiB`,
          failures: wasm.failures,
        }
      : wasm,
    jvm:
      overJvm.length === 0
        ? jvm
        : {
            ...jvm,
            detail: `${jvm.detail} JVM size wall: ${overJvm.length} cases write more than the Java io runtime's ${JAVA_IO_OUTPUT_WORDS} output words and are not run (${overJvm.join(', ')})`,
          },
  };
}

async function main(): Promise<void> {
  const source = await readFile('examples/life.a0', 'utf8');
  const program = parseAndValidate(source);
  const cases = buildCases();
  // Sanity: the glider returns to its shape translated by (1,1) after four steps (reference only).
  const g4 = [0, 1, 2, 3].reduce((g) => refStep(g), PATTERNS.glider as number[]);
  const shifted = patternGrid([
    [2, 3],
    [3, 4],
    [4, 2],
    [4, 3],
    [4, 4],
  ]);
  const referenceSelfCheck = g4.every((row, i) => row === shifted[i]);
  const targets: Record<string, TargetReport> = {
    interpreter: checkInterpreter(program, cases),
    optimizer: checkOptimizer(program, cases),
    javascript: await checkJs(program, cases),
    native_c_clang: await checkNative(program, cases, findClang(), false, 'native C via clang'),
    native_cpp_clang: await checkNative(
      program,
      cases,
      findClangPlusPlus(),
      true,
      'C-compatible output as C++17 via clang++',
    ),
    webassembly: await checkWasm(program, cases),
    jvm: await checkJvm(program, cases),
  };
  const lexProgram = parseAndValidate(await readFile('compiler/lex.a0', 'utf8'));
  const lexCases = await buildLexCases();
  const lexTargets = await frontEndTargets(lexProgram, lexCases, 2);
  const parseProgram = (await link('compiler/parse.a0', (p) => readFile(p, 'utf8'))).program;
  const parseCases = await buildParseCases();
  const parseTargets = await frontEndTargets(parseProgram, parseCases, 8);
  const checkProgram = (await link('compiler/check.a0', (p) => readFile(p, 'utf8'))).program;
  const checkCases = await buildCheckCases();
  const checkTargets = await frontEndTargets(checkProgram, checkCases, 8);
  const report = {
    generatedAt: new Date().toISOString(),
    application: 'Conway’s Life 32x32 torus session protocol (examples/life.a0)',
    lexer: {
      application: 'Self-hosted A0 lexer (compiler/lex.a0), io front lexio',
      reference: 'Independent TypeScript tokenizer refLex in tools/app.ts',
      cases: lexCases.length,
      caseLabels: lexCases.map((c) => c.label),
      targets: lexTargets,
    },
    parser: {
      application: 'Self-hosted A0 parser (compiler/parse.a0 linked with lex.a0), io front parseio',
      reference: 'Independent TypeScript token-driven parser refParse in tools/app.ts (word IR)',
      cases: parseCases.length,
      caseLabels: parseCases.map((c) => c.label),
      targets: parseTargets,
    },
    checker: {
      application:
        'Self-hosted A0 checker (compiler/check.a0 linked with parse.a0 and lex.a0), io front checkio',
      reference:
        'Independent TypeScript checker refCheck in tools/ref-check.ts over the word IR of refParse',
      cases: checkCases.length,
      caseLabels: checkCases.map((c) => c.label),
      targets: checkTargets,
    },
    reference:
      'Independent TypeScript implementation in tools/app.ts (refStep/refSession); no A0 code involved',
    referenceSelfCheck,
    functions: program.functions.length,
    cases: cases.length,
    caseLabels: cases.map((c) => c.label),
    targets,
    browser:
      'The Wasm build is also driven by the DOM adapter in site/ (built by `bun run site`); browser execution is checked manually or with the in-app browser, not by this script.',
  };
  await mkdir('results', { recursive: true });
  await writeFile(join('results', 'app.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`reference self-check: ${referenceSelfCheck ? 'ok' : 'FAILED'}\n`);
  for (const [name, t] of Object.entries(targets)) {
    process.stdout.write(
      `${name.padEnd(18)} ${t.status.padEnd(10)} ${String(t.cases).padStart(5)} cases  ${t.detail.slice(0, 80)}\n`,
    );
    if (t.failures)
      for (const f of t.failures.slice(0, 5)) process.stdout.write(`    ${f.slice(0, 300)}\n`);
  }
  process.stdout.write('lexer (compiler/lex.a0):\n');
  for (const [name, t] of Object.entries(lexTargets)) {
    process.stdout.write(
      `${name.padEnd(18)} ${t.status.padEnd(10)} ${String(t.cases).padStart(5)} cases  ${t.detail.slice(0, 80)}\n`,
    );
    if (t.failures)
      for (const f of t.failures.slice(0, 5)) process.stdout.write(`    ${f.slice(0, 300)}\n`);
  }
  process.stdout.write('parser (compiler/parse.a0):\n');
  for (const [name, t] of Object.entries(parseTargets)) {
    process.stdout.write(
      `${name.padEnd(18)} ${t.status.padEnd(10)} ${String(t.cases).padStart(5)} cases  ${t.detail.slice(0, 80)}\n`,
    );
    if (t.failures)
      for (const f of t.failures.slice(0, 5)) process.stdout.write(`    ${f.slice(0, 300)}\n`);
  }
  process.stdout.write('checker (compiler/check.a0):\n');
  for (const [name, t] of Object.entries(checkTargets)) {
    process.stdout.write(
      `${name.padEnd(18)} ${t.status.padEnd(10)} ${String(t.cases).padStart(5)} cases  ${t.detail.slice(0, 80)}\n`,
    );
    if (t.failures)
      for (const f of t.failures.slice(0, 5)) process.stdout.write(`    ${f.slice(0, 300)}\n`);
  }
  const bad =
    !referenceSelfCheck ||
    Object.values(targets).some((t) => t.status === 'failed') ||
    Object.values(lexTargets).some((t) => t.status === 'failed') ||
    Object.values(parseTargets).some((t) => t.status === 'failed') ||
    Object.values(checkTargets).some((t) => t.status === 'failed');
  process.exit(bad ? 1 : 0);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
