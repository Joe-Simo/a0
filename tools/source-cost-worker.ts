/** Fresh-process phase measurement; every arm uses the same research preloads and C emitter. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import type * as Backends from '../src/backends.js';
import type * as Core from '../src/core.js';
import { validate } from '../src/core.js';
import type * as Dense from '../src/dense.js';
import { parseSource } from '../src/source.js';
import { sourceCostComponents } from './source-cost-control.js';
import { prepareSourceFrontend } from './source-native-load.js';
import { systemLoad } from './system-load.js';

const [arm, inputArg, artifactArg, baselineArg, artifactCheckout] = process.argv.slice(2);
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
// Direct build inputs are relative to their immutable checkout; every arm uses the same SDK.
if (artifactCheckout !== undefined) process.chdir(resolve(artifactCheckout));
const prepared = await prepareSourceFrontend(artifact);
const components = sourceCostComponents(prepared.build);
const preload = {
  backend: prepared.build.backend ?? 'clang-wasm',
  components,
  componentCount: components.length,
  totalWasmBytes: prepared.bytes,
  artifactSha256: prepared.artifactSha256,
};
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
console.log(
  JSON.stringify({
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
    frontendExternalBytes: frontendMemory.external,
    frontendPeakRssBytes,
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
    wasmLinearMemoryBytes: engine?.memoryBytes ?? 0,
    preload,
    outputBytes: Buffer.byteLength(output),
    outputSha256: createHash('sha256').update(output).digest('hex'),
  }),
);
engine?.close();
