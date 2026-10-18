import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { makeIo, run } from '../src/core.js';
import {
  cStageOptimizerFrontend,
  prepareStandardCStageCompiler,
} from '../tools/c-stage-optimizer-experiment.js';
import { inspectNativeSourceArtifact } from '../tools/source-native-artifact.js';

test('compiler preparation retains contract-only dependencies after executable-call elimination', async () => {
  const frontend = await cStageOptimizerFrontend(process.env.A0_C_STAGE_FRONTEND_ARTIFACT);
  try {
    const original = `fn unused u32 -> u32
ret add p0 0
end
fn positive u32 -> bool
ret gt p0 0
end
fn stage u32 -> u32
ex 7 -> 7
pre call positive p0
post call positive r
dead call unused p0
same add p0 0
ret same
end
`;
    const prepared = prepareStandardCStageCompiler(frontend, original, 16_000_000, 'stage');
    assert.deepEqual(
      prepared.program.functions.map((fn) => fn.name),
      ['positive', 'stage'],
    );
    assert.deepEqual(prepared.report.removedFunctions, ['unused']);
    const stage = prepared.typed.byName.get('stage');
    assert.ok(stage?.spec);
    assert.equal(stage.spec.examples.length, 1);
    assert.equal(stage.spec.pre?.callee, 'positive');
    assert.equal(stage.spec.post?.callee, 'positive');
    assert.equal(run(stage, [17]), 17);
    const reparsed = frontend.parse(prepared.source);
    assert.ok(reparsed.ok, JSON.stringify(reparsed));
    const roundTripStage = reparsed.typed.byName.get('stage');
    assert.ok(roundTripStage);
    assert.equal(run(roundTripStage, [0xffff_ffff]), 0xffff_ffff);
  } finally {
    frontend.close();
  }
});

test('compiler preparation preserves affine IO effects and strict dead-result traps', async () => {
  const frontend = await cStageOptimizerFrontend(process.env.A0_C_STAGE_FRONTEND_ARTIFACT);
  try {
    const effects = prepareStandardCStageCompiler(
      frontend,
      'fn stage io -> io\na write p0 3\nb write a 4\nret b\nend\n',
      16_000_000,
      'stage',
    );
    const stage = effects.typed.byName.get('stage');
    assert.ok(stage);
    const token = makeIo([]);
    assert.equal(run(stage, [token]), token);
    assert.deepEqual(token.output, [3, 4]);
    const traps = prepareStandardCStageCompiler(
      frontend,
      'profile strict\nfn stage u32x2 u32 -> u32\nignored get p0 p1\nret 0\nend\n',
      16_000_000,
      'stage',
    );
    const strict = traps.typed.byName.get('stage');
    assert.ok(strict);
    assert.equal(strict.profile, 'strict');
    assert.equal(run(strict, [[11, 22], 1]), 0);
    assert.throws(() => run(strict, [[11, 22], 2]), /bounds/);
  } finally {
    frontend.close();
  }
});

test('explicit compiler checker rejects stale input inventories and binds provenance to loaded bytes', async () => {
  const original = resolve(process.env.A0_C_STAGE_FRONTEND_ARTIFACT ?? 'seed/source-frontend');
  const dir = await mkdtemp(join(tmpdir(), 'a0-optimizer-checker-'));
  const manifest = await readFile(join(original, 'build.json'));
  const wasm = await readFile(join(original, 'frontend.wasm'));
  const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  interface ArtifactBuild {
    modules: { sha256: string }[];
    nativeInputs: { sha256: string }[];
    sourceSHA256: string;
    cSHA256: string;
  }
  try {
    await copyFile(join(original, 'frontend.wasm'), join(dir, 'frontend.wasm'));
    for (const mutate of [
      (build: ArtifactBuild) => {
        (build.modules[0] as { sha256: string }).sha256 = '0'.repeat(64);
      },
      (build: ArtifactBuild) => {
        (build.nativeInputs[0] as { sha256: string }).sha256 = '0'.repeat(64);
      },
      (build: ArtifactBuild) => {
        build.sourceSHA256 = '0'.repeat(64);
      },
      (build: ArtifactBuild) => {
        build.cSHA256 = '0'.repeat(64);
      },
    ]) {
      const changed: ArtifactBuild = JSON.parse(manifest.toString());
      mutate(changed);
      await writeFile(join(dir, 'build.json'), JSON.stringify(changed));
      await assert.rejects(cStageOptimizerFrontend(dir), /stale frontend/);
    }
    await writeFile(join(dir, 'build.json'), manifest);
    const frontend = await cStageOptimizerFrontend(dir);
    try {
      if (typeof frontend.artifact === 'string')
        assert.fail('explicit snapshot provenance missing');
      assert.equal(frontend.artifact.buildSHA256, sha(manifest));
      assert.equal(frontend.artifact.wasmSHA256, sha(wasm));
      // Replacing the selected directory cannot change the already loaded
      // checker or the identities used by the preparation report.
      await writeFile(join(dir, 'build.json'), '{}');
      await writeFile(join(dir, 'frontend.wasm'), new Uint8Array());
      const checked = frontend.checkProgram({
        functions: [
          {
            name: 'probe',
            params: ['u32'],
            result: 'u32',
            nodes: [],
            ret: { kind: 'param', index: 0 },
          },
        ],
      });
      assert.ok(checked.ok, JSON.stringify(checked));
      assert.equal(frontend.artifact.buildSHA256, sha(manifest));
      assert.equal(frontend.artifact.wasmSHA256, sha(wasm));
    } finally {
      frontend.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('strict checker artifact verifies symlink roots without weakening closure cardinality', async () => {
  const original = resolve(process.env.A0_C_STAGE_FRONTEND_ARTIFACT ?? 'seed/source-frontend');
  const dir = await mkdtemp(join(tmpdir(), 'a0-optimizer-root-'));
  const manifest = await readFile(join(original, 'build.json'));
  const build: { modules: Record<string, unknown>[] } = JSON.parse(manifest.toString());
  const alias = join(dir, 'checkout');
  try {
    await symlink(resolve('.'), alias, process.platform === 'win32' ? 'junction' : 'dir');
    await copyFile(join(original, 'frontend.wasm'), join(dir, 'frontend.wasm'));
    await writeFile(join(dir, 'build.json'), manifest);
    const snapshot = await inspectNativeSourceArtifact(dir, alias);
    assert.equal(
      snapshot.provenance.wasmBytes,
      (await readFile(join(original, 'frontend.wasm'))).length,
    );
    for (const modules of [build.modules.slice(1), [...build.modules, build.modules[0]]]) {
      await writeFile(join(dir, 'build.json'), JSON.stringify({ ...build, modules }));
      await assert.rejects(inspectNativeSourceArtifact(dir, alias), /dependency closure differs/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
