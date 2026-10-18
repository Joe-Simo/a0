/** Fresh-process phase measurement; every arm uses the same research preloads and C emitter. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { compile } from '../src/backends.js';
import type * as Core from '../src/core.js';
import { validate } from '../src/core.js';
import type * as Dense from '../src/dense.js';
import { parseSource } from '../src/source.js';
import { nativeSource } from '../src/source-native.js';
import { systemLoad } from './system-load.js';

const [arm, inputPath, artifact, baseline] = process.argv.slice(2);
assert.ok(arm && inputPath && artifact && baseline);
const oldCore = (await import(
  pathToFileURL(join(baseline, 'dist/src/core.js')).href
)) as typeof Core;
const oldDense = (await import(
  pathToFileURL(join(baseline, 'dist/src/dense.js')).href
)) as typeof Dense;
const input = JSON.parse(await readFile(inputPath, 'utf8')) as {
  canonical: string;
  dense: string;
  unified: string;
};
const module = new WebAssembly.Module(await readFile(join(artifact, 'frontend.wasm')));
let engine: ReturnType<typeof nativeSource> | undefined;
let program: Core.TypedProgram;
const loadBefore = systemLoad(),
  cpuBefore = process.cpuUsage(),
  start = performance.now();
if (arm === 'old-canonical') program = oldCore.parseAndValidate(input.canonical);
else if (arm === 'old-dense') program = oldCore.validate(oldDense.parseDense(input.dense));
else if (arm === 'flat-ts-control') program = validate(parseSource(input.unified));
else {
  assert.equal(arm, 'flat-a0');
  engine = nativeSource(module);
  const result = engine.parse(input.unified);
  assert.ok(result.ok, `native status ${result.status}`);
  program = result.typed;
}
const frontendEnd = performance.now(),
  frontendCpu = process.cpuUsage(cpuBefore);
const frontendPeakRssBytes = process.resourceUsage().maxRSS * 1024;
const output = compile(program, 'c').text,
  end = performance.now();
const memory = process.memoryUsage();
console.log(
  JSON.stringify({
    frontendMs: frontendEnd - start,
    emitCMs: end - frontendEnd,
    pipelineMs: end - start,
    frontendCpu,
    loadBefore,
    loadAfter: systemLoad(),
    frontendPeakRssBytes,
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
    wasmLinearMemoryBytes: engine?.memoryBytes ?? 0,
    outputBytes: Buffer.byteLength(output),
    outputSha256: createHash('sha256').update(output).digest('hex'),
  }),
);
engine?.close();
