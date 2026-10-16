import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { link } from '../src/link.js';
import { findClang, runTool } from '../src/toolchain.js';
import { closure, emitChunked, runStageChunk } from '../tools/bootstrap.js';
import { buildVerifiedNativeSeed } from './helpers/native-source-compiler.js';

const clang = findClang();

test('seed-built A0 SHA256 preserves standard byte digests, padding, IO and atomic refusals', {
  skip: clang.path === undefined ? 'clang is unavailable' : false,
}, async () => {
  assert.ok(clang.path);
  const dir = await mkdtemp(join(tmpdir(), 'a0-arena-sha256-'));
  try {
    const seed = await buildVerifiedNativeSeed(dir, clang);
    const linked = await link('compiler/sha256_arena.a0', (path) => readFile(path, 'utf8'));
    const source = closure(linked.program.functions, 'arena_sha256_hex');
    // TS links/plans this bootstrap input; the verified native A0 seed parses/checks/emits it.
    const emitted = emitChunked(source, (chunk, bounds) => runStageChunk(seed.exe, chunk, bounds));
    assert.equal(emitted.code, 0, `A0 SHA256 compilation: ${emitted.failed?.own.join(',')}`);
    const hex = /^(a0t\d+) a0_arena_sha256_hex\(/m.exec(emitted.text)?.[1];
    const hash = /^(a0t\d+) a0_arena_sha256\(/m.exec(emitted.text)?.[1];
    assert.ok(hex);
    assert.ok(hash);
    await writeFile(join(dir, 'module.c'), emitted.text);
    await writeFile(join(dir, 'api.h'), `#define HEX_RESULT ${hex}\n#define HASH_RESULT ${hash}\n`);
    const runtime = resolve('tools/native');
    const fixtures = resolve('test/fixtures/arena-sha256');
    for (const level of [0, 2]) {
      const built = runTool(
        clang.path,
        [
          '-std=c11',
          `-O${level}`,
          '-Wall',
          '-Wextra',
          '-Werror',
          '-Wno-unused-parameter',
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
        { timeoutMs: 120_000 },
      );
      assert.ok(built.ok, built.stderr);
    }
    const checked = runTool(process.execPath, [join(fixtures, 'oracle.mjs'), dir], {
      timeoutMs: 180_000,
    });
    assert.ok(checked.ok, `${checked.stdout}${checked.stderr}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
