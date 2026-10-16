import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { type A0Error, formatProgram } from '../src/core.js';
import { link } from '../src/link.js';
import { findClang, runTool } from '../src/toolchain.js';
import { emitChunked, runStageChunk } from '../tools/bootstrap.js';
import { runJSConformance } from './fixtures/arena-js/conformance.js';
import { checkOwnership } from './fixtures/arena-js/ownership.js';
import { checkStrictSupplement } from './fixtures/arena-js/strict-supplement.js';
import { compileSource } from './fixtures/arena-js/transport.js';
import { cases } from './fixtures/arena-js/verifier-cases.js';
import { buildVerifiedNativeSeed } from './helpers/native-source-compiler.js';

const clang = findClang();
const skip = clang.path === undefined ? 'clang is unavailable' : false;
const fixtures = resolve('test/fixtures/arena-js');
const runtime = resolve('tools/native');
let scratch: string | undefined;
let prepared: Promise<{ exe: string; dir: string }> | undefined;
after(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
});

function prepare(): Promise<{ exe: string; dir: string }> {
  prepared ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'a0-arena-js-'));
    scratch = dir;
    const seed = await buildVerifiedNativeSeed(dir, clang);
    assert.ok(seed.clang.path);
    const linked = await link(join(fixtures, 'probe.a0'), (path) => readFile(path, 'utf8'));
    const emitted = emitChunked(formatProgram(linked.program), (chunk, bounds) =>
      runStageChunk(seed.exe, chunk, bounds),
    );
    assert.equal(emitted.code, 0, `A0 seed rejected ${emitted.failed?.own.join(',')}`);
    await writeFile(join(dir, 'module.c'), emitted.text);
    const api: string[] = [];
    for (const [key, name] of Object.entries({
      JS_STATE: 'arena_js_begin',
      JS_RESULT: 'arena_js_result',
      EW_RESULT: 'ew_emit',
    })) {
      const type = new RegExp(`^(a0t\\d+) a0_${name}\\(`, 'm').exec(emitted.text)?.[1];
      assert.ok(type, name);
      api.push(`#define ${key} ${type}`);
    }
    await writeFile(join(dir, 'api.h'), `${api.join('\n')}\n`);
    const exe = join(dir, 'arena-js');
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
      { cwd: dir, timeoutMs: 180000 },
    );
    assert.ok(built.ok, built.stderr);
    return { exe, dir };
  })();
  return prepared;
}

test('native A0 original-source JavaScript preserves checked, alias, IO, strict and public ABI semantics', {
  skip,
  timeout: 240000,
}, async () => {
  const { exe, dir } = await prepare();
  const emit = (source: string) => compileSource(exe, source);
  const common = await runJSConformance(emit, {
    strict: 'supported',
    cacheDir: join(dir, 'imports'),
  });
  assert.equal(common.comparisons, 9327);
  assert.equal(common.publicCalls, 41);
  assert.equal(common.refusedSources, 0);
  const strict = await checkStrictSupplement(emit, join(dir, 'strict-imports'));
  assert.equal(strict.comparisons, 18);
});

test('native A0 JavaScript source service retains ordered specs, refusals, continuations and resources', {
  skip,
  timeout: 240000,
}, async () => {
  const { exe } = await prepare();
  for (const item of cases) {
    const got = compileSource(exe, item.source, { quantum: 7 });
    assert.equal(got.code, item.status, item.name);
    assert.equal(got.m[1], item.id ?? 0, item.name);
    if (item.status) assert.equal(got.text, '');
  }
  for (const item of [
    { source: 'use "child.a0"\nfn entry -> u32\nret 9\nend\n', code: 7, stage: 4 },
    { source: 'use "child.a0"\nfn entry u32 -> u32\nx add p0\nret x\nend\n', code: 6, stage: 1 },
    { source: 'use "child.a0"\nfn entry -> u32\nex ( -> 9\nret 9\nend\n', code: 6, stage: 1 },
  ]) {
    const got = compileSource(exe, item.source, { quantum: 1 });
    assert.equal(got.code, item.code);
    assert.equal(got.e[5], item.stage);
    assert.equal(got.text, '');
  }
  const source = 'fn f u32 -> u32\nex 9 -> 9\nret p0\nend\n';
  for (const maxWords of [5000, 20000]) {
    const got = compileSource(exe, source, { maxWords });
    assert.equal(got.code, maxWords === 5000 ? 4 : 0);
    assert.equal(got.text.length === 0, got.code !== 0);
  }
  for (const quantum of [0, 1]) {
    const got = compileSource(exe, source, { quantum, observation: 1 });
    assert.equal(got.code, 7);
    assert.equal(got.e[0], 0);
    assert.notEqual(got.e[1], 3);
    assert.equal(got.text, '');
  }
  const limited = compileSource(exe, 'fn f -> u32\nret 7\nend\n', { maxOutput: 1000 });
  assert.equal(limited.code, 4);
  assert.equal(limited.text, '');
});

