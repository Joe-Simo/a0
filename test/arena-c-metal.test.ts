import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { formatProgram } from '../src/core.js';
import { link } from '../src/link.js';
import { findClang, runTool } from '../src/toolchain.js';
import { emitChunked, runStageChunk } from '../tools/bootstrap.js';
import { buildVerifiedNativeSeed } from './helpers/native-source-compiler.js';

// TS links and serializes checked IR for this component test. The fresh verified
// A0 seed compiles the actual A0 emitter; the C driver only transports arena words.
// Metal tests execute a C++14 CPU shim, not a Metal compiler or GPU.
const clang = findClang();
const options = {
  skip: clang.path === undefined ? 'clang is unavailable' : false,
  timeout: 600_000,
};
const fixtures = resolve('test/fixtures/arena-c-metal');
let scratch: string | undefined;
let prepared: Promise<string> | undefined;
after(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
});

function prepare(): Promise<string> {
  prepared ??= (async () => {
    assert.ok(clang.path);
    const dir = await mkdtemp(join(tmpdir(), 'a0-c-metal-'));
    scratch = dir;
    const build = join(dir, 'build');
    await mkdir(build);
    const seed = await buildVerifiedNativeSeed(dir, clang);
    const linked = await link(resolve('compiler/emit_metal.a0'), (path) => readFile(path, 'utf8'));
    const roots = [
      'c_emit',
      'c_emit_shaped',
      'metal_emit',
      'metal_emit_shaped',
      'ew_emit',
      'arena_hello',
      'arena_finish',
    ];
    const needed = new Set<string>();
    const visit = (name: string): void => {
      if (needed.has(name)) return;
      needed.add(name);
      const fn = linked.program.byName.get(name);
      assert.ok(fn, `missing C/Metal service function ${name}`);
      for (const node of fn.nodes) {
        if (node.callee !== undefined) visit(node.callee);
        if (node.pred !== undefined) visit(node.pred);
      }
    };
    for (const name of roots) visit(name);
    const source = formatProgram({
      functions: linked.program.functions.filter((fn) => needed.has(fn.name)),
    });
    const emitted = emitChunked(source, (chunk, bounds) => runStageChunk(seed.exe, chunk, bounds));
    assert.equal(emitted.code, 0, `native A0 emission of ${emitted.failed?.own.join(',')}`);
    await writeFile(join(build, 'compiler-source.a0'), source);
    await writeFile(join(build, 'module.c'), emitted.text);
    const type = (name: string): string => {
      const found = new RegExp(`^(a0t\\d+) a0_${name}\\(`, 'm').exec(emitted.text)?.[1];
      assert.ok(found, name);
      return found;
    };
    const context = /a0_c_emit\(a0_io \* p0, (a0t\d+) p1,/.exec(emitted.text)?.[1];
    assert.ok(context);
    await writeFile(
      join(build, 'api.h'),
      `${[
        ...roots.map((name) => `#define ${name.toUpperCase()}_RESULT ${type(name)}`),
        `#define CTX_TYPE ${context}`,
      ].join('\n')}\n`,
    );
    const runtime = resolve('tools/native');
    for (const level of [0, 2]) {
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
          build,
          '-I',
          runtime,
          join(fixtures, 'driver.c'),
          join(runtime, 'arena_runtime.c'),
          '-o',
          join(build, `driver-O${level}`),
        ],
        { cwd: build, timeoutMs: 180_000 },
      );
      assert.ok(built.ok, `C/Metal driver O${level}: ${built.stderr}`);
    }
    return dir;
  })();
  return prepared;
}

interface Evidence {
  results: { cases?: number }[];
}
async function fixture(script: string, evidence: string): Promise<Evidence> {
  const dir = await prepare();
  assert.ok(clang.path);
  const ran = runTool(process.execPath, [join(fixtures, script), dir, clang.path], {
    timeoutMs: 360_000,
  });
  assert.ok(ran.ok, `${script}: ${ran.stderr}\n${ran.stdout}`);
  return JSON.parse(await readFile(join(dir, evidence), 'utf8')) as Evidence;
}

test(
  'native A0 C emission matches the independent BigInt/control-flow oracle',
  options,
  async () => {
    const evidence = await fixture('semantics-c.mjs', 'native-check.json');
    assert.equal(evidence.results.length, 86);
    assert.equal(
      evidence.results.reduce((n, r) => n + (r.cases ?? 0), 0),
      14_746,
    );
  },
);

test('native A0 Metal wrapper ABI and CPU-shim semantics', options, async () => {
  const evidence = await fixture('semantics-metal.mjs', 'metal-native-check.json');
  assert.equal(evidence.results.length, 86);
  assert.equal(
    evidence.results.reduce((n, r) => n + (r.cases ?? 0), 0),
    12_482,
  );
});

test(
  'native A0 C/Metal refusal, resource, ownership and full-word boundaries',
  options,
  async () => {
    const evidence = await fixture('controls.mjs', 'native-controls.json');
    assert.equal(evidence.results.length, 72);
  },
);
