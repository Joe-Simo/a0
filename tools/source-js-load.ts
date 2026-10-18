/** Explicit experimental loader for a fresh process/frozen compiler checkout; no fallback. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type JsSourceFunction, jsSource } from '../src/source-js.js';
import type { NativeFormatOptions } from '../src/source-native-format.js';
import type { NativeDiagnosticOptions } from '../src/source-native-render.js';
import { JS_ARENA_INPUTS } from './source-js-inputs.js';
import { prepareJsCompiler } from './source-js-prepare.js';
import { wasmStackBound } from './wasm-stack-bound.js';

interface Build {
  schema: number;
  backend: string;
  entry: string;
  frontendABI: number;
  frontendCallABI: string;
  frontendOptions: { jsIo: 'host'; optimize: boolean };
  functions: Readonly<Record<string, JsSourceFunction>>;
  functionCount: number;
  sourceSHA256: string;
  modules: { path: string; sha256: string }[];
  frontendSHA256: string;
  frontendBytes: number;
  arenaSHA256: string;
  arenaBytes: number;
  totalArtifactBytes: number;
  totalWasmBytes: number;
  transportStackProof: unknown;
  arenaOrigin: {
    backend: string;
    arenaSHA256: string;
    arenaBytes: number;
    transportStackProof: unknown;
    inputs: { path: string; sha256: string }[];
  };
  inputs: { path: string; sha256: string }[];
}

export async function prepareJsSource(directory: string) {
  const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const build = JSON.parse(await readFile(join(directory, 'build.json'), 'utf8')) as Build;
  assert.equal(build.schema, 1);
  assert.equal(build.backend, 'generated-js');
  assert.equal(build.entry, 'compiler/source_frontend.a0');
  assert.equal(build.frontendABI, 3);
  assert.equal(build.frontendCallABI, 'js-typed-values-v1');
  assert.deepEqual(build.frontendOptions, { jsIo: 'host', optimize: true });
  await prepareJsCompiler('verify', directory);
  const frontend = await readFile(join(directory, 'frontend.mjs'));
  const arenaBytes = await readFile(join(directory, 'arena.wasm'));
  assert.equal(frontend.length, build.frontendBytes);
  assert.equal(hash(frontend), build.frontendSHA256);
  assert.equal(arenaBytes.length, build.arenaBytes);
  assert.equal(hash(arenaBytes), build.arenaSHA256);
  assert.equal(build.totalArtifactBytes, frontend.length + arenaBytes.length);
  assert.equal(build.totalWasmBytes, arenaBytes.length);
  assert.equal(build.arenaOrigin.backend, 'direct-wasm');
  assert.equal(build.arenaOrigin.arenaSHA256, build.arenaSHA256);
  assert.equal(build.arenaOrigin.arenaBytes, build.arenaBytes);
  for (const path of JS_ARENA_INPUTS) {
    const original = build.arenaOrigin.inputs.find((input) => input.path === path);
    assert.ok(original, `missing original arena input: ${path}`);
    assert.equal(
      hash(await readFile(path)),
      original.sha256,
      `different original arena input: ${path}`,
    );
  }
  assert.deepEqual(wasmStackBound(arenaBytes), build.transportStackProof);
  assert.deepEqual(build.transportStackProof, build.arenaOrigin.transportStackProof);
  const arena = new WebAssembly.Module(arenaBytes);
  assert.deepEqual(WebAssembly.Module.imports(arena), []);
  // Import the exact verified bytes. No string rewriting or path/module-cache ambiguity.
  const module = (await import(
    `data:text/javascript;base64,${frontend.toString('base64')}`
  )) as Readonly<Record<string, unknown>>;
  return {
    build,
    instantiate(diagnostics?: NativeDiagnosticOptions, formatting?: NativeFormatOptions) {
      return jsSource(
        { frontend: module, arena, functions: build.functions },
        diagnostics,
        formatting,
      );
    },
  };
}
