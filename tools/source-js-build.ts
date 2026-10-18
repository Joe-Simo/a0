/** Explicit experimental build: unchanged A0 frontend -> JS, existing proved arena -> Wasm. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { committedTree } from './measurement-checkout.js';
import { writeReport } from './scrub-results.js';
import { JS_ARENA_INPUTS } from './source-js-inputs.js';
import { prepareJsCompiler } from './source-js-prepare.js';
import { wasmStackBound } from './wasm-stack-bound.js';

const args = process.argv.slice(2);
for (const arg of args)
  assert.ok(/^--(?:out|arena-artifact)=.+$/.test(arg), `unsupported argument ${arg}`);
const option = (name: string) =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const outArg = option('out'),
  arenaArg = option('arena-artifact');
assert.ok(outArg && arenaArg, '--out=DIR --arena-artifact=DIR required');
const out = resolve(outArg),
  arenaDirectory = resolve(arenaArg);
const identity = committedTree(process.cwd());
const hash = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const origin = JSON.parse(await readFile(join(arenaDirectory, 'build.json'), 'utf8'));
assert.equal(origin.backend, 'direct-wasm', 'reuse an existing proved generic direct-target arena');
const arena = await readFile(join(arenaDirectory, 'arena.wasm'));
assert.equal(hash(arena), origin.arenaSHA256);
assert.equal(arena.length, origin.arenaBytes);
for (const path of JS_ARENA_INPUTS) {
  const input = origin.inputs.find((input: { path: string }) => input.path === path);
  assert.ok(input, `missing arena provenance: ${path}`);
  assert.equal(hash(await readFile(path)), input.sha256, `different arena input: ${path}`);
}
const transportStackProof = wasmStackBound(arena);
assert.deepEqual(transportStackProof, origin.transportStackProof);
assert.deepEqual(WebAssembly.Module.imports(new WebAssembly.Module(arena)), []);
await prepareJsCompiler('emit', out);
const emission = JSON.parse(await readFile(join(out, 'emission.json'), 'utf8'));
const frontend = await readFile(join(out, 'frontend.mjs'));
await mkdir(out, { recursive: true });
await writeFile(join(out, 'arena.wasm'), arena);
assert.deepEqual(committedTree(process.cwd()), identity, 'source changed during build');
await writeReport(join(out, 'build.json'), {
  ...emission,
  schema: 1,
  backend: 'generated-js',
  candidate: identity,
  scope:
    'Experimental target of the unchanged A0 parser/checker. No public routing or performance claim.',
  frontendABI: 3,
  frontendCallABI: 'js-typed-values-v1',
  javascript: {
    module: 'ESM',
    scalarArrays: 'Uint32Array/Uint8Array',
    records: 'Array',
    io: 'branded callback token',
    exportPolicy: 'all declared functions',
  },
  arenaSHA256: hash(arena),
  arenaBytes: arena.length,
  totalArtifactBytes: Buffer.byteLength(frontend) + arena.length,
  totalWasmBytes: arena.length,
  frontendRuntime: 'JavaScript ESM; only the reused arena executes as Wasm',
  arenaOrigin: origin,
  transportStackProof,
  memoryAccounting:
    'memoryBytes counts retained Wasm buffers only. JS heap, generated code, JIT, GC and shared ESM module retention require process/engine measurements.',
});
console.log(
  `JS frontend: ${Buffer.byteLength(frontend)} bytes; reused arena: ${arena.length} bytes`,
);
