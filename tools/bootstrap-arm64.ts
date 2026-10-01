/**
 * Bootstrap of the self-hosted arm64 path (DESIGN.md 7a stage 6b) up to its fixed point. The
 * compiler is compiler/boot.a0 `emitachunkio` with every function it reaches (lex.a0, parse.a0,
 * check.a0, the q functions of emit_arm64.a0 and the writers of emit_c.a0 they use): it compiles
 * one chunk of A0 source to Darwin arm64 assembly. The chunks are planned exactly as for the C
 * path (tools/bootstrap.ts `planChunks`); their assembly is concatenated.
 *
 * - Stage 1 (the seed): the TypeScript C backend compiles the compiler and clang builds it with
 *   the stage main of tools/bootstrap.ts into `a0c-a64-stage1`. This is the only C.
 * - Stage 2: a0c-a64-stage1 compiles the compiler to assembly; the system assembler (clang's,
 *   `clang -c -x assembler`) assembles it and the hand-written assembly runtime below (`_main`,
 *   the io buffers `_a0_io` `_a0_in` `_a0_out` and `_a0rt_read` `_a0rt_write` `_a0rt_puts`), and
 *   the system linker (ld through the clang driver, with libSystem for `_read` `_write` `_mmap`)
 *   links them into `a0c-a64-stage2`. No C is compiled for it.
 * - Stage 3: a0c-a64-stage2 compiles the compiler again. The fixed point holds when the assembly
 *   of stage 2 and stage 3 is byte-identical; a0c-a64-stage3 is built from it and must reproduce
 *   it, and the stage 2 and stage 3 executables are compared byte for byte.
 * - Every stage compiles the test sources of tools/bootstrap.ts (small programs, the ill-typed
 *   programs, the corpus and its closures, the examples and their closures, the compiler's own
 *   closures). Stage 2 and 3 must give stage 1's code and assembly byte for byte; stage 1 must
 *   equal `emitachunkio` in the reference interpreter on the small programs, kernels.a0 and four
 *   ill-typed ones; rejected sources must give the reference checker's code and no text. For an
 *   accepted source, the io-free part of the program (io is the stage runtime's, not the C
 *   driver's) is compiled by stage 1, assembled, linked with the C test driver of tools/verify.ts
 *   and must give the independent oracle's result on every case of tools/corpus.ts
 *   `generateCases`. Writes results/bootstrap-arm64.json.
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { compile } from '../src/backends.js';
import { formatProgram, parseAndValidate, type TypedFunc } from '../src/core.js';
import { link } from '../src/link.js';
import { findClang, runTool, type ToolInfo, withTempDir } from '../src/toolchain.js';
import { ENTRY, runtime, STACK_GIB } from './arm64-runtime.js';
import {
  BUILD_DIR,
  buildStage,
  type Emission,
  emitChunked,
  FRONT_END_BYTES,
  INTERPRETED,
  INTERPRETED_ILL_TYPED,
  rejected,
  round1,
  runInterpreterChunk,
  runStageChunk,
  SMALL,
  STAGE_INPUT,
  STAGE_OUTPUT,
} from './bootstrap.js';
import { closure, closures, generateCases, generateCorpus, ioFreeSubset } from './corpus.js';
import { ILL_TYPED, refCheckWords } from './ref-check.js';
import { checkArm64Assembly, type TargetReport } from './verify.js';

/** Assemble `asm` and the runtime and link them: the arm64 stage `name` (`<name>/a0c`). */
async function assembleStage(
  clang: ToolInfo,
  name: string,
  asm: string,
): Promise<{ exe: string; buildMs: number }> {
  const dir = join(BUILD_DIR, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'compiler.s'), asm, 'utf8');
  await writeFile(join(dir, 'runtime.s'), runtime(), 'utf8');
  const start = performance.now();
  for (const unit of ['compiler', 'runtime']) {
    const r = runTool(
      clang.path as string,
      ['-c', '-x', 'assembler', '-o', `${unit}.o`, `${unit}.s`],
      { cwd: dir, timeoutMs: 1_800_000 },
    );
    if (!r.ok) throw new Error(`${name}: assembling ${unit}.s failed:\n${r.stderr.slice(0, 4000)}`);
  }
  // Every stage links to the same file name in its own directory: the ad-hoc code signature
  // records the name, so stage executables built from the same assembly are then identical.
  const r = runTool(clang.path as string, ['-o', 'a0c', 'compiler.o', 'runtime.o'], {
    cwd: dir,
    timeoutMs: 1_800_000,
  });
  if (!r.ok) throw new Error(`${name}: link failed:\n${r.stderr.slice(0, 4000)}`);
  return { exe: join(dir, 'a0c'), buildMs: Math.round(performance.now() - start) };
}

