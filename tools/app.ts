/**
 * Gate 5 application acceptance across targets: Conway's Life (examples/life.a0) and the
 * self-hosted A0 lexer (compiler/lex.a0), each checked against an independent reference.
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
import { parseAndValidate } from '../src/core.js';
import { findClang, findClangPlusPlus } from '../src/toolchain.js';
import { type Case, makeRng } from './corpus.js';
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

// --- Self-hosted lexer reference ---------------------------------------------------

/** The token grammar of compiler/lex.a0, written directly: (kind start length) triples. */
export function refLex(src: string): number[] {
  const out: number[] = [];
  const b = Buffer.from(src);
  let i = 0;
  const word = (c: number): boolean => (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95;
  while (i < b.length) {
    const c = b[i] as number;
    if (c === 32 || c === 9 || c === 13) i += 1;
    else if (c === 10) {
      out.push(5, i, 1);
      i += 1;
    } else if (c === 35) {
      while (i < b.length && b[i] !== 10) i += 1;
    } else if (word(c)) {
      const s = i;
      while (i < b.length && word(b[i] as number)) i += 1;
      out.push(c >= 48 && c <= 57 ? 2 : 1, s, i - s);
    } else if (c === 34) {
      const s = i + 1;
      i += 1;
      while (i < b.length && b[i] !== 34) i += b[i] === 92 ? 2 : 1;
      if (i < b.length) out.push(3, s, i - s);
      i += 1;
    } else if (c === 45 && b[i + 1] === 62) {
      out.push(4, i, 2);
      i += 2;
    } else {
      out.push(c === 45 ? 6 : c === 64 ? 7 : 9, i, 1);
      i += 1;
    }
  }
  return out;
}

export async function buildLexCases(): Promise<(Case & { readonly label: string })[]> {
  const sources: [string, string][] = [
    ['sq', 'fn sq u32 -> u32\na mul p0 p0\nret a\nend\n'],
    ['edit', 'e0\nb add p0 1 @ a\n-a\ng0\n-fn f\n'],
    ['text', 'fn f -> u32x3\nt text "a\\"b\\\\c"\nret t\nend\n'],
    ['types', 'fn f u32x4 (u32,bool) io -> (u32,io)  # comment\n\tx  mov 4294967295\r\n?\n'],
  ];
  const { readdir } = await import('node:fs/promises');
  for (const f of (await readdir('examples')).filter((f) => f.endsWith('.a0')).sort()) {
    const text = (await readFile(`examples/${f}`, 'utf8')).slice(0, 500);
    sources.push([f, text.slice(0, text.lastIndexOf('\n') + 1)]);
  }
  sources.push(['lex.a0', (await readFile('compiler/lex.a0', 'utf8')).slice(0, 500)]);
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
  const lexTargets: Record<string, TargetReport> = {
    interpreter: checkInterpreter(lexProgram, lexCases),
    optimizer: checkOptimizer(lexProgram, lexCases),
    javascript: await checkJs(lexProgram, lexCases),
    native_c_clang: await checkNative(
      lexProgram,
      lexCases,
      findClang(),
      false,
      'native C via clang',
    ),
    webassembly: await checkWasm(lexProgram, lexCases),
    jvm: await checkJvm(lexProgram, lexCases),
  };
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
  const bad =
    !referenceSelfCheck ||
    Object.values(targets).some((t) => t.status === 'failed') ||
    Object.values(lexTargets).some((t) => t.status === 'failed');
  process.exit(bad ? 1 : 0);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
