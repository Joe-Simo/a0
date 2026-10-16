import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { link } from '../src/link.js';
import { findClang, runTool } from '../src/toolchain.js';
import { buildStage, closure, emitChunked, runStageChunk } from '../tools/bootstrap.js';
import { readBootstrapSeed } from '../tools/seed.js';

const clang = findClang();
const skip = clang.path === undefined ? 'clang is unavailable' : false;
const fixtures = resolve('test/fixtures/arena-program');
const runtime = resolve('tools/native');
let scratch: string | undefined;
let prepared: Promise<string> | undefined;
after(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
});

function prepare(): Promise<string> {
  prepared ??= (async () => {
    assert.ok(clang.path);
    const dir = await mkdtemp(join(tmpdir(), 'a0-arena-program-'));
    scratch = dir;
    const seed = await readBootstrapSeed();
    const [compiler] = await buildStage(clang, 'compiler', seed.c, 'emitchunkio', dir);
    const linked = await link('compiler/check_arena.a0', (path) => readFile(path, 'utf8'));
    const source = closure(linked.program.functions, 'arena_parse_check');
    const emitted = emitChunked(source, (chunk, bounds) => runStageChunk(compiler, chunk, bounds));
    assert.equal(
      emitted.code,
      0,
      `native A0 frontend compilation: ${emitted.failed?.own.join(',')}`,
    );
    const result = /^(a0t\d+) a0_arena_parse_check\(/m.exec(emitted.text)?.[1];
    assert.ok(result);
    await writeFile(join(dir, 'module.c'), emitted.text);
    await writeFile(join(dir, 'api.h'), `#define PARSE_RESULT ${result}\n`);
    for (const level of [0, 2]) {
      const built = runTool(
        clang.path,
        [
          '-std=c11',
          `-O${level}`,
          '-Wall',
          '-Wextra',
          '-Wno-unused-parameter',
          '-Werror',
          '-fsanitize=undefined',
          '-fno-sanitize-recover=all',
          '-I',
          dir,
          '-I',
          runtime,
          join(fixtures, 'driver.c'),
          join(runtime, 'arena_runtime.c'),
          '-o',
          join(dir, `driver-O${level}`),
        ],
        { cwd: dir, timeoutMs: 120_000 },
      );
      assert.ok(built.ok, `native A0 frontend O${level}: ${built.stderr}`);
    }
    return dir;
  })();
  return prepared;
}

function compare(dir: string, capacity: boolean): void {
  const ran = runTool(
    process.execPath,
    [join(fixtures, 'oracle.mjs'), dir, ...(capacity ? ['capacity'] : [])],
    { timeoutMs: 180_000 },
  );
  assert.ok(ran.ok, `${ran.stderr}\n${ran.stdout}`);
}

test(
  'seed-built A0 frontend preserves original IR, types, diagnostic IDs and metadata',
  {
    skip,
  },
  async () => compare(await prepare(), false),
);

test(
  'seed-built A0 frontend preserves full-width types, operands, symbols and source spans',
  {
    skip,
  },
  async () => compare(await prepare(), true),
);