/** The module assembles on its own (no driver-callable function). */
async function assembleOnly(clang: ToolInfo, asm: string): Promise<TargetReport> {
  return withTempDir(async (dir) => {
    await writeFile(join(dir, 'module.s'), asm, 'utf8');
    const r = runTool(
      clang.path as string,
      ['-c', '-x', 'assembler', '-o', 'module.o', 'module.s'],
      { cwd: dir },
    );
    return r.ok
      ? { status: 'passed', cases: 0, detail: 'assembled; no driver-callable io-free function' }
      : {
          status: 'failed',
          cases: 0,
          detail: 'assembly failed',
          failures: [r.stderr.slice(0, 2000)],
        };
  });
}

interface SourceReport {
  readonly label: string;
  readonly group: string;
  readonly bytes: number;
  readonly chunks: number;
  readonly outcome: 'passed' | 'compiled' | 'rejected' | 'failed';
  readonly code: number;
  readonly functions?: number;
  readonly ioFreeFunctions?: number;
  readonly cases?: number;
  readonly asmBytes?: number;
  readonly stage1Ms: number;
  readonly stage2Ms: number;
  readonly stage3Ms: number;
  /** Stage 2 and stage 3 gave stage 1's code and assembly byte for byte. */
  readonly stagesIdentical: boolean;
  readonly interpreterMs?: number;
  readonly sameAsInterpreter?: boolean;
  readonly native?: TargetReport;
  readonly detail?: string;
}

