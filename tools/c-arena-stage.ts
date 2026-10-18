/** Isolated C-only arena stage experiment. Bootstrap setup may use TS, but each
 * stage consumes the same frozen raw A0 bytes and emits verbatim C through A0.
 * This does not replace seed/, native drivers, or public compiler defaults. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { link } from '../src/link.js';
import { findClang, runTool, type ToolInfo } from '../src/toolchain.js';
import { buildStage, closure, emitChunked, runStageChunk } from './bootstrap.js';
import { writeReport } from './scrub-results.js';
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
const sha = (text: string | Uint8Array): string => createHash('sha256').update(text).digest('hex');

export function runCStage(
  exe: string,
  source: string,
  output: string,
  resources: StageResources = C_STAGE_RESOURCES,
): ReturnType<typeof runTool> {
  return runTool(exe, [source, output, ...Object.values(resources).map(String)], {
    timeoutMs: 900_000,
  });
}

/** No type-name extraction or generated-C rewriting: the entry uses only the
 * existing opaque IO pointer and u32 values on both bootstrap implementations. */
export function buildCStage(
  clang: ToolInfo,
  dir: string,
  extraFlags: readonly string[] = [],
): string {
  assert.ok(clang.path, 'C arena stage requires clang');
  const exe = join(dir, 'stage');
  const runtime = resolve('tools/native');
  const built = runTool(
    clang.path,
    [
      '-std=c11',
      '-O2',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-Wno-unused-parameter',
      '-fsanitize=undefined',
      '-fno-sanitize-recover=all',
      '-pthread',
      ...extraFlags,
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
  assert.ok(built.ok, built.stderr);
  return exe;
}

export async function bootstrapCStage(
  dir: string,
  clang = findClang(),
): Promise<{
  readonly exe: string;
  readonly source: string;
  readonly seedSHA256: string;
  readonly chunks: number;
}> {
  await mkdir(dir, { recursive: true });
  const linked = await link('compiler/c_stage_arena.a0', (path) => readFile(path, 'utf8'));
  const source = closure(linked.program.functions, C_STAGE_ENTRY);
  const seed = await readBootstrapSeed();
  const [seedExe] = await buildStage(clang, 'verified-seed', seed.c, 'emitchunkio', dir);
  const emitted = emitChunked(source, (chunk, bounds) => runStageChunk(seedExe, chunk, bounds));
  assert.equal(emitted.code, 0, `verified seed rejected ${emitted.failed?.own.join(',')}`);
  await writeFile(join(dir, 'compiler-source.a0'), source);
  await writeFile(join(dir, 'module.c'), emitted.text);
  const exe = buildCStage(clang, dir);
  return { exe, source, seedSHA256: sha(seed.c), chunks: emitted.chunks };
}

export async function reproduceCStage(dir: string): Promise<void> {
  const clang = findClang();
  const initial = await bootstrapCStage(join(dir, 'stage1'), clang);
  const frozen = join(dir, 'stage1', 'compiler-source.a0');
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
    rows.push({ stage, accepted: ran.ok, stdout: ran.stdout, stderr: ran.stderr });
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
      exe = buildCStage(clang, next);
      Object.assign(rows[rows.length - 1] as Record<string, unknown>, { nativeBuilt: true });
    } catch {
      Object.assign(rows[rows.length - 1] as Record<string, unknown>, { nativeBuilt: false });
      failure = `stage ${stage} emitted C fails the native build; see its native-build.stderr.log`;
      break;
    }
  }
  assert.equal(sha(await readFile(frozen)), sha(initial.source), 'original source is immutable');
  await writeReport(join(dir, 'proof.json'), {
    status: failure === undefined ? 'passed' : 'failed',
    failure,
    entry: C_STAGE_ENTRY,
    bootstrap: 'verified native A0 seed; TS only links and plans this fixed implementation',
    stageExecution: 'C + POSIX; raw original source, A0 service, same generic shim, verbatim C',
    sourceBytes: Buffer.byteLength(initial.source),
    sourceSHA256: sha(initial.source),
    seedSHA256: initial.seedSHA256,
    bootstrapChunks: initial.chunks,
    resources: C_STAGE_RESOURCES,
    rows,
  });
  assert.equal(failure, undefined, failure);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2];
  assert.ok(dir, 'caller-owned artifact directory required');
  reproduceCStage(resolve(dir)).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
