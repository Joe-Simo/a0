/**
 * Bootstrap step 1 of self-hosting (DESIGN.md 7a stage 6). Stage 1: the A0-written C emitter
 * pipeline (compiler/emit_c.a0 linked with check.a0, parse.a0, lex.a0; entry `emitcio`) is
 * compiled by the TypeScript compiler's C backend plus clang into a native `a0c-stage1` that
 * reads A0 source bytes on stdin and writes C on stdout (exit status: the front end's
 * diagnostic code). Stage 2: stage 1 compiles small programs, the corpus and example functions
 * (each with its callees) and the compiler's own functions, as far as they fit the front end's
 * tables; its output must equal the interpreter's `emitcio` byte for byte, its C is compiled by
 * clang and must give the independent oracle's result on every case, and the TypeScript C
 * emitter's module must give the same results (observable agreement). Rejected programs must
 * give the reference checker's code and no C. Writes results/bootstrap.json.
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { C_IO_INPUT_CAPACITY, C_IO_OUTPUT_CAPACITY, compile } from '../src/backends.js';
import {
  type Func,
  formatProgram,
  makeIo,
  parseAndValidate,
  run,
  type TypedFunc,
  type TypedProgram,
} from '../src/core.js';
import { link } from '../src/link.js';
import { findClang, runTool, type ToolInfo, withTempDir } from '../src/toolchain.js';
import { generateCases, generateCorpus } from './corpus.js';
import { ILL_TYPED, refCheckWords } from './ref-check.js';
import { checkNative, ioCaps, type TargetReport } from './verify.js';

/** The front end's source limit (compiler/lex.a0: u32x512 source and token arrays). */
const FRONT_END_BYTES = 512;
/** Stage 1's io capacities: the length word plus the source, and the C it writes. */
const STAGE1_INPUT = FRONT_END_BYTES + 8;
const STAGE1_OUTPUT = 1 << 20;
/** Table capacities of the A0 front end (compiler/parse.a0, check.a0) for the limit report. */
const TABLES = { fns: 1024, nodes: 4096, args: 8192, pool: 512, sym: 512, types: 768 };
const BUILD_DIR = join('dist', 'bootstrap');

const SMALL: [string, string][] = [
  [
    'clamp',
    'fn clamp u32 u32 u32 -> u32\nlo lt p0 p1\na select lo p1 p0\nhi gt a p2\nr select hi p2 a\nret r\nend\n',
  ],
  ['sq', 'fn sq u32 -> u32\na mul p0 p0\nret a\nend\n'],
  ['retop', 'fn f u32 u32 -> u32\nret add p0 p1\nend\n'],
  [
    'calls',
    'fn step u32 u32 -> u32\nret add p0 p1\nend\nfn go u32 -> bool\nc lt p0 10\nret c\nend\nfn body u32 u32 u32 -> u32\nret call step p0 p2\nend\nfn pred u32 u32 u32 -> bool\nret call go p0\nend\nfn top u32 -> u32\na fold step 4 0\nb loop pred body 100 a p0\nz select true a b\nret z\nend\n',
  ],
];

/** Stage 1's entry: stdin bytes become the io stream (length, bytes); output words are bytes. */
const STAGE1_MAIN = `#include <stdio.h>
#include "emitter.c"
int main(void) {
  static a0_io io;
  static unsigned char src[${FRONT_END_BYTES + 1}];
  size_t n = fread(src, 1, sizeof src, stdin);
  if (n > ${FRONT_END_BYTES}u) {
    fprintf(stderr, "a0c-stage1: source over the front end's ${FRONT_END_BYTES} bytes\\n");
    return 64;
  }
  io.input[0] = (uint32_t)n;
  for (size_t k = 0; k < n; k++) io.input[k + 1] = src[k];
  io.ninput = (uint32_t)n + 1u;
  uint32_t code = a0_emitcio(&io);
  if (io.noutput >= ${STAGE1_OUTPUT}u) {
    fprintf(stderr, "a0c-stage1: output capacity reached\\n");
    return 65;
  }
  for (uint32_t k = 0; k < io.noutput; k++) putchar((int)(io.output[k] & 255u));
  return (int)code;
}
`;

