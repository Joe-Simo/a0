/** Recover the exact experiment in isolated Git worktrees and run its original tools. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeReport } from '../../../../tools/scrub-results.ts';

const archive = dirname(fileURLToPath(import.meta.url));
const metadata = JSON.parse(readFileSync(join(archive, 'metadata.json'), 'utf8'));
const args = process.argv.slice(2);
const importOnly = args.includes('--import-only');
const positional = args.filter((arg) => arg !== '--import-only');
assert.equal(positional.length, 1, 'usage: node replay.mjs NEW_OUTPUT_DIRECTORY [--import-only]');
const output = resolve(positional[0]);
assert.ok(!existsSync(output), 'output directory must be new; existing artifacts are never reused');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function verifyFile(path, expected) {
  const bytes = readFileSync(path);
  assert.equal(bytes.length, expected.bytes);
  assert.equal(sha(bytes), expected.sha256);
  return bytes;
}
const bundle = join(archive, metadata.bundle.path);
const frozenSource = join(archive, metadata.originalSource.path);
const bundleBytes = verifyFile(bundle, metadata.bundle);
const sourceBytes = verifyFile(frozenSource, metadata.originalSource);
assert.equal(metadata.bundle.format, 'git-bundle-v2');
assert.equal(metadata.bundle.storage, 'binary-file');
const header = bundleBytes.subarray(0, bundleBytes.indexOf('\n\n')).toString('utf8').split('\n');
assert.equal(header[0], '# v2 git bundle');
assert.deepEqual(
  header.filter((line) => line.startsWith('-')).map((line) => line.slice(1).split(' ')[0]),
  metadata.bundle.prerequisites,
);
assert.deepEqual(
  header.filter((line) => /^[0-9a-f]{40} /.test(line)).sort(),
  metadata.bundle.refs.map((ref) => `${ref.commit} ${ref.name}`).sort(),
);

const env = { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' };
for (const key of [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
]) delete env[key];
function git(cwd, args, allowFailure = false) {
  const result = spawnSync('git', args, {
    cwd, env, encoding: 'utf8', maxBuffer: 16 << 20, timeout: 300000,
  });
  if (!allowFailure) assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result;
}
const sourceRoot = git(archive, ['rev-parse', '--show-toplevel']).stdout.trim();
const baselineCommit = metadata.subjects.baseline.commit;
const proofCommit = metadata.subjects.proof.commit;
git(sourceRoot, ['cat-file', '-e', `${baselineCommit}^{commit}`]);
mkdirSync(dirname(output), { recursive: true });
mkdirSync(output);
const logs = join(output, 'logs');
mkdirSync(logs);
mkdirSync(join(output, 'tmp'));
env.TMPDIR = join(output, 'tmp');
const commands = [];
function run(label, command, args, cwd, extraEnv = {}) {
  console.log(`${label} ...`);
  const stdout = openSync(join(logs, `${label}.stdout.log`), 'wx');
  const stderr = openSync(join(logs, `${label}.stderr.log`), 'wx');
  let result;
  try {
    result = spawnSync(command, args, {
      cwd, env: { ...env, ...extraEnv }, stdio: ['ignore', stdout, stderr], timeout: 1800000,
    });
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
  commands.push({ phase: label, exitCode: result.status });
  assert.equal(result.status, 0, `${label}: ${result.error?.message ?? ''}\n${
    readFileSync(join(logs, `${label}.stderr.log`), 'utf8').slice(-12000)
  }`);
}

// Fetch only prerequisite ancestry into a fresh source, then make an actual independent clone.
// No feature/proof object is available through a local object directory or an alternate.
const prerequisiteRepository = join(output, 'prerequisite.git');
git(output, ['init', '--bare', prerequisiteRepository]);
run('fetch-prerequisite', 'git', [
  '-C', prerequisiteRepository, 'fetch', '--no-tags', '--no-write-fetch-head',
  sourceRoot, `${baselineCommit}:refs/heads/prerequisite`,
], output);
git(prerequisiteRepository, ['symbolic-ref', 'HEAD', 'refs/heads/prerequisite']);
const repository = join(output, 'repository');
run('clone-prerequisite', 'git', [
  'clone', '--no-local', '--no-checkout', '--single-branch', '--branch', 'prerequisite',
  prerequisiteRepository, repository,
], output);
assert.ok(!existsSync(join(repository, '.git/objects/info/alternates')));
for (const name of ['feature', 'proof']) {
  assert.notEqual(
    git(repository, ['cat-file', '-e', `${metadata.subjects[name].commit}^{commit}`], true).status,
    0,
    `${name} must be absent before bundle import`,
  );
}
run('verify-bundle', 'git', ['bundle', 'verify', bundle], repository);
run('import-bundle', 'git', [
  'fetch', '--no-tags', bundle,
  ...metadata.bundle.refs.map((ref) => `${ref.name}:${ref.name}`),
], repository);
for (const subject of Object.values(metadata.subjects)) {
  assert.equal(git(repository, ['rev-parse', `${subject.commit}^{tree}`]).stdout.trim(), subject.tree);
  if (subject.parent) {
    assert.equal(git(repository, ['rev-parse', `${subject.commit}^`]).stdout.trim(), subject.parent);
  }
}
assert.equal(
  Number(git(repository, ['rev-list', '--count', proofCommit, `^${baselineCommit}`]).stdout.trim()),
  metadata.bundle.commitCount,
);
const baseline = join(output, 'baseline');
const candidate = join(output, 'candidate');
git(repository, ['worktree', 'add', '--detach', baseline, baselineCommit]);
git(repository, ['worktree', 'add', '--detach', candidate, proofCommit]);
const report = {
  schema: 1,
  status: 'import-passed',
  scope: 'Exact source recovery and correctness replay only; no timing samples or default adoption.',
  bundle: metadata.bundle,
  subjects: metadata.subjects,
  prerequisiteOnlyClone: true,
  noLocalObjectAlternates: true,
  featureAndProofAbsentBeforeImport: true,
  exactCommitTreesAndParentsRecovered: true,
  detachedBaselineAndProofWorktrees: true,
  generatedCRewritten: false,
  featureReimplemented: false,
  timingClaims: false,
};
if (!importOnly) {
  assert.ok(env.A0_CLANG && env.A0_CLANGXX, 'set explicit A0_CLANG and A0_CLANGXX executables');
  const nativeEnv = { CC: env.A0_CLANG };
  for (const [name, directory] of [['baseline', baseline], ['candidate', candidate]]) {
    run(`${name}-dependencies`, 'bun', ['install', '--frozen-lockfile'], directory);
    run(`${name}-build`, 'bun', ['run', 'build'], directory);
  }
  const prepared = join(output, 'baseline-prepared');
  const stages = join(output, 'baseline-stages');
  run('baseline-prepare', process.execPath, [
    'dist/tools/c-arena-stage.js', '--prepare', prepared,
  ], baseline, nativeEnv);
  assert.deepEqual(readFileSync(join(prepared, 'compiler-source.a0')), sourceBytes);
  run('baseline-c-only-stages', 'sh', [
    'tools/c-arena-stage.sh', prepared, stages,
  ], baseline, nativeEnv);
  assert.deepEqual(readFileSync(join(stages, 'compiler-source.a0')), sourceBytes);
  for (const stage of [2, 3, 4]) {
    verifyFile(join(stages, `stage${stage}/module.c`), metadata.baselineStableC);
  }
  // Exact baseline identities are established before the original candidate runner is invoked.
  const artifacts = join(output, 'controls');
  run('candidate-original-experiment', process.execPath, [
    metadata.originalProof.experimentRunner,
    join(stages, 'stage4/module.c'), frozenSource, artifacts,
  ], candidate, nativeEnv);
  run('candidate-original-host-mutation', process.execPath, [
    metadata.originalProof.hostMutationRunner, artifacts, env.A0_CLANG, env.A0_CLANGXX,
  ], candidate, nativeEnv);
  const experiment = JSON.parse(readFileSync(join(artifacts, 'experiment.json'), 'utf8'));
  const mutation = JSON.parse(readFileSync(join(artifacts, 'original-host-mutation.json'), 'utf8'));
  assert.equal(experiment.status, 'correctness-passed-default-not-adopted');
  assert.equal(experiment.sameInput.wrapperCount, metadata.sameS0CandidateC.wrapperCount);
  verifyFile(join(artifacts, 'same-S0-candidate.c'), metadata.sameS0CandidateC);
  const reproduction = experiment.reproduction;
  assert.equal(reproduction.status, 'passed');
  assert.equal(reproduction.sourceBytes, metadata.candidateSelfReproduction.sourceBytes);
  assert.equal(reproduction.sourceSHA256, metadata.candidateSelfReproduction.sourceSHA256);
  assert.deepEqual(reproduction.rows.map((row) => row.stage), [2, 3, 4]);
  for (const row of reproduction.rows) {
    assert.equal(row.accepted, true);
    assert.equal(row.nativeBuilt, true);
    assert.equal(row.cBytes, metadata.candidateSelfReproduction.stableCBytes);
    assert.equal(row.cSHA256, metadata.candidateSelfReproduction.stableCSHA256);
  }
  assert.equal(experiment.host.status, 'passed');
  assert.equal(experiment.host.results.length, 12);
  assert.ok(experiment.host.results.every((row) => row.status === 'passed'));
  assert.equal(mutation.status, 'passed');
  assert.equal(mutation.generatedCByteIdentical, true);
  assert.equal(mutation.results.length, 12);
  assert.ok(mutation.results.every((row) => row.status === 'passed'));
  Object.assign(report, {
    status: 'correctness-replay-passed-no-default-adoption',
    baselineSource: metadata.originalSource,
    baselineStableC: metadata.baselineStableC,
    baselineNativeStages: [2, 3, 4],
    sameS0CandidateC: metadata.sameS0CandidateC,
    candidateSelfReproduction: metadata.candidateSelfReproduction,
    independentHostControlsPassed: experiment.host.results.length,
    originalHostMutationControlsPassed: mutation.results.length,
    defaultAdopted: false,
    seedAdopted: false,
  });
}
for (const directory of [baseline, candidate]) {
  assert.equal(git(directory, ['status', '--porcelain', '--untracked-files=no']).stdout, '');
}
assert.deepEqual(readFileSync(frozenSource), sourceBytes);
verifyFile(bundle, metadata.bundle);
report.commands = commands;
await writeReport(join(output, 'replay-report.json'), report);
console.log(`${report.status}; isolated artifacts: ${output}`);
