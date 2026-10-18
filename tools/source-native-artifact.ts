/** Freshness guard for the executable candidate fixture; no frontend fallback. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { compile } from '../src/backends.js';
import { formatProgram } from '../src/core.js';
import { link } from '../src/link.js';
import { defaultRepo } from './dev/repo.js';

interface Build {
  entry: string;
  frontendABI: number;
  wasmSHA256: string;
  wasmBytes: number;
  sourceSHA256: string;
  cSHA256: string;
  requiredWasmFeatures: string[];
  optimization: string;
  symbols: string;
  symbolFlags: string[];
  libcSHA256: string;
  builtinsSHA256: string;
  modules: { path: string; sha256: string }[];
  nativeInputs: { path: string; sha256: string }[];
}

const root = defaultRepo();
const sha = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** Bind every native transport input, including the arena implementation, to the build record. */
export async function verifyNativeInputs(
  checkout: string,
  inputs: readonly { readonly path: string; readonly sha256: string }[],
): Promise<void> {
  assert.deepEqual(
    inputs.map((input) => input.path).sort(),
    [
      'tools/native/source_frontend.c',
      'tools/native/arena_runtime.c',
      'tools/native/arena_runtime.h',
      'tools/source-native-build.ts',
    ].sort(),
    'native input inventory differs',
  );
  for (const input of inputs)
    assert.equal(
      sha(await readFile(join(checkout, input.path))),
      input.sha256,
      `stale frontend fixture: ${input.path}; regenerate seed/source-frontend`,
    );
}

let artifact: Promise<WebAssembly.Module> | undefined;
export function nativeSourceArtifact(): Promise<WebAssembly.Module> {
  artifact ??= (async () => {
    const directory = join(root, 'seed/source-frontend');
    const build = JSON.parse(await readFile(join(directory, 'build.json'), 'utf8')) as Build;
    const bytes = await readFile(join(directory, 'frontend.wasm'));
    assert.equal(sha(bytes), build.wasmSHA256, 'candidate frontend artifact hash mismatch');
    assert.equal(bytes.length, build.wasmBytes);
    assert.equal(build.frontendABI, 3);
    assert.equal(build.entry, 'compiler/source_frontend.a0');
    assert.deepEqual(build.requiredWasmFeatures, [], 'the bundled default remains MVP');
    assert.equal(
      build.optimization,
      'O3',
      'the smaller research builds have recorded timing losses',
    );
    assert.equal(build.symbols, 'strip');
    assert.deepEqual(build.symbolFlags, ['--strip-all']);
    assert.match(build.libcSHA256, /^[0-9a-f]{64}$/);
    assert.match(build.builtinsSHA256, /^[0-9a-f]{64}$/);
    await verifyNativeInputs(root, build.nativeInputs);
    for (const input of build.modules)
      assert.equal(
        sha(await readFile(join(root, input.path))),
        input.sha256,
        `stale frontend fixture: ${input.path}; regenerate seed/source-frontend`,
      );
    const linked = await link(join(root, build.entry), (path) => readFile(path, 'utf8'));
    assert.deepEqual(
      build.modules.map((input) => resolve(root, input.path)).sort(),
      linked.sources.map((source) => resolve(source.path)).sort(),
    );
    assert.equal(sha(formatProgram(linked.program)), build.sourceSHA256, 'stale frontend IR');
    assert.equal(
      sha(compile(linked.program, 'c', { cIo: 'host' }).text),
      build.cSHA256,
      'stale frontend C',
    );
    const module = new WebAssembly.Module(bytes);
    assert.deepEqual(WebAssembly.Module.imports(module), []);
    for (const name of ['name', '.debug_info', '.debug_line'])
      assert.deepEqual(
        WebAssembly.Module.customSections(module, name),
        [],
        'release fixture contains debug metadata',
      );
    return module;
  })();
  return artifact;
}
