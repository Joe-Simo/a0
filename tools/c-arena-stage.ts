/** Isolated C-only arena stage experiment. Bootstrap setup may use TS, but each
 * stage consumes the same frozen raw A0 bytes and emits verbatim C through A0.
 * This does not replace seed/, native drivers, or public compiler defaults. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { link } from '../src/link.js';
import { findClang, runTool, type ToolInfo, type ToolResult } from '../src/toolchain.js';
import { buildStage, closure, emitChunked, runStageChunk } from './bootstrap.js';
import { reportJson, writeReport } from './scrub-results.js';
import { readBootstrapSeed } from './seed.js';

export const C_STAGE_ENTRY = 'arena_c_stage';
export const C_STAGE_RESOURCES = {
  arenaWords: 100_000_000,
  outputWords: 100_000_000,
  quantum: 97,
  resumes: 10_000_000,
  inputCapacity: 1,
  outputCapacity: 1,
  flags: 0,
  stackBytes: 1 << 30,
};
export type StageResources = typeof C_STAGE_RESOURCES;
export interface BootstrappedCStage {
  readonly exe: string;
  readonly source: string;
  readonly sourcePath: string;
  readonly seedSHA256: string;
  readonly chunks: number;
}
const sha = (text: string | Uint8Array): string => createHash('sha256').update(text).digest('hex');
const shimFiles = ['c_arena_stage.c', 'arena_runtime.c', 'arena_runtime.h'];

/** CC names one executable, as in the C-only script. An explicit unavailable
 * compiler fails instead of silently selecting another implementation. */
export function findCStageCompiler(): ToolInfo {
  const path = process.env.CC;
  if (!path) return findClang();
  const version = runTool(path, ['--version']);
  assert.ok(version.ok, `configured CC unavailable: ${path}`);
  return {
    name: path,
    path,
    version: version.stdout.split('\n')[0],
  };
}

export interface CStageBuildSettings {
  readonly optimization?: 'O0' | 'O2' | 'O3' | 'Os' | 'Oz';
  readonly sanitize?: boolean;
}

const compilerTargets = new Map<string, { windows: boolean; suffix: string }>();
function cStageCompilerTarget(compiler: ToolInfo): { windows: boolean; suffix: string } {
  assert.ok(compiler.path, 'C arena stage requires a C compiler');
  let target = compilerTargets.get(compiler.path);
  if (!target) {
    const macros = runTool(compiler.path, ['-dM', '-E', '-x', 'c', '-'], { input: '' });
    assert.ok(macros.ok, macros.stderr);
    const windows = /^#define _WIN32\b/m.test(macros.stdout);
    target = {
      windows,
      suffix: windows || /^#define __(?:CYGWIN|MSYS)__\b/m.test(macros.stdout) ? '.exe' : '',
    };
    compilerTargets.set(compiler.path, target);
  }
  return target;
}

export function cStageCompilerFlags(
  settings: CStageBuildSettings = {},
  compiler = findCStageCompiler(),
): string[] {
  const target = cStageCompilerTarget(compiler);
  return [
    '-std=c11',
    `-${settings.optimization ?? 'O2'}`,
    '-Wall',
    '-Wextra',
    '-Werror',
    '-Wno-unused-parameter',
    ...((settings.sanitize ?? !target.windows)
      ? ['-fsanitize=undefined', '-fno-sanitize-recover=all']
      : []),
    '-pthread',
    ...(target.windows ? ['-municode'] : []),
  ];
}

export function runCStage(
  exe: string,
  source: string,
  output: string,
  resources: StageResources = C_STAGE_RESOURCES,
): ToolResult {
  const values = [
    resources.arenaWords,
    resources.outputWords,
    resources.quantum,
    resources.resumes,
    resources.inputCapacity,
    resources.outputCapacity,
    resources.flags,
    resources.stackBytes,
  ];
  // Source/output are arbitrary native paths, including Unicode and spaces.
  // Arguments remain separate and never pass through a shell.
  const ran = spawnSync(exe, [source, output, ...values.map(String)], {
    encoding: 'utf8',
    timeout: 900_000,
    maxBuffer: 64 << 20,
  });
  return {
    ok: ran.status === 0,
    status: ran.status,
    stdout: ran.stdout ?? '',
    stderr: ran.stderr || ran.error?.message || '',
  };
}

/** No type-name extraction or generated-C rewriting: the entry uses only the
 * existing opaque IO pointer and u32 values on both bootstrap implementations. */
export function buildCStage(
  compiler: ToolInfo,
  dir: string,
  extraFlags: readonly string[] = [],
  settings: CStageBuildSettings = {},
): string {
  assert.ok(compiler.path, 'C arena stage requires a C compiler');
  const exe = join(dir, `stage${cStageCompilerTarget(compiler).suffix}`);
  const runtime = resolve('tools/native');
  const flags = [...cStageCompilerFlags(settings, compiler), ...extraFlags];
  const built = runTool(
    compiler.path,
    [
      ...flags,
      '-I',
      dir,
      '-I',
      runtime,
      join(runtime, 'c_arena_stage.c'),
      join(runtime, 'arena_runtime.c'),
      '-o',
      exe,
    ],
    { cwd: dir, timeoutMs: 240_000 },
  );
  writeFileSync(join(dir, 'native-build.stderr.log'), built.stderr);
  writeFileSync(join(dir, 'native-build.stdout.log'), built.stdout);
  writeFileSync(
    join(dir, 'native-build.json'),
    reportJson({ compiler, flags, accepted: built.ok }),
  );
  assert.ok(built.ok, built.stderr);
  return exe;
}

