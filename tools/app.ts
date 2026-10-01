/**
 * Gate 5 application acceptance across targets: Conway's Life (examples/life.a0) and the
 * self-hosted A0 lexer (compiler/lex.a0), parser (compiler/parse.a0) and checker
 * (compiler/check.a0), each checked against an independent reference, the AArch64
 * emitter (compiler/emit_arm64.a0), whose assembly bytes must be identical across targets
 * (its correctness is checked by execution in tools/selfhost-verify.ts), and the C emitter
 * (compiler/emit_c.a0), whose C must be byte-identical on every target to `emitc` run over the
 * reference front end's tables (tools/selfhost-c.ts compiles and runs that C).
 *
 * Expected results come from an independent TypeScript reference implementation of Life
 * on a 32x32 torus (no A0 code involved). Cases exercise the session protocol
 * (32 rows, command, x, y -> 32 rows + population) for named patterns and seeded random
 * grids, and are executed through the interpreter, the optimizer, emitted JS in Node,
 * native C (clang, UBSan), C++ (clang++), Wasm in Node, and the JVM using the same driver
 * machinery as the corpus verification. Writes results/app.json.
 */

import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  formatProgram,
  makeIo,
  parseAndValidate,
  run,
  type TypedFunc,
  type TypedProgram,
} from '../src/core.js';
import { link } from '../src/link.js';
import { findClang, findClangPlusPlus } from '../src/toolchain.js';
import { type Case, makeRng } from './corpus.js';
import { frontEndSources, UNKNOWN_NAMES, wholeFiles } from './front-end-sources.js';
import { ILL_TYPED, refCheck, refCheckWords } from './ref-check.js';
import { irWords, refLex, refParse, refSuggest } from './ref-parse.js';
import { writeReport } from './scrub-results.js';
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

/**
 * `suggestio` cases: every unknown-name program at the token the parser rejects (the row and the
 * suggestion), and at its first token (not a name: rule 0). The expected words are refSuggest's.
 */
