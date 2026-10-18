import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { link } from '../src/link.js';
import { findClang, runTool } from '../src/toolchain.js';
import { buildStage, closure, emitChunked, runStageChunk } from '../tools/bootstrap.js';
import { readBootstrapSeed } from '../tools/seed.js';

const clang = findClang();
const skip = clang.path === undefined ? 'clang is unavailable' : false;
const fixtures = resolve('test/fixtures/arena-program');
const runtime = resolve('tools/native');
let scratch: string | undefined;
let prepared: Promise<string> | undefined;
after(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
});

function prepare(): Promise<string> {
  prepared ??= (async () => {
    assert.ok(clang.path);
    const dir = await mkdtemp(join(tmpdir(), 'a0-arena-program-'));
    scratch = dir;
    const seed = await readBootstrapSeed();
    const [compiler] = await buildStage(clang, 'compiler', seed.c, 'emitchunkio', dir);
    const linked = await link('compiler/check_arena.a0', (path) => readFile(path, 'utf8'));
    const source = closure(linked.program.functions, 'arena_parse_check');
    const emitted = emitChunked(source, (chunk, bounds) => runStageChunk(compiler, chunk, bounds));
    assert.equal(
      emitted.code,
      0,
      `native A0 frontend compilation: ${emitted.failed?.own.join(',')}`,
    );
    const result = /^(a0t\d+) a0_arena_parse_check\(/m.exec(emitted.text)?.[1];
    assert.ok(result);
    await writeFile(join(dir, 'module.c'), emitted.text);
    const builderType = (name: string): string => {
      const match = new RegExp(`^(a0t[0-9]+) a0_${name}\\(`, 'm').exec(emitted.text)?.[1];
      assert.ok(match, `native builder export ${name}`);
      return match;
    };
    await writeFile(
      join(dir, 'api.h'),
      [
        `#define PARSE_RESULT ${result}`,
        `#define STATE ${builderType('ab_begin')}`,
        `#define MIO_RESULT ${builderType('ab_node')}`,
        `#define OPERAND_RESULT ${builderType('ab_operand')}`,
        '',
      ].join('\n'),
    );
    for (const level of [0, 2]) {
      for (const fixture of ['driver', 'builder']) {
        const built = runTool(
          clang.path,
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
            join(fixtures, `${fixture}.c`),
            join(runtime, 'arena_runtime.c'),
            '-o',
            join(dir, `${fixture}-O${level}`),
          ],
          { cwd: dir, timeoutMs: 120_000 },
        );
        assert.ok(built.ok, `native A0 frontend ${fixture} O${level}: ${built.stderr}`);
      }
    }
    return dir;
  })();
  return prepared;
}

function compare(dir: string, capacity: boolean): void {
  const ran = runTool(
    process.execPath,
    [join(fixtures, 'oracle.mjs'), dir, ...(capacity ? ['capacity'] : [])],
    { timeoutMs: 180_000 },
  );
  assert.ok(ran.ok, `${ran.stderr}\n${ran.stdout}`);
}

test('seed-built arena services read the shared source grammar without conversion', {
  skip,
}, async () => {
  const dir = await prepare();
  const ran = runTool(process.execPath, [join(fixtures, 'oracle.mjs'), dir, 'shared-source'], {
    timeoutMs: 180_000,
  });
  assert.ok(ran.ok, `${ran.stderr}\n${ran.stdout}`);
});

test(
  'seed-built A0 frontend preserves original IR, types, diagnostic IDs and metadata',
  {
    skip,
  },
  async () => compare(await prepare(), false),
);

test(
  'seed-built A0 frontend preserves full-width types, operands, symbols and source spans',
  {
    skip,
  },
  async () => compare(await prepare(), true),
);

test('seed-built shared IR constructors preserve full-width rows, immutable prefixes and first failures', {
  skip,
}, async () => {
  const dir = await prepare();
  for (const level of [0, 2]) {
    const ran = runTool(join(dir, `builder-O${level}`), [], { timeoutMs: 30_000 });
    assert.ok(ran.ok, `${ran.stderr}\n${ran.stdout}`);
    assert.match(ran.stdout, /PASS shared IR construction seam/);
  }
});

test('seed-built frontend parses a comment-heavy source within a bounded allocation budget', {
  skip,
}, async () => {
  const dir = await prepare();
  const source = `# ${'x'.repeat(32768)}\nfn answer -> u32\nret 42\nend\n`;
  const input = join(dir, 'comment-budget.a0');
  await writeFile(input, source);
  for (const level of [0, 2]) {
    const output = join(dir, `comment-budget-O${level}.bin`);
    const result = runTool(
      join(dir, `driver-O${level}`),
      [input, output, String(Buffer.byteLength(source) * 2)],
      { timeoutMs: 30_000 },
    );
    assert.ok(result.ok, result.stderr);
    const words = await readFile(output);
    assert.equal(words.readUInt32LE(0), 0, `O${level}: valid program exhausted the arena budget`);
  }
});
