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
const skip =
  process.platform === 'win32'
    ? 'the optional filesystem transport implements POSIX OS calls'
    : clang.path === undefined
      ? 'clang is unavailable'
      : false;
const fixtures = resolve('test/fixtures/arena-linked-verifier'),
  runtime = resolve('tools/native');
let scratch: string | undefined, prepared: Promise<string> | undefined;
after(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
});
function prepare(): Promise<string> {
  prepared ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'a0-arena-linked-verifier-'));
    scratch = dir;
    const seed = await buildVerifiedNativeSeed(dir, clang);
    assert.ok(seed.clang.path);
    const linked = await link('compiler/link_verify_arena.a0', (p) => readFile(p, 'utf8'));
    const emitted = emitChunked(formatProgram(linked.program), (chunk, bounds) =>
      runStageChunk(seed.exe, chunk, bounds),
    );
    assert.equal(
      emitted.code,
      0,
      `native A0 linked verifier rejected ${emitted.failed?.own.join(',')}`,
    );
    await writeFile(join(dir, 'module.c'), emitted.text);
    const result = (name: string) => {
      const t = new RegExp(`^(a0t\\d+) a0_${name}\\(`, 'm').exec(emitted.text)?.[1];
      assert.ok(t, name);
      return t;
    };
    await writeFile(
      join(dir, 'api.h'),
      `#define LINKED_RESULT ${result('arena_link_verify_begin')}\n#define HELLO_RESULT ${result('fs_hello')}\n`,
    );
    const built = runTool(
      seed.clang.path,
      [
        '-std=c11',
        '-O2',
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
        join(runtime, 'fs_runtime.c'),
        join(runtime, 'arena_runtime.c'),
        '-o',
        join(dir, 'driver'),
      ],
      { cwd: dir, timeoutMs: 240000 },
    );
    assert.ok(built.ok, built.stderr);
    return dir;
  })();
  return prepared;
}
async function compare(group: 'sources' | 'resources') {
  const dir = await prepare();
  const ran = runTool(process.execPath, [join(fixtures, 'oracle.mjs'), dir, group], {
    timeoutMs: 240000,
  });
  assert.ok(ran.ok, `${ran.stderr}\n${ran.stdout}`);
}
test(
  'native A0 linked verifier preserves parse, dependency, profile and ordered spec decisions with original origins',
  { skip },
  async () => compare('sources'),
);
test(
  'native A0 linked verifier preserves pending, terminal and resource statuses',
  { skip },
  async () => compare('resources'),
);
