/** Detached generated-JS components; provenance re-emission belongs to the strict parent loader. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type JsSourceFunction, jsSource } from '../src/source-js.js';
import type { NativeFormatOptions } from '../src/source-native-format.js';
import type { NativeDiagnosticOptions } from '../src/source-native-render.js';
import { sourceCostInputs } from './source-cost-control.js';
import { JS_ARENA_INPUTS, jsCompilerOutputPaths, jsSourceInputPaths } from './source-js-inputs.js';
import { wasmStackBound } from './wasm-stack-bound.js';

export interface JsSourceBuild {
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
  compilerOutputs: { path: string; sha256: string }[];
}

export async function readJsSourceArtifact(directory: string) {
  const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const buildText = await readFile(join(directory, 'build.json'), 'utf8');
  const build = JSON.parse(buildText) as JsSourceBuild;
  for (const [name, inventory] of [
    ['source', build.inputs],
    ['compiler output', build.compilerOutputs],
  ] as const)
    for (const input of sourceCostInputs(inventory, name))
      assert.equal(
        hash(await readFile(input.path)),
        input.sha256,
        `stale JS ${name}: ${input.path}`,
      );
  assert.deepEqual(
    build.inputs.map((input) => input.path).sort(),
    jsSourceInputPaths(build.modules.map((input) => input.path)),
    'JS input inventory differs',
  );
  assert.deepEqual(
    build.compilerOutputs.map((input) => input.path).sort(),
    jsCompilerOutputPaths(),
    'JS compiler output inventory differs',
  );
  assert.equal(build.schema, 1);
  assert.equal(build.backend, 'generated-js');
  assert.equal(build.entry, 'compiler/source_frontend.a0');
  assert.equal(build.frontendABI, 3);
  assert.equal(build.frontendCallABI, 'js-typed-values-v1');
  assert.deepEqual(build.frontendOptions, { jsIo: 'host', optimize: true });
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
  return { build, buildText, frontend, arenaBytes };
}

/** Compile the exact detached components of a previously inspected artifact. */
export async function compileJsSourceArtifact(
  snapshot: Awaited<ReturnType<typeof readJsSourceArtifact>>,
) {
  const { build, frontend, arenaBytes } = snapshot;
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
