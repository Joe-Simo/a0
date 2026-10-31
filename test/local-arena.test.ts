import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { compile } from '../src/backends.js';
import { parseAndValidate } from '../src/core.js';
import { findClang, runTool } from '../src/toolchain.js';
import { compileLocalArena } from '../tools/source-local-arena.js';

const clang = findClang();
for (const level of [0, 2]) {
  test(`private local arena matches v1 storage and revokes stale capabilities, O${level}`, {
    skip: clang.path === undefined ? 'clang unavailable' : false,
  }, async () => {
    assert.ok(clang.path);
    const dir = await mkdtemp(join(tmpdir(), 'a0-local-arena-'));
    try {
      const exe = join(dir, 'contract');
      const build = runTool(
        clang.path,
        [
          '-std=c11',
          `-O${level}`,
          '-Wall',
          '-Wextra',
          '-Werror',
          '-fsanitize=address,undefined',
          '-fno-sanitize-recover=all',
          '-DA0_ARENA_LOCAL_EXPERIMENT',
          '-I',
          resolve('tools/native'),
          resolve('test/fixtures/arena-local/contract.c'),
          resolve('tools/native/arena_runtime.c'),
          ...(process.platform === 'win32' ? [] : ['-pthread']),
          '-o',
          exe,
        ],
        { timeoutMs: 120_000 },
      );
      assert.ok(build.ok, build.stderr);
      const run = runTool(exe, [], { timeoutMs: 120_000 });
      assert.ok(run.ok, run.stderr);
      assert.match(run.stdout, /16271 checks;400 concurrent independent lifetimes passed/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('local lowering is explicit and refuses changed contract dependencies', async () => {
  const source = await readFile('compiler/arena_shared.a0', 'utf8');
  const program = parseAndValidate(source);
  const normal = compile(program, 'c', { cIo: 'host' }).text;
  const local = compileLocalArena(program, source);
  for (const op of ['alloc', 'load', 'store'])
    assert.ok(local.includes(`a0_arena_local_${op}(A0_LOCAL_ARENA(p0)`));
  assert.ok(!normal.includes('A0_LOCAL_ARENA'));
  assert.equal(compile(program, 'c', { cIo: 'host' }).text, normal);
  assert.throws(() => compileLocalArena(program, `${source}\n`), /contract source changed/);
  const changed = parseAndValidate(source.replace('bad ne p1 n', 'bad eq p1 n'));
  assert.throws(
    () => compileLocalArena(changed, source),
    /untrusted local arena dependency arena_expect/,
  );
  assert.throws(
    () => compileLocalArena({ ...program, profile: 'strict' }, source),
    /canonical compiler semantics/,
  );
});

test('lowered arena functions accept only the wrapper-owned live token', {
  skip: clang.path === undefined ? 'clang unavailable' : false,
}, async () => {
  assert.ok(clang.path);
  const dir = await mkdtemp(join(tmpdir(), 'a0-local-binding-'));
  try {
    const source = await readFile('compiler/arena_shared.a0', 'utf8');
    await writeFile(join(dir, 'module.c'), compileLocalArena(parseAndValidate(source), source));
    const exe = join(dir, 'binding');
    const build = runTool(
      clang.path,
      [
        '-std=c11',
        '-O2',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-Wno-unused-parameter',
        '-fsanitize=address,undefined',
        '-fno-sanitize-recover=all',
        '-DA0_ARENA_LOCAL_EXPERIMENT',
        '-I',
        dir,
        '-I',
        resolve('tools/native'),
        resolve('test/fixtures/arena-local/binding.c'),
        resolve('tools/native/arena_runtime.c'),
        '-o',
        exe,
      ],
      { timeoutMs: 120_000 },
    );
    assert.ok(build.ok, build.stderr);
    const result = runTool(exe, [], { timeoutMs: 120_000 });
    assert.ok(result.ok, result.stderr);
    assert.match(result.stdout, /foreign and closed tokens refused/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
