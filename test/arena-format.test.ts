import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { formatProgram } from '../src/core.js';
import { link } from '../src/link.js';
import { findClang, runTool } from '../src/toolchain.js';
import { emitChunked, runStageChunk } from '../tools/bootstrap.js';
import { assertCase } from './fixtures/arena-format/assertions.js';
import {
  formattingCases,
  pressureCases,
  resourceCases,
  revisionCases,
  type SourceCase,
  selfCase,
} from './fixtures/arena-format/cases.js';
import { runNative } from './fixtures/arena-format/transport.js';
import { buildVerifiedNativeSeed } from './helpers/native-source-compiler.js';

const clang = findClang();
const skip = clang.path === undefined ? 'clang is unavailable' : false;
const fixtures = resolve('test/fixtures/arena-format'),
  runtime = resolve('tools/native');
const roots = [
  'arena_revision',
  'arena_format',
  'arena_format_described',
  'arena_parse',
  'as_resume',
  'arena_parse_verify_begin',
  'arena_verify_resume',
  'arena_verify_status',
  'arena_hello',
  'arena_finish',
  'arena_emit',
];
let scratch: string | undefined;
let prepared: Promise<{ exes: readonly string[]; source: string }> | undefined;
after(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
});

/** One current verified seed and one fixed A0 closure, entirely in the test's own directory. */
function prepare(): Promise<{ exes: readonly string[]; source: string }> {
  prepared ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'a0-arena-format-'));
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
    // The host links/plans compiler implementation only. The seed parses/checks/emits every chunk.
    const emitted = emitChunked(source, (chunk, bounds) => runStageChunk(seed.exe, chunk, bounds));
    assert.equal(emitted.code, 0, `A0 seed rejected ${emitted.failed?.own.join(',')}`);
    await writeFile(join(dir, 'module.c'), emitted.text);
    const api: string[] = [];
    for (const [key, name] of Object.entries({
      PARSED: 'arena_parse',
      AS_RESULT: 'as_resume',
      VERIFIED: 'arena_verify_begin',
      FORMATTED: 'arena_format_described',
      REVISION: 'arena_revision',
    })) {
      const type = new RegExp(`^(a0t\\d+) a0_${name}\\(`, 'm').exec(emitted.text)?.[1];
      assert.ok(type, name);
      api.push(`#define ${key} ${type}`);
    }
    const input = /^a0t\d+ a0_as_resume\((a0t\d+) p0\)/m.exec(emitted.text)?.[1];
    assert.ok(input);
    api.push(`#define AS_INPUT ${input}`);
    await writeFile(join(dir, 'api.h'), `${api.join('\n')}\n`);
    const exes: string[] = [];
    for (const level of [0, 2]) {
      const exe = join(dir, `arena-format-O${level}`);
      // driver.c includes arena_runtime.c to inspect all original capacities; link it exactly once.
      const built = runTool(
        seed.clang.path,
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
          '-o',
          exe,
        ],
        { cwd: dir, timeoutMs: 180000 },
      );
      assert.ok(built.ok, built.stderr);
      exes.push(exe);
    }
    return { exes, source };
  })();
  return prepared;
}
async function check(rows: readonly SourceCase[]): Promise<void> {
  const { exes } = await prepare();
  for (const exe of exes) for (const row of rows) assertCase(row, runNative(exe, row));
}

test('native A0 flat function/program/source bytes preserve specs, comments, text and Number spelling', {
  skip,
  timeout: 240000,
}, async () => {
  await check(formattingCases());
});
test('native A0 content and semantic revisions match crypto, sorted dependencies, profile and spec boundaries', {
  skip,
  timeout: 240000,
}, async () => {
  await check(revisionCases());
});
test('native A0 formatter preserves immutable inputs and returns atomic mapping/resource refusals', {
  skip,
  timeout: 240000,
}, async () => {
  await check(resourceCases());
});
test('native A0 formatter retains full-word rows/spans and growing type/literal stacks', {
  skip,
  timeout: 240000,
}, async () => {
  await check(pressureCases());
});
test('native A0 formatter prints flat source and preserves internal hashes of its compiler implementation', {
  skip,
  timeout: 240000,
}, async () => {
  const { source } = await prepare();
  await check([selfCase(source)]);
});
