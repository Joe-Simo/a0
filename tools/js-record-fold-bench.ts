/** Compare two compiler builds on existing execution kernels. The timed input
 * generator and checksum are the JS arm of exec-bench.ts; no kernel is rewritten.
 * Usage: node dist/tools/js-record-fold-bench.js BEFORE_COMPILER OUTPUT_JSON [KERNELS] [BASELINE_REVISION]
 */
import assert from 'node:assert/strict';
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { COMPILER_VERSION, compile } from '../src/backends.js';
import { parseAndValidate } from '../src/core.js';
import { KERNELS } from './exec-bench-kernels.js';
import { ITER } from './exec-bench-languages.js';
import { writeReport } from './scrub-results.js';
import { systemLoadTriple } from './system-load.js';

interface Variant {
  label: string;
  path: string;
  bytes: number;
  sha256: string;
  fn: (...args: number[]) => number;
}
interface Timing {
  round: number;
  variant: string;
  load: number[];
  nsPerCall: number;
  checksum: number;
}
interface Probe {
  phase: string;
  round: number;
  variant: string;
  load: number[];
  processWallMs: number;
  importMs: number;
  maxRssKiB: number;
  checksum: number;
  retained: { heapUsed: number; arrayBuffers: number };
  before: object;
  after: object;
}

const [
  beforePath,
  out = 'results/js-record-fold.json',
  kernelNames,
  baselineRevision = '9a036e702a8b325e23a17d4854ca7bd63a63eee3',
] = process.argv.slice(2);
assert.ok(beforePath, 'expected baseline compiler module path');
const before = await import(pathToFileURL(resolve(beforePath)).href);
const directory = resolve('.a0-cache/record-fold-bench');
await mkdir(directory, { recursive: true });
const samples = 15;
const names = kernelNames?.split(',') ?? ['minmax1k', 'rle4k', 'utf8dec4k', 'prefix1k'];
assert.equal(new Set(names).size, names.length, 'duplicate kernel names');
assert.ok(
  names.every((name) => KERNELS.some((k) => k.name === name)),
  'unknown kernel',
);
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const median = (xs: number[]): number =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;

/** Same xorshift arguments and XOR accumulator as the stock JS benchmark. */
function run(f: (...args: number[]) => number, arity: number, iterations: number) {
  let s = 0x9e3779b9;
  let acc = 0;
  const a = [0, 0, 0];
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    for (let k = 0; k < arity; k++) {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      a[k] = s;
    }
    const r =
      arity === 1
        ? f(a[0] as number)
        : arity === 2
          ? f(a[0] as number, a[1] as number)
          : f(a[0] as number, a[1] as number, a[2] as number);
    acc = (acc ^ r) >>> 0;
  }
  return { nsPerCall: ((performance.now() - start) * 1e6) / iterations, checksum: acc };
}

