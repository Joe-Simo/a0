import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { formatProgram } from '../src/core.js';
import { link } from '../src/link.js';
import { findClang, runTool } from '../src/toolchain.js';
import { buildStage, emitChunked, runStageChunk } from '../tools/bootstrap.js';
import { readBootstrapSeed } from '../tools/seed.js';

const clang = findClang();
const skip =
  process.platform === 'win32'
    ? 'the optional filesystem transport implements POSIX paths and OS calls'
    : clang.path === undefined
      ? 'clang is unavailable'
      : false;
const fixtures = resolve('test/fixtures/arena-linker');
const runtime = resolve('tools/native');
let scratch: string | undefined;
let prepared: Promise<string> | undefined;
after(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
});

function prepare(): Promise<string> {
  prepared ??= (async () => {
    assert.ok(clang.path);
    const dir = await mkdtemp(join(tmpdir(), 'a0-arena-linker-'));
    scratch = dir;
    const seed = await readBootstrapSeed();
    const [compiler] = await buildStage(clang, 'compiler', seed.c, 'emitchunkio', dir);
    // Build the promoted modules, including the current source-order spec grammar hooks.
    // No TS C emission or paged frontend fallback participates in the native candidate.
    const linked = await link('compiler/link_parse_arena.a0', (path) => readFile(path, 'utf8'));
    const emitted = emitChunked(formatProgram(linked.program), (chunk, bounds) =>
      runStageChunk(compiler, chunk, bounds),
    );
    assert.equal(emitted.code, 0, `native A0 linker compilation: ${emitted.failed?.own.join(',')}`);
    const result = (name: string): string => {
      const type = new RegExp(`^(a0t\\d+) a0_${name}\\(`, 'm').exec(emitted.text)?.[1];
      assert.ok(type, name);
      return type;
    };
    const vector = /^a0t\d+ a0_lc_project\(a0_io \*\s*p0, (a0t\d+) p1,/m.exec(emitted.text)?.[1];
    assert.ok(vector);
    await writeFile(join(dir, 'module.c'), emitted.text);
    await writeFile(
      join(dir, 'api.h'),
      `#define LINK_RESULT ${result('arena_link_parse')}\n#define HELLO_RESULT ${result('fs_hello')}\n#define ORIGIN_RESULT ${result('lc_project')}\n#define ORIGIN_VECTOR ${vector}\n`,
    );
    for (const level of [0, 2]) {
      for (const name of ['driver', 'host-test']) {
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
            join(fixtures, `${name}.c`),
            join(runtime, 'fs_runtime.c'),
            join(runtime, 'arena_runtime.c'),
            '-o',
            join(dir, `${name}-O${level}`),
          ],
          { cwd: dir, timeoutMs: 120_000 },
        );
        assert.ok(built.ok, `native A0 linker ${name} O${level}: ${built.stderr}`);
      }
    }
    return dir;
  })();
  return prepared;
}

async function compare(mode: string): Promise<void> {
  const dir = await prepare();
  const ran = runTool(process.execPath, [join(fixtures, 'oracle.mjs'), dir, mode], {
    timeoutMs: 240_000,
  });
  assert.ok(ran.ok, `${ran.stderr}\n${ran.stdout}`);
}

test(
  'native A0 linker preserves POSIX module policy, combined source and original IR spans',
  {
    skip,
  },
  async () => compare('sources'),
);

test(
  'native A0 origin projection preserves full-width spans and failed append metadata',
  {
    skip,
  },
  async () => compare('origins'),
);

test('optional filesystem transport preserves generic errors, framing and completion', {
  skip,
}, async () => {
  const dir = await prepare();
  for (const level of [0, 2]) {
    const ran = runTool(join(dir, `host-test-O${level}`), [dir]);
    assert.ok(ran.ok, `filesystem transport O${level}: ${ran.stderr}`);
  }
});
