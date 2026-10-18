/** Fresh-process phase measurement; every arm uses the same research preloads and C emitter. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type * as Backends from '../src/backends.js';
import type * as Core from '../src/core.js';
import { validate } from '../src/core.js';
import type * as Dense from '../src/dense.js';
import { parseSource } from '../src/source.js';
import { sourceCostArtifact } from './source-cost-artifact.js';
import { sourceCostComponents } from './source-cost-control.js';
import {
  readSourceCostWorkerProof,
  verifySourceCostWorkerSubject,
} from './source-cost-worker-proof.js';
import { compileJsSourceArtifact, readJsSourceArtifact } from './source-js-artifact.js';
import { prepareSourceFrontend } from './source-native-load.js';
import { systemLoad } from './system-load.js';

const [arm, inputArg, artifactArg, baselineArg, artifactCheckout, proofPath, proofSHA256] =
  process.argv.slice(2);
const workerRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
assert.ok(arm && inputArg && artifactArg && baselineArg);
const inputPath = resolve(inputArg),
  artifact = resolve(artifactArg),
  baseline = resolve(baselineArg);
const oldCore = (await import(
  pathToFileURL(join(baseline, 'dist/src/core.js')).href
)) as typeof Core;
const oldDense = (await import(
  pathToFileURL(join(baseline, 'dist/src/dense.js')).href
)) as typeof Dense;
const commonEmitter = (await import(
  pathToFileURL(join(baseline, 'dist/src/backends.js')).href
)) as typeof Backends;
const input = JSON.parse(await readFile(inputPath, 'utf8')) as {
  canonical: string;
  dense: string;
  unified: string;
};
// Parent cold provenance is preparation-once; workers bind exact artifacts and actual SDK bytes.
const modulePreparationStart = performance.now();
const modulePreparationCpuStart = process.cpuUsage();
const beforePreparationMemory = process.memoryUsage();
const proof =
  proofPath === undefined
    ? undefined
    : await readSourceCostWorkerProof(workerRoot, proofPath, proofSHA256 as string, baseline);
if (artifactCheckout !== undefined) process.chdir(resolve(artifactCheckout));
const snapshot = proof === undefined ? undefined : await sourceCostArtifact(artifact);
if (snapshot)
  verifySourceCostWorkerSubject(
    snapshot,
    proof?.subjects[arm === 'flat-a0-control' ? 'control' : 'candidate'],
  );
const isJs = snapshot?.build.backend === 'generated-js';
const prepared = isJs
  ? await (async () => {
      const inspected = await readJsSourceArtifact(artifact);
      assert.equal(
        inspected.buildText,
        snapshot?.buildText,
        'JS manifest changed during preparation',
      );
      const loaded = await compileJsSourceArtifact(inspected);
      return {
        ...loaded,
        bytes: snapshot.preload.totalArtifactBytes as number,
        artifactSha256: snapshot.preload.artifactSha256,
      };
    })()
  : await prepareSourceFrontend(artifact);
assert.ok(
  proof !== undefined || prepared.build.backend !== 'generated-js',
  'JS worker requires strict parent proof',
);
if (snapshot)
  assert.deepEqual(
    prepared.build,
    snapshot.build,
    'loaded worker build differs from parent snapshot',
  );
const components = sourceCostComponents(prepared.build);
const preload = snapshot?.preload ?? {
  backend: prepared.build.backend ?? 'clang-wasm',
  components,
  componentCount: components.length,
  totalWasmBytes: prepared.bytes,
  artifactSha256: prepared.artifactSha256,
};
const modulePreparationMs = performance.now() - modulePreparationStart;
const modulePreparationCpu = process.cpuUsage(modulePreparationCpuStart);
if (proof && proofPath) {
  assert.deepEqual(
    await readSourceCostWorkerProof(workerRoot, proofPath, proofSHA256 as string, baseline),
    proof,
    'worker proof changed during module preparation',
  );
  verifySourceCostWorkerSubject(
    await sourceCostArtifact(artifact),
    proof.subjects[arm === 'flat-a0-control' ? 'control' : 'candidate'],
  );
}
const initialMemory = process.memoryUsage();
const initialPeakRssBytes = process.resourceUsage().maxRSS * 1024;
let engine: ReturnType<typeof prepared.instantiate> | undefined;
let program: Core.TypedProgram;
const loadBefore = systemLoad(),
  cpuBefore = process.cpuUsage(),
  start = performance.now();
if (arm === 'old-canonical') program = oldCore.parseAndValidate(input.canonical);
else if (arm === 'old-dense') program = oldCore.validate(oldDense.parseDense(input.dense));
else if (arm === 'flat-ts-control') program = validate(parseSource(input.unified));
else {
  assert.ok(arm === 'flat-a0' || arm === 'flat-a0-control');
  engine = prepared.instantiate();
  const result = engine.parse(input.unified);
  assert.ok(result.ok, `native status ${result.status}`);
  program = result.typed;
}
const frontendEnd = performance.now(),
  frontendCpu = process.cpuUsage(cpuBefore);
const frontendMemory = process.memoryUsage();
const emitStart = performance.now();
const frontendPeakRssBytes = process.resourceUsage().maxRSS * 1024;
const output = commonEmitter.compile(program, 'c').text,
  end = performance.now();
const memory = process.memoryUsage();
const peakRssBytes = process.resourceUsage().maxRSS * 1024;
const wasmLinearMemoryBytes = engine?.memoryBytes ?? 0;
const postCheckStart = performance.now();
if (proof && proofPath) {
  assert.deepEqual(
    await readSourceCostWorkerProof(workerRoot, proofPath, proofSHA256 as string, baseline),
    proof,
    'worker proof changed during execution',
  );
  verifySourceCostWorkerSubject(
    await sourceCostArtifact(artifact),
    proof.subjects[arm === 'flat-a0-control' ? 'control' : 'candidate'],
  );
}
const postCheckMs = performance.now() - postCheckStart;
console.log(
  JSON.stringify({
    modulePreparationMs,
    modulePreparationCpu,
    postCheckMs,
    beforePreparationRssBytes: beforePreparationMemory.rss,
    beforePreparationHeapUsedBytes: beforePreparationMemory.heapUsed,
    beforePreparationExternalBytes: beforePreparationMemory.external,
    frontendMs: frontendEnd - start,
    emitCMs: end - emitStart,
    pipelineMs: end - start,
    frontendCpu,
    loadBefore,
    loadAfter: systemLoad(),
    initialPeakRssBytes,
    initialRssBytes: initialMemory.rss,
    frontendRssBytes: frontendMemory.rss,
    frontendHeapUsedBytes: frontendMemory.heapUsed,
    frontendHeapTotalBytes: frontendMemory.heapTotal,
    frontendArrayBufferBytes: frontendMemory.arrayBuffers,
    frontendExternalBytes: frontendMemory.external,
    frontendPeakRssBytes,
    peakRssBytes,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    arrayBufferBytes: memory.arrayBuffers,
    externalBytes: memory.external,
    wasmLinearMemoryBytes,
    preload,
    outputBytes: Buffer.byteLength(output),
    outputSha256: createHash('sha256').update(output).digest('hex'),
  }),
);
engine?.close();
