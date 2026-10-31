/** Load compiled backends of the shared A0 frontend without reparsing source. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import { type DirectSourceArtifact, directSource } from '../src/source-direct.js';
import { nativeSource } from '../src/source-native.js';
import type { NativeFormatOptions } from '../src/source-native-format.js';
import type { NativeDiagnosticOptions } from '../src/source-native-render.js';
import { DIAGNOSTIC_OPTIONS, diagnosticInputs } from './source-diagnostic-inputs.js';
import { FORMAT_OPTIONS, FORMAT_ROOTS, formatInputs } from './source-format-inputs.js';

const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Module compilation is preparation; instantiate() is deliberately separate for phase trials. */
export async function prepareSourceFrontend(
  directory: string,
  diagnostics?: NativeDiagnosticOptions,
  formatting?: NativeFormatOptions,
) {
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
      instantiate: () => directSource(artifact, diagnostics, formatting),
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
    instantiate: () => nativeSource(module, diagnostics, formatting),
  };
}

/** Read and verify the optional renderer now; compile and instantiate only on failure. */
export async function prepareSourceDiagnostic(directory: string) {
  const path = resolve(directory);
  const build = JSON.parse(await readFile(join(path, 'build.json'), 'utf8'));
  const bytes = await readFile(join(path, 'diagnostic.wasm'));
  assert.equal(build.schema, 1);
  assert.equal(build.capability, 'arena-v1');
  assert.equal(
    build.entry,
    build.verificationWords === undefined
      ? 'compiler/diagnostics_arena.a0'
      : 'compiler/diagnostic_specs_arena.a0',
  );
  assert.equal(build.root, 'arena_diagnostic_options');
  assert.equal(build.resultWords, 133);
  assert.equal(build.parsedWords, 128);
  if (build.verificationWords !== undefined) {
    assert.equal(build.verificationWords, 768);
    assert.deepEqual(build.roots, {
      arena_diagnostic_options: { params: [1, 128, 1], resultWords: 133 },
      arena_verified_diagnostic_options: {
        params: [1, 128, 128, 128, 128, 128, 128, 1],
        resultWords: 133,
      },
    });
  }
  if (build.verificationWords !== undefined) {
    assert.deepEqual(build.options, DIAGNOSTIC_OPTIONS, 'diagnostic compiler options differ');
    const current = await diagnosticInputs(build.entry);
    assert.deepEqual(build.inputs, current.inputs, 'diagnostic input closure differs');
    assert.equal(build.sourceSHA256, current.sourceSHA256, 'diagnostic source IR differs');
    assert.deepEqual(build.requiredWasmFeatures, ['bulk-memory', 'simd']);
  }
  assert.equal(hash(bytes), build.wasmSHA256, 'diagnostic renderer artifact differs');
  assert.equal(bytes.length, build.wasmBytes);
  assert.ok(
    Array.isArray(build.inputs) && build.inputs.length > 0,
    'renderer input inventory missing',
  );
  const seen = new Set<string>();
  for (const input of build.inputs as { path: string; sha256: string }[]) {
    assert.ok(
      !isAbsolute(input.path) &&
        normalize(input.path) === input.path &&
        !input.path.split('/').includes('..') &&
        !seen.has(input.path),
      'invalid renderer input path',
    );
    seen.add(input.path);
    assert.equal(
      hash(await readFile(input.path)),
      input.sha256,
      `stale renderer input ${input.path}`,
    );
  }
  let module: WebAssembly.Module | undefined;
  return {
    build,
    bytes: bytes.length,
    ...(build.verificationWords === undefined ? {} : { verification: true as const }),
    load: () => (module ??= new WebAssembly.Module(bytes)),
  };
}

/** Verify companion provenance now; compile and instantiate only on the first requested use. */
export async function prepareSourceFormat(directory: string) {
  const path = resolve(directory);
  const build = JSON.parse(await readFile(join(path, 'build.json'), 'utf8'));
  const bytes = await readFile(join(path, 'format.wasm'));
  assert.equal(build.schema, 1);
  assert.ok(['arena-format-v1', 'arena-format-v2'].includes(build.capability));
  if (build.capability === 'arena-format-v2') {
    assert.equal(build.authoringSchema, 1);
    assert.equal(build.authoringWords, 128);
    assert.equal(build.roots?.arena_format_authoring?.resultWords, 133);
    assert.equal(build.roots?.arena_revision_authoring?.resultWords, 5);
    const current = await formatInputs();
    assert.deepEqual(build.inputs, current.inputs, 'formatter input closure differs');
    assert.equal(build.sourceSHA256, current.sourceSHA256, 'formatter source IR differs');
    assert.deepEqual(build.roots, FORMAT_ROOTS, 'formatter function ABI differs');
    assert.deepEqual(build.options, FORMAT_OPTIONS, 'formatter compiler options differ');
    assert.deepEqual(build.requiredWasmFeatures, ['bulk-memory', 'simd']);
  }
  assert.equal(build.entry, 'compiler/revision_arena.a0');
  assert.equal(build.parsedWords, 128);
  assert.equal(build.specWords, 128);
  assert.equal(build.eventWords, 6);
  assert.equal(build.roots?.arena_format_described?.resultWords, 133);
  assert.equal(build.roots?.arena_revision?.resultWords, 5);
  assert.equal(hash(bytes), build.wasmSHA256, 'formatter artifact differs');
  assert.equal(bytes.length, build.wasmBytes);
  assert.ok(Array.isArray(build.inputs) && build.inputs.length > 0, 'formatter inventory missing');
  const seen = new Set<string>();
  for (const input of build.inputs as { path: string; sha256: string }[]) {
    assert.ok(
      !isAbsolute(input.path) &&
        normalize(input.path) === input.path &&
        !input.path.split('/').includes('..') &&
        !seen.has(input.path),
      'invalid formatter input path',
    );
    seen.add(input.path);
    assert.equal(
      hash(await readFile(input.path)),
      input.sha256,
      `stale formatter input ${input.path}`,
    );
  }
  let module: WebAssembly.Module | undefined;
  return { build, bytes: bytes.length, load: () => (module ??= new WebAssembly.Module(bytes)) };
}
