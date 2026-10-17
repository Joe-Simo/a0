import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { formatProgram } from '../src/core.js';
import { link } from '../src/link.js';
import { findClang, runTool } from '../src/toolchain.js';
import { emitChunked, runStageChunk } from '../tools/bootstrap.js';
import { buildVerifiedNativeSeed } from './helpers/native-source-compiler.js';

const clang = findClang();
const skip = clang.path === undefined ? 'clang is unavailable' : false;
const fixtures = resolve('test/fixtures/arena-backend-context');
const runtime = resolve('tools/native');
let scratch: string | undefined;
let prepared: Promise<string> | undefined;
after(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
});

function prepare(): Promise<string> {
  prepared ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'a0-arena-backend-context-'));
    scratch = dir;
    const seed = await buildVerifiedNativeSeed(dir, clang);
    assert.ok(seed.clang.path);
    // The verified native A0 seed parses/checks/emits the entire service closure.
    // The TS linker and chunk planner construct this explicit test build only.
    const linked = await link('compiler/backend_service_arena.a0', (path) =>
      readFile(path, 'utf8'),
    );
    const emitted = emitChunked(formatProgram(linked.program), (chunk, bounds) =>
      runStageChunk(seed.exe, chunk, bounds),
    );
    assert.equal(
      emitted.code,
      0,
      `native A0 context service rejected ${emitted.failed?.own.join(',')}`,
    );
    await writeFile(join(dir, 'module.c'), emitted.text);
    const result = (name: string): string => {
      const type = new RegExp(`^(a0t\\d+) a0_${name}\\(`, 'm').exec(emitted.text)?.[1];
      assert.ok(type, name);
      return type;
    };
    await writeFile(
      join(dir, 'api.h'),
      `#define SERVICE_RESULT ${result('arena_backend_service_begin')}\n#define HELLO_RESULT ${result('arena_hello')}\n#define LOWER_RESULT ${result('arena_backend_context')}\n#define PAGE ${result('arena_zero')}\n`,
    );
    for (const level of [0, 2]) {
      const built = runTool(
        seed.clang.path,
        [
          '-std=c11',
          `-O${level}`,
          '-Wall',
          '-Wextra',
          '-Wno-unused-parameter',
          '-Werror',
          '-fsanitize=address,undefined',
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
        { cwd: dir, timeoutMs: 240_000 },
      );
      assert.ok(built.ok, `native context O${level}: ${built.stderr}`);
    }
    return dir;
  })();
  return prepared;
}

async function compare(group: 'core' | 'capacity'): Promise<void> {
  const dir = await prepare();
  const ran = runTool(process.execPath, [join(fixtures, 'oracle.mjs'), dir, group], {
    timeoutMs: 240_000,
  });
  assert.ok(ran.ok, `${ran.stderr}\n${ran.stdout}`);
}

test(
  'native A0 source lowering preserves checked types, operands, strict IDs and ownership metadata',
  { skip },
  async () => compare('core'),
);
test(
  'native A0 source lowering retains full-width types, nodes, fields, names and source coordinates',
  { skip },
  async () => compare('capacity'),
);
