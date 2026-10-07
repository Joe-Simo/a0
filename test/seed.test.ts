import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseAndValidate } from '../src/core.js';
import { findClang, withTempDir } from '../src/toolchain.js';
import { emitChunked, runStageChunk } from '../tools/bootstrap.js';
import { generateCases } from '../tools/corpus.js';
import { staleness } from '../tools/seed.js';
import { checkNative } from '../tools/verify.js';

// A fresh machine has a C compiler and a shell, not Node, Bun or the TypeScript toolchain.
// On Windows the shell and compiler come from MSYS2 or Git Bash, so the environment is kept as it is.
const CLEAN_ENV: NodeJS.ProcessEnv =
  process.platform === 'win32'
    ? { ...process.env }
    : { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '/' };
const noShell =
  process.platform === 'win32' &&
  spawnSync('sh', ['-c', 'cc --version || gcc --version'], { env: CLEAN_ENV }).status !== 0 &&
  'needs sh and a C compiler (MSYS2) on PATH';

const bootstrap = (seedDir: string, out: string): ReturnType<typeof spawnSync> =>
  spawnSync('sh', [join(seedDir, 'bootstrap.sh'), out], {
    env: CLEAN_ENV,
    encoding: 'utf8',
    timeout: 600_000,
  });

const size = (dir: string): number =>
  readdirSync(dir, { withFileTypes: true }).reduce(
    (n, e) => n + (e.isDirectory() ? size(join(dir, e.name)) : statSync(join(dir, e.name)).size),
    0,
  );

test('seed: it matches the compiler source in the working tree', async () => {
  assert.deepEqual(await staleness(), []);
});

test('seed: it is small', () => {
  // A few megabytes is the stated ceiling for a checked-in artifact (STATUS.md records the size).
  assert.ok(size('seed') < 2 * 1024 * 1024, `seed/ is ${size('seed')} bytes`);
});

test('seed: a C compiler alone rebuilds it, and stage 2 equals stage 3 byte for byte', {
  skip: noShell,
}, async () => {
  const node = spawnSync('sh', ['-c', 'command -v node'], { env: CLEAN_ENV, encoding: 'utf8' });
  const hasNodeOnCleanPath = node.status === 0;
  await withTempDir(async (dir) => {
    const r = bootstrap('seed', join(dir, 'build'));
    assert.equal(r.status, 0, `${String(r.stdout)}${String(r.stderr)}`);
    const out = String(r.stdout);
    assert.match(out, /stage 2 C equals stage 3 C byte for byte/);
    assert.match(out, /stage 3 reproduces itself/);
    // The executables of the two later stages are built from byte-identical C.
    const stage3 = await readFile(join(dir, 'build', 'stage3.c'), 'utf8');
    const seed = await readFile(join('seed', 'a0c-seed.c'), 'utf8');
    assert.equal(stage3, seed);
    assert.equal(await readFile(join(dir, 'build', 'stage4.c'), 'utf8'), stage3);

    // The compiler the seed produced compiles a program and the C runs correctly: every example
    // function of kernels.a0 agrees with the BigInt oracle (the harness is Node; the build was not).
    const source = await readFile(join('examples', 'kernels.a0'), 'utf8');
    const emitted = emitChunked(source, (c, b) => runStageChunk(join(dir, 'build', 'a0c'), c, b));
    assert.equal(emitted.code, 0);
    const program = parseAndValidate(source);
    const check = await checkNative(
      program,
      generateCases(program),
      findClang(),
      false,
      'C written by the seed-built compiler',
      emitted.text,
    );
    assert.equal(check.status, 'passed', check.failures?.join('\n'));
    assert.ok(check.cases > 100);
  });
  // Where Node is not on the clean PATH the claim "built without Node" is literally what ran.
  if (!hasNodeOnCleanPath) assert.notEqual(node.status, 0);
});

test('seed: a damaged seed fails the rebuild instead of passing', { skip: noShell }, async () => {
  await withTempDir(async (dir) => {
    const copy = join(dir, 'seed');
    cpSync('seed', copy, { recursive: true });
    // A newline is still valid C, so the seed builds, but its output no longer reproduces it.
    const path = join(copy, 'a0c-seed.c');
    writeFileSync(path, `${await readFile(path, 'utf8')}\n`, 'utf8');
    const r = bootstrap(copy, join(dir, 'build'));
    assert.notEqual(r.status, 0);
    assert.match(String(r.stderr), /stage 3 C differs from seed\/a0c-seed\.c/);
  });
});
