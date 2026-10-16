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
const fixtures = resolve('test/fixtures/arena-spec-verifier');
const runtime = resolve('tools/native');
let scratch: string | undefined;
let prepared: Promise<string> | undefined;
after(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
});

function prepare(): Promise<string> {
  prepared ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'a0-arena-spec-verifier-'));
    scratch = dir;
    const seed = await buildVerifiedNativeSeed(dir, clang);
    assert.ok(seed.clang.path);
    const linked = await link(join(fixtures, 'probe.a0'), (path) => readFile(path, 'utf8'));
    const emitted = emitChunked(formatProgram(linked.program), (chunk, bounds) =>
      runStageChunk(seed.exe, chunk, bounds),
    );
    assert.equal(emitted.code, 0, `A0 seed rejected ${emitted.failed?.own.join(',')}`);
    await writeFile(join(dir, 'module.c'), emitted.text);
    const state = /^(a0t\d+) a0_arena_verify_begin\(/m.exec(emitted.text)?.[1];
    assert.ok(state);
    await writeFile(join(dir, 'api.h'), `#define SV_STATE ${state}\n`);
    const exe = join(dir, 'spec-verifier');
    const built = runTool(
      seed.clang.path,
      [
        '-std=c11',
        '-O2',
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
        exe,
      ],
      { cwd: dir, timeoutMs: 180_000 },
    );
    assert.ok(built.ok, built.stderr);
    return exe;
  })();
  return prepared;
}

async function compare(group: string): Promise<void> {
  const exe = await prepare();
  const ran = runTool(process.execPath, [join(fixtures, 'oracle.mjs'), exe, group], {
    timeoutMs: 180_000,
  });
  assert.ok(ran.ok, `${ran.stderr}\n${ran.stdout}`);
}

test(
  'seed-built spec verifier preserves example, contract and function order',
  { skip },
  async () => compare('core'),
);
test(
  'seed-built spec verifier preserves fresh phase and example fuel budgets',
  { skip },
  async () => compare('fuel'),
);
test(
  'seed-built spec verifier preserves full-width literal IDs and deep equality',
  { skip },
  async () => compare('capacity'),
);
test(
  'seed-built spec verifier keeps pending continuations and resource failures explicit',
  { skip },
  async () => compare('boundaries'),
);
