/**
 * arm64 bootstrap without the system assembler and linker. The compiler is the one of
 * tools/bootstrap-arm64.ts (compiler/boot.a0 `emitachunkio`, which writes arm64 assembly); its
 * assembly and the stage runtime (tools/arm64-runtime.ts) are encoded by src/arm64enc.ts and
 * linked by src/macho.ts into a signed Mach-O executable. clang is used for the C seed (stage
 * 1) and, only as a reference, to check the encoder instruction by instruction; no stage 2 or
 * stage 3 byte comes from clang, ld or codesign.
 *
 * - Stage 1: the TypeScript C backend and clang (the seed, as in tools/bootstrap-arm64.ts).
 * - Stage 2: stage 1 compiles the compiler to assembly; arm64enc + macho write `a0c-mo-stage2/a0c`.
 * - Stage 3: stage 2 compiles the compiler again; its assembly must equal stage 2's, the
 *   executable written from it must equal stage 2's byte for byte, and stage 3 must reproduce.
 * - Encoder check: for every test source of tools/bootstrap.ts (emitted by stage 2, which must
 *   give stage 1's code and text), the compiler's own assembly, the runtime, and the
 *   src/arm64.ts output of the corpus and the examples, the words of arm64enc equal the words
 *   of `clang -c -x assembler` instruction by instruction, with the same relocations.
 * Writes results/bootstrap-macho.json.
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { assembleArm64Text } from '../src/arm64enc.js';
import { COMPILER_VERSION, compile } from '../src/backends.js';
import { formatProgram, parseAndValidate, type TypedProgram } from '../src/core.js';
import { link } from '../src/link.js';
import { linkMachO, readObjectText } from '../src/macho.js';
import { findClang, runTool, type ToolInfo, withTempDir } from '../src/toolchain.js';
import { ENTRY, runtime } from './arm64-runtime.js';
import {
  BUILD_DIR,
  buildStage,
  emitChunked,
  rejected,
  runStageChunk,
  SMALL,
  STAGE_INPUT,
  STAGE_OUTPUT,
} from './bootstrap.js';
import { closure, closures, generateCorpus, ioFreeSubset } from './corpus.js';
import { ILL_TYPED } from './ref-check.js';
import { writeReport } from './scrub-results.js';

const RELOC_KIND: Readonly<Record<number, string>> = { 2: 'branch26', 3: 'page21', 4: 'pageoff12' };

interface Check {
  readonly label: string;
  readonly instructions: number;
  readonly relocations: number;
  readonly mismatches: readonly string[];
}

/** arm64enc against clang's assembler on one assembly text. */
async function checkEncoding(clang: ToolInfo, label: string, text: string): Promise<Check> {
  return withTempDir(async (dir) => {
    await writeFile(join(dir, 'm.s'), text, 'utf8');
    const r = runTool(clang.path as string, ['-c', '-x', 'assembler', '-o', 'm.o', 'm.s'], {
      cwd: dir,
    });
    if (!r.ok)
      return {
        label,
        instructions: 0,
        relocations: 0,
        mismatches: [`clang: ${r.stderr.slice(0, 500)}`],
      };
    const obj = readObjectText(await readFile(join(dir, 'm.o')));
    const mismatches: string[] = [];
    let mine: ReturnType<typeof assembleArm64Text>;
    try {
      mine = assembleArm64Text(text);
    } catch (err) {
      return { label, instructions: 0, relocations: 0, mismatches: [String(err)] };
    }
    const lines = text.split('\n');
    if (obj.words.length !== mine.words.length)
      mismatches.push(`length: clang ${obj.words.length} words, arm64enc ${mine.words.length}`);
    for (let i = 0; i < Math.min(obj.words.length, mine.words.length); i += 1)
      if (obj.words[i] !== mine.words[i])
        mismatches.push(
          `word ${i} (${(lines[(mine.lines[i] ?? 1) - 1] ?? '').trim()}): clang ${(obj.words[i] as number).toString(16)} arm64enc ${(mine.words[i] as number).toString(16)}`,
        );
    const theirs = obj.relocations
      .map((x) => `${x.offset}:${RELOC_KIND[x.type] ?? x.type}`)
      .sort()
      .join(' ');
    const ours = mine.relocations
      .map((x) => `${x.offset}:${x.kind}`)
      .sort()
      .join(' ');
    if (theirs !== ours)
      mismatches.push(`relocations differ: clang [${theirs}] arm64enc [${ours}]`);
    return {
      label,
      instructions: obj.words.length,
      relocations: obj.relocations.length,
      mismatches: mismatches.slice(0, 10),
    };
  });
}

