/**
 * Bootstrap of the self-hosted compiler (DESIGN.md 7a stage 6) up to the self-compilation
 * fixed point. The compiler is compiler/boot.a0 (entry `emitchunkio`) linked with emit_c.a0,
 * check.a0, parse.a0, lex.a0 and front512.a0: it compiles one chunk of A0 source (up to the
 * front end's 16384 bytes) to C.
 *
 * - Stage 1: the TypeScript C backend compiles the linked compiler, clang builds it with a
 *   stdin/stdout main into `a0c-stage1`.
 * - Chunked mode: a program that does not fit one chunk is split here by function boundaries
 *   only (no A0 semantics in TypeScript): each chunk is a header prelude naming every header
 *   type of the program (so every chunk interns the same type table), the signature lines of
 *   the functions the chunk calls (stub bodies, parsed but not checked or emitted), then the
 *   chunk's functions in program order. The A0 front end checks and the A0 emitter emits each
 *   chunk; the iteration bounds the checker computes for a chunk's functions are returned and
 *   passed back, unread here, with the stubs of later chunks. The C of the chunks is
 *   concatenated (the first chunk also writes the prelude and every typedef).
 * - Stage 2: a0c-stage1 compiles the linked compiler in chunks; clang builds that C into
 *   `a0c-stage2`. Stage 3: a0c-stage2 compiles it again. The fixed point holds when the C of
 *   stage 2 and stage 3 is byte-identical; a0c-stage3 is built too and must reproduce it.
 * - Every stage compiles the same test sources: small programs, the ill-typed programs of
 *   tools/ref-check.ts, the corpus (its function closures and the whole corpus), the examples
 *   and their closures, and the compiler's own function closures. Stage 1's C must equal
 *   `emitchunkio` in the reference interpreter on the small sources; its C is compiled with the
 *   standard driver of tools/verify.ts and must give the independent oracle's result on every
 *   case (the TypeScript emitter's C too: observable agreement); rejected sources must give the
 *   reference checker's code and no C. Stage 2 and stage 3 must give stage 1's output byte for
 *   byte (code and C) on every source; a source where they differ is verified on the oracle on
 *   its own. Writes results/bootstrap.json.
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { C_IO_INPUT_CAPACITY, C_IO_OUTPUT_CAPACITY, compile } from '../src/backends.js';
import {
  type Func,
  formatFunction,
  formatProgram,
  makeIo,
  type Program,
  parse,
  parseAndValidate,
  run,
  type TypedFunc,
} from '../src/core.js';
import { link } from '../src/link.js';
import {
  findClang,
  runTool,
  spawnWithInput,
  type ToolInfo,
  withTempDir,
} from '../src/toolchain.js';
import { closure, closures, generateCases, generateCorpus } from './corpus.js';
import { ILL_TYPED, refCheckWords } from './ref-check.js';
import { FRONT_END_SOURCE_LIMIT, frontEndFits } from './ref-parse.js';
import { writeReport } from './scrub-results.js';
import { checkNative, ioCaps, type TargetReport } from './verify.js';

export { closure, closures };

/** The front end's source limit (compiler/lex.a0 `readsrc`); tools/ref-parse.ts has its other capacities. */
export const FRONT_END_BYTES = FRONT_END_SOURCE_LIMIT;
/** Name of the header-prelude function of a chunk (must not name a program function). */
export const PRELUDE = 'a0boottypes';
/** io capacities of every stage: n, the bytes, head, strict, from and up to 1024 bounds in. */
export const STAGE_INPUT = 1 + FRONT_END_BYTES + 3 + 1024;
export const STAGE_OUTPUT = 1 << 22;
/** Stack of the thread that runs the compiler (aggregates are passed by value). */
export const STAGE_STACK = 1 << 30;
export const BUILD_DIR = join('dist', 'bootstrap');
export const CLANG_BUILD = ['-std=c11', '-O2', '-Wall', '-Wextra', '-Wno-unused-parameter'];

