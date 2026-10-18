/** Load compiled backends of the shared A0 frontend without reparsing source. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import { type DirectSourceArtifact, directSource } from '../src/source-direct.js';
import { nativeSource } from '../src/source-native.js';

const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Module compilation is preparation; instantiate() is deliberately separate for phase trials. */
export async function prepareSourceFrontend(directory: string) {
  const path = resolve(directory);
  const build = JSON.parse(await readFile(join(path, 'build.json'), 'utf8'));
  const frontend = await readFile(join(path, 'frontend.wasm'));
  if (build.backend === 'direct-wasm') {
    assert.equal(hash(frontend), build.frontendSHA256, 'direct frontend artifact differs');
    assert.equal(frontend.length, build.frontendBytes);
    const arena = await readFile(join(path, 'arena.wasm'));
    assert.equal(hash(arena), build.arenaSHA256, 'generic arena artifact differs');
    assert.equal(arena.length, build.arenaBytes);
    assert.equal(frontend.length + arena.length, build.totalWasmBytes);
    const inputs = build.inputs as { path: string; sha256: string }[];
    assert.ok(Array.isArray(inputs) && inputs.length > 0, 'direct input inventory missing');
    const seen = new Set<string>();
    for (const input of inputs) {
      assert.ok(
        !isAbsolute(input.path) &&
          normalize(input.path) === input.path &&
          !input.path.split('/').includes('..') &&
          !seen.has(input.path),
        'invalid direct input path',
      );
      seen.add(input.path);
      assert.equal(
        hash(await readFile(input.path)),
        input.sha256,
        `stale direct input ${input.path}`,
      );
    }
    const artifact: DirectSourceArtifact = {
      frontend: new WebAssembly.Module(frontend),
      arena: new WebAssembly.Module(arena),
      functions: build.functions,
    };
    return {
      build,
      artifactSha256: hash(Buffer.concat([frontend, arena])),
      bytes: frontend.length + arena.length,
      instantiate: () => directSource(artifact),
    };
  }
  assert.equal(build.backend, undefined, 'unsupported frontend backend');
  assert.equal(hash(frontend), build.wasmSHA256, 'native artifact differs');
  assert.equal(frontend.length, build.wasmBytes);
  const module = new WebAssembly.Module(frontend);
  return {
    build,
    artifactSha256: build.wasmSHA256 as string,
    bytes: frontend.length,
    instantiate: () => nativeSource(module),
  };
}