type Module = Record<string, (...args: unknown[]) => unknown>;
function call(module: Module, name: string, ...args: unknown[]): unknown {
  const fn = module[name];
  assert.ok(fn, name);
  return fn(...args);
}

test('native A0 JavaScript retains full-word metadata, flat literals and source capacity', {
  skip,
  timeout: 240000,
}, async () => {
  const { exe, dir } = await prepare();
  let index = 0;
  async function load(source: string): Promise<Module> {
    const got = compileSource(exe, source);
    assert.equal(got.code, 0);
    const file = join(dir, `capacity-${index++}.mjs`);
    await writeFile(file, got.text);
    return (await import(pathToFileURL(file).href)) as Module;
  }
  const names = [
    'default',
    'class',
    'await',
    'eval',
    'a0_make_io',
    'a0t0',
    'a0i_probe',
    'a0p_default',
    'a0_enter',
    'a0_proto',
  ];
  const source = names
    .map((name, i) => `fn ${name} u32 -> u32\na add p0 ${i + 1}\nret a\nend\n`)
    .join('');
  for (const strict of [false, true]) {
    const module = await load(`${strict ? 'profile strict\n' : ''}${source}`);
    for (const [i, name] of names.entries())
      for (const x of [0, 1, 0x80000000, 0xffffffff])
        assert.equal(call(module, name, x), Number(BigInt.asUintN(32, BigInt(x) + BigInt(i + 1))));
    assert.throws(() => call(module, 'default', -1), RangeError);
  }
  for (const element of ['u32', 'bool']) {
    const literal = element === 'u32' ? '1' : 'true';
    const module = await load(
      `fn large -> ${element}x65536\na arr ${Array(65536).fill(literal).join(' ')}\nret a\nend\n`,
    );
    const values = call(module, 'large');
    assert.ok(values instanceof (element === 'u32' ? Uint32Array : Uint8Array));
    assert.equal(values.length, 65536);
    assert.ok(values.every((value) => value === 1));
  }
  const many = await load(
    Array.from(
      { length: 9000 },
      (_, i) => `fn f${i} u32x${i + 1} -> u32x${i + 1}\nret p0\nend\n`,
    ).join(''),
  );
  const input = new Uint32Array(9000);
  input[8999] = 0xffffffff;
  assert.deepEqual(Array.from(call(many, 'f8999', input) as Uint32Array), Array.from(input));
  let pads = 'profile strict\n';
  for (let fn = 0; fn < 17; fn++) {
    pads += `fn pad${fn} u32 u32 -> u32\n`;
    for (let i = 0; i < 4000; i++) pads += `f${fn}_n${i} mov p0\n`;
    pads +=
      fn === 16
        ? 'original_failure div p0 0\nret original_failure\nend\n'
        : `ret f${fn}_n3999\nend\n`;
  }
  pads +=
    'fn entry u32 -> u32\niteration_after_globalid_boundary fold pad16 1 p0\nret iteration_after_globalid_boundary\nend\n';
  const large = await load(pads);
  assert.throws(
    () => call(large, 'entry', 7),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      const actual = error as A0Error;
      assert.equal(actual.id, 'A0711');
      assert.deepEqual(actual.trap, {
        kind: 'divzero',
        fn: 'pad16',
        at: 'entry.iteration_after_globalid_boundary',
        trip: 0,
        chain: ['entry', 'pad16'],
      });
      return true;
    },
  );
  const prefix = 'fn exact -> u32\nret 9\nend\n#';
  const exact = await load(prefix + 'x'.repeat(2097152 - Buffer.byteLength(prefix)));
  assert.equal(call(exact, 'exact'), 9);
});

test('native A0 JavaScript retains allocation plans and independent escaping-borrow aliases', {
  skip,
  timeout: 240000,
}, async () => {
  const { exe, dir } = await prepare();
  const result = await checkOwnership(
    (source) => compileSource(exe, source, { quantum: 1 }),
    join(dir, 'ownership'),
  );
  assert.deepEqual(result, { lifecycle: 18, aliases: 14, comparisons: 80 });
});
