/**
 * The bootstrap seed (the idea of Zig's zig1.wasm): a small, checked-in artifact that lets a machine
 * with only a C compiler build A0 without Node or TypeScript.
 *
 * The seed is the C of the A0 compiler (compiler/boot.a0 entry `emitchunkio`, with everything it
 * reaches) as written by the compiler itself: stage 2 of tools/bootstrap.ts, the C that a0c-stage1
 * emits for the compiler. The pieces, all in seed/:
 *
 *   a0c-seed.c    the stage-2 C (generated, ~0.4 MB)
 *   stage-main.c  the shim: the stdin/stdout main that wraps the C as a stage (tools/bootstrap.ts stageMain)
 *   driver.c      replays the chunked self-compilation (tools/bootstrap.ts emitChunked) in C
 *   plan.txt      the chunk plan: per chunk its file, flags, the earlier functions it stubs, its own
 *   chunks/*.a0   the compiler's own source cut at function boundaries (tools/bootstrap.ts planChunks)
 *   MANIFEST      sha256 of the compiler source and the seed C, so a stale seed is caught without a build
 *   bootstrap.sh  the Node-free script: build the seed, compile the compiler, require stage 2 C ==
 *                 stage 3 C byte for byte, then once more (stage 4 == stage 3)
 *
 * Regenerating (needed after any change to compiler/*.a0, since the seed compiles that source):
 *   bun run seed            rebuild stage 1 (TypeScript C backend + clang), compile the compiler with
 *                           it, write seed/, then run seed/bootstrap.sh as the proof
 *   bun run seed -- --check cheap freshness check against the working tree (no build); exit 1 if stale
 *
 * The seed is C text, not a binary; seed/ is under a megabyte (STATUS.md records the exact sizes).
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compile } from '../src/backends.js';
import { parseAndValidate } from '../src/core.js';
import { link } from '../src/link.js';
import { findClang } from '../src/toolchain.js';
import {
  buildStage,
  type Chunk,
  closure,
  emitChunked,
  planChunks,
  rejected,
  runStageChunk,
  STAGE_INPUT,
  STAGE_OUTPUT,
  stageMain,
} from './bootstrap.js';

export const SEED_DIR = 'seed';
export const SEED_ENTRY = 'emitchunkio';
const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** The compiler as one source: `emitchunkio` with every function it reaches, as bootstrap.ts uses it. */
export async function compilerSource(): Promise<string> {
  const linked = (await link('compiler/boot.a0', (p) => readFile(p, 'utf8'))).program;
  return closure(linked.functions, SEED_ENTRY);
}

const chunkFile = (i: number): string => `chunks/${String(i).padStart(2, '0')}.a0`;
const list = (names: readonly string[]): string => (names.length === 0 ? '-' : names.join(','));

export function planText(chunks: readonly Chunk[]): string {
  return `${chunks
    .map(
      (c, i) =>
        `chunk ${chunkFile(i)} ${c.head ? 1 : 0} ${c.strict ? 1 : 0} ${list(c.before)} ${list(c.own)}`,
    )
    .join('\n')}\n`;
}

export function manifestText(source: string, seedC: string, chunks: number): string {
  return `${[
    'a0 bootstrap seed v1',
    `compiler-source-sha256 ${sha(source)}`,
    `seed-c-sha256 ${sha(seedC)}`,
    `seed-c-bytes ${Buffer.byteLength(seedC)}`,
    `chunks ${chunks}`,
    `stage-io-words ${STAGE_INPUT} ${STAGE_OUTPUT}`,
    'generated-by tools/seed.ts (bun run seed)',
  ].join('\n')}\n`;
}

/** What seed/ should hold for a compiler source and its stage-2 C. */
export function seedFiles(source: string, seedC: string): Map<string, string> {
  const chunks = planChunks(source);
  const files = new Map<string, string>([
    ['a0c-seed.c', seedC],
    ['stage-main.c', stageMain(SEED_ENTRY)],
    ['plan.txt', planText(chunks)],
    ['MANIFEST', manifestText(source, seedC, chunks.length)],
  ]);
  for (const [i, c] of chunks.entries()) files.set(chunkFile(i), c.source);
  return files;
}

/** Cheap staleness check against the working tree: everything but the seed C is recomputed. */
export async function staleness(): Promise<string[]> {
  const problems: string[] = [];
  const source = await compilerSource();
  let seedC: string;
  try {
    seedC = await readFile(join(SEED_DIR, 'a0c-seed.c'), 'utf8');
  } catch {
    return [`${SEED_DIR}/a0c-seed.c is missing: run \`bun run seed\``];
  }
  for (const [name, text] of seedFiles(source, seedC)) {
    let have: string | undefined;
    try {
      have = await readFile(join(SEED_DIR, name), 'utf8');
    } catch {
      have = undefined;
    }
    if (have !== text)
      problems.push(
        `${SEED_DIR}/${name} ${have === undefined ? 'is missing' : name === 'a0c-seed.c' ? 'differs' : 'is out of date'} for the current compiler source (the compiler source changed: run \`bun run seed\`)`,
      );
  }
  return problems;
}

/** Rebuild the seed from the compiler source: stage 1 by the TypeScript C backend, then its output. */
export async function regenerate(): Promise<{ files: Map<string, string>; chunks: number }> {
  const clang = findClang();
  if (clang.path === undefined) throw new Error('clang not found');
  const source = await compilerSource();
  const compiler = parseAndValidate(source);
  const stage1C = compile(compiler, 'c', {
    ioInputCapacity: STAGE_INPUT,
    ioOutputCapacity: STAGE_OUTPUT,
  }).text;
  const [stage1] = await buildStage(clang, 'a0c-stage1', stage1C);
  const self1 = emitChunked(source, (c, b) => runStageChunk(stage1, c, b));
  await rejected('stage 1', self1);
  const files = seedFiles(source, self1.text);
  return { files, chunks: self1.chunks };
}

async function write(files: Map<string, string>): Promise<void> {
  await rm(join(SEED_DIR, 'chunks'), { recursive: true, force: true });
  await mkdir(join(SEED_DIR, 'chunks'), { recursive: true });
  for (const [name, text] of files) await writeFile(join(SEED_DIR, name), text, 'utf8');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--check')) {
    const problems = await staleness();
    process.stdout.write(problems.length === 0 ? 'seed is fresh\n' : `${problems.join('\n')}\n`);
    process.exit(problems.length === 0 ? 0 : 1);
  }
  const { files, chunks } = await regenerate();
  await write(files);
  let total = 0;
  for (const text of files.values()) total += Buffer.byteLength(text);
  process.stdout.write(
    `seed: wrote ${files.size} files, ${chunks} chunks, ${total} bytes (a0c-seed.c ${Buffer.byteLength(files.get('a0c-seed.c') ?? '')} bytes)\n`,
  );
  if (!args.includes('--no-verify')) {
    const r = spawnSync('sh', [join(SEED_DIR, 'bootstrap.sh'), join('dist', 'seed')], {
      stdio: 'inherit',
      // On Windows the shell and compiler come from MSYS2 or Git Bash, so the environment is kept.
      env:
        process.platform === 'win32'
          ? { ...process.env }
          : { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '' },
    });
    process.exit(r.status ?? 1);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
