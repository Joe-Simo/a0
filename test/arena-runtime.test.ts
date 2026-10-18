import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { findClang, runTool } from '../src/toolchain.js';

const clang = findClang();
const skip = clang.path === undefined ? 'clang is unavailable' : false;
const runtime = resolve('tools/native');
const fixture = resolve('test/fixtures/arena/reply-view-test.c');

for (const level of [0, 2]) {
  test(`arena reply retention and lifecycle obey the wire oracle at every split, O${level}`, {
    skip,
  }, async () => {
    assert.ok(clang.path);
    const dir = await mkdtemp(join(tmpdir(), 'a0-arena-wire-'));
    try {
      const exe = join(dir, 'reply-wire');
      const built = runTool(
        clang.path,
        [
          '-std=c11',
          `-O${level}`,
          '-Wall',
          '-Wextra',
          '-Werror',
          '-fsanitize=address,undefined',
          '-fno-sanitize-recover=all',
          '-I',
          runtime,
          fixture,
          join(runtime, 'arena_runtime.c'),
          '-o',
          exe,
        ],
        { cwd: dir, timeoutMs: 120_000 },
      );
      assert.ok(built.ok, built.stderr);
      const ran = runTool(exe, [], { cwd: dir, timeoutMs: 120_000 });
      assert.ok(ran.ok, ran.stderr);
      assert.match(ran.stdout, /^arena reply wire: \d+ checks passed\n$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