/** Sources compared with `emitcio` in the reference interpreter (about 4.5 s each there). */
const INTERPRETED = new Set(['small', 'kernels.a0']);
const INTERPRETED_ILL_TYPED = 4;

/** A module without driver-callable functions: it must compile warning-free on its own. */
async function compileOnly(clang: ToolInfo, text: string): Promise<TargetReport> {
  return withTempDir(async (dir) => {
    await writeFile(join(dir, 'module.c'), text, 'utf8');
    // Included like the test driver includes it, so unused prelude helpers draw no warning.
    await writeFile(join(dir, 'unit.c'), '#include "module.c"\n', 'utf8');
    const r = runTool(
      clang.path as string,
      ['-std=c11', '-O1', '-Wall', '-Wextra', '-Wno-unused-parameter', '-Werror', '-c', 'unit.c'],
      { cwd: dir },
    );
    return r.ok
      ? { status: 'passed', cases: 0, detail: 'compiled (-Werror); no driver-callable function' }
      : { status: 'failed', cases: 0, detail: 'build failed', failures: [r.stderr.slice(0, 2000)] };
  });
}

interface Emission {
  readonly code: number;
  readonly text: string;
  readonly ms: number;
}

function runStage1(exe: string, src: string): Emission {
  const start = performance.now();
  const r = runTool(exe, [], { input: src, timeoutMs: 60_000 });
  const ms = performance.now() - start;
  if (r.status === null || r.status > 4) throw new Error(`a0c-stage1 failed: ${r.stderr}`);
  return { code: r.status, text: r.stdout, ms };
}

function runInterpreter(emitcio: TypedFunc, src: string): Emission {
  const bytes = [...Buffer.from(src)];
  const io = makeIo([bytes.length, ...bytes]);
  const start = performance.now();
  const code = run(emitcio, [io], { fuel: 1e12 }) as number;
  return {
    code,
    text: Buffer.from(io.output.map((w) => w & 255)).toString('latin1'),
    ms: performance.now() - start,
  };
}

/** Function `name` with every function it reaches (calls, fold/loop bodies and predicates). */
function closure(fns: readonly Func[], root: string): string {
  const byName = new Map(fns.map((f) => [f.name, f] as const));
  const seen = new Set<string>();
  const visit = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    for (const n of byName.get(name)?.nodes ?? []) {
      if (n.callee !== undefined) visit(n.callee);
      if (n.pred !== undefined) visit(n.pred);
    }
  };
  visit(root);
  return formatProgram({ functions: fns.filter((f) => seen.has(f.name)) });
}

/** Distinct callee closures of every function of `program`, labelled `prefix/name`. */
function closures(prefix: string, program: TypedProgram): [string, string][] {
  const out = new Map<string, string>();
  for (const f of program.functions) {
    const src = closure(program.functions, f.name);
    if (![...out.values()].includes(src)) out.set(`${prefix}/${f.name}`, src);
  }
  return [...out];
}

interface SourceReport {
  readonly label: string;
  readonly group: string;
  readonly bytes: number;
  readonly outcome: 'passed' | 'compiled' | 'rejected' | 'too-large' | 'failed';
  readonly code?: number;
  readonly functions?: number;
  readonly cases?: number;
  readonly cBytes?: number;
  readonly stage1Ms?: number;
  /** Present when the source was also emitted by `emitcio` in the reference interpreter. */
  readonly interpreterMs?: number;
  readonly sameAsInterpreter?: boolean;
  readonly stage1C?: TargetReport;
  readonly typescriptC?: TargetReport;
  readonly detail?: string;
}

