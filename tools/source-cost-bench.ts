/** Matched historical-input controls for the modular A0 frontend; no shipping-CLI or AI claim. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { availableParallelism, cpus } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getEncoding } from 'js-tiktoken';
import type * as Backends from '../src/backends.js';
import { compile } from '../src/backends.js';
import type * as Core from '../src/core.js';
import { formatProgram } from '../src/core.js';
import type * as Dense from '../src/dense.js';
import { link } from '../src/link.js';
import { committedTree } from './measurement-checkout.js';
import { writeReport } from './scrub-results.js';
import { loadSource, systemLoadTriple } from './system-load.js';

const args = process.argv.slice(2);
const option = (name: string): string | undefined =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const controlArtifactArg = option('control-artifact');
const controlArtifact = controlArtifactArg === undefined ? undefined : resolve(controlArtifactArg);
const baselineArg = option('baseline'),
  artifactArg = option('artifact'),
  outArg = option('out');
assert.ok(
  baselineArg && artifactArg && outArg,
  '--baseline=DIR --artifact=DIR --out=DIR are required',
);
const baseline = resolve(baselineArg),
  artifact = resolve(artifactArg),
  out = resolve(outArg);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const identity = committedTree(root),
  baselineIdentity = committedTree(baseline);
for (const checkout of [baseline, root]) {
  const built = spawnSync('bun', ['x', 'tsc', '-p', 'tsconfig.json', '--incremental', 'false'], {
    cwd: checkout,
    encoding: 'utf8',
  });
  assert.equal(built.status, 0, `fresh build failed: ${built.stdout}\n${built.stderr}`);
}
assert.deepEqual(committedTree(root), identity);
assert.deepEqual(committedTree(baseline), baselineIdentity);
const oldCore = (await import(
  pathToFileURL(join(baseline, 'dist/src/core.js')).href
)) as typeof Core;
const oldDense = (await import(
  pathToFileURL(join(baseline, 'dist/src/dense.js')).href
)) as typeof Dense;
const oldBackends = (await import(
  pathToFileURL(join(baseline, 'dist/src/backends.js')).href
)) as typeof Backends;
const expectedOutputs = new Map<string, string>();
const hash = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
const experiment = join(root, 'experiments/unification/frontend-a0');
const units = JSON.parse(await readFile(join(experiment, 'inputs/index.json'), 'utf8')) as {
  id: number;
  unit: string;
  input: string;
  outputSHA256: string;
  inputSHA256: string;
}[];
const build = JSON.parse(await readFile(join(artifact, 'build.json'), 'utf8'));
assert.equal(hash(await readFile(join(artifact, 'frontend.wasm'))), build.wasmSHA256);
assert.equal(build.entry, 'compiler/source_frontend.a0');
const linked = await link(join(root, build.entry), (path) => readFile(path, 'utf8'));
assert.equal(hash(formatProgram(linked.program)), build.sourceSHA256, 'artifact source differs');
assert.equal(
  hash(compile(linked.program, 'c', { cIo: 'host' }).text),
  build.cSHA256,
  'artifact C differs',
);
assert.deepEqual(
  build.modules.map((module: { path: string }) => resolve(root, module.path)).sort(),
  linked.sources.map((source) => resolve(source.path)).sort(),
  'artifact dependency closure differs',
);
assert.equal(
  hash(await readFile(join(root, 'tools/native/source_frontend.c'))),
  build.driverSHA256,
);
for (const module of build.modules as { path: string; sha256: string }[]) {
  assert.equal(
    hash(await readFile(join(root, module.path))),
    module.sha256,
    `stale module ${module.path}`,
  );
}
let controlBuild: typeof build | undefined;
if (controlArtifact !== undefined) {
  controlBuild = JSON.parse(await readFile(join(controlArtifact, 'build.json'), 'utf8'));
  assert.equal(
    hash(await readFile(join(controlArtifact, 'frontend.wasm'))),
    controlBuild.wasmSHA256,
  );
  for (const field of ['sourceSHA256', 'cSHA256', 'driverSHA256', 'aggregateBytes', 'stackBytes'])
    assert.equal(
      controlBuild[field],
      build[field],
      `control differs in ${field}; this comparison permits only Wasm build changes`,
    );
}
await mkdir(out, { recursive: true });
const tokenizers = ['o200k_base', 'cl100k_base'].map(
  (name) => [name, getEncoding(name as 'o200k_base' | 'cl100k_base')] as const,
);
const preparedInputs = new Map<string, string>();
const workerPath = join(root, 'dist/tools/source-cost-worker.js');
const workerSHA256 = hash(await readFile(workerPath));
const inputs: { unit: string; hashes: Record<string, string>; tokens: unknown }[] = [];
for (const unit of units) {
  const frozenInput = await readFile(join(experiment, 'inputs', unit.input), 'utf8');
  assert.equal(hash(frozenInput), unit.inputSHA256, 'frozen input changed');
  const input = JSON.parse(frozenInput) as {
    canonical: string;
    dense: string;
    unified: string;
  };
  const control = oldCore.parseAndValidate(input.canonical);
  input.dense = oldDense.formatDense(control, { comments: true });
  assert.equal(
    oldCore.formatSource(oldCore.validate(oldDense.parseDense(input.dense))),
    oldCore.formatSource(control),
    'Dense control IR differs',
  );
  const output = oldBackends.compile(control, 'c').text;
  // The archive predates the compiler version bump; require exact bytes after this banner-only substitution.
  assert.ok(output.startsWith('/* Generated by A0 a0c-0.1.63. Exact u32/bool semantics. */'));
  assert.equal(
    hash(output.replace('/* Generated by A0 a0c-0.1.63.', '/* Generated by A0 a0c-0.1.62.')),
    unit.outputSHA256,
    'frozen output differs beyond the recorded version banner',
  );
  expectedOutputs.set(unit.unit, hash(output));
  const texts = { canonical: input.canonical, dense: input.dense, flat: input.unified };
  inputs.push({
    unit: unit.unit,
    hashes: Object.fromEntries(Object.entries(texts).map(([name, text]) => [name, hash(text)])),
    tokens: Object.fromEntries(
      tokenizers.map(([name, encoding]) => [
        name,
        Object.fromEntries(
          Object.entries(texts).map(([kind, text]) => [kind, encoding.encode(text).length]),
        ),
      ]),
    ),
  });
  const prepared = JSON.stringify(input);
  preparedInputs.set(unit.input, hash(prepared));
  await writeFile(join(out, unit.input), prepared);
}
const arms = ['old-canonical', 'old-dense', 'flat-ts-control', 'flat-a0'];
if (controlArtifact !== undefined) arms.push('flat-a0-control');
const samples: Record<string, unknown>[] = [];
const startedAt = new Date().toISOString();
for (let round = -1; round < 7; round++) {
  for (const unit of units)
    for (let index = 0; index < arms.length; index++) {
      const arm = arms[(round + 1 + unit.id + index) % arms.length] as string;
      const load = systemLoadTriple();
      assert.ok((load[0] as number) <= 10, 'loaded machine: discard this run');
      const start = performance.now();
      const child = spawnSync(
        process.execPath,
        [
          workerPath,
          arm,
          join(out, unit.input),
          arm === 'flat-a0-control' ? (controlArtifact as string) : artifact,
          baseline,
        ],
        {
          encoding: 'utf8',
          timeout: 240_000,
          maxBuffer: 8 * 1024 * 1024,
        },
      );
      assert.equal(child.status, 0, `${unit.unit}/${arm}: ${child.error ?? ''}\n${child.stderr}`);
      const measurement = JSON.parse(child.stdout);
      assert.equal(
        measurement.outputSha256,
        expectedOutputs.get(unit.unit),
        'a subject changed emitted C',
      );
      assert.ok(
        measurement.loadBefore <= 10 && measurement.loadAfter <= 10,
        'loaded subject: discard run',
      );
      samples.push({
        unit: unit.unit,
        arm,
        round,
        warmup: round < 0,
        load,
        wallMs: performance.now() - start,
        ...measurement,
      });
      await writeReport(join(out, 'samples.json'), samples);
    }
  console.log(`round ${round} complete`);
}
assert.deepEqual(committedTree(root), identity, 'candidate changed during measurement');
assert.deepEqual(committedTree(baseline), baselineIdentity, 'baseline changed during measurement');
assert.equal(
  hash(await readFile(join(artifact, 'frontend.wasm'))),
  build.wasmSHA256,
  'artifact changed',
);
assert.equal(hash(await readFile(workerPath)), workerSHA256, 'worker changed');
for (const [file, digest] of preparedInputs)
  assert.equal(hash(await readFile(join(out, file))), digest, 'prepared input changed');
