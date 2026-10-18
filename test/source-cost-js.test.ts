/** Cross-target provenance metadata and immutable worker handoff controls; no timing. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { formatType, type Type } from '../src/core.js';
import { committedTree } from '../tools/measurement-checkout.js';
import { writeReport } from '../tools/scrub-results.js';
import { sourceCostArtifact } from '../tools/source-cost-artifact.js';
import {
  type SourceCostBuild,
  sourceCostComponents,
  verifySourceCostControl,
} from '../tools/source-cost-control.js';
import {
  readSourceCostWorkerProof,
  SOURCE_COST_WORKER_MODULES,
  sourceCostHistoricalOutputs,
  sourceCostWorkerInputs,
  verifySourceCostWorkerSubject,
} from '../tools/source-cost-worker-proof.js';
import { jsCompilerOutputPaths } from '../tools/source-js-inputs.js';

const hash = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const clone = <T>(value: T): T => structuredClone(value);

test('JS compiled-backend compatibility binds common compiler, full A0 closure and structural API independently of word counts', async () => {
  // Metadata fixtures only. Actual emission/native rebuilding are independently required by preparation.
  const js = JSON.parse(await readFile('results/source-frontend-js-build.json', 'utf8'));
  const native = JSON.parse(await readFile('seed/source-frontend/build.json', 'utf8'));
  const inputs = ['bun.lock', 'package.json', 'tsconfig.json', 'src/compiler.ts']
    .sort()
    .map((path) => ({ path, sha256: hash(path) }));
  const configuration = ['bun.lock', 'package.json', 'tsconfig.json'];
  const versions = { node: process.version, typescript: 'independent-fixture' };
  const checkout = { commit: 'a'.repeat(40), tree: 'b'.repeat(40), dirty: false };
  const signatures = Object.entries(
    js.functions as Record<string, { params: Type[]; result: Type }>,
  )
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, fn]) => ({
      name,
      params: fn.params.map(formatType),
      result: formatType(fn.result),
    }));
  Object.assign(native, {
    frontendOptions: { cIo: 'host', optimize: true },
    frontendFunctions: signatures,
    compilerVersion: js.compilerVersion,
    compilerInputs: inputs,
    compilerConfiguration: configuration,
    compilerBuild: versions,
    compilerCheckout: checkout,
    compileFlags: ['--target=wasm32-wasi', '-O3', '-flto'],
    linkerFlags: ['--no-entry', '--strip-all'],
    effectiveCompileSHA256: hash('independent-effective-command'),
    diagnosticPorts: 'disabled',
    modules: js.modules,
    functions: js.functionCount,
    nativeCompileInputs: [
      { path: '<artifact>/api.h', sha256: hash('independent-api') },
      { path: '<artifact>/driver.c', sha256: native.driverSHA256 },
      { path: '<artifact>/module.c', sha256: native.cSHA256 },
      { path: '<sysroot>/stdint.h', sha256: hash('independent-stdint') },
    ],
  });
  for (const field of [
    'entry',
    'sourceSHA256',
    'frontendABI',
    'libcSHA256',
    'builtinsSHA256',
    'clang',
    'linker',
  ])
    native[field] = js.arenaOrigin[field];
  for (const input of native.nativeInputs) {
    const original = js.arenaOrigin.inputs.find(
      (item: { path: string }) => item.path === input.path,
    );
    if (original) input.sha256 = original.sha256;
  }
  js.frontendFunctions = signatures;
  js.compilerInputInventory = { inputs, configuration, build: versions, checkout };
  const accepts = (a: SourceCostBuild, b: SourceCostBuild) =>
    verifySourceCostControl(a, b, 'compiled-backends');
  accepts(js, native);
  accepts(native, js);
  assert.deepEqual(
    sourceCostComponents(js).map((c) => c.file),
    ['frontend.mjs', 'arena.wasm'],
  );
  assert.equal(js.totalWasmBytes, js.arenaBytes);
  const mutations: ((a: typeof js, b: typeof native) => void)[] = [
    (a) => {
      a.frontendCallABI = 'wasm-words';
    },
    (a) => {
      a.sourceSHA256 = hash('different-source');
    },
    (a) => {
      a.modules[0].sha256 = hash('different-module');
    },
    (a) => {
      a.functionCount++;
    },
    (a) => {
      a.frontendOptions.optimize = false;
    },
    (a) => {
      a.frontendFunctions[0].params[0] = 'bool';
    },
    (a, b) => {
      a.frontendFunctions.pop();
      b.frontendFunctions.pop();
    },
    (a) => {
      a.compilerInputInventory.inputs[0].sha256 = hash('different-compiler');
    },
    (a) => {
      a.compilerInputInventory.configuration = [];
    },
    (a) => {
      a.compilerInputInventory.checkout.dirty = true;
    },
    (a) => {
      a.arenaOrigin.libcSHA256 = hash('different-libc');
    },
    (a) => {
      a.arenaOrigin.inputs.find(
        (i: { path: string }) => i.path === 'tools/native/arena_runtime.c',
      ).sha256 = hash('different-runtime');
    },
    (a) => {
      a.arenaSHA256 = hash('different-arena');
    },
    (a) => {
      a.totalArtifactBytes = a.totalWasmBytes;
    },
    (a) => {
      a.totalWasmBytes = a.totalArtifactBytes;
    },
    (_a, b) => {
      delete b.compilerInputs;
    },
    (_a, b) => {
      delete b.effectiveCompileSHA256;
    },
    (_a, b) => {
      delete b.diagnosticPorts;
    },
  ];
  for (const mutate of mutations) {
    const a = clone(js),
      b = clone(native);
    mutate(a, b);
    assert.throws(() => accepts(a, b));
  }
  assert.throws(() => verifySourceCostControl(js, native, 'compiler-codegen'));
  assert.throws(() => verifySourceCostControl(js, native, 'source-algorithm'));
});

test('worker handoff refuses changed proof, omitted SDK files, stale ignored code and self-consistent artifact replacement', async () => {
  await mkdir('.a0-tmp', { recursive: true });
  const root = await mkdtemp(join(process.cwd(), '.a0-tmp/js-worker-proof-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/compiler.ts'), 'export const value=1;\n');
    await writeFile(join(root, '.gitignore'), 'dist/\n.a0-tmp/\n');
    git('init', '--quiet');
    git('add', '.');
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    );
    const paths = [
      ...new Set([
        ...jsCompilerOutputPaths(root),
        ...SOURCE_COST_WORKER_MODULES.map((p) => `dist/${p}.js`),
      ]),
    ].sort();
    for (const path of paths) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), `// independently loaded SDK ${path}\n`);
    }
    const outputInputs = paths.map((path) => ({
      path,
      sha256: hash(`// independently loaded SDK ${path}\n`),
    }));
    const sdkOutputs = await sourceCostWorkerInputs(root, outputInputs);
    const directory = join(root, '.a0-tmp/artifact');
    await mkdir(directory, { recursive: true });
    const wasm = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);
    await writeFile(join(directory, 'frontend.wasm'), wasm);
    await writeReport(join(directory, 'build.json'), {
      wasmBytes: wasm.length,
      wasmSHA256: hash(wasm),
    });
    const snapshot = await sourceCostArtifact(directory);
    const proof = {
      schema: 1,
      checkout: committedTree(root),
      sdkOutputs,
      subjects: { candidate: snapshot, control: snapshot },
      historical: {
        checkout: committedTree(root),
        outputs: await sourceCostHistoricalOutputs(root),
      },
    };
    const proofPath = join(root, '.a0-tmp/proof.json');
    await writeReport(proofPath, proof);
    const proofHash = hash(await readFile(proofPath));
    const read = () => readSourceCostWorkerProof(root, proofPath, proofHash, root);
    assert.deepEqual(await read(), proof);
    verifySourceCostWorkerSubject(await sourceCostArtifact(directory), proof.subjects.candidate);
    await writeFile(proofPath, '{}');
    await assert.rejects(read, /worker proof changed/);
    const incomplete = clone(proof);
    incomplete.sdkOutputs.pop();
    await writeReport(proofPath, incomplete);
    await assert.rejects(
      readSourceCostWorkerProof(root, proofPath, hash(await readFile(proofPath)), root),
      /inventory incomplete/,
    );
    const noHistorical = clone(proof);
    noHistorical.historical.outputs = [];
    await writeReport(proofPath, noHistorical);
    await assert.rejects(
      readSourceCostWorkerProof(root, proofPath, hash(await readFile(proofPath)), root),
      /historical SDK output changed/,
    );
    await writeReport(proofPath, proof);
    const first = paths[0];
    assert.ok(first);
    const original = await readFile(join(root, first));
    await writeFile(join(root, first), 'throw new Error("stale ignored code");\n');
    await assert.rejects(read, /SDK output changed/);
    await writeFile(join(root, first), original);
    await read();
    const replacement = Buffer.concat([wasm, Uint8Array.of(0, 2, 1, 120)]);
    assert.equal(WebAssembly.validate(replacement), true);
    await writeFile(join(directory, 'frontend.wasm'), replacement);
    await writeReport(join(directory, 'build.json'), {
      wasmBytes: replacement.length,
      wasmSHA256: hash(replacement),
    });
    const altered = await sourceCostArtifact(directory);
    assert.throws(
      () => verifySourceCostWorkerSubject(altered, proof.subjects.candidate),
      /strict parent snapshot/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
