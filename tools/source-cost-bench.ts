/**
 * Matched historical-input controls for the modular A0 frontend; no shipping-CLI or AI claim.
 * --cross-backend explicitly compares C with direct-Wasm/generated-JS and requires --control-artifact=DIR and
 * --control-checkout=DIR. --prepare-only verifies provenance and frozen inputs without timing.
 * --compiler-codegen compares two freshly recorded C emitters with identical runtime/build options.
 * --source-algorithm compares different A0 closures with an identical compiler/host/runtime/toolchain.
 * Without an explicit mode, the existing C build-option / separate-transport controls apply.
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
import {
  rebuildCSourceCostBuild,
  sourceCostArtifact,
  verifyCSourceCostBuild,
  verifyDirectSourceCostBuild,
  verifyJsSourceCostBuild,
  verifySourceCostStackProof,
} from './source-cost-artifact.js';
import {
  SOURCE_COST_FROZEN_C_BANNER,
  sourceCostAlgorithmDifferences,
  sourceCostCompilerDifferences,
  sourceCostControlMode,
  verifySourceCostControl,
  verifySourceCostFrozenC,
} from './source-cost-control.js';
import { sourceCostHistoricalOutputs, sourceCostWorkerInputs } from './source-cost-worker-proof.js';
import { loadSource, systemLoadTriple } from './system-load.js';

const args = process.argv.slice(2);
const option = (name: string): string | undefined =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const controlArtifactArg = option('control-artifact');
const controlArtifact = controlArtifactArg === undefined ? undefined : resolve(controlArtifactArg);
const controlCheckoutArg = option('control-checkout');
const controlCheckout = controlCheckoutArg === undefined ? undefined : resolve(controlCheckoutArg);
const crossBackend = args.includes('--cross-backend');
const compilerCodegen = args.includes('--compiler-codegen');
const sourceAlgorithm = args.includes('--source-algorithm');
const strictNative = compilerCodegen || sourceAlgorithm;
const controlMode = sourceCostControlMode(
  crossBackend,
  controlArtifact,
  controlCheckout,
  compilerCodegen,
  sourceAlgorithm,
);
const sysrootArg = option('sysroot'),
  builtinsArg = option('builtins');
assert.ok(
  !strictNative || (sysrootArg && builtinsArg),
  `${sourceAlgorithm ? '--source-algorithm' : '--compiler-codegen'} requires --sysroot and --builtins`,
);
const nativeToolchain =
  sysrootArg && builtinsArg
    ? { sysroot: resolve(sysrootArg), builtins: resolve(builtinsArg) }
    : undefined;
const nativeRebuilds: Record<string, unknown> = {};
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
const { compile, COMPILER_VERSION } = await import('../src/backends.js');
const { formatProgram } = await import('../src/core.js');
const { link } = await import('../src/link.js');
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
const controlSnapshot =
  controlArtifact === undefined ? undefined : await sourceCostArtifact(controlArtifact);
let controlBuild = controlSnapshot?.build;
const strictJsComparison =
  build.backend === 'generated-js' || controlBuild?.backend === 'generated-js';
if (strictJsComparison) {
  assert.ok(
    crossBackend && build.backend === 'generated-js',
    'JS target requires --cross-backend with candidate JS and C control',
  );
  assert.ok(nativeToolchain, 'JS target comparison requires --sysroot and --builtins');
}
assert.ok(crossBackend || build.backend === undefined, 'direct frontend requires --cross-backend');
async function verifyBuild(
  checkout: string,
  record: Readonly<Record<string, unknown>>,
  directory: string,
  linker: typeof Link.link = link,
  formatter: typeof Core.formatProgram = formatProgram,
  emitter: typeof Backends.compile = compile,
  version: string = COMPILER_VERSION,
): Promise<void> {
  if (record.backend === 'generated-js') {
    assert.ok(
      crossBackend && nativeToolchain,
      'JS target requires explicit cross-backend toolchain',
    );
    nativeRebuilds[checkout === root ? 'candidate' : 'control'] = await verifyJsSourceCostBuild(
      checkout,
      directory,
      record,
      nativeToolchain,
    );
    return;
  }
  if (record.backend === 'direct-wasm') {
    assert.ok(crossBackend, 'direct frontend requires --cross-backend');
    await verifyDirectSourceCostBuild(checkout, record, {
      link: linker,
      formatProgram: formatter,
      compile: emitter,
    });
    const { wasmStackBound } = await import(
      pathToFileURL(join(checkout, 'dist/tools/wasm-stack-bound.js')).href
    );
    verifySourceCostStackProof(
      record,
      await readFile(join(directory, 'arena.wasm')),
      wasmStackBound,
    );
    return;
  }
  await verifyCSourceCostBuild(
    checkout,
    record,
    {
      link: linker,
      formatProgram: formatter,
      compile: emitter,
      version,
    },
    strictNative || strictJsComparison,
  );
  if (strictNative || strictJsComparison) {
    assert.ok(nativeToolchain);
    nativeRebuilds[checkout === root ? 'candidate' : 'control'] = await rebuildCSourceCostBuild(
      checkout,
      record,
      nativeToolchain,
    );
  }
}
await verifyBuild(root, build, artifact);
if (controlArtifact !== undefined) {
  assert.ok(controlSnapshot);
  controlBuild = controlSnapshot.build;
  verifySourceCostControl(
    build,
    controlBuild,
    sourceAlgorithm
      ? 'source-algorithm'
      : compilerCodegen
        ? 'compiler-codegen'
        : crossBackend
          ? 'compiled-backends'
          : controlCheckout !== undefined,
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
      controlArtifact,
      controlLink.link,
      controlCore.formatProgram,
      controlBackends.compile,
      controlBackends.COMPILER_VERSION,
    );
    assert.deepEqual(committedTree(controlCheckout), controlIdentity);
  } else await verifyBuild(root, controlBuild, controlArtifact);
}
const compilerInputDifferences =
  strictNative && controlBuild !== undefined
    ? sourceCostCompilerDifferences(build, controlBuild)
    : undefined;
const sourceAlgorithmDifferences =
  sourceAlgorithm && controlBuild !== undefined
    ? sourceCostAlgorithmDifferences(build, controlBuild)
    : undefined;
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
let workerProofPath: string | undefined, workerProofSHA256: string | undefined;
let workerProof:
  | {
      schema: number;
      checkout: typeof identity;
      sdkOutputs: Awaited<ReturnType<typeof sourceCostWorkerInputs>>;
      subjects: { candidate: typeof candidateArtifact; control: typeof controlSnapshot };
      historical: {
        checkout: typeof baselineIdentity;
        outputs: Awaited<ReturnType<typeof sourceCostHistoricalOutputs>>;
      };
    }
  | undefined;
if (strictJsComparison) {
  assert.ok(controlSnapshot);
  workerProof = {
    schema: 1,
    checkout: identity,
    sdkOutputs: await sourceCostWorkerInputs(root, build.compilerOutputs),
    subjects: { candidate: candidateArtifact, control: controlSnapshot },
    historical: {
      checkout: baselineIdentity,
      outputs: await sourceCostHistoricalOutputs(baseline),
    },
  };
  workerProofPath = join(out, 'worker-proof.json');
  await writeReport(workerProofPath, workerProof);
  workerProofSHA256 = hash(await readFile(workerProofPath));
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
  if (workerProof && workerProofPath) {
    assert.equal(hash(await readFile(workerProofPath)), workerProofSHA256, 'worker proof changed');
    assert.deepEqual(
      await sourceCostHistoricalOutputs(baseline),
      workerProof.historical.outputs,
      'historical SDK outputs changed',
    );
    assert.deepEqual(
      await sourceCostWorkerInputs(root, build.compilerOutputs),
      workerProof.sdkOutputs,
      'worker SDK outputs changed',
    );
  }
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
    ...(strictJsComparison
      ? { strictJsComparison, workerProofSHA256, workerProof, nativeRebuilds }
      : {}),
    compilerInputDifferences,
    sourceAlgorithmDifferences,
    ...(strictNative
      ? {
          nativeRebuilds,
          restriction:
            'Strict native comparisons require stripped symbols; keep is refused because debug paths are not reproducible across output directories.',
        }
      : {}),
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
          ...(workerProofPath ? [workerProofPath, workerProofSHA256 as string] : []),
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
  'modulePreparationMs',
  'postCheckMs',
  'beforePreparationRssBytes',
  'beforePreparationHeapUsedBytes',
  'beforePreparationExternalBytes',
  'frontendHeapTotalBytes',
  'frontendArrayBufferBytes',
  'heapTotalBytes',
  'arrayBufferBytes',
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
  ...(strictJsComparison
    ? { strictJsComparison, workerProofSHA256, workerProof, nativeRebuilds }
    : {}),
  compilerInputDifferences,
  sourceAlgorithmDifferences,
  ...(strictNative
    ? {
        nativeRebuilds,
        restriction:
          'Strict native comparisons require stripped symbols; keep is refused because debug paths are not reproducible across output directories.',
      }
    : {}),
  startedAt,
  finishedAt: new Date().toISOString(),
  scope:
    'Frozen flattened whole-program inputs, old Canonical/Dense controls, current flat TS control and compiled A0 frontend. Parser/checker plus one historical C text emitter. Frontend instantiation/upload/typed-IR decoding included. Graph I/O, shipping CLI startup, formatter, model inference and generated-target execution excluded. Every fresh process preloads the common candidate SDK and its selected artifact; candidate artifact also preloaded for historical and TS controls. Per-sample preload records identify every component, hash and size, separating JavaScript text from Wasm bytes. Artifact validation and module compilation are outside frontend/pipeline phases; fresh-child wall time includes process startup, preparation and final proof checks. No official source cutover or no-regression conclusion is implied.',
  protocol:
    'Reuse the archived frontend experiment input corpus and rotated fresh-process protocol; one discarded warmup round and seven measured rounds. Every arm uses the historical baseline C text emitter, so frontend IR is compared through one fixed backend even when frontend artifact code generation changes. Every emitted C hash must match the baseline control. That control must match the frozen reference after the explicitly recorded compiler-version banner substitution. ' +
    (strictJsComparison
      ? 'JS compiled-backend mode requires a cold parent re-emission with exact compiler outputs/configuration and SDK/source inventory, the same raw and normalized A0 closure/count and eight structural API signatures, identical common compiler implementation/configuration, explicit host-word IO and optimization, same arena/libc/builtins/toolchain, exact generic-arena rebuild and strict C native rebuild. A hashed immutable parent proof binds every worker to the actual component and SDK bytes; compiler rebuilding never occurs per worker. JavaScript text bytes are distinct from arena Wasm bytes. Module preparation includes artifact/SDK validation plus fresh ESM import and Wasm module compilation outside frontendMs, and remains inside child wall. First-call JS lazy JIT is included in frontendMs. No same-process warm cohort or total engine-memory equivalence is claimed.'
      : sourceAlgorithm
        ? 'Source-algorithm mode requires two freshly recorded C-derived artifacts with identical compiler/host inputs, compiler version, consumed structural API signatures, ABI, runtime, libraries, toolchain, headers, effective compiler command, frontend emission options and complete compile/link flags. Only A0 source closure, normalized source hash and function count may differ and all differences are recorded. Both artifacts reproduce their own exact C and complete Wasm/build record through their existing fresh builders. Legacy manifests are ineligible.'
        : compilerCodegen
          ? 'Compiler-codegen mode requires two freshly recorded C-derived artifacts: identical A0 source closure/count, ABI, runtime, libraries, Clang/LLD and compiler build versions, frontend emission options and complete normalized compile/link flags. Both artifacts reproduce exact C through their own fresh compilers; complete compiler inventories and all differing inputs are recorded. Legacy manifests are ineligible.'
          : 'Compiled-backend mode requires the same A0 source closure/count, generic arena runtime hashes, libc/builtins and Clang/LLD versions; backend code generation, feature requirements and stack settings are separately recorded in the complete build manifests and are not claimed matched.'),
  workerSha256: workerSHA256,
  historicalEmitterBanner,
  frozenEmitterBanner,
  preparedInputs: Object.fromEntries(preparedInputs),
  inputIndexSHA256,
  artifact: {
    sha256: candidateArtifact.preload.artifactSha256,
    sourceSha256: build.sourceSHA256,
    bytes: strictJsComparison
      ? candidateArtifact.preload.totalArtifactBytes
      : candidateArtifact.preload.totalWasmBytes,
    ...candidateArtifact.preload,
  },
  controlArtifact: controlBuild,
  controlPreload: controlSnapshot?.preload,
  nativeBuild: build,
  memoryMethod:
    'Live frontend RSS/heap/external/arrayBuffer memory captured before emission. Module preparation and pre-preparation memory are separately recorded; process/SDK import startup remains in child wall. Initial peak/live RSS exposes any inherited launch or preload floor; maxRSS alone cannot establish small-cell frontend parity. JS engine code/JIT/GC cannot be isolated by these process counters. wasmLinearMemoryBytes includes only retained Wasm buffers (arena-only for JS), not JS heap/code/JIT/GC; no cross-engine total-memory equivalence is implied.',
  runtime: {
    node: process.version,
    v8: process.versions.v8,
    arch: process.arch,
    platform: process.platform,
  },
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
