import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { formatProgram } from '../../src/core.js';
import { link } from '../../src/link.js';
import { runTool, type ToolInfo } from '../../src/toolchain.js';
import { emitChunked, runStageChunk } from '../../tools/bootstrap.js';
import { buildVerifiedNativeSeed, type NativeSeed } from './native-source-compiler.js';

/** Initial linking/closure/chunk planning is host tooling. The verified native A0
 * seed performs every parse/check/C-emission decision for the actual service.
 * Per-input source/link/target decisions then execute in that native A0 service.
 * Callers own and clean dir. No retained binary or target-emission fallback. */
export async function buildNativeArenaCompiler(options: {
  readonly module: string;
  readonly roots: readonly string[];
  readonly driver: string;
  readonly apiHeader: (emittedC: string) => string;
  readonly dir: string;
  readonly clang: ToolInfo;
  readonly seed?: NativeSeed;
}): Promise<{ readonly exe: string; readonly source: string; readonly chunks: number }> {
  const seed = options.seed ?? (await buildVerifiedNativeSeed(options.dir, options.clang));
  assert.ok(seed.clang.path);
  const linked = await link(options.module, (path) => readFile(path, 'utf8'));
  const needed = new Set<string>();
  const visit = (name: string): void => {
    if (needed.has(name)) return;
    needed.add(name);
    const fn = linked.program.byName.get(name);
    assert.ok(fn, `missing native service function ${name}`);
    for (const node of fn.nodes) {
      if (node.callee !== undefined) visit(node.callee);
      if (node.pred !== undefined) visit(node.pred);
    }
  };
  for (const name of options.roots) visit(name);
  const source = formatProgram({
    functions: linked.program.functions.filter((fn) => needed.has(fn.name)),
  });
  const emitted = emitChunked(source, (chunk, bounds) => runStageChunk(seed.exe, chunk, bounds));
  assert.equal(emitted.code, 0, `A0 seed rejected ${emitted.failed?.own.join(',')}`);
  await writeFile(join(options.dir, 'compiler-source.a0'), source);
  await writeFile(join(options.dir, 'module.c'), emitted.text);
  await writeFile(join(options.dir, 'api.h'), options.apiHeader(emitted.text));
  const exe = join(options.dir, 'native-arena-compiler');
  const runtime = resolve('tools/native');
  const built = runTool(
    seed.clang.path,
    [
      '-std=c11',
      '-O2',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-Wno-unused-parameter',
      '-fsanitize=undefined',
      '-fno-sanitize-recover=all',
      '-pthread',
      '-I',
      options.dir,
      '-I',
      runtime,
      resolve(options.driver),
      join(runtime, 'arena_runtime.c'),
      join(runtime, 'fs_runtime.c'),
      '-o',
      exe,
    ],
    { cwd: options.dir, timeoutMs: 180_000 },
  );
  assert.ok(built.ok, built.stderr);
  return { exe, source, chunks: emitted.chunks };
}