export async function bootstrapCStage(
  dir: string,
  compiler = findCStageCompiler(),
): Promise<BootstrappedCStage> {
  await mkdir(dir, { recursive: true });
  const linked = await link('compiler/c_stage_arena.a0', (path) => readFile(path, 'utf8'));
  const source = closure(linked.program.functions, C_STAGE_ENTRY);
  const seed = await readBootstrapSeed();
  const [seedExe] = await buildStage(compiler, 'verified-seed', seed.c, 'emitchunkio', dir);
  const emitted = emitChunked(source, (chunk, bounds) => runStageChunk(seedExe, chunk, bounds));
  assert.equal(emitted.code, 0, `verified seed rejected ${emitted.failed?.own.join(',')}`);
  const sourcePath = join(dir, 'compiler-source.a0');
  await writeFile(sourcePath, source);
  await writeFile(join(dir, 'module.c'), emitted.text);
  const exe = buildCStage(compiler, dir);
  return { exe, source, sourcePath, seedSHA256: sha(seed.c), chunks: emitted.chunks };
}

export async function reproduceCStage(dir: string, prepared?: BootstrappedCStage): Promise<void> {
  const compiler = findCStageCompiler();
  const shim = await Promise.all(
    shimFiles.map(async (file) => ({
      file,
      sha256: sha(await readFile(resolve('tools/native', file))),
    })),
  );
  const initial = prepared ?? (await bootstrapCStage(join(dir, 'stage1'), compiler));
  const frozen = initial.sourcePath;
  const rows: Record<string, unknown>[] = [];
  let exe = initial.exe;
  let previous: Buffer | undefined;
  let failure: string | undefined;
  for (let stage = 2; stage <= 4; stage++) {
    const next = join(dir, `stage${stage}`);
    await mkdir(next, { recursive: true });
    const module = join(next, 'module.c');
    const ran = runCStage(exe, frozen, module);
    await writeFile(join(next, 'stderr.log'), ran.stderr);
    rows.push({
      stage,
      accepted: ran.ok,
      stdout: ran.stdout.replaceAll(dir, '<artifact>'),
      stderr: ran.stderr.replaceAll(dir, '<artifact>'),
    });
    if (!ran.ok) {
      failure = `stage ${stage} rejected the frozen original input`;
      break;
    }
    const bytes = await readFile(module);
    Object.assign(rows[rows.length - 1] as Record<string, unknown>, {
      cBytes: bytes.length,
      cSHA256: sha(bytes),
      identicalToPrevious: previous === undefined ? null : previous.equals(bytes),
    });
    if (previous !== undefined && !previous.equals(bytes)) {
      failure = `stage ${stage} C differs from the previous stage`;
      break;
    }
    previous = bytes;
    try {
      exe = buildCStage(compiler, next);
      Object.assign(rows[rows.length - 1] as Record<string, unknown>, { nativeBuilt: true });
    } catch {
      Object.assign(rows[rows.length - 1] as Record<string, unknown>, { nativeBuilt: false });
      failure = `stage ${stage} emitted C fails the native build; see its native-build.stderr.log`;
      break;
    }
  }
  assert.equal(sha(await readFile(frozen)), sha(initial.source), 'original source is immutable');
  for (const file of shim) {
    assert.equal(
      sha(await readFile(resolve('tools/native', file.file))),
      file.sha256,
      'same immutable shim/runtime',
    );
  }
  await writeReport(join(dir, 'proof.json'), {
    status: failure === undefined ? 'passed' : 'failed',
    failure,
    entry: C_STAGE_ENTRY,
    bootstrap: 'verified native A0 seed; TS only links and plans this fixed implementation',
    stageExecution: 'C + pthreads; raw original source, A0 service, same generic shim, verbatim C',
    compiler,
    sourceBytes: Buffer.byteLength(initial.source),
    sourceSHA256: sha(initial.source),
    seedSHA256: initial.seedSHA256,
    bootstrapChunks: initial.chunks,
    shim,
    resources: C_STAGE_RESOURCES,
    rows,
  });
  assert.equal(failure, undefined, failure);
}

/** One-time development bootstrap. The exported directory can then be copied
 * to a machine with only a C compiler, pthreads and the documented shell tools. */
export async function prepareCStage(dir: string): Promise<void> {
  const compiler = findCStageCompiler();
  const initial = await bootstrapCStage(dir, compiler);
  for (const file of shimFiles) await copyFile(resolve('tools/native', file), join(dir, file));
  await writeReport(join(dir, 'preparation.json'), {
    status: 'prepared',
    bootstrap: 'verified native A0 seed; TS links and plans only this development bootstrap',
    compiler,
    sourceSHA256: sha(initial.source),
    seedSHA256: initial.seedSHA256,
    bootstrapChunks: initial.chunks,
    resources: C_STAGE_RESOURCES,
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const prepare = process.argv[2] === '--prepare';
  const dir = process.argv[prepare ? 3 : 2];
  assert.ok(dir, 'caller-owned artifact directory required');
  (prepare ? prepareCStage(resolve(dir)) : reproduceCStage(resolve(dir))).catch(
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