async function main(): Promise<void> {
  const clang = findClang();
  if (clang.path === undefined) throw new Error('clang not found');
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error(`needs macOS on Apple silicon, found ${process.platform}-${process.arch}`);
  const linked = (await link('compiler/boot.a0', (p) => readFile(p, 'utf8'))).program;
  const compilerSource = closure(linked.functions, ENTRY);
  const compiler = parseAndValidate(compilerSource);
  const entry = compiler.byName.get(ENTRY) as TypedFunc;

  // Stage 1 (the seed): the compiler through the TypeScript C backend and clang.
  const stage1C = compile(compiler, 'c', {
    ioInputCapacity: STAGE_INPUT,
    ioOutputCapacity: STAGE_OUTPUT,
  }).text;
  const [stage1, stage1BuildMs] = await buildStage(clang, 'a0c-a64-stage1', stage1C, ENTRY);
  process.stdout.write(
    `stage 1: ${compiler.functions.length} functions (${Buffer.byteLength(compilerSource)} source bytes), TypeScript C ${Buffer.byteLength(stage1C)} bytes, clang -O2 ${stage1BuildMs} ms -> ${stage1}\n`,
  );

  // Stage 2 and 3: the compiler compiles itself to assembly.
  const self1 = emitChunked(compilerSource, (c, b) => runStageChunk(stage1, c, b));
  await rejected('stage 1', self1);
  const s2 = await assembleStage(clang, 'a0c-a64-stage2', self1.text);
  process.stdout.write(
    `stage 2: a0c-a64-stage1 compiled the compiler in ${self1.chunks} chunks (${Math.round(self1.ms)} ms, ${Buffer.byteLength(self1.text)} assembly bytes); assembled and linked in ${s2.buildMs} ms -> ${s2.exe}\n`,
  );
  const self2 = emitChunked(compilerSource, (c, b) => runStageChunk(s2.exe, c, b));
  await rejected('stage 2', self2);
  const fixedPoint = self2.text === self1.text;
  const s3 = await assembleStage(clang, 'a0c-a64-stage3', self2.text);
  const self3 = emitChunked(compilerSource, (c, b) => runStageChunk(s3.exe, c, b));
  const reproduces = self3.code === 0 && self3.text === self2.text;
  const [bin2, bin3] = await Promise.all([readFile(s2.exe), readFile(s3.exe)]);
  const sameBinary = bin2.equals(bin3);
  process.stdout.write(
    `stage 3: a0c-a64-stage2 compiled the compiler in ${Math.round(self2.ms)} ms (${Buffer.byteLength(self2.text)} assembly bytes): ${fixedPoint ? 'byte-identical to stage 2 (fixed point)' : 'DIFFERS from stage 2'}; a0c-a64-stage3 (${s3.buildMs} ms) reproduces it: ${reproduces}; stage 2 and stage 3 executables identical: ${sameBinary} (${bin2.length} bytes)\n`,
  );

  // Test sources (those of tools/bootstrap.ts).
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
  groups.push([
    'compiler',
    closures('boot.a0', compiler).filter(([label]) => label !== `boot.a0/${ENTRY}`),
  ]);

  const stages = [stage1, s2.exe, s3.exe];
  const reports: SourceReport[] = [];
  for (const [group, sources] of groups) {
    for (const [index, [label, src]] of sources.entries()) {
      const [e1, e2, e3] = stages.map((exe) =>
        emitChunked(src, (c, b) => runStageChunk(exe, c, b)),
      ) as [Emission, Emission, Emission];
      const same2 = e2.code === e1.code && e2.text === e1.text;
      const same3 = e3.code === e1.code && e3.text === e1.text;
      const interpret =
        INTERPRETED.has(group) || (group === 'ill-typed' && index < INTERPRETED_ILL_TYPED);
      const start = performance.now();
      const interp = interpret
        ? emitChunked(src, (c, b) => runInterpreterChunk(entry, c, b))
        : undefined;
      const interpMs = performance.now() - start;
      const sameInterp =
        interp === undefined || (e1.code === interp.code && e1.text === interp.text);
      const common = {
        label,
        group,
        bytes: Buffer.byteLength(src),
        chunks: e1.chunks,
        code: e1.code,
        stage1Ms: round1(e1.ms),
        stage2Ms: round1(e2.ms),
        stage3Ms: round1(e3.ms),
        stagesIdentical: same2 && same3,
        ...(interp === undefined
          ? {}
          : { interpreterMs: Math.round(interpMs), sameAsInterpreter: sameInterp }),
      };
      const agree = same2 && same3 && sameInterp;
      if (e1.code !== 0) {
        const expected = refCheckWords(src)[1] as number;
        const ok = agree && e1.text.length === 0 && e1.code === expected;
        reports.push({
          ...common,
          outcome: ok ? 'rejected' : 'failed',
          detail: `diagnostic ${e1.code} (reference checker ${expected})`,
        });
        continue;
      }
      const program = parseAndValidate(src);
      const subset = ioFreeSubset(program);
      const cases = generateCases(subset);
      let native: TargetReport;
      if (subset.functions.length === 0) native = await assembleOnly(clang, e1.text);
      else {
        const subsetSrc = formatProgram(subset);
        const es = emitChunked(subsetSrc, (c, b) => runStageChunk(stage1, c, b));
        native =
          es.code !== 0
            ? { status: 'failed', cases: 0, detail: `io-free part rejected: code ${es.code}` }
            : cases.length === 0
              ? await assembleOnly(clang, es.text)
              : await checkArm64Assembly(
                  subset,
                  es.text,
                  cases,
                  clang,
                  'A0-emitted arm64 assembly (a0c-a64-stage1) via clang -x assembler, linked with the C test driver',
                );
      }
      const ok = agree && native.status === 'passed';
      reports.push({
        ...common,
        outcome: ok ? (cases.length === 0 ? 'compiled' : 'passed') : 'failed',
        functions: program.functions.length,
        ioFreeFunctions: subset.functions.length,
        cases: cases.length,
        asmBytes: Buffer.byteLength(e1.text),
        native,
      });
    }
    const mine = reports.filter((r) => r.group === group);
    const count = (o: SourceReport['outcome']): number =>
      mine.filter((r) => r.outcome === o).length;
    process.stdout.write(
      `${group.padEnd(12)} ${mine.length} sources (${mine.filter((r) => r.chunks > 1).length} chunked): ${count('passed')} passed (${mine.reduce((n, r) => n + (r.outcome === 'passed' ? (r.cases ?? 0) : 0), 0)} cases), ${count('compiled')} assemble-only, ${count('rejected')} rejected as expected, ${count('failed')} failed; stages 1-3 identical on ${mine.filter((r) => r.stagesIdentical).length}\n`,
    );
    for (const r of mine.filter((r) => r.outcome === 'failed'))
      process.stdout.write(
        `    FAIL ${r.label}: ${r.detail ?? ''} stages=${r.stagesIdentical} interp=${r.sameAsInterpreter} ${r.native?.detail ?? ''} ${(r.native?.failures ?? []).join(' | ').slice(0, 600)}\n`,
      );
  }

  const timed = reports.filter((r) => r.interpreterMs !== undefined);
  const stageMs = (k: 'stage1Ms' | 'stage2Ms' | 'stage3Ms', list: SourceReport[]): number =>
    Math.round(list.reduce((n, r) => n + r[k], 0));
  const passed = reports.filter((r) => r.outcome === 'passed');
  const failed = reports.filter((r) => r.outcome === 'failed').length;
  process.stdout.write(
    `emission over all ${reports.length} sources: stage 1 (C seed) ${stageMs('stage1Ms', reports)} ms, stage 2 (arm64) ${stageMs('stage2Ms', reports)} ms, stage 3 (arm64) ${stageMs('stage3Ms', reports)} ms (one process per chunk)\n`,
  );
  const report = {
    generatedAt: new Date().toISOString(),
    stage:
      'Self-hosting stage 6b (arm64 bootstrap): the A0 compiler compiles itself to arm64 assembly with its own emitter, to a fixed point',
    compiler: {
      entry: `${ENTRY} (compiler/boot.a0 linked with emit_arm64.a0, emit_c.a0, check.a0, parse.a0, lex.a0, front512.a0)`,
      functions: compiler.functions.length,
      sourceBytes: Buffer.byteLength(compilerSource),
      linkedFunctions: linked.functions.length,
      chunkSourceBytes: FRONT_END_BYTES,
      io: { inputWords: STAGE_INPUT, outputWords: STAGE_OUTPUT, stackBytes: STACK_GIB * 2 ** 30 },
      clang: clang.version,
    },
    toolchain:
      'Stage 1 is the only C (the seed, built by clang from the TypeScript C backend). Stages 2 and 3 are the A0-emitted assembly plus the assembly runtime of this file, assembled by the system assembler (clang -c -x assembler) and linked by the system linker (ld via the clang driver) against libSystem (_read, _write, _mmap); no C is compiled for them.',
    stage1: {
      method: 'TypeScript C backend plus the C stage main, clang -O2',
      cBytes: Buffer.byteLength(stage1C),
      buildMs: stage1BuildMs,
    },
    stage2: {
      method:
        'a0c-a64-stage1 compiles the compiler in chunks to assembly; assembled with the runtime and linked',
      chunks: self1.chunks,
      emitMs: Math.round(self1.ms),
      asmBytes: Buffer.byteLength(self1.text),
      buildMs: s2.buildMs,
      executableBytes: bin2.length,
    },
    stage3: {
      method:
        'a0c-a64-stage2 (A0-emitted arm64) compiles the compiler in chunks to assembly; assembled with the runtime and linked',
      chunks: self2.chunks,
      emitMs: Math.round(self2.ms),
      asmBytes: Buffer.byteLength(self2.text),
      buildMs: s3.buildMs,
      executableBytes: bin3.length,
      stage3ReproducesMs: Math.round(self3.ms),
      stage3Reproduces: reproduces,
    },
    fixedPoint: {
      holds: fixedPoint,
      executablesIdentical: sameBinary,
      detail: fixedPoint
        ? 'the assembly of the compiler written by a0c-a64-stage1 (stage 2) and by a0c-a64-stage2 (stage 3) is byte-identical'
        : 'the assembly of stage 2 and stage 3 differs',
    },
    tests: {
      method:
        'Every source goes through a0c-a64-stage1, -stage2 and -stage3 (chunked when it does not fit one chunk). Stage 1 output must equal emitachunkio in the reference interpreter on the small programs, kernels.a0 and four ill-typed programs; stage 2 and 3 output must equal stage 1 byte for byte. Accepted sources: the io-free part of the program is compiled by stage 1, assembled (clang -x assembler), linked with the C test driver of tools/verify.ts and must give the independent oracle result on every case of tools/corpus.ts generateCases; with no such case it must assemble. Rejected sources must write no text and give the reference checker code.',
      sources: reports.length,
      chunked: reports.filter((r) => r.chunks > 1).length,
      passedSources: passed.length,
      assembleOnly: reports.filter((r) => r.outcome === 'compiled').length,
      rejectedAsExpected: reports.filter((r) => r.outcome === 'rejected').length,
      failed,
      stagesIdentical: reports.filter((r) => r.stagesIdentical).length,
      cases: passed.reduce((n, r) => n + (r.cases ?? 0), 0),
      emission: {
        stage1Ms: stageMs('stage1Ms', reports),
        stage2Ms: stageMs('stage2Ms', reports),
        stage3Ms: stageMs('stage3Ms', reports),
        interpreted: timed.length,
        interpreterMs: timed.reduce((n, r) => n + (r.interpreterMs ?? 0), 0),
        note: 'one process spawn per chunk',
      },
    },
    sources: reports,
  };
  await mkdir('results', { recursive: true });
  await writeFile(
    join('results', 'bootstrap-arm64.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  process.stdout.write(
    `total ${passed.length} sources passed, ${report.tests.cases} cases; ${failed} failed; arm64 fixed point ${fixedPoint ? 'reached' : 'NOT reached'}\n`,
  );
  process.exit(failed === 0 && passed.length > 0 && fixedPoint && reproduces ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