const median = (values: number[]): number =>
  values.sort((a, b) => a - b)[Math.floor(values.length / 2)] as number;
const fields = [
  'frontendMs',
  'emitCMs',
  'pipelineMs',
  'wallMs',
  'initialPeakRssBytes',
  'initialRssBytes',
  'frontendRssBytes',
  'frontendHeapUsedBytes',
  'frontendExternalBytes',
  'frontendPeakRssBytes',
  'peakRssBytes',
  'rssBytes',
  'heapUsedBytes',
  'externalBytes',
  'wasmLinearMemoryBytes',
];
const rows = units.map((unit) => ({
  unit: unit.unit,
  arms: Object.fromEntries(
    arms.map((arm) => [
      arm,
      Object.fromEntries(
        fields.map((field) => [
          field,
          median(
            samples
              .filter((sample) => sample.unit === unit.unit && sample.arm === arm && !sample.warmup)
              .map((sample) => sample[field] as number),
          ),
        ]),
      ),
    ]),
  ),
}));
if (controlArtifact !== undefined)
  assert.equal(
    hash(await readFile(join(controlArtifact, 'frontend.wasm'))),
    controlBuild.wasmSHA256,
    'control artifact changed',
  );
await writeReport(join(out, 'results.json'), {
  schema: 1,
  candidate: identity,
  baseline: baselineIdentity,
  startedAt,
  finishedAt: new Date().toISOString(),
  scope:
    'Frozen flattened whole-program inputs, old Canonical/Dense controls, current flat TS control and modular A0 frontend. Parser/checker plus the same optimized C text emitter. Native instantiation/upload/typed-IR decoding included. Graph I/O, shipping CLI startup, formatter and model inference excluded. Equal module and compiled-Wasm preloads in every fresh process; memory includes those preloads and the input. No official source cutover or no-regression conclusion is implied.',
  protocol:
    'Reuse the archived frontend experiment input corpus and rotated fresh-process protocol; one discarded warmup round and seven measured rounds. Every emitted C hash must match the baseline control. That control must match the frozen reference after the explicitly recorded compiler-version banner substitution.',
  workerSha256: workerSHA256,
  preparedInputs: Object.fromEntries(preparedInputs),
  artifact: { sha256: build.wasmSHA256, sourceSha256: build.sourceSHA256, bytes: build.wasmBytes },
  controlArtifact: controlBuild,
  nativeBuild: build,
  memoryMethod:
    'Live frontend RSS/heap/external memory captured before emission. Initial peak/live RSS exposes any inherited launch or preload floor; maxRSS alone cannot establish small-cell frontend parity.',
  node: process.version,
  cpu: cpus()[0]?.model,
  availableParallelism: availableParallelism(),
  loadSource: loadSource(),
  maxLoad1: Math.max(
    ...samples.flatMap((sample) => [
      (sample.load as readonly number[])[0] as number,
      sample.loadBefore as number,
      sample.loadAfter as number,
    ]),
  ),
  measuredRounds: 7,
  warmups: 1,
  samples: samples.length,
  outputControls: units.map((unit) => ({
    unit: unit.unit,
    frozenSHA256: unit.outputSHA256,
    expectedSHA256: expectedOutputs.get(unit.unit),
    difference:
      'Only the first compiler banner changes from a0c-0.1.62 to a0c-0.1.63; exact frozen hash verified after that explicit substitution.',
  })),
  inputs,
  rows,
});
console.log(`PASS ${samples.length} matched cells; inspect losses before any promotion`);
