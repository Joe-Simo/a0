/** Internal immutable controller/worker handoff; never a public loader validation option. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { committedTree } from './measurement-checkout.js';
import type { sourceCostArtifact } from './source-cost-artifact.js';
import { sourceCostInputs } from './source-cost-control.js';
import { jsCompilerOutputPaths } from './source-js-inputs.js';

const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export const SOURCE_COST_WORKER_MODULES = [
  'tools/source-cost-worker',
  'tools/source-cost-worker-proof',
  'tools/source-cost-artifact',
  'tools/source-cost-control',
  'tools/source-native-load',
  'tools/source-js-artifact',
  'tools/source-js-inputs',
  'tools/measurement-checkout',
  'tools/wasm-stack-bound',
];

export async function sourceCostWorkerInputs(root: string, sdkOutputs: unknown) {
  const paths = [
    ...new Set([
      ...sourceCostInputs(sdkOutputs, 'SDK output').map((input) => input.path),
      ...SOURCE_COST_WORKER_MODULES.map((path) => `dist/${path}.js`),
    ]),
  ].sort();
  return Promise.all(
    paths.map(async (path) => ({ path, sha256: hash(await readFile(join(root, path))) })),
  );
}

export async function sourceCostHistoricalOutputs(root: string) {
  const tracked = execFileSync('git', ['ls-files', 'src/*.ts'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  assert.ok(tracked, 'historical SDK source inventory missing');
  return Promise.all(
    tracked
      .split('\n')
      .sort()
      .map(async (path) => ({
        path: `dist/${path.slice(0, -3)}.js`,
        sha256: hash(await readFile(join(root, `dist/${path.slice(0, -3)}.js`))),
      })),
  );
}

export async function readSourceCostWorkerProof(
  root: string,
  path: string,
  sha256: string,
  historicalRoot: string,
) {
  assert.match(sha256, /^[0-9a-f]{64}$/, 'invalid worker proof hash');
  const bytes = await readFile(path);
  assert.equal(hash(bytes), sha256, 'worker proof changed');
  const proof = JSON.parse(bytes.toString('utf8')) as {
    schema: number;
    checkout: ReturnType<typeof committedTree>;
    sdkOutputs: { path: string; sha256: string }[];
    subjects: Record<string, Awaited<ReturnType<typeof sourceCostArtifact>>>;
    historical: {
      checkout: ReturnType<typeof committedTree>;
      outputs: Awaited<ReturnType<typeof sourceCostHistoricalOutputs>>;
    };
  };
  assert.equal(proof.schema, 1);
  assert.deepEqual(committedTree(root), proof.checkout, 'worker SDK checkout changed');
  const outputs = sourceCostInputs(proof.sdkOutputs, 'worker SDK output');
  assert.deepEqual(
    outputs.map((input) => input.path).sort(),
    [
      ...new Set([
        ...jsCompilerOutputPaths(root),
        ...SOURCE_COST_WORKER_MODULES.map((module) => `dist/${module}.js`),
      ]),
    ].sort(),
    'worker SDK inventory incomplete',
  );
  for (const output of outputs)
    assert.equal(
      hash(await readFile(join(root, output.path))),
      output.sha256,
      `worker SDK output changed: ${output.path}`,
    );
  assert.deepEqual(
    committedTree(historicalRoot),
    proof.historical.checkout,
    'historical SDK checkout changed',
  );
  sourceCostInputs(proof.historical.outputs, 'historical SDK output');
  assert.deepEqual(
    await sourceCostHistoricalOutputs(historicalRoot),
    proof.historical.outputs,
    'historical SDK output changed',
  );
  return proof;
}

export function verifySourceCostWorkerSubject(
  actual: Awaited<ReturnType<typeof sourceCostArtifact>>,
  expected: Awaited<ReturnType<typeof sourceCostArtifact>> | undefined,
): void {
  assert.ok(expected, 'worker subject absent from parent proof');
  assert.deepEqual(actual, expected, 'worker artifact differs from strict parent snapshot');
}
