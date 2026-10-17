import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { link } from '../../src/link.js';
import { findClang, runTool, spawnWithInput, type ToolInfo } from '../../src/toolchain.js';
import {
  buildStage,
  CLANG_BUILD,
  closure,
  emitChunked,
  runStageChunk,
} from '../../tools/bootstrap.js';
import { readBootstrapSeed } from '../../tools/seed.js';

/** Private source-packet v1: length, byte words, mandatory completion tag. */
export const SOURCE_COMPLETION_TAG = 2690135777;
export const SOURCE_FRONTEND_CAPACITY = 131072;

export interface NativeSourceRun {
  readonly code: number;
  readonly text: string;
  readonly stderr: string;
}

export interface NativeSeed {
  readonly exe: string;
  readonly clang: ToolInfo;
  readonly cSha256: string;
}

export interface NativeSourceCompiler {
  readonly exe: string;
  readonly source: string;
  readonly emittedC: string;
  readonly chunks: number;
  readonly seed: NativeSeed;
  /** Byte-text output only. This is not the bootstrap bounds/trailer protocol. */
  runSource(source: string): NativeSourceRun;
  /** Deliberately malformed framing can be supplied for negative tests. */
  runWords(words: readonly number[]): NativeSourceRun;
  /** Tests can also supply an incomplete final binary word. */
  runRaw(input: Buffer): NativeSourceRun;
}

export function packWords(words: readonly number[]): Buffer {
  const input = Buffer.alloc(words.length * 4);
  for (const [i, value] of words.entries()) {
    assert.ok(Number.isInteger(value) && value >= 0 && value <= 0xffffffff);
    input.writeUInt32LE(value, i * 4);
  }
  return input;
}

export function sourcePacket(source: string): Buffer {
  const bytes = Buffer.from(source, 'utf8');
  const packet = Buffer.alloc((bytes.length + 2) * 4);
  packet.writeUInt32LE(bytes.length, 0);
  for (const [i, byte] of bytes.entries()) packet.writeUInt32LE(byte, (i + 1) * 4);
  packet.writeUInt32LE(SOURCE_COMPLETION_TAG, (bytes.length + 1) * 4);
  return packet;
}

/** Build a current, verified seed in a caller-owned temporary directory. */
export async function buildVerifiedNativeSeed(
  dir: string,
  clang: ToolInfo = findClang(),
): Promise<NativeSeed> {
  assert.ok(clang.path, 'native A0 source tests require clang');
  const seed = await readBootstrapSeed();
  const [exe] = await buildStage(clang, 'verified-seed', seed.c, 'emitchunkio', dir);
  return { exe, clang, cSha256: createHash('sha256').update(seed.c).digest('hex') };
}

/** Generic word transport and atomic byte output; no language/target decisions live here. */
export function sourceCompilerMain(
  entry: string,
  inputCapacity = 1 << 22,
  outputCapacity = 1 << 22,
): string {
  assert.match(entry, /^[a-z][a-z0-9_]*$/);
  assert.ok(Number.isInteger(inputCapacity) && inputCapacity >= SOURCE_FRONTEND_CAPACITY + 3);
  assert.ok(Number.isInteger(outputCapacity) && outputCapacity > 0);
  return `#include <pthread.h>
#include <stdio.h>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif
#define A0_IO_INPUT_CAPACITY ${inputCapacity}u
#define A0_IO_OUTPUT_CAPACITY ${outputCapacity}u
#include "emitter.c"
static a0_io io;
static uint32_t code;
static void *run(void *unused) {
  (void)unused;
  code = a0_${entry}(&io);
  return NULL;
}
int main(void) {
#ifdef _WIN32
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
#endif
  unsigned char word[4];
  uint32_t count = 0;
  for (;;) {
    size_t got = fread(word, 1, 4, stdin);
    if (got == 0) break;
    if (got != 4 || count == A0_IO_INPUT_CAPACITY) return 64;
    io.input[count++] = (uint32_t)word[0] | (uint32_t)word[1] << 8 |
      (uint32_t)word[2] << 16 | (uint32_t)word[3] << 24;
  }
  if (ferror(stdin)) return 64;
  io.ninput = count;
  pthread_attr_t attr;
  pthread_t thread;
  if (pthread_attr_init(&attr) != 0) return 66;
  if (pthread_attr_setstacksize(&attr, (size_t)1u << 30) != 0) return 66;
  if (pthread_create(&thread, &attr, run, NULL) != 0) return 66;
  pthread_attr_destroy(&attr);
  if (pthread_join(thread, NULL) != 0) return 66;
  if (io.noutput >= A0_IO_OUTPUT_CAPACITY) return 65;
  if (code != 0) {
    if (io.noutput != 0) { fputs("partial compiler output on refusal\\n", stderr); return 67; }
    return code <= 255 ? (int)code : 68;
  }
  for (uint32_t i = 0; i < io.noutput; i++) if (io.output[i] > 255) return 68;
  unsigned char bytes[4096];
  for (uint32_t i = 0; i < io.noutput;) {
    uint32_t n = io.noutput - i;
    if (n > sizeof bytes) n = sizeof bytes;
    for (uint32_t j = 0; j < n; j++) bytes[j] = (unsigned char)io.output[i + j];
    if (fwrite(bytes, 1, n, stdout) != n) return 69;
    i += n;
  }
  return 0;
}
`;
}

/**
 * Initial host linking/chunk planning is explicit. All parse/check/C emission of the
 * target compiler closure runs in the verified native A0 seed. Tests own/clean `dir`.
 */
export async function buildNativeSourceCompiler(options: {
  readonly module: string;
  readonly entry: string;
  readonly dir: string;
  readonly seed?: NativeSeed;
  readonly clang?: ToolInfo;
  readonly inputCapacity?: number;
  readonly outputCapacity?: number;
}): Promise<NativeSourceCompiler> {
  const seed = options.seed ?? (await buildVerifiedNativeSeed(options.dir, options.clang));
  assert.ok(seed.clang.path);
  const linked = await link(options.module, (path) => readFile(path, 'utf8'));
  const source = closure(linked.program.functions, options.entry);
  const emitted = emitChunked(source, (chunk, bounds) => runStageChunk(seed.exe, chunk, bounds));
  assert.equal(emitted.code, 0, `A0 seed rejected ${emitted.failed?.own.join(',')}`);
  const dir = join(options.dir, options.entry);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'emitter.c'), emitted.text);
  await writeFile(
    join(dir, 'main.c'),
    sourceCompilerMain(options.entry, options.inputCapacity, options.outputCapacity),
  );
  const exe = join(dir, 'source-compiler');
  const built = runTool(seed.clang.path, [...CLANG_BUILD, '-Werror', '-o', exe, 'main.c'], {
    cwd: dir,
    timeoutMs: 180_000,
  });
  assert.ok(built.ok, `seed-built ${options.entry}: ${built.stderr}`);
  const runRaw = (input: Buffer): NativeSourceRun => {
    const ran = spawnWithInput(exe, input, { timeout: 60_000, maxBuffer: 1 << 26 });
    assert.equal(ran.error, undefined);
    assert.equal(ran.signal, null);
    assert.notEqual(ran.status, null);
    return {
      code: ran.status as number,
      text: ran.stdout.toString('utf8'),
      stderr: ran.stderr.toString('utf8'),
    };
  };
  return {
    exe,
    source,
    emittedC: emitted.text,
    chunks: emitted.chunks,
    seed,
    runRaw,
    runWords: (words) => runRaw(packWords(words)),
    runSource: (input) => runRaw(sourcePacket(input)),
  };
}
