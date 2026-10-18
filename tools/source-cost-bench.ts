/**
 * Matched historical-input controls for the modular A0 frontend; no shipping-CLI or AI claim.
 * --cross-backend explicitly compares C/direct builds and requires --control-artifact=DIR and
 * --control-checkout=DIR. --prepare-only verifies provenance and frozen inputs without timing.
 * Without --cross-backend, the existing C build-option / separate-transport controls apply.
 */
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
import type * as Core from '../src/core.js';
import type * as Dense from '../src/dense.js';
import type * as Link from '../src/link.js';
import { committedTree } from './measurement-checkout.js';
import { writeReport } from './scrub-results.js';
import { sourceCostArtifact, verifyDirectSourceCostBuild } from './source-cost-artifact.js';
import {
  SOURCE_COST_FROZEN_C_BANNER,
  sourceCostControlMode,
  verifySourceCostControl,
  verifySourceCostFrozenC,
} from './source-cost-control.js';
import { loadSource, systemLoadTriple } from './system-load.js';

const args = process.argv.slice(2);
const option = (name: string): string | undefined =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const controlArtifactArg = option('control-artifact');
const controlArtifact = controlArtifactArg === undefined ? undefined : resolve(controlArtifactArg);
const controlCheckoutArg = option('control-checkout');
const controlCheckout = controlCheckoutArg === undefined ? undefined : resolve(controlCheckoutArg);
const crossBackend = args.includes('--cross-backend');
const controlMode = sourceCostControlMode(crossBackend, controlArtifact, controlCheckout);
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
const controlIdentity = controlCheckout === undefined ? undefined : committedTree(controlCheckout);
for (const checkout of new Set([baseline, root, ...(controlCheckout ? [controlCheckout] : [])])) {
  const built = spawnSync('bun', ['x', 'tsc', '-p', 'tsconfig.json', '--incremental', 'false'], {
    cwd: checkout,
    encoding: 'utf8',
  });
  assert.equal(built.status, 0, `fresh build failed: ${built.stdout}\n${built.stderr}`);
}
assert.deepEqual(committedTree(root), identity);
assert.deepEqual(committedTree(baseline), baselineIdentity);
// Load every compiler dependency only after the fresh build; Node caches earlier static imports.
const { compile } = await import('../src/backends.js');
const { formatProgram } = await import('../src/core.js');
const { link } = await import('../src/link.js');
const { verifyNativeInputs } = await import('./source-native-artifact.js');
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
let historicalEmitterBanner: string | undefined;
const frozenEmitterBanner = SOURCE_COST_FROZEN_C_BANNER;
const hash = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
const experiment = join(root, 'experiments/unification/frontend-a0');
const inputIndexPath = join(experiment, 'inputs/index.json');
const inputIndexSHA256 = hash(await readFile(inputIndexPath));
const units = JSON.parse(await readFile(inputIndexPath, 'utf8')) as {
  id: number;
  unit: string;
  input: string;
  outputSHA256: string;
  inputSHA256: string;
}[];
const candidateArtifact = await sourceCostArtifact(artifact);
const build = candidateArtifact.build;
assert.ok(crossBackend || build.backend === undefined, 'direct frontend requires --cross-backend');
async function verifyBuild(
  checkout: string,
  record: Readonly<Record<string, unknown>>,
  linker: typeof Link.link = link,
  formatter: typeof Core.formatProgram = formatProgram,
  emitter: typeof Backends.compile = compile,
): Promise<void> {
  if (record.backend === 'direct-wasm') {
    assert.ok(crossBackend, 'direct frontend requires --cross-backend');
    await verifyDirectSourceCostBuild(checkout, record, {
      link: linker,
      formatProgram: formatter,
      compile: emitter,
    });
    return;
  }
  assert.equal(record.backend, undefined, 'unsupported frontend backend');
  await verifyNativeInputs(checkout, record.nativeInputs as { path: string; sha256: string }[]);
  assert.equal(record.entry, 'compiler/source_frontend.a0');
  const linked = await linker(join(checkout, record.entry), (path) => readFile(path, 'utf8'));
  assert.equal(
    linked.program.functions.length,
    record.functions,
    'artifact function count differs',
  );
  assert.equal(hash(formatter(linked.program)), record.sourceSHA256, 'artifact source differs');
  assert.equal(
    hash(emitter(linked.program, 'c', { cIo: 'host' }).text),
    record.cSHA256,
    'artifact C differs',
  );
  assert.deepEqual(
    (record.modules as { path: string }[]).map((module) => resolve(checkout, module.path)).sort(),
    linked.sources.map((source) => resolve(source.path)).sort(),
    'artifact dependency closure differs',
  );
  assert.equal(
    hash(await readFile(join(checkout, 'tools/native/source_frontend.c'))),
    record.driverSHA256,
  );
  for (const module of record.modules as { path: string; sha256: string }[])
    assert.equal(
      hash(await readFile(join(checkout, module.path))),
      module.sha256,
      `stale module ${module.path}`,
    );
}
await verifyBuild(root, build);
let controlSnapshot: Awaited<ReturnType<typeof sourceCostArtifact>> | undefined;
let controlBuild: typeof build | undefined;
if (controlArtifact !== undefined) {
  controlSnapshot = await sourceCostArtifact(controlArtifact);
  controlBuild = controlSnapshot.build;
  verifySourceCostControl(
    build,
    controlBuild,
    crossBackend ? 'compiled-backends' : controlCheckout !== undefined,
  );
  if (controlCheckout !== undefined) {
    const controlCore = (await import(
      pathToFileURL(join(controlCheckout, 'dist/src/core.js')).href
    )) as typeof Core;
    const controlLink = (await import(
      pathToFileURL(join(controlCheckout, 'dist/src/link.js')).href
    )) as typeof Link;
    const controlBackends = (await import(
      pathToFileURL(join(controlCheckout, 'dist/src/backends.js')).href
    )) as typeof Backends;
    await verifyBuild(
      controlCheckout,
      controlBuild,
      controlLink.link,
      controlCore.formatProgram,
      controlBackends.compile,
    );
    assert.deepEqual(committedTree(controlCheckout), controlIdentity);
  } else await verifyBuild(root, controlBuild);
}
await mkdir(out, { recursive: true });
const tokenizers = ['o200k_base', 'cl100k_base'].map(
  (name) => [name, getEncoding(name as 'o200k_base' | 'cl100k_base')] as const,
);
const preparedInputs = new Map<string, string>();
const workerPath = join(root, 'dist/tools/source-cost-worker.js');
const workerSHA256 = hash(await readFile(workerPath));
const inputs: {
  unit: string;
  rawInputSHA256: string;
  hashes: Record<string, string>;
  tokens: unknown;
}[] = [];
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
  // The archive predates compiler version bumps. Only its first generated-version banner may differ.
  const currentBanner = verifySourceCostFrozenC(output, unit.outputSHA256);
  historicalEmitterBanner ??= currentBanner;
  assert.equal(currentBanner, historicalEmitterBanner, 'historical emitter changed between inputs');
  expectedOutputs.set(unit.unit, hash(output));
  const texts = { canonical: input.canonical, dense: input.dense, flat: input.unified };
  inputs.push({
    unit: unit.unit,
    rawInputSHA256: unit.inputSHA256,
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
async function verifyUnchanged(): Promise<void> {
  assert.deepEqual(committedTree(root), identity, 'candidate changed during measurement');
  assert.deepEqual(
    committedTree(baseline),
    baselineIdentity,
    'baseline changed during measurement',
  );
  if (controlCheckout !== undefined)
    assert.deepEqual(
      committedTree(controlCheckout),
      controlIdentity,
      'control checkout changed during measurement',
    );
  assert.deepEqual(
    await sourceCostArtifact(artifact),
    candidateArtifact,
    'candidate artifact or build record changed',
  );
  if (controlArtifact !== undefined)
    assert.deepEqual(
      await sourceCostArtifact(controlArtifact),
      controlSnapshot,
      'control artifact or build record changed',
    );
  assert.equal(hash(await readFile(workerPath)), workerSHA256, 'worker changed');
  assert.equal(
    hash(await readFile(inputIndexPath)),
    inputIndexSHA256,
    'frozen input index changed',
  );
  for (const unit of units)
    assert.equal(
      hash(await readFile(join(experiment, 'inputs', unit.input))),
      unit.inputSHA256,
      'frozen input changed',
    );
  for (const [file, digest] of preparedInputs)
    assert.equal(hash(await readFile(join(out, file))), digest, 'prepared input changed');
}
if (args.includes('--prepare-only')) {
  await verifyUnchanged();
  await writeReport(join(out, 'preparation.json'), {
    schema: 1,
    candidate: identity,
    baseline: baselineIdentity,
    control: controlIdentity,
    controlMode,
    scope: 'Provenance and frozen-input checks only; no timing samples or performance conclusion.',
    nativeBuild: build,
    controlBuild,
    artifact: candidateArtifact.preload,
    controlArtifact: controlSnapshot?.preload,
    inputIndexSHA256,
    historicalEmitterBanner,
    frozenEmitterBanner,
    preparedInputs: Object.fromEntries(preparedInputs),
    inputs,
  });
  console.log(`PASS prepared ${units.length} inputs; artifact provenance verified; no timing run`);
  process.exit(0);
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
          arm === 'flat-a0-control' ? (controlCheckout ?? root) : root,
        ],
        {
          encoding: 'utf8',
          timeout: 240_000,
          maxBuffer: 8 * 1024 * 1024,
        },
      );
      assert.equal(child.status, 0, `${unit.unit}/${arm}: ${child.error ?? ''}\n${child.stderr}`);
      const measurement = JSON.parse(child.stdout);
      assert.deepEqual(
        measurement.preload,
        arm === 'flat-a0-control' ? controlSnapshot?.preload : candidateArtifact.preload,
        'subject artifact preload differs',
      );
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
await verifyUnchanged();
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
await writeReport(join(out, 'results.json'), {
  schema: 1,
  candidate: identity,
  baseline: baselineIdentity,
  control: controlIdentity,
  controlMode,
  startedAt,
  finishedAt: new Date().toISOString(),
  scope:
    'Frozen flattened whole-program inputs, old Canonical/Dense controls, current flat TS control and compiled A0 frontend. Parser/checker plus one historical C text emitter. Frontend instantiation/upload/typed-IR decoding included. Graph I/O, shipping CLI startup, formatter, model inference and generated-target execution excluded. Every fresh process preloads the common candidate SDK and its selected artifact; candidate artifact also preloaded for historical and TS controls. Per-sample preload records identify every Wasm component, hash and size. Artifact validation and Wasm module compilation are outside frontend/pipeline phases; fresh-child wall time includes process startup and preparation. No official source cutover or no-regression conclusion is implied.',
  protocol:
    'Reuse the archived frontend experiment input corpus and rotated fresh-process protocol; one discarded warmup round and seven measured rounds. Every arm uses the historical baseline C text emitter, so frontend IR is compared through one fixed backend even when frontend artifact code generation changes. Every emitted C hash must match the baseline control. That control must match the frozen reference after the explicitly recorded compiler-version banner substitution. Compiled-backend mode requires the same A0 source closure/count, generic arena runtime hashes, libc/builtins and Clang/LLD versions; backend code generation, feature requirements and stack settings are separately recorded in the complete build manifests and are not claimed matched.',
  workerSha256: workerSHA256,
  historicalEmitterBanner,
  frozenEmitterBanner,
  preparedInputs: Object.fromEntries(preparedInputs),
  inputIndexSHA256,
  artifact: {
    sha256: candidateArtifact.preload.artifactSha256,
    sourceSha256: build.sourceSHA256,
    bytes: candidateArtifact.preload.totalWasmBytes,
    ...candidateArtifact.preload,
  },
  controlArtifact: controlBuild,
  controlPreload: controlSnapshot?.preload,
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
    difference: `Only the first compiler banner changes from ${frozenEmitterBanner} to ${historicalEmitterBanner}; exact frozen hash verified after that explicit substitution.`,
  })),
  inputs,
  rows,
});
console.log(`PASS ${samples.length} matched cells; inspect losses before any promotion`);