/** Encode and link `asm` with the runtime: the executable `<name>/a0c`. */
async function writeStage(
  name: string,
  asm: string,
): Promise<{ exe: string; bytes: Buffer; ms: number }> {
  const start = performance.now();
  const bytes = linkMachO(assembleArm64Text(asm + runtime()), '_main');
  const ms = Math.round(performance.now() - start);
  const dir = join(BUILD_DIR, name);
  await mkdir(dir, { recursive: true });
  const exe = join(dir, 'a0c');
  await writeFile(exe, bytes, { mode: 0o755 });
  return { exe, bytes, ms };
}

async function main(): Promise<void> {
  const clang = findClang();
  if (clang.path === undefined) throw new Error('clang not found');
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error(`needs macOS on Apple silicon, found ${process.platform}-${process.arch}`);
  const linked = (await link('compiler/boot.a0', (p) => readFile(p, 'utf8'))).program;
  const compilerSource = closure(linked.functions, ENTRY);
  const compiler = parseAndValidate(compilerSource);

  const stage1C = compile(compiler, 'c', {
    ioInputCapacity: STAGE_INPUT,
    ioOutputCapacity: STAGE_OUTPUT,
  }).text;
  const [stage1, stage1BuildMs] = await buildStage(clang, 'a0c-mo-stage1', stage1C, ENTRY);
  const self1 = emitChunked(compilerSource, (c, b) => runStageChunk(stage1, c, b));
  await rejected('stage 1', self1);
  const s2 = await writeStage('a0c-mo-stage2', self1.text);
  process.stdout.write(
    `stage 2: seed compiled the compiler (${Buffer.byteLength(self1.text)} assembly bytes); arm64enc + macho wrote ${s2.bytes.length} bytes in ${s2.ms} ms -> ${s2.exe}\n`,
  );
  const sign = runTool('/usr/bin/codesign', ['-v', s2.exe]);
  const self2 = emitChunked(compilerSource, (c, b) => runStageChunk(s2.exe, c, b));
  await rejected('stage 2', self2);
  const fixedPoint = self2.text === self1.text;
  const s3 = await writeStage('a0c-mo-stage3', self2.text);
  const sameBinary = s2.bytes.equals(s3.bytes);
  const self3 = emitChunked(compilerSource, (c, b) => runStageChunk(s3.exe, c, b));
  const reproduces = self3.code === 0 && self3.text === self2.text;
  process.stdout.write(
    `stage 3: stage 2 compiled the compiler in ${Math.round(self2.ms)} ms: assembly ${fixedPoint ? 'identical (fixed point)' : 'DIFFERS'}; executables identical: ${sameBinary} (${s3.bytes.length} bytes); stage 3 reproduces: ${reproduces}; codesign -v (check only): ${sign.ok ? 'valid' : sign.stderr.trim()}\n`,
  );

  // Encoder check.
  const corpus = generateCorpus();
  const groups: [string, [string, string][]][] = [
    ['small', SMALL],
    ['ill-typed', [...ILL_TYPED]],
    ['corpus', [['corpus', formatProgram(corpus)], ...closures('corpus', corpus)]],
  ];
  const tsPrograms: [string, TypedProgram][] = [['corpus', corpus]];
  for (const f of (await readdir('examples')).filter((f) => f.endsWith('.a0')).sort()) {
    const text = await readFile(`examples/${f}`, 'utf8');
    const program = parseAndValidate(text);
    groups.push([f, [[f, text], ...closures(f, program)]]);
    tsPrograms.push([f, program]);
  }
  groups.push([
    'compiler',
    closures('boot.a0', compiler).filter(([label]) => label !== `boot.a0/${ENTRY}`),
  ]);
  const checks: Check[] = [];
  let sources = 0;
  let stageDiffers = 0;
  for (const [, list] of groups)
    for (const [label, src] of list) {
      sources += 1;
      const e1 = emitChunked(src, (c, b) => runStageChunk(stage1, c, b));
      const e2 = emitChunked(src, (c, b) => runStageChunk(s2.exe, c, b));
      if (e1.code !== e2.code || e1.text !== e2.text) stageDiffers += 1;
      if (e2.code === 0) checks.push(await checkEncoding(clang, label, e2.text));
    }
  checks.push(await checkEncoding(clang, 'compiler (whole)', self2.text));
  checks.push(await checkEncoding(clang, 'runtime', runtime()));
  for (const [label, program] of tsPrograms) {
    const subset = ioFreeSubset(program);
    if (subset.functions.length > 0)
      checks.push(
        await checkEncoding(clang, `src/arm64.ts ${label}`, compile(subset, 'arm64').text),
      );
  }
  const failed = checks.filter((c) => c.mismatches.length > 0);
  const instructions = checks.reduce((n, c) => n + c.instructions, 0);
  for (const c of failed)
    process.stdout.write(`    FAIL ${c.label}: ${c.mismatches.join(' | ')}\n`);
  process.stdout.write(
    `encoder: ${checks.length} assembly texts (${sources} sources through stages 1 and 2, ${stageDiffers} differing), ${instructions} instructions, ${failed.length} with mismatches\n`,
  );

  const ok =
    fixedPoint && sameBinary && reproduces && sign.ok && failed.length === 0 && stageDiffers === 0;
  const report = {
    generatedAt: new Date().toISOString(),
    compilerVersion: COMPILER_VERSION,
    stage: 'arm64 bootstrap to a signed Mach-O executable without the system assembler and linker',
    toolchain:
      'Stage 1 is the C seed (TypeScript C backend + clang). Stages 2 and 3: A0-emitted assembly plus the runtime of tools/arm64-runtime.ts, encoded by src/arm64enc.ts and linked and ad-hoc signed by src/macho.ts (SHA-256 code directory written in TypeScript); dyld binds libSystem _mmap/_read/_write. clang, ld and codesign produce no byte of stages 2 and 3; clang is the reference of the encoder check and codesign -v checks the signature.',
    stage1: { cBytes: Buffer.byteLength(stage1C), buildMs: stage1BuildMs },
    stage2: {
      asmBytes: Buffer.byteLength(self1.text),
      executableBytes: s2.bytes.length,
      linkMs: s2.ms,
    },
    stage3: {
      asmBytes: Buffer.byteLength(self2.text),
      executableBytes: s3.bytes.length,
      emitMs: Math.round(self2.ms),
      reproduces,
    },
    fixedPoint: { assembly: fixedPoint, executablesIdentical: sameBinary, codesignValid: sign.ok },
    encoder: {
      method:
        'arm64enc words equal clang -c -x assembler __text words one by one, and the relocation offsets and kinds are equal',
      texts: checks.length,
      sources,
      stage2DiffersFromStage1: stageDiffers,
      instructions,
      failed: failed.length,
      checks,
    },
  };
  await mkdir('results', { recursive: true });
  await writeReport(join('results', 'bootstrap-macho.json'), report);
  process.exit(ok ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