export const SMALL: [string, string][] = [
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

/**
 * The C main of a stage whose compiler is `entry`: stdin words (little-endian) are the io
 * input, stdout the text bytes then the trailer words; see compiler/boot.a0.
 */
export const stageMain = (entry: string): string => `#include <pthread.h>
#include <stdio.h>
#define A0_IO_INPUT_CAPACITY ${STAGE_INPUT}u
#define A0_IO_OUTPUT_CAPACITY ${STAGE_OUTPUT}u
#include "emitter.c"
static a0_io io;
static uint32_t code;
static void *run(void *arg) {
  (void)arg;
  code = a0_${entry}(&io);
  return NULL;
}
int main(void) {
  unsigned char b[4];
  uint32_t n = 0;
  while (fread(b, 1, 4, stdin) == 4) {
    if (n == A0_IO_INPUT_CAPACITY) {
      fprintf(stderr, "a0c: input over %u words\\n", A0_IO_INPUT_CAPACITY);
      return 64;
    }
    io.input[n++] = (uint32_t)b[0] | (uint32_t)b[1] << 8 | (uint32_t)b[2] << 16 | (uint32_t)b[3] << 24;
  }
  io.ninput = n;
  pthread_attr_t attr;
  pthread_t thread;
  pthread_attr_init(&attr);
  pthread_attr_setstacksize(&attr, (size_t)${STAGE_STACK}u);
  if (pthread_create(&thread, &attr, run, NULL) != 0 || pthread_join(thread, NULL) != 0) {
    fprintf(stderr, "a0c: cannot run the compiler thread\\n");
    return 66;
  }
  if (io.noutput >= A0_IO_OUTPUT_CAPACITY) {
    fprintf(stderr, "a0c: output capacity reached\\n");
    return 65;
  }
  /* The C bytes, then the trailer words (k bounds, then k) little-endian. */
  uint32_t k = io.noutput > 0 ? io.output[io.noutput - 1] : 0;
  uint32_t c = io.noutput > k ? io.noutput - k - 1 : 0;
  for (uint32_t i = 0; i < io.noutput; i++) {
    uint32_t w = io.output[i];
    putchar((int)(w & 255u));
    if (i >= c) {
      putchar((int)(w >> 8 & 255u));
      putchar((int)(w >> 16 & 255u));
      putchar((int)(w >> 24 & 255u));
    }
  }
  return (int)code;
}
`;

/** Sources also compiled by `emitchunkio` in the reference interpreter (seconds each there). */
export const INTERPRETED = new Set(['small', 'kernels.a0']);
export const INTERPRETED_ILL_TYPED = 4;

/** A module without driver-callable functions: it must compile warning-free on its own. */
export async function compileOnly(clang: ToolInfo, text: string): Promise<TargetReport> {
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

// --- chunked mode --------------------------------------------------------------------------

export interface Chunk {
  readonly source: string;
  readonly head: boolean;
  /** 1 when the program is split: a body may then not build a type no header names. */
  readonly strict: boolean;
  /** Functions before the chunk's own: the prelude, then the stubs (their bounds are passed). */
  readonly before: readonly string[];
  readonly own: readonly string[];
}

const signature = (f: Func): string => formatFunction(f).split('\n')[0] as string;

/** Header type words of a signature line (`fn name T... -> R`), as written. */
function headerTypes(line: string): string[] {
  return line
    .split(' ')
    .slice(2)
    .filter((w) => w !== '->');
}

/**
 * The chunks of a program source. A source that fits one chunk is one chunk as written; a
 * program over the limits is split at function boundaries (consecutive functions in program
 * order, each chunk within every capacity of the front end: tools/ref-parse.ts `frontEndFits`).
 */
export function planChunks(src: string): Chunk[] {
  let program: Program | undefined;
  try {
    program = parse(src);
  } catch {
    program = undefined;
  }
  const whole = [{ source: src, head: true, strict: false, before: [], own: [] }];
  // A source within every capacity of the front end is one chunk, as written.
  if (program === undefined || frontEndFits(src)) return whole;
  const fns = program.functions;
  // every chunk of a strict program is itself strict, so that the compiler refuses it (code 2)
  // as it refuses the whole program, instead of compiling the chunk as canonical
  const directive = program.profile === 'strict' ? 'profile strict\n' : '';
  if ((program.uses?.length ?? 0) > 0) throw new Error('chunked mode needs a linked source');
  if (fns.some((f) => f.name === PRELUDE)) throw new Error(`a function is named ${PRELUDE}`);
  const types: string[] = [];
  for (const f of fns)
    for (const t of headerTypes(signature(f))) if (!types.includes(t)) types.push(t);
  const prelude = `fn ${PRELUDE} ${types.join(' ')} -> u32\nret 0\nend\n`;
  const index = new Map(fns.map((f, i) => [f.name, i] as const));
  const text = fns.map((f) => `${formatFunction(f)}\n`);
  const stubOf = (f: Func): string => `${signature(f)}\nret 0\nend\n`;
  const build = (from: number, to: number): Chunk & { fits: boolean } => {
    const own = fns.slice(from, to);
    const called = new Set<number>();
    for (const f of own)
      for (const n of f.nodes)
        for (const c of [n.callee, n.pred]) {
          const i = c === undefined ? undefined : index.get(c);
          if (i !== undefined && (i < from || i >= to)) called.add(i);
        }
    const stubs = [...called].sort((a, b) => a - b).map((i) => fns[i] as Func);
    const source = [directive, prelude, ...stubs.map(stubOf), ...text.slice(from, to)].join('');
    return {
      source,
      head: from === 0,
      strict: true,
      before: [PRELUDE, ...stubs.map((f) => f.name)],
      own: own.map((f) => f.name),
      fits: frontEndFits(source),
    };
  };
  const chunks: Chunk[] = [];
  let from = 0;
  while (from < fns.length) {
    let to = from + 1;
    if (!build(from, to).fits) throw new Error(`${(fns[from] as Func).name} does not fit a chunk`);
    while (to < fns.length && build(from, to + 1).fits) to += 1;
    const { fits: _, ...chunk } = build(from, to);
    chunks.push(chunk);
    from = to;
  }
  return chunks;
}

export interface StageRun {
  readonly code: number;
  readonly bounds: number[];
  readonly text: string;
}

/** How long one chunk of a stage executable may run, and how many times a hung run is tried. */
const STAGE_CHUNK_MS = 120_000;
const STAGE_CHUNK_TRIES = 3;

export function runStageChunk(exe: string, chunk: Chunk, bounds: readonly number[]): StageRun {
  const bytes = [...Buffer.from(chunk.source)];
  const words = [bytes.length, ...bytes, chunk.head ? 1 : 0, chunk.strict ? 1 : 0];
  words.push(bounds.length, ...bounds);
  const input = Buffer.alloc(words.length * 4);
  for (const [i, w] of words.entries()) input.writeUInt32LE(w, i * 4);
  // A chunk runs in seconds. The input goes in as a file (`spawnWithInput`): with Node's own stdin
  // pipe a child, any child, sometimes never receives its data on macOS 27 beta (see there). The
  // chunk is a pure function of its input, so a run that outlives STAGE_CHUNK_MS is still killed
  // and repeated, as a safety net; only a chunk that hangs every time fails.
  const run = (): ReturnType<typeof spawnWithInput> =>
    spawnWithInput(exe, input, { timeout: STAGE_CHUNK_MS, maxBuffer: 1 << 28 });
  let r = run();
  for (
    let attempt = 1;
    attempt < STAGE_CHUNK_TRIES && r.status === null && r.signal !== null;
    attempt++
  )
    r = run();
  if (r.status === null || r.status > 6)
    throw new Error(
      `${exe} failed (${r.status ?? r.signal}${r.status === null ? ` after ${STAGE_CHUNK_TRIES} tries of ${STAGE_CHUNK_MS} ms` : ''}): ${r.stderr?.toString() ?? ''}`,
    );
  const out = r.stdout;
  if (r.status !== 0) return { code: r.status, bounds: [], text: out.toString('latin1') };
  const k = out.readUInt32LE(out.length - 4);
  const c = out.length - 4 * (k + 1);
  const own = Array.from({ length: k }, (_, i) => out.readUInt32LE(c + i * 4));
  return { code: 0, bounds: own, text: out.subarray(0, c).toString('latin1') };
}

export function runInterpreterChunk(
  entry: TypedFunc,
  chunk: Chunk,
  bounds: readonly number[],
): StageRun {
  const bytes = [...Buffer.from(chunk.source)];
  const io = makeIo([
    bytes.length,
    ...bytes,
    chunk.head ? 1 : 0,
    chunk.strict ? 1 : 0,
    bounds.length,
    ...bounds,
  ]);
  const code = run(entry, [io], { fuel: 1e12 }) as number;
  const out = io.output;
  if (code !== 0) return { code, bounds: [], text: '' };
  const k = out[out.length - 1] as number;
  const c = out.length - k - 1;
  return {
    code,
    bounds: out.slice(c, c + k),
    text: Buffer.from(out.slice(0, c).map((w) => w & 255)).toString('latin1'),
  };
}

export interface Emission {
  readonly code: number;
  readonly text: string;
  readonly chunks: number;
  readonly ms: number;
  /** The chunk that gave the nonzero code. */
  readonly failed?: Chunk;
}

/** A program's C through a compiler stage, chunk by chunk; the first nonzero code stops it. */
export function emitChunked(
  src: string,
  step: (chunk: Chunk, bounds: readonly number[]) => StageRun,
): Emission {
  const start = performance.now();
  const chunks = planChunks(src);
  const bounds = new Map<string, number>();
  let text = '';
  for (const chunk of chunks) {
    const r = step(
      chunk,
      chunk.before.map((name) => (name === PRELUDE ? 0 : (bounds.get(name) as number))),
    );
    if (r.code !== 0)
      return {
        code: r.code,
        text: r.text,
        chunks: chunks.length,
        ms: performance.now() - start,
        failed: chunk,
      };
    for (const [i, name] of chunk.own.entries()) bounds.set(name, r.bounds[i] as number);
    text += r.text;
  }
  return { code: 0, text, chunks: chunks.length, ms: performance.now() - start };
}

/** A stage that rejects the compiler: the failing chunk is kept for inspection. */
export async function rejected(stage: string, e: Emission): Promise<void> {
  if (e.code === 0) return;
  const path = join(BUILD_DIR, 'rejected-chunk.a0');
  await writeFile(path, e.failed?.source ?? '', 'utf8');
  throw new Error(
    `${stage} rejected the compiler: code ${e.code} in the chunk of ${e.failed?.own.join(' ') ?? '?'} (${path})`,
  );
}

export async function buildStage(
  clang: ToolInfo,
  name: string,
  c: string,
  entry = 'emitchunkio',
): Promise<[string, number]> {
  const dir = join(BUILD_DIR, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'emitter.c'), c, 'utf8');
  await writeFile(join(dir, 'main.c'), stageMain(entry), 'utf8');
  const start = performance.now();
  const r = runTool(clang.path as string, [...CLANG_BUILD, '-o', name, 'main.c'], {
    cwd: dir,
    timeoutMs: 1_800_000,
  });
  if (!r.ok) throw new Error(`${name} build failed:\n${r.stderr.slice(0, 4000)}`);
  return [join(dir, name), Math.round(performance.now() - start)];
}

interface SourceReport {
  readonly label: string;
  readonly group: string;
  readonly bytes: number;
  readonly chunks: number;
  readonly outcome: 'passed' | 'compiled' | 'rejected' | 'failed';
  readonly code: number;
  readonly functions?: number;
  readonly cases?: number;
  readonly cBytes?: number;
  readonly stage1Ms: number;
  readonly stage2Ms: number;
  readonly stage3Ms: number;
  /** Stage 2 and stage 3 gave stage 1's code and C byte for byte. */
  readonly stagesIdentical: boolean;
  /** Present when the source was also compiled by `emitchunkio` in the reference interpreter. */
  readonly interpreterMs?: number;
  readonly sameAsInterpreter?: boolean;
  readonly stage1C?: TargetReport;
  readonly stage2C?: TargetReport;
  readonly stage3C?: TargetReport;
  readonly typescriptC?: TargetReport;
  readonly detail?: string;
}

export const round1 = (ms: number): number => Math.round(ms * 10) / 10;

async function main(): Promise<void> {
  const clang = findClang();
  if (clang.path === undefined) throw new Error('clang not found');
  // The compiler is `emitchunkio` with every function it reaches (front512.a0, which check.a0
  // uses for the playground, is not reached).
  const linked = (await link('compiler/boot.a0', (p) => readFile(p, 'utf8'))).program;
  const compilerSource = closure(linked.functions, 'emitchunkio');
  const compiler = parseAndValidate(compilerSource);
  const entry = compiler.byName.get('emitchunkio') as TypedFunc;

  // Stage 1: the compiler through the TypeScript C backend and clang.
  const stage1C = compile(compiler, 'c', {
    ioInputCapacity: STAGE_INPUT,
    ioOutputCapacity: STAGE_OUTPUT,
  }).text;
  const [stage1, stage1BuildMs] = await buildStage(clang, 'a0c-stage1', stage1C);
  process.stdout.write(
    `stage 1: ${compiler.functions.length} functions (${Buffer.byteLength(compilerSource)} source bytes), TypeScript C ${Buffer.byteLength(stage1C)} bytes, clang -O2 ${stage1BuildMs} ms -> ${stage1}\n`,
  );

  // Stage 2 and 3: the compiler compiles itself in chunks.
  const self1 = emitChunked(compilerSource, (c, b) => runStageChunk(stage1, c, b));
  await rejected('stage 1', self1);
  const [stage2, stage2BuildMs] = await buildStage(clang, 'a0c-stage2', self1.text);
  process.stdout.write(
    `stage 2: a0c-stage1 compiled the compiler in ${self1.chunks} chunks (${Math.round(self1.ms)} ms, ${Buffer.byteLength(self1.text)} C bytes), clang -O2 ${stage2BuildMs} ms -> ${stage2}\n`,
  );
  const self2 = emitChunked(compilerSource, (c, b) => runStageChunk(stage2, c, b));
  await rejected('stage 2', self2);
  const fixedPoint = self2.text === self1.text;
  const [stage3, stage3BuildMs] = await buildStage(clang, 'a0c-stage3', self2.text);
  const self3 = emitChunked(compilerSource, (c, b) => runStageChunk(stage3, c, b));
  process.stdout.write(
    `stage 3: a0c-stage2 compiled the compiler in ${Math.round(self2.ms)} ms (${Buffer.byteLength(self2.text)} C bytes): ${fixedPoint ? 'byte-identical to stage 2 (fixed point)' : 'DIFFERS from stage 2'}; a0c-stage3 (clang ${stage3BuildMs} ms) reproduces it: ${self3.code === 0 && self3.text === self2.text}\n`,
  );

  // Test sources.
  const corpus = generateCorpus();
  const groups: [string, [string, string][]][] = [
    ['small', SMALL],
    ['ill-typed', [...ILL_TYPED]],
    ['corpus', [['corpus', formatProgram(corpus)], ...closures('corpus', corpus)]],
  ];
  for (const f of (await readdir('examples')).filter((f) => f.endsWith('.a0')).sort()) {
    const text = await readFile(`examples/${f}`, 'utf8');
    groups.push([f, [[f, text], ...closures(f, parseAndValidate(text))]]);
  }
  // The closure of the entry is the whole compiler: stages 2 and 3 are it, exercised on every
  // source above (its io cases would each run the whole compiler in the reference interpreter).
  groups.push([
    'compiler',
    closures('boot.a0', compiler).filter(([label]) => label !== 'boot.a0/emitchunkio'),
  ]);

  const reports: SourceReport[] = [];
  for (const [group, sources] of groups) {
    for (const [index, [label, src]] of sources.entries()) {
      const bytes = Buffer.byteLength(src);
      const s1 = emitChunked(src, (c, b) => runStageChunk(stage1, c, b));
      const s2 = emitChunked(src, (c, b) => runStageChunk(stage2, c, b));
      const s3 = emitChunked(src, (c, b) => runStageChunk(stage3, c, b));
      const same2 = s2.code === s1.code && s2.text === s1.text;
      const same3 = s3.code === s1.code && s3.text === s1.text;
      const interpret =
        INTERPRETED.has(group) || (group === 'ill-typed' && index < INTERPRETED_ILL_TYPED);
      const start = performance.now();
      const interp = interpret
        ? emitChunked(src, (c, b) => runInterpreterChunk(entry, c, b))
        : undefined;
      const interpMs = performance.now() - start;
      const sameInterp =
        interp === undefined || (s1.code === interp.code && s1.text === interp.text);
      const common = {
        label,
        group,
        bytes,
        chunks: s1.chunks,
        code: s1.code,
        stage1Ms: round1(s1.ms),
        stage2Ms: round1(s2.ms),
        stage3Ms: round1(s3.ms),
        stagesIdentical: same2 && same3,
        ...(interp === undefined
          ? {}
          : { interpreterMs: Math.round(interpMs), sameAsInterpreter: sameInterp }),
      };
      const agree = same2 && same3 && sameInterp;
      if (s1.code !== 0) {
        const expected = refCheckWords(src)[1] as number;
        const ok = agree && s1.text.length === 0 && s1.code === expected;
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
      const verify = async (text: string, what: string): Promise<TargetReport> =>
        cases.length === 0
          ? compileOnly(clang, text)
          : checkNative(program, cases, clang, false, `C from ${what} via clang`, text);
      const c1 = await verify(s1.text, 'a0c-stage1');
      const c2 = same2 ? undefined : await verify(s2.text, 'a0c-stage2');
      const c3 = same3 ? undefined : await verify(s3.text, 'a0c-stage3');
      const typescriptC =
        cases.length === 0
          ? await compileOnly(clang, compile(program, 'c').text)
          : await checkNative(program, cases, clang, false, 'C from the TypeScript emitter');
      const ok =
        sameInterp &&
        [c1, c2, c3, typescriptC].every((r) => r === undefined || r.status === 'passed');
      reports.push({
        ...common,
        outcome: ok ? (cases.length === 0 ? 'compiled' : 'passed') : 'failed',
        functions: program.functions.length,
        cases: cases.length,
        cBytes: Buffer.byteLength(s1.text),
        stage1C: c1,
        ...(c2 === undefined ? {} : { stage2C: c2 }),
        ...(c3 === undefined ? {} : { stage3C: c3 }),
        typescriptC,
      });
    }
    const mine = reports.filter((r) => r.group === group);
    const count = (o: SourceReport['outcome']): number =>
      mine.filter((r) => r.outcome === o).length;
    process.stdout.write(
      `${group.padEnd(12)} ${mine.length} sources (${mine.filter((r) => r.chunks > 1).length} chunked): ${count('passed')} passed (${mine.reduce((n, r) => n + (r.outcome === 'passed' ? (r.cases ?? 0) : 0), 0)} cases), ${count('compiled')} compile-only, ${count('rejected')} rejected as expected, ${count('failed')} failed; stages 1-3 identical on ${mine.filter((r) => r.stagesIdentical).length}\n`,
    );
    for (const r of mine.filter((r) => r.outcome === 'failed'))
      process.stdout.write(
        `    FAIL ${r.label}: ${r.detail ?? ''} stages=${r.stagesIdentical} interp=${r.sameAsInterpreter} ${[...(r.stage1C?.failures ?? []), ...(r.typescriptC?.failures ?? [])].join(' | ').slice(0, 600)}\n`,
      );
  }

  const timed = reports.filter((r) => r.interpreterMs !== undefined);
  const stageMs = (k: 'stage1Ms' | 'stage2Ms' | 'stage3Ms', list: SourceReport[]): number =>
    Math.round(list.reduce((n, r) => n + r[k], 0));
  const interpreterMs = timed.reduce((n, r) => n + (r.interpreterMs ?? 0), 0);
  process.stdout.write(
    `emission over all ${reports.length} sources: stage 1 ${stageMs('stage1Ms', reports)} ms, stage 2 ${stageMs('stage2Ms', reports)} ms, stage 3 ${stageMs('stage3Ms', reports)} ms (one process per chunk); on the ${timed.length} also interpreted: stage 1 ${stageMs('stage1Ms', timed)} ms, interpreter ${interpreterMs} ms\n`,
  );

  const passed = reports.filter((r) => r.outcome === 'passed');
  const failed = reports.filter((r) => r.outcome === 'failed').length;
  const report = {
    generatedAt: new Date().toISOString(),
    stage:
      'Self-hosting stage 6 (bootstrap): the A0 compiler compiles itself in chunks to a C fixed point',
    compiler: {
      entry:
        'emitchunkio (compiler/boot.a0 linked with emit_c.a0, check.a0, parse.a0, lex.a0, front512.a0)',
      functions: compiler.functions.length,
      sourceBytes: Buffer.byteLength(compilerSource),
      linkedFunctions: linked.functions.length,
      chunkSourceBytes: FRONT_END_BYTES,
      io: { inputWords: STAGE_INPUT, outputWords: STAGE_OUTPUT, stackBytes: STAGE_STACK },
      clang: clang.version,
      build: CLANG_BUILD.join(' '),
    },
    stage1: {
      method: `TypeScript C backend (compile(program, 'c', { ioInputCapacity: ${STAGE_INPUT}, ioOutputCapacity: ${STAGE_OUTPUT} })) plus the stage main, clang`,
      cBytes: Buffer.byteLength(stage1C),
      buildMs: stage1BuildMs,
    },
    stage2: {
      method: 'a0c-stage1 compiles the linked compiler in chunks; clang builds that C',
      chunks: self1.chunks,
      emitMs: Math.round(self1.ms),
      cBytes: Buffer.byteLength(self1.text),
      buildMs: stage2BuildMs,
    },
    stage3: {
      method: 'a0c-stage2 compiles the linked compiler in chunks; clang builds that C',
      chunks: self2.chunks,
      emitMs: Math.round(self2.ms),
      cBytes: Buffer.byteLength(self2.text),
      buildMs: stage3BuildMs,
      stage3ReproducesMs: Math.round(self3.ms),
      stage3Reproduces: self3.code === 0 && self3.text === self2.text,
    },
    fixedPoint: {
      holds: fixedPoint,
      detail: fixedPoint
        ? 'the C of the compiler written by a0c-stage1 (stage 2) and by a0c-stage2 (stage 3) is byte-identical'
        : 'the C of stage 2 and stage 3 differs',
    },
    tests: {
      method:
        'Every source goes through a0c-stage1, a0c-stage2 and a0c-stage3 (chunked when it does not fit one chunk). Stage 1 output must equal emitchunkio in the reference interpreter on the small programs, kernels.a0 and four ill-typed programs; stage 2 and 3 output must equal stage 1 byte for byte. Accepted sources: the C is compiled by clang (-std=c11 -O1 -Wall -Wextra -Werror, UBSan) with the standard driver of tools/verify.ts and must give the independent oracle result on every case of tools/corpus.ts generateCases, as must the TypeScript C module (observable agreement); sources without a driver-callable function are compiled with -Werror only. Rejected sources must write no C; ill-typed ones must give the reference checker code.',
      sources: reports.length,
      chunked: reports.filter((r) => r.chunks > 1).length,
      passedSources: passed.length,
      compileOnly: reports.filter((r) => r.outcome === 'compiled').length,
      rejectedAsExpected: reports.filter((r) => r.outcome === 'rejected').length,
      failed,
      stagesIdentical: reports.filter((r) => r.stagesIdentical).length,
      cases: passed.reduce((n, r) => n + (r.cases ?? 0), 0),
      emission: {
        stage1Ms: stageMs('stage1Ms', reports),
        stage2Ms: stageMs('stage2Ms', reports),
        stage3Ms: stageMs('stage3Ms', reports),
        interpreted: timed.length,
        interpretedStage1Ms: stageMs('stage1Ms', timed),
        interpreterMs,
        note: 'one process spawn per chunk',
      },
    },
    sources: reports,
  };
  await mkdir('results', { recursive: true });
  await writeReport(join('results', 'bootstrap.json'), report);
  process.stdout.write(
    `total ${passed.length} sources passed, ${report.tests.cases} cases; ${failed} failed; fixed point ${fixedPoint ? 'reached' : 'NOT reached'}\n`,
  );
  process.exit(failed === 0 && passed.length > 0 && fixedPoint ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
