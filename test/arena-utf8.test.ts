import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { formatProgram } from '../src/core.js';
import { link } from '../src/link.js';
import { findClang, runTool } from '../src/toolchain.js';
import { emitChunked, runStageChunk } from '../tools/bootstrap.js';
import type { DecoderCase } from './fixtures/arena-utf8/cases.mjs';
import { buildVerifiedNativeSeed } from './helpers/native-source-compiler.js';

const clang = findClang();
const skip = clang.path === undefined ? 'clang is unavailable' : false;
const fixtures = resolve('test/fixtures/arena-utf8');
const runtime = resolve('tools/native');
// Deliberately fixed: pure unit and internal append controls remain in this closure.
const roots = ['arena_utf8_decode', 'arena_hello', 'arena_finish'];
let scratch: string | undefined;
let prepared:
  | Promise<{ dir: string; exes: readonly string[]; cases: readonly DecoderCase[] }>
  | undefined;
after(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
});

function prepare(): Promise<{
  dir: string;
  exes: readonly string[];
  cases: readonly DecoderCase[];
}> {
  prepared ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'a0-arena-utf8-'));
    scratch = dir;
    const seed = await buildVerifiedNativeSeed(dir, clang);
    assert.ok(seed.clang.path);
    const linked = await link(join(fixtures, 'probe.a0'), (path) => readFile(path, 'utf8'));
    const needed = new Set<string>();
    function visit(name: string): void {
      if (needed.has(name)) return;
      needed.add(name);
      const fn = linked.program.byName.get(name);
      assert.ok(fn, name);
      for (const node of fn.nodes) {
        if (node.callee !== undefined) visit(node.callee);
        if (node.pred !== undefined) visit(node.pred);
      }
    }
    for (const root of roots) visit(root);
    const source = formatProgram({
      functions: linked.program.functions.filter((fn) => needed.has(fn.name)),
    });
    // Host linking/planning is explicit; the actual seed parses/checks/emits every chunk.
    const emitted = emitChunked(source, (chunk, bounds) => runStageChunk(seed.exe, chunk, bounds));
    assert.equal(emitted.code, 0, `A0 seed rejected ${emitted.failed?.own.join(',')}`);
    await writeFile(join(dir, 'module.c'), emitted.text);
    const api: string[] = [];
    for (const [key, name] of Object.entries({
      HELLO: 'arena_hello',
      FINISHED: 'arena_finish',
      DECODED: 'arena_utf8_decode',
      UD_STATE: 'ud_append',
      META: 'arena_zero',
      UNIT_RESULT: 'utf8_unit',
    })) {
      const type = new RegExp(`^(a0t\\d+) a0_${name}\\(`, 'm').exec(emitted.text)?.[1];
      assert.ok(type, name);
      api.push(`#define ${key} ${type}`);
    }
    const unitBytes = /^a0t\d+ a0_utf8_unit\((a0t\d+) p0,/m.exec(emitted.text)?.[1];
    assert.ok(unitBytes);
    api.push(`#define UNIT_BYTES ${unitBytes}`);
    await writeFile(join(dir, 'api.h'), `${api.join('\n')}\n`);
    const exes: string[] = [];
    for (const level of [0, 2]) {
      const exe = join(dir, `arena-utf8-O${level}`);
      // driver.c includes arena_runtime.c for full old-allocation snapshots; compile it once.
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
          '-o',
          exe,
        ],
        { cwd: dir, timeoutMs: 180000 },
      );
      assert.ok(built.ok, built.stderr);
      exes.push(exe);
    }
    // MJS fixtures stay at repository paths; tsc does not copy them into dist.
    const { makeCases } = (await import(
      pathToFileURL(join(fixtures, 'cases.mjs')).href
    )) as typeof import('./fixtures/arena-utf8/cases.mjs');
    const cases = makeCases();
    assert.equal(cases.length, 645);
    return { dir, exes, cases };
  })();
  return prepared;
}

async function check(first: number, end: number): Promise<void> {
  const { dir, exes, cases } = await prepare();
  const { runCase } = (await import(
    pathToFileURL(join(fixtures, 'transport.mjs')).href
  )) as typeof import('./fixtures/arena-utf8/transport.mjs');
  const outputs = new Map<number, string>();
  for (const exe of exes) {
    for (let index = first; index < end; index++) {
      const item = cases[index];
      assert.ok(item);
      const result = await runCase(exe, dir, item, index);
      const previous = outputs.get(index);
      if (previous === undefined) outputs.set(index, result.outputSHA256);
      else assert.equal(result.outputSHA256, previous, `${item.label}: O0/O2 output differs`);
    }
  }
}

test('native A0 UTF8 matches independent bytes and whole-span UTF16 across pages and random inputs', {
  skip,
  timeout: 300000,
}, async () => {
  await check(0, 607);
});
test('native A0 UTF8 retains full-word lengths, scalar encodings, handles and relation counts', {
  skip,
  timeout: 300000,
}, async () => {
  await check(607, 613);
});
test('native A0 UTF8 preserves prefix/empty semantics, atomic failures and resource/session lifecycles', {
  skip,
  timeout: 300000,
}, async () => {
  await check(613, 645);
});
