import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { assembleArm64Text } from '../src/arm64enc.js';
import { compile } from '../src/backends.js';
import { parseAndValidate } from '../src/core.js';
import { link } from '../src/link.js';
import { findClang, runTool, withTempDir } from '../src/toolchain.js';
import { closure } from '../tools/corpus.js';
import { checkArm64Assembly } from '../tools/verify.js';
import { CHECKED_SOURCE, checkedCases } from './fixtures/checked-ops-fixtures.js';

type Io = { input: number[]; position: number; output: number[] };
let cached: Promise<(source: string) => { code: number; text: string; words: number }> | undefined;
function emitter(): Promise<(source: string) => { code: number; text: string; words: number }> {
  cached ??= (async () => {
    const linked = (await link('compiler/boot.a0', (p) => readFile(p, 'utf8'))).program;
    const text = compile(parseAndValidate(closure(linked.functions, 'emitachunkio')), 'js').text;
    const mod = (await import(
      `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`
    )) as {
      emitachunkio: (io: Io) => number;
    };
    return (source) => {
      const bytes = Buffer.from(source);
      const io: Io = { input: [bytes.length, ...bytes, 1, 0, 0], position: 0, output: [] };
      const code = mod.emitachunkio(io);
      if (code !== 0) return { code, text: '', words: io.output.length };
      const n = io.output[io.output.length - 1] as number;
      return {
        code,
        text: Buffer.from(io.output.slice(0, io.output.length - n - 1)).toString('latin1'),
        words: io.output.length,
      };
    };
  })();
  return cached;
}

test('A0 arm64 whole-language emitter accepts total checked ops and still refuses strict', async () => {
  const emit = await emitter();
  const result = emit(CHECKED_SOURCE);
  assert.equal(result.code, 0);
  // The repository's direct encoder must accept every emitted instruction too.
  assert.ok(assembleArm64Text(result.text).words.length > 0);
  for (const body of [
    'fn f u32 -> u32\nret p0\nend\n',
    'fn f u32 u32 -> (u32,bool)\nr cadd p0 p1\nret r\nend\n',
  ]) {
    const refused = emit(`profile strict\n${body}`);
    assert.deepEqual([refused.code, refused.words], [2, 0]);
  }
  // Type diagnostics precede the emitter's unsupported-profile check.
  assert.equal(
    emit('profile strict\nfn f u32 bool -> (u32,bool)\nr cadd p0 p1\nret r\nend\n').code,
    3,
  );
});

test('A0 checked arm64 output cross-assembles as Darwin arm64 on Linux and macOS', async (t) => {
  const clang = findClang();
  if (clang.path === undefined) return t.skip('clang is unavailable');
  const result = (await emitter())(CHECKED_SOURCE);
  assert.equal(result.code, 0);
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'module.s'), result.text, 'utf8');
    const assembled = runTool(
      clang.path as string,
      ['-target', 'arm64-apple-darwin', '-c', '-x', 'assembler', '-o', 'module.o', 'module.s'],
      { cwd: dir },
    );
    assert.ok(assembled.ok, assembled.stderr);
  });
});

test('A0 checked arm64 tuples, calls, fold state and bounds equal independent integer oracle', {
  skip:
    process.platform !== 'darwin' || process.arch !== 'arm64'
      ? 'needs macOS on Apple silicon'
      : false,
}, async () => {
  const clang = findClang();
  assert.ok(clang.path, 'clang is required');
  const result = (await emitter())(CHECKED_SOURCE);
  assert.equal(result.code, 0);
  const checks = checkedCases();
  const report = await checkArm64Assembly(
    parseAndValidate(CHECKED_SOURCE),
    result.text,
    checks,
    clang,
    'compiler/emit_arm64.a0: total checked operations',
  );
  assert.equal(report.status, 'passed', report.failures?.join('\n') ?? report.detail);
  assert.equal(report.cases, checks.length);
});
