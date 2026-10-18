/** Bounded, non-shipping relink experiment. The normal builders remain unchanged. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { writeReport } from '../../../dist/tools/scrub-results.js';
import { wasmStackBound } from '../../../dist/tools/wasm-stack-bound.js';

export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const identity = () => ({
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim(),
  dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()),
});

export async function relinkStack({ input, sysroot, builtins, linker, resource, out }) {
  const source = identity();
  assert.equal(source.dirty, false, 'experiment requires a committed clean source');
  const buildBytes = await readFile(join(input, 'build.json'));
  assert.equal(
    hash(buildBytes),
    '17554161dadfbb44e0c9e63081e3afc3b124bf01d04d68ddcb2e95490c7040cb',
  );
  const build = JSON.parse(buildBytes);
  assert.equal(build.frontendABI, 3);
  assert.equal(build.diagnosticPorts, 'arena-v1');
  assert.deepEqual(build.requiredWasmFeatures, []);
  assert.equal(build.compilerCheckout.dirty, false);
  const originals = {};
  for (const name of ['frontend.o', 'frontend.wasm', 'module.c', 'api.h', 'driver.c'])
    originals[name] = await readFile(join(input, name));
  assert.equal(hash(originals['frontend.wasm']), build.wasmSHA256);
  assert.equal(hash(originals['module.c']), build.cSHA256);
  assert.equal(hash(originals['driver.c']), build.driverSHA256);
  const bound = wasmStackBound(originals['frontend.wasm']);
  const stackBytes = Math.ceil(bound.maxLinearStackBytes / 65536) * 65536;
  assert.ok(stackBytes > 0 && stackBytes < build.stackBytes);
  const roots = { artifact: input, checkout: process.cwd(), resource, sysroot };
  const dependencies = [
    ...build.compilerInputs,
    ...build.modules,
    ...build.nativeInputs,
    ...build.nativeCompileInputs.map((row) => {
      const found = /^<([^>]+)>\/(.+)$/.exec(row.path);
      assert.ok(found && roots[found[1]], 'unsupported recorded native input');
      return { ...row, path: join(roots[found[1]], found[2]), label: row.path };
    }),
    {
      path: join(sysroot, 'lib/wasm32-wasi/libc.a'),
      label: '<sysroot>/lib/wasm32-wasi/libc.a',
      sha256: build.libcSHA256,
    },
    { path: builtins, label: '<builtins>', sha256: build.builtinsSHA256 },
  ];
  for (const row of dependencies)
    assert.equal(hash(await readFile(row.path)), row.sha256, row.label ?? row.path);
  const linkerBytes = await readFile(await realpath(linker));
  const version = execFileSync(linker, ['--version'], { encoding: 'utf8' }).trim();
  assert.equal(version, build.linker);
  const baselineFlags = build.linkerFlags;
  const stackFlag = `stack-size=${build.stackBytes}`;
  assert.equal(baselineFlags.filter((flag) => flag === stackFlag).length, 1);
  const candidateFlags = baselineFlags.map((flag) =>
    flag === stackFlag ? `stack-size=${stackBytes}` : flag,
  );
  assert.equal(candidateFlags.filter((flag, index) => flag !== baselineFlags[index]).length, 1);
  await mkdir(join(out, 'inputs'), { recursive: true });
  for (const [name, bytes] of Object.entries(originals))
    await writeFile(join(out, 'inputs', name), bytes);
  await writeFile(join(out, 'inputs/build.json'), buildBytes);
  const proofs = {};
  for (const [name, flags] of [
    ['baseline', baselineFlags],
    ['candidate', candidateFlags],
  ]) {
    const directory = join(out, name);
    await mkdir(directory, { recursive: true });
    const actual = flags.map((flag) =>
      flag
        .replaceAll('<artifact>/frontend.o', join(out, 'inputs/frontend.o'))
        .replaceAll('<artifact>/frontend.wasm', join(directory, 'frontend.wasm'))
        .replaceAll('<wasi-sysroot>', sysroot)
        .replaceAll('<builtins>', builtins),
    );
    assert.ok(
      actual.every((flag) => !flag.includes('<')),
      'unresolved link argument',
    );
    const linked = spawnSync(linker, actual, { encoding: 'utf8', timeout: 120_000 });
    assert.equal(linked.status, 0, linked.stderr);
    const bytes = await readFile(join(directory, 'frontend.wasm'));
    if (name === 'baseline')
      assert.deepEqual(bytes, originals['frontend.wasm'], 'original link does not reproduce');
    const proof = wasmStackBound(bytes);
    assert.deepEqual(proof.functions, bound.functions, 'linked function/frame/call proof changed');
    assert.deepEqual(proof.exports, bound.exports, 'exported frame bounds changed');
    assert.deepEqual(proof.opcodeHistogram, bound.opcodeHistogram, 'instruction inventory changed');
    assert.ok(proof.maxLinearStackBytes <= (name === 'baseline' ? build.stackBytes : stackBytes));
    await writeReport(join(directory, 'stack-proof.json'), proof);
    proofs[name] = proof;
  }
  const heapDelta = build.stackBytes - stackBytes;
  assert.equal(
    proofs.baseline.stackGlobal.initialValue - proofs.candidate.stackGlobal.initialValue,
    heapDelta,
  );
  for (const [name, bytes] of Object.entries(originals))
    assert.deepEqual(await readFile(join(input, name)), bytes);
  for (const row of dependencies)
    assert.equal(hash(await readFile(row.path)), row.sha256, row.label ?? row.path);
  assert.equal(hash(await readFile(await realpath(linker))), hash(linkerBytes));
  assert.deepEqual(identity(), source);
  const record = {
    schema: 1,
    kind: 'research-only-stack-relink',
    source,
    originalBuildSHA256: hash(buildBytes),
    originalBuildCheckout: build.compilerCheckout,
    objectSHA256: hash(originals['frontend.o']),
    cSHA256: build.cSHA256,
    sourceSHA256: build.sourceSHA256,
    linker: { version, sha256: hash(linkerBytes) },
    libcSHA256: build.libcSHA256,
    builtinsSHA256: build.builtinsSHA256,
    originalStackBytes: build.stackBytes,
    candidateStackBytes: stackBytes,
    heapDelta,
    baselineFlags,
    candidateFlags,
    verifiedRecordedInputs: dependencies.length,
    artifacts: Object.fromEntries(
      Object.entries(proofs).map(([name, proof]) => [
        name,
        {
          bytes: proof.artifactBytes,
          sha256: proof.artifactSHA256,
          functions: proof.functions.length,
          conservativeLinearStackBoundBytes: proof.maxLinearStackBytes,
        },
      ]),
    ),
    scope:
      'Original object and compile dependencies retained; one normalized link stack argument differs. No recompilation or production build-record/default change.',
  };
  await writeReport(join(out, 'relink.json'), record);
  return record;
}

export function configuration() {
  const paths = {};
  for (const name of ['input', 'sysroot', 'builtins', 'linker', 'resource', 'out']) {
    const value = process.env[`A0_STACK_${name.toUpperCase()}`];
    assert.ok(value, `A0_STACK_${name.toUpperCase()} required`);
    paths[name] = resolve(value);
  }
  return paths;
}