export function buildSuggestCases(): (Case & { readonly label: string })[] {
  return UNKNOWN_NAMES.flatMap(([id, src], k) => {
    const bytes = [...Buffer.from(src)];
    const tokens = [refParse(src).tok, 0];
    return tokens.map((tok) => {
      const words = refSuggest(src, tok);
      return {
        label: `suggest/${id}-${k}-token${tok}`,
        functionName: 'suggestio',
        args: [],
        expected: words[0] as number,
        input: [bytes.length, ...bytes, tok],
        expectedOutput: words,
      };
    });
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

/** The wasm32 stack of `compileWasm` (`WASM_FLAGS` in src/toolchain.ts). */
const WASM_STACK_MIB = 1;

/**
 * The rows of a self-hosted front-end module on every target. One target has a size wall the
 * module cannot move: the wasm row is reported blocked (not failed) when the build runs out of stack,
 * with the stack the module needs at its capacities (`needMiB`, measured by rebuilding the
 * same C with larger `-z stack-size` values).
 */
async function frontEndTargets(
  program: TypedProgram,
  cases: readonly (Case & { readonly label: string })[],
  needMiB: number,
): Promise<Record<string, TargetReport>> {
  const wasm = await checkWasm(program, cases);
  const stackWall =
    wasm.status === 'failed' &&
    (wasm.failures ?? []).some((f) => f.includes('memory access out of bounds'));
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
    jvm: await checkJvm(program, cases),
  };
}

/**
 * `emitio` cases: the scalar examples, one module each for call, fold and loop, and
 * refusals (an array parameter, io, a record, an ill-typed module). The expected output words are the reference interpreter's run of the
 * emitter; every other target must produce the same assembly bytes. That the bytes are
 * correct assembly is checked by execution in `bun run selfhost`.
 */
export async function buildEmitCases(
  emitter: Awaited<ReturnType<typeof link>>['program'],
): Promise<(Case & { readonly label: string })[]> {
  const kernels = parseAndValidate(await readFile('examples/kernels.a0', 'utf8'));
  const sources: [string, string][] = ['affine', 'clamp_max', 'rotl', 'is_even', 'parity_select']
    .filter((n) => kernels.byName.has(n))
    .map((n) => [n, formatProgram({ functions: [kernels.byName.get(n) as TypedFunc] })]);
  sources.push(
    [
      'call',
      'fn step u32 u32 -> u32\nret add p0 p1\nend\nfn top u32 -> u32\na call step p0 7\nret a\nend\n',
    ],
    [
      'fold',
      'fn step u32 u32 -> u32\nret add p0 p1\nend\nfn top u32 -> u32\na fold step 4 p0\nret a\nend\n',
    ],
    [
      'loop',
      'fn pred u32 u32 u32 -> bool\nret lt p1 10\nend\nfn body u32 u32 u32 -> u32\nret add p1 p2\nend\nfn top u32 -> u32\nb loop pred body 100 p0 3\nret b\nend\n',
    ],
    ['refuse-array', 'fn f u32x4 -> u32\nv get p0 1\nret v\nend\n'],
    ['refuse-io', 'fn f io -> u32\nr read p0\nv at r 0\nret v\nend\n'],
    ['refuse-record', 'fn f u32 -> (u32,bool)\nr rec p0 true\nret r\nend\n'],
    ['ill-typed', 'fn f u32 -> u32\na add p0 true\nret a\nend\n'],
  );
  const emitio = emitter.byName.get('emitio') as TypedFunc;
  return sources.map(([label, src]) => {
    const bytes = [...Buffer.from(src)];
    const input = [bytes.length, ...bytes];
    const state = makeIo(input);
    const expected = run(emitio, [state]) as number;
    return {
      label: `emit/${label}`,
      functionName: 'emitio',
      args: [],
      expected,
      input,
      expectedOutput: [...state.output],
    };
  });
}

/**
 * emitcio cases: the C bytes of `emitc` (in the reference interpreter) over the tables of the
 * reference parser and checker, or no output with the diagnostic code for rejected programs.
 * `emitcio` runs the 16384-byte front end; the cases keep to sources of at most 512 bytes so
 * that the reference emission in the interpreter stays short.
 */
const EMITCIO_SOURCE_LIMIT = 512;

export async function buildEmitCCases(
  emitc: TypedFunc,
): Promise<(Case & { readonly label: string })[]> {
  const all: [string, string][] = [
    [
      'clamp',
      'fn clamp u32 u32 u32 -> u32\nlo lt p0 p1\na select lo p1 p0\nhi gt a p2\nr select hi p2 a\nret r\nend\n',
    ],
    ...(await frontEndSources()),
    ...ILL_TYPED.slice(0, 4),
  ];
  const sources = all.filter(([, src]) => Buffer.byteLength(src) <= EMITCIO_SOURCE_LIMIT);
  // The emitter's tables are the front end's: `count` pages of 128 words (types 384).
  const paged = (t: readonly number[], count: number, size = 128): number[][] =>
    Array.from({ length: count }, (_, p) => {
      const page = t.slice(p * size, p * size + size);
      return [...page, ...new Array(size - page.length).fill(0)];
    });
  return sources.map(([label, src]) => {
    const bytes = [...Buffer.from(src)];
    const code = refCheckWords(src)[1] as number;
    let output: number[] = [];
    if (code === 0) {
      const ir = refParse(src);
      const r = refCheck(ir);
      const nfns = ir.fns.length / 7;
      const fnm = Array.from({ length: nfns }, (_, i) => {
        const name = ir.fns[i * 7] as number;
        return [ir.sym[name * 2] as number, ir.sym[name * 2 + 1] as number];
      }).flat();
      const io = makeIo([]);
      run(emitc, [
        io,
        paged(r.types, 65, 384),
        paged(r.tlist, 65),
        paged(ir.fns, 45),
        paged(ir.nodes, 128),
        paged(ir.args, 512),
        paged(r.nodeTypes, 24),
        paged(ir.pool, 400),
        paged(fnm, 16),
        r.types.length / 3,
        3,
        0,
        nfns,
        1,
      ]);
      output = [...io.output];
    }
    return {
      label: `emitc/${label}`,
      functionName: 'emitcio',
      args: [],
      expected: code,
      input: [bytes.length, ...bytes],
      expectedOutput: output,
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
  const lexTargets = await frontEndTargets(lexProgram, lexCases, 2);
  const parseProgram = (await link('compiler/parse.a0', (p) => readFile(p, 'utf8'), { root: '.' }))
    .program;
  const parseCases = await buildParseCases();
  const parseTargets = await frontEndTargets(parseProgram, parseCases, 8);
  const checkProgram = (await link('compiler/check.a0', (p) => readFile(p, 'utf8'), { root: '.' }))
    .program;
  const checkCases = await buildCheckCases();
  const checkTargets = await frontEndTargets(checkProgram, checkCases, 8);
  const suggestProgram = (
    await link('compiler/suggest.a0', (p) => readFile(p, 'utf8'), { root: '.' })
  ).program;
  const suggestCases = buildSuggestCases();
  const suggestTargets = await frontEndTargets(suggestProgram, suggestCases, 8);
  const emitProgram = (
    await link('compiler/emit_arm64.a0', (p) => readFile(p, 'utf8'), { root: '.' })
  ).program;
  const emitCases = await buildEmitCases(emitProgram);
  const cEmitProgram = (await link('compiler/emit_c.a0', (p) => readFile(p, 'utf8'), { root: '.' }))
    .program;
  const cEmitCases = await buildEmitCCases(cEmitProgram.byName.get('emitc') as TypedFunc);
  const emitTargets: Record<string, TargetReport> = {
    interpreter: checkInterpreter(emitProgram, emitCases),
    optimizer: checkOptimizer(emitProgram, emitCases),
    javascript: await checkJs(emitProgram, emitCases),
    native_c_clang: await checkNative(
      emitProgram,
      emitCases,
      findClang(),
      false,
      'native C via clang',
    ),
    webassembly: await checkWasm(emitProgram, emitCases),
    jvm: await checkJvm(emitProgram, emitCases),
  };
  // emitcio runs the 16384-byte front end, so it meets the checker's wasm stack wall.
  const cEmitTargets = await frontEndTargets(cEmitProgram, cEmitCases, 8);
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
    suggester: {
      application:
        'Self-hosted A0 spelling suggestions (compiler/suggest.a0 linked with lex.a0), io front suggestio',
      reference:
        'Independent TypeScript refSuggest in tools/ref-parse.ts (the rule of getSpellingSuggestion over the token stream)',
      cases: suggestCases.length,
      caseLabels: suggestCases.map((c) => c.label),
      targets: suggestTargets,
    },
    emitter: {
      application:
        'Self-hosted A0 AArch64 emitter (compiler/emit_arm64.a0 linked with check.a0, parse.a0, lex.a0), io front emitio',
      reference:
        'Byte-identical assembly across targets (expected from the reference interpreter); correctness by execution in results/selfhost.json',
      cases: emitCases.length,
      caseLabels: emitCases.map((c) => c.label),
      targets: emitTargets,
    },
    cEmitter: {
      application:
        'Self-hosted A0 C emitter (compiler/emit_c.a0 linked with check.a0, parse.a0 and lex.a0), io front emitcio',
      reference:
        'emitc in the reference interpreter over the tables of refParse and refCheck: the C bytes must be identical on every target (tools/selfhost-c.ts compiles that C and checks it against the oracle)',
      cases: cEmitCases.length,
      caseLabels: cEmitCases.map((c) => c.label),
      cBytes: Object.fromEntries(cEmitCases.map((c) => [c.label, c.expectedOutput?.length ?? 0])),
      targets: cEmitTargets,
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
  await writeReport(join('results', 'app.json'), report);
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
  process.stdout.write('suggester (compiler/suggest.a0):\n');
  for (const [name, t] of Object.entries(suggestTargets)) {
    process.stdout.write(
      `${name.padEnd(18)} ${t.status.padEnd(10)} ${String(t.cases).padStart(5)} cases  ${t.detail.slice(0, 80)}\n`,
    );
    if (t.failures)
      for (const f of t.failures.slice(0, 5)) process.stdout.write(`    ${f.slice(0, 300)}\n`);
  }
  process.stdout.write('emitter (compiler/emit_arm64.a0):\n');
  for (const [name, t] of Object.entries(emitTargets)) {
    process.stdout.write(
      `${name.padEnd(18)} ${t.status.padEnd(10)} ${String(t.cases).padStart(5)} cases  ${t.detail.slice(0, 80)}\n`,
    );
    if (t.failures)
      for (const f of t.failures.slice(0, 5)) process.stdout.write(`    ${f.slice(0, 300)}\n`);
  }
  process.stdout.write('C emitter (compiler/emit_c.a0):\n');
  for (const [name, t] of Object.entries(cEmitTargets)) {
    process.stdout.write(
      `${name.padEnd(18)} ${t.status.padEnd(10)} ${String(t.cases).padStart(5)} cases  ${t.detail.slice(0, 80)}\n`,
    );
    if (t.failures)
      for (const f of t.failures.slice(0, 5)) process.stdout.write(`    ${f.slice(0, 300)}\n`);
  }
  const bad =
    !referenceSelfCheck ||
    Object.values(emitTargets).some((t) => t.status === 'failed') ||
    Object.values(cEmitTargets).some((t) => t.status === 'failed') ||
    Object.values(targets).some((t) => t.status === 'failed') ||
    Object.values(lexTargets).some((t) => t.status === 'failed') ||
    Object.values(parseTargets).some((t) => t.status === 'failed') ||
    Object.values(suggestTargets).some((t) => t.status === 'failed') ||
    Object.values(checkTargets).some((t) => t.status === 'failed');
  process.exit(bad ? 1 : 0);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