async function main(): Promise<void> {
  const clang = findClang();
  if (clang.path === undefined) throw new Error('clang not found');
  const emitter = (await link('compiler/emit_c.a0', (p) => readFile(p, 'utf8'))).program;
  const emitcio = emitter.byName.get('emitcio') as TypedFunc;

  // Stage 1: the emitter pipeline through the TypeScript C backend and clang.
  await mkdir(BUILD_DIR, { recursive: true });
  const emitterC = compile(emitter, 'c', {
    ioInputCapacity: STAGE1_INPUT,
    ioOutputCapacity: STAGE1_OUTPUT,
  }).text;
  await writeFile(join(BUILD_DIR, 'emitter.c'), emitterC, 'utf8');
  await writeFile(join(BUILD_DIR, 'main.c'), STAGE1_MAIN, 'utf8');
  const exe = join(BUILD_DIR, 'a0c-stage1');
  const buildStart = performance.now();
  const build = runTool(
    clang.path,
    ['-std=c11', '-O2', '-Wall', '-Wextra', '-Wno-unused-parameter', '-o', 'a0c-stage1', 'main.c'],
    { cwd: BUILD_DIR, timeoutMs: 600_000 },
  );
  const buildMs = Math.round(performance.now() - buildStart);
  if (!build.ok) throw new Error(`stage 1 build failed:\n${build.stderr.slice(0, 4000)}`);
  process.stdout.write(
    `stage 1: ${emitter.functions.length} functions, ${Buffer.byteLength(emitterC)} C bytes, clang -O2 in ${buildMs} ms -> ${exe}\n`,
  );

  // Stage 2 inputs.
  const groups: [string, [string, string][]][] = [
    ['small', SMALL],
    ['ill-typed', [...ILL_TYPED]],
    ['corpus', closures('corpus', generateCorpus())],
  ];
  for (const f of (await readdir('examples')).filter((f) => f.endsWith('.a0')).sort()) {
    const text = await readFile(`examples/${f}`, 'utf8');
    const program = parseAndValidate(text);
    groups.push([f, [[f, text], ...closures(f, program)]]);
  }
  groups.push(['compiler', closures('emit_c.a0', emitter)]);

  const reports: SourceReport[] = [];
  for (const [group, sources] of groups) {
    for (const [index, [label, src]] of sources.entries()) {
      const bytes = Buffer.byteLength(src);
      if (bytes > FRONT_END_BYTES) {
        reports.push({ label, group, bytes, outcome: 'too-large' });
        continue;
      }
      const s1 = runStage1(exe, src);
      const interpret =
        INTERPRETED.has(group) || (group === 'ill-typed' && index < INTERPRETED_ILL_TYPED);
      const interp = interpret ? runInterpreter(emitcio, src) : undefined;
      const same = interp === undefined || (s1.code === interp.code && s1.text === interp.text);
      const common = {
        label,
        group,
        bytes,
        code: s1.code,
        stage1Ms: Math.round(s1.ms * 10) / 10,
        ...(interp === undefined
          ? {}
          : { interpreterMs: Math.round(interp.ms), sameAsInterpreter: same }),
      };
      if (s1.code !== 0) {
        const expected = refCheckWords(src)[1] as number;
        const ok = same && s1.text.length === 0 && (group !== 'ill-typed' || s1.code === expected);
        reports.push({
          ...common,
          outcome: ok ? 'rejected' : 'failed',
          detail: `diagnostic ${s1.code} (reference checker ${expected})`,
        });
        continue;
      }
      const program = parseAndValidate(src);
      const cases = generateCases(program);
      const caps = ioCaps(cases);
      if (
        caps.ioInputCapacity > C_IO_INPUT_CAPACITY ||
        caps.ioOutputCapacity > C_IO_OUTPUT_CAPACITY
      )
        throw new Error(`${label}: cases exceed the emitted C's fixed io capacities`);
      if (cases.length === 0) {
        const stage1C = await compileOnly(clang, s1.text);
        const typescriptC = await compileOnly(clang, compile(program, 'c').text);
        const ok = same && stage1C.status === 'passed' && typescriptC.status === 'passed';
        reports.push({
          ...common,
          outcome: ok ? 'compiled' : 'failed',
          functions: program.functions.length,
          cases: 0,
          cBytes: Buffer.byteLength(s1.text),
          stage1C,
          typescriptC,
        });
        continue;
      }
      const stage1C = await checkNative(
        program,
        cases,
        clang,
        false,
        'C from a0c-stage1 via clang',
        s1.text,
      );
      const typescriptC = await checkNative(
        program,
        cases,
        clang,
        false,
        'C from the TypeScript emitter via clang',
      );
      const ok = same && stage1C.status === 'passed' && typescriptC.status === 'passed';
      reports.push({
        ...common,
        outcome: ok ? 'passed' : 'failed',
        functions: program.functions.length,
        cases: cases.length,
        cBytes: Buffer.byteLength(s1.text),
        stage1C,
        typescriptC,
      });
    }
    const mine = reports.filter((r) => r.group === group);
    const count = (o: SourceReport['outcome']): number =>
      mine.filter((r) => r.outcome === o).length;
    process.stdout.write(
      `${group.padEnd(12)} ${mine.length} sources: ${count('passed')} passed, ${count('compiled')} compile-only (${mine.reduce((n, r) => n + (r.outcome === 'passed' ? (r.cases ?? 0) : 0), 0)} cases), ${count('rejected')} rejected as expected, ${count('too-large')} over ${FRONT_END_BYTES} bytes, ${count('failed')} failed\n`,
    );
    for (const r of mine.filter((r) => r.outcome === 'failed'))
      process.stdout.write(
        `    FAIL ${r.label}: ${r.detail ?? ''} same=${r.sameAsInterpreter} ${[...(r.stage1C?.failures ?? []), ...(r.typescriptC?.failures ?? [])].join(' | ').slice(0, 600)}\n`,
      );
  }

  const fed = reports.filter((r) => r.stage1Ms !== undefined);
  const timedBoth = fed.filter((r) => r.interpreterMs !== undefined);
  const stage1Ms = timedBoth.reduce((n, r) => n + (r.stage1Ms ?? 0), 0);
  const interpreterMs = timedBoth.reduce((n, r) => n + (r.interpreterMs ?? 0), 0);
  process.stdout.write(
    `emission over ${timedBoth.length} sources run both ways: a0c-stage1 ${Math.round(stage1Ms)} ms (process spawn included), interpreter ${interpreterMs} ms, ${(interpreterMs / stage1Ms).toFixed(1)}x; all ${fed.length} fed sources through stage 1 in ${Math.round(fed.reduce((n, r) => n + (r.stage1Ms ?? 0), 0))} ms\n`,
  );

  // What blocks the full fixed point: stage 1 compiling compiler/emit_c.a0 itself.
  const linkedSource = formatProgram({ functions: emitter.functions });
  const nodes = emitter.functions.reduce((n, f) => n + f.nodes.length, 0);
  const args = emitter.functions.reduce(
    (n, f) => n + f.nodes.reduce((m, x) => m + x.args.length, 0),
    0,
  );
  const names = new Set<string>();
  for (const f of emitter.functions) {
    names.add(f.name);
    for (const n of f.nodes) names.add(n.id);
  }
  const poolBytes = [...names].reduce((n, s) => n + Buffer.byteLength(s), 0);
  const selfFits = reports.filter((r) => r.group === 'compiler' && r.outcome !== 'too-large');
  const selfOk = selfFits.filter((r) => r.outcome === 'passed' || r.outcome === 'compiled');
  const fixedPoint = {
    emitterFiles: {
      'emit_c.a0': Buffer.byteLength(await readFile('compiler/emit_c.a0', 'utf8')),
      'check.a0': Buffer.byteLength(await readFile('compiler/check.a0', 'utf8')),
      'parse.a0': Buffer.byteLength(await readFile('compiler/parse.a0', 'utf8')),
      'lex.a0': Buffer.byteLength(await readFile('compiler/lex.a0', 'utf8')),
    },
    linkedFormattedBytes: Buffer.byteLength(linkedSource),
    sourceLimitBytes: FRONT_END_BYTES,
    functions: emitter.functions.length,
    fnsWords: emitter.functions.length * 7,
    fnsCapacity: TABLES.fns,
    nodes,
    nodesWords: nodes * 6,
    nodesCapacity: TABLES.nodes,
    argWords: args * 2,
    argsCapacity: TABLES.args,
    distinctNameBytes: poolBytes,
    poolCapacity: TABLES.pool,
    symWords: names.size * 2,
    symCapacity: TABLES.sym,
    largestFunctionNodes: Math.max(...emitter.functions.map((f) => f.nodes.length)),
    ownClosuresWithinLimit: selfFits.length,
    ownClosuresPassed: selfOk.length,
    ownClosuresWithCases: selfFits.filter((r) => r.outcome === 'passed').length,
    ownClosures: reports.filter((r) => r.group === 'compiler').length,
    use: 'emitcio has no `use` resolution: the input is one self-contained source, so emit_c.a0 must be fed pre-linked',
  };
  process.stdout.write(
    `fixed point: emit_c.a0 linked is ${fixedPoint.linkedFormattedBytes} bytes (limit ${FRONT_END_BYTES}), ${fixedPoint.functions} fns (${fixedPoint.fnsWords}/${TABLES.fns} words), ${nodes} nodes (${fixedPoint.nodesWords}/${TABLES.nodes}), ${fixedPoint.argWords}/${TABLES.args} arg words, ${poolBytes}/${TABLES.pool} name bytes; ${fixedPoint.ownClosuresPassed}/${fixedPoint.ownClosures} of its own function closures compiled by stage 1 and verified\n`,
  );

  const passed = reports.filter((r) => r.outcome === 'passed');
  const report = {
    generatedAt: new Date().toISOString(),
    stage:
      'Self-hosting stage 6 (bootstrap), step 1: the A0 C emitter pipeline as a native binary (a0c-stage1)',
    stage1: {
      entry: 'emitcio (compiler/emit_c.a0 linked with check.a0, parse.a0, lex.a0)',
      method: `TypeScript C backend (compile(program, 'c', { ioInputCapacity: ${STAGE1_INPUT}, ioOutputCapacity: ${STAGE1_OUTPUT} })) plus a stdin/stdout main, clang -std=c11 -O2`,
      functions: emitter.functions.length,
      cBytes: Buffer.byteLength(emitterC),
      buildMs,
      clang: clang.version,
    },
    stage2: {
      method:
        'Each source (at most 512 bytes) goes to a0c-stage1; the small programs, kernels.a0 and four ill-typed programs also go to emitcio in the reference interpreter, and the outputs must be byte-identical. Accepted sources: the stage 1 C and the TypeScript C module are each compiled by clang (-std=c11 -O1 -Wall -Wextra -Werror, UBSan) with the standard driver of tools/verify.ts and must give the independent oracle result on every case of tools/corpus.ts generateCases. Rejected sources must write no C; ill-typed ones must give the reference checker code. Programs without a driver-callable function are compiled with -Werror only.',
      sources: reports.length,
      fed: fed.length,
      passedSources: passed.length,
      compileOnly: reports.filter((r) => r.outcome === 'compiled').length,
      comparedWithInterpreter: timedBoth.length,
      rejectedAsExpected: reports.filter((r) => r.outcome === 'rejected').length,
      tooLarge: reports.filter((r) => r.outcome === 'too-large').length,
      failed: reports.filter((r) => r.outcome === 'failed').length,
      cases: passed.reduce((n, r) => n + (r.cases ?? 0), 0),
      emission: {
        sources: timedBoth.length,
        stage1Ms: Math.round(stage1Ms),
        interpreterMs,
        speedup: Math.round((interpreterMs / stage1Ms) * 10) / 10,
        note: 'stage 1 time includes one process spawn per source',
      },
    },
    fixedPoint,
    sources: reports,
  };
  await mkdir('results', { recursive: true });
  await writeFile(
    join('results', 'bootstrap.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  process.stdout.write(
    `total ${passed.length} sources passed, ${report.stage2.cases} cases; ${report.stage2.failed} failed\n`,
  );
  process.exit(report.stage2.failed === 0 && passed.length > 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