const probe = `import {performance} from 'node:perf_hooks';
const start=performance.now();
const mod=await import(process.argv[2]);
const imported=performance.now()-start;
const fn=mod[process.argv[3]];
const iterations=Number(process.argv[4]);
const arity=Number(process.argv[5]);
global.gc();
const before=process.memoryUsage();
let s=0x9e3779b9,acc=0;const a=[0,0,0];
for(let i=0;i<iterations;i++){
 for(let k=0;k<arity;k++){s^=s<<13;s>>>=0;s^=s>>>17;s^=s<<5;s>>>=0;a[k]=s;}
 const r=arity===1?fn(a[0]):arity===2?fn(a[0],a[1]):fn(a[0],a[1],a[2]);acc=(acc^r)>>>0;
}
const after=process.memoryUsage();global.gc();const retained=process.memoryUsage();
console.log(JSON.stringify({importMs:imported,maxRssKiB:process.resourceUsage().maxRSS,before,after,retained,checksum:acc}));`;
const probePath = resolve(directory, 'probe.mjs');
await writeFile(probePath, probe);
const results = [];
for (const name of names) {
  const kernel = KERNELS.find((k) => k.name === name);
  assert.ok(kernel);
  const iterations = Math.floor(ITER / (kernel.iterScale ?? 1) / 4);
  const program = parseAndValidate(kernel.a0);
  const texts = [
    before.compile(program, 'js').text as string,
    compile(program, 'js').text,
    kernel.js,
  ];
  const variants: Variant[] = [];
  for (const [i, text] of texts.entries()) {
    const path = resolve(directory, `${name}-${i}.mjs`);
    await writeFile(path, text);
    const mod = await import(pathToFileURL(path).href);
    variants.push({
      label: ['before', 'after', 'handwritten'][i] as string,
      path,
      bytes: Buffer.byteLength(text),
      sha256: sha(text),
      fn: mod[name] as (...args: number[]) => number,
    });
  }
  for (let round = 0; round < 3; round++)
    for (const variant of variants) run(variant.fn, kernel.arity, iterations);
  const timings: Timing[] = [];
  for (let round = 0; round < samples; round++) {
    const order = round % 2 ? [2, 1, 0] : [0, 1, 2];
    for (const index of order) {
      const variant = variants[index];
      assert.ok(variant);
      const load = [...systemLoadTriple()];
      assert.ok((load[0] ?? Infinity) <= 10, 'loaded timing run');
      timings.push({
        round,
        variant: variant.label,
        load,
        ...run(variant.fn, kernel.arity, iterations),
      });
    }
  }
  assert.equal(new Set(timings.map((t) => t.checksum)).size, 1, `${name} runtime checksums`);
  const probes: Probe[] = [];
  for (const phase of ['startup', 'memory']) {
    for (let round = 0; round < 7; round++) {
      for (const index of round % 2 ? [1, 0] : [0, 1]) {
        const variant = variants[index];
        assert.ok(variant);
        const load = [...systemLoadTriple()];
        assert.ok((load[0] ?? Infinity) <= 10, 'loaded startup run');
        const start = performance.now();
        const result: SpawnSyncReturns<string> = spawnSync(
          process.execPath,
          [
            '--expose-gc',
            probePath,
            pathToFileURL(variant.path).href,
            name,
            phase === 'startup' ? '0' : '10000',
            String(kernel.arity),
          ],
          { encoding: 'utf8', timeout: 120_000 },
        );
        assert.equal(result.status, 0, result.stderr);
        const measured = JSON.parse(result.stdout) as Pick<
          Probe,
          'importMs' | 'maxRssKiB' | 'checksum' | 'retained' | 'before' | 'after'
        >;
        probes.push({
          phase,
          round,
          variant: variant.label,
          load,
          processWallMs: performance.now() - start,
          ...measured,
        });
      }
    }
  }
  assert.equal(
    new Set(probes.filter((p) => p.phase === 'memory').map((p) => p.checksum)).size,
    1,
    `${name} memory probe checksums`,
  );
  const summary = variants.map(({ label, path: _path, fn: _fn, ...v }) => ({
    label,
    ...v,
    medianNsPerCall: median(timings.filter((t) => t.variant === label).map((t) => t.nsPerCall)),
    ...(label === 'handwritten'
      ? {}
      : {
          medianImportMs: median(
            probes
              .filter((p) => p.variant === label && p.phase === 'startup')
              .map((p) => p.importMs),
          ),
          medianStartupProcessMs: median(
            probes
              .filter((p) => p.variant === label && p.phase === 'startup')
              .map((p) => p.processWallMs),
          ),
          medianMaxRssKiB: median(
            probes
              .filter((p) => p.variant === label && p.phase === 'memory')
              .map((p) => p.maxRssKiB),
          ),
          medianRetainedHeapBytes: median(
            probes
              .filter((p) => p.variant === label && p.phase === 'memory')
              .map((p) => p.retained.heapUsed),
          ),
          medianRetainedArrayBufferBytes: median(
            probes
              .filter((p) => p.variant === label && p.phase === 'memory')
              .map((p) => p.retained.arrayBuffers),
          ),
        }),
  }));
  results.push({ name, kernelSha256: sha(kernel.a0), iterations, summary, timings, probes });
  console.log(name, JSON.stringify(summary));
}
await writeReport(out, {
  generatedAt: new Date().toISOString(),
  baselineRevision,
  ledgerIds: names.map((name) => `exec-benchmark-linux-x64|${name}|ns-per-call-js|js-handwritten`),
  compilerVersion: COMPILER_VERSION,
  sourceSha256: {
    backends: sha(await readFile('src/backends.ts', 'utf8')),
    targets: sha(await readFile('src/targets.ts', 'utf8')),
  },
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  samples,
  warmups: 3,
  memoryProbeCalls: 10000,
  memoryMeaning:
    'Fresh Node process, GC before and after identical calls. maxRSS is process peak, retained fields are after-GC process memory; neither isolates all transient allocations.',
  startupMeaning:
    'importMs includes loading/parsing/JIT entry setup; Startup-phase processWallMs uses zero kernel calls and includes Node process launch, module import and teardown; memory-phase processWallMs additionally includes 10000 kernel calls.',
  results,
});
