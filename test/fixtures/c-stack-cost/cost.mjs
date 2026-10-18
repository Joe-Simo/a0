/** Isolated fixed-object experiment using the existing shared source-cost worker. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { availableParallelism, cpus } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { compile } from '../../../dist/src/backends.js';
import { committedTree } from '../../../dist/tools/measurement-checkout.js';
import { writeReport } from '../../../dist/tools/scrub-results.js';
import { sourceCostArtifact } from '../../../dist/tools/source-cost-artifact.js';
import { verifySourceCostFrozenC } from '../../../dist/tools/source-cost-control.js';
import {
  readSourceCostWorkerProof,
  sourceCostHistoricalOutputs,
  sourceCostWorkerInputs,
} from '../../../dist/tools/source-cost-worker-proof.js';
import { jsCompilerOutputPaths } from '../../../dist/tools/source-js-inputs.js';
import { prepareSourceFrontend } from '../../../dist/tools/source-native-load.js';
import { loadSource, systemLoadTriple } from '../../../dist/tools/system-load.js';
import { wasmStackBound } from '../../../dist/tools/wasm-stack-bound.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
assert.equal(process.cwd(), root, 'run from this checkout');
const mode = process.argv[2];
assert.ok(mode === 'prepare' || mode === 'collect', 'expected prepare or collect');
const out = resolve(process.argv[3] ?? '.a0-tmp/c-stack-cost');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJSON = async (path) => JSON.parse(await readFile(path, 'utf8'));
async function requireMissing(path) {
  try {
    await readFile(path);
    assert.fail('existing evidence must be preserved; use a separate output directory');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
const archive = join(root, 'results/source-frontend-c-stack-relink-artifacts.zip');
const archiveSHA256 = '200d40ab0eab525278d2abe7e9e75fb0b51da705d34647591241ea7a274a9b50';
const workerPath = join(root, 'dist/tools/source-cost-worker.js');
const protocolPath = join(root, 'experiments/unification/c-stack-cost/protocol.md');
const arms = ['flat-a0-control', 'flat-a0'];
const measuredRounds = 11;

function sequence(units) {
  const result = [];
  for (let round = -1; round < measuredRounds; round++) {
    const rotation = round + 1;
    for (let offset = 0; offset < units.length; offset++) {
      const unit = units[(rotation + offset) % units.length];
      for (let position = 0; position < arms.length; position++) {
        const arm = arms[(rotation + unit.id + position) % arms.length];
        result.push({
          index: result.length,
          round,
          unit: unit.unit,
          id: unit.id,
          arm,
          warmup: round < 0,
        });
      }
    }
  }
  return result;
}

if (mode === 'prepare') {
  const source = committedTree(root);
  assert.equal(hash(await readFile(archive)), archiveSHA256);
  await mkdir(out, { recursive: true });
  await requireMissing(join(out, 'preparation.json'));
  await requireMissing(join(out, 'status.json'));
  const extraction = spawnSync(
    'python3',
    [
      '-c',
      `
import hashlib,json,pathlib,sys,zipfile
out=pathlib.Path(sys.argv[2])
with zipfile.ZipFile(sys.argv[1]) as z:
 assert z.testzip() is None
 members=json.loads(z.read('members.json'))['members']
 assert len(members)==38 and set(z.namelist())=={x['path'] for x in members}|{'members.json'}
 for row in members:
  data=z.read(row['path'])
  assert len(data)==row['bytes'] and hashlib.sha256(data).hexdigest()==row['sha256']
 names=['inputs/build.json','final/relink.json','final/baseline/frontend.wasm','final/baseline/stack-proof.json','final/candidate/frontend.wasm','final/candidate/stack-proof.json','frozen/index.json']+['frozen/u%d.json'%n for n in range(6)]
 for name in names:
  path=out/'archive'/name
  path.parent.mkdir(parents=True,exist_ok=True)
  path.write_bytes(z.read(name))
`,
      archive,
      out,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(extraction.status, 0, extraction.stderr);
  const originalText = await readFile(join(out, 'archive/inputs/build.json'), 'utf8');
  const original = JSON.parse(originalText);
  const relinkText = await readFile(join(out, 'archive/final/relink.json'), 'utf8');
  const relink = JSON.parse(relinkText);
  assert.equal(hash(originalText), relink.originalBuildSHA256);
  assert.deepEqual(
    relink.baselineFlags.filter((value, index) => value !== relink.candidateFlags[index]),
    ['stack-size=16777216'],
  );
  assert.deepEqual(
    relink.candidateFlags.filter((value, index) => value !== relink.baselineFlags[index]),
    ['stack-size=131072'],
  );
  const subjects = {};
  for (const [side, arm] of [
    ['baseline', 'control'],
    ['candidate', 'candidate'],
  ]) {
    const directory = join(out, side);
    await mkdir(directory, { recursive: true });
    const bytes = await readFile(join(out, `archive/final/${side}/frontend.wasm`));
    const recorded = await readJSON(join(out, `archive/final/${side}/stack-proof.json`));
    const proof = wasmStackBound(bytes);
    assert.deepEqual(proof, recorded);
    assert.equal(proof.functions.length, 109);
    assert.equal(proof.maxLinearStackBytes, 127888);
    assert.equal(hash(bytes), relink.artifacts[side].sha256);
    await writeFile(join(directory, 'frontend.wasm'), bytes);
    if (side === 'baseline') await writeFile(join(directory, 'build.json'), originalText);
    else
      await writeReport(join(directory, 'build.json'), {
        ...original,
        stackBytes: relink.candidateStackBytes,
        wasmBytes: bytes.length,
        wasmSHA256: hash(bytes),
        linkerFlags: relink.candidateFlags,
        researchOnlyStackRelink: {
          kind: 'derived-measurement-descriptor-not-production-build',
          originalBuildSHA256: hash(originalText),
          relinkRecordSHA256: hash(relinkText),
          correctnessArchiveSHA256: archiveSHA256,
          productionBuildTimeGuardAcceptanceClaimed: false,
        },
      });
    subjects[arm] = await sourceCostArtifact(directory);
  }
  const candidateBuild = { ...subjects.candidate.build };
  for (const key of [
    'stackBytes',
    'wasmBytes',
    'wasmSHA256',
    'linkerFlags',
    'researchOnlyStackRelink',
  ])
    delete candidateBuild[key];
  const controlBuild = { ...subjects.control.build };
  for (const key of ['stackBytes', 'wasmBytes', 'wasmSHA256', 'linkerFlags'])
    delete controlBuild[key];
  assert.deepEqual(candidateBuild, controlBuild);
  const historicalOutputs = await sourceCostHistoricalOutputs(root);
  const compilerOutputs = await Promise.all(
    jsCompilerOutputPaths(root).map(async (path) => ({
      path,
      sha256: hash(await readFile(join(root, path))),
    })),
  );
  const sdkOutputs = await sourceCostWorkerInputs(root, compilerOutputs);
  const workerProof = {
    schema: 1,
    checkout: source,
    sdkOutputs,
    subjects,
    historical: { checkout: source, outputs: historicalOutputs },
  };
  await writeReport(join(out, 'worker-proof.json'), workerProof);
  const workerProofSHA256 = hash(await readFile(join(out, 'worker-proof.json')));
  await readSourceCostWorkerProof(root, join(out, 'worker-proof.json'), workerProofSHA256, root);
  const units = await readJSON(join(out, 'archive/frozen/index.json'));
  assert.equal(units.length, 6);
  const inputs = [];
  for (const unit of units) {
    const bytes = await readFile(join(out, 'archive/frozen', unit.input));
    assert.equal(hash(bytes), unit.inputSHA256);
    assert.equal(
      hash(bytes),
      hash(await readFile(join(root, 'experiments/unification/frontend-a0/inputs', unit.input))),
    );
    await writeFile(join(out, unit.input), bytes);
    const input = JSON.parse(bytes);
    const outputs = [];
    for (const side of ['baseline', 'candidate']) {
      const prepared = await prepareSourceFrontend(join(out, side));
      const frontend = prepared.instantiate();
      try {
        const result = frontend.parse(input.unified);
        assert.ok(result.ok, `${side}/${unit.unit}`);
        assert.equal(result.typed.functions.length, unit.functions);
        const output = compile(result.typed, 'c').text;
        verifySourceCostFrozenC(output, unit.outputSHA256);
        outputs.push(output);
      } finally {
        frontend.close();
      }
    }
    assert.equal(outputs[0], outputs[1]);
    inputs.push({
      ...unit,
      sourceSHA256: hash(input.unified),
      outputBytes: Buffer.byteLength(outputs[0]),
      measuredOutputSHA256: hash(outputs[0]),
    });
  }
  assert.deepEqual(committedTree(root), source);
  await writeReport(join(out, 'preparation.json'), {
    schema: 1,
    source,
    protocolSHA256: hash(await readFile(protocolPath)),
    archiveSHA256,
    workerSHA256: hash(await readFile(workerPath)),
    workerProofSHA256,
    inputs,
    sequence: sequence(inputs),
    host: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cpus: cpus().length,
      availableParallelism: availableParallelism(),
      cpuModel: cpus()[0]?.model,
      loadSource: loadSource(),
    },
    scope: 'Preparation and correctness checks only; no measured cost sample collected.',
  });
  console.log(
    `PASS preparation: ${inputs.length} inputs, ${sequence(inputs).length} preregistered fresh children; no collection`,
  );
} else {
  const preparationPath = join(out, 'preparation.json');
  const preparationBytes = await readFile(preparationPath);
  const preparation = JSON.parse(preparationBytes);
  const workerProofPath = join(out, 'worker-proof.json');
  async function verifyUnchanged() {
    assert.deepEqual(committedTree(root), preparation.source);
    assert.equal(hash(await readFile(preparationPath)), hash(preparationBytes));
    assert.equal(hash(await readFile(protocolPath)), preparation.protocolSHA256);
    assert.equal(hash(await readFile(archive)), preparation.archiveSHA256);
    assert.equal(hash(await readFile(workerPath)), preparation.workerSHA256);
    const proof = await readSourceCostWorkerProof(
      root,
      workerProofPath,
      preparation.workerProofSHA256,
      root,
    );
    for (const [side, key] of [
      ['baseline', 'control'],
      ['candidate', 'candidate'],
    ])
      assert.deepEqual(await sourceCostArtifact(join(out, side)), proof.subjects[key]);
    for (const input of preparation.inputs)
      assert.equal(hash(await readFile(join(out, input.input))), input.inputSHA256);
  }
  await verifyUnchanged();
  assert.deepEqual(preparation.sequence, sequence(preparation.inputs));
  assert.equal(preparation.sequence.length, 144);
  const load = systemLoadTriple();
  assert.ok(load[0] <= 10, `collection deferred: load ${load[0]}`);
  await mkdir(join(out, 'raw'), { recursive: true });
  const statusPath = join(out, 'status.json');
  await requireMissing(statusPath);
  const samples = [];
  const status = {
    source: preparation.source,
    preparationSHA256: hash(preparationBytes),
    startedAt: new Date().toISOString(),
    completed: false,
    attempted: 0,
    expected: 144,
    outcome: 'running',
  };
  await writeReport(statusPath, status);
  try {
    for (const cell of preparation.sequence) {
      await verifyUnchanged();
      const loadBeforeChild = systemLoadTriple();
      assert.ok(
        loadBeforeChild[0] <= 10,
        `collection stopped before cell ${cell.index}: load ${loadBeforeChild[0]}`,
      );
      const side = cell.arm === 'flat-a0-control' ? 'baseline' : 'candidate';
      const input = preparation.inputs.find((value) => value.id === cell.id);
      const childArguments = [
        workerPath,
        cell.arm,
        join(out, input.input),
        join(out, side),
        root,
        root,
        workerProofPath,
        preparation.workerProofSHA256,
      ];
      const start = performance.now();
      const child = spawnSync(process.execPath, childArguments, {
        cwd: root,
        encoding: 'utf8',
        timeout: 240_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      const wallMs = performance.now() - start;
      const loadAfterChild = systemLoadTriple();
      const prefix = join(out, 'raw', String(cell.index).padStart(3, '0'));
      await writeFile(`${prefix}.stdout`, child.stdout ?? '');
      await writeFile(`${prefix}.stderr`, child.stderr ?? '');
      const sample = {
        ...cell,
        loadBeforeChild,
        loadAfterChild,
        wallMs,
        exitStatus: child.status,
        signal: child.signal,
        error: child.error?.message,
        stdoutSHA256: hash(child.stdout ?? ''),
        stderrSHA256: hash(child.stderr ?? ''),
      };
      samples.push(sample);
      status.attempted = samples.length;
      await writeReport(join(out, 'samples.json'), samples);
      await writeReport(statusPath, status);
      assert.equal(
        child.status,
        0,
        `${input.unit}/${cell.arm}: ${child.error ?? ''}\n${child.stderr}`,
      );
      const measured = JSON.parse(child.stdout);
      const proof = await readJSON(workerProofPath);
      assert.deepEqual(
        measured.preload,
        proof.subjects[side === 'baseline' ? 'control' : 'candidate'].preload,
      );
      assert.equal(measured.outputSha256, input.measuredOutputSHA256);
      assert.equal(measured.outputBytes, input.outputBytes);
      for (const value of [
        measured.loadBefore,
        measured.loadAfter,
        ...loadBeforeChild,
        ...loadAfterChild,
      ])
        assert.ok(Number.isFinite(value) && value >= 0);
      assert.ok(
        measured.loadBefore <= 10 && measured.loadAfter <= 10 && loadAfterChild[0] <= 10,
        `loaded cell ${cell.index}; entire cohort invalid`,
      );
      for (const key of [
        'modulePreparationMs',
        'postCheckMs',
        'frontendMs',
        'emitCMs',
        'pipelineMs',
        'peakRssBytes',
        'frontendPeakRssBytes',
        'frontendRssBytes',
        'wasmLinearMemoryBytes',
      ])
        assert.ok(Number.isFinite(measured[key]) && measured[key] >= 0, key);
      for (const key of ['frontendCpu', 'pipelineCpu', 'processCpu', 'modulePreparationCpu'])
        for (const field of ['user', 'system'])
          assert.ok(
            Number.isFinite(measured[key][field]) && measured[key][field] >= 0,
            `${key}.${field}`,
          );
      sample.measurement = measured;
      await writeReport(join(out, 'samples.json'), samples);
      if ((cell.index + 1) % 12 === 0)
        console.log(`round ${cell.round} complete (${cell.index + 1}/144)`);
    }
    await verifyUnchanged();
    status.completed = true;
    status.outcome = 'pass';
  } catch (error) {
    status.outcome = 'failed-or-loaded-incomplete';
    status.failure = String(error);
    throw error;
  } finally {
    status.endedAt = new Date().toISOString();
    await writeReport(statusPath, status);
  }
}
