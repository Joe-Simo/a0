// Exercise the existing real transport-corruption controls against the new
// compiler implementation's emitted C, with the unchanged generic host.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { findClang, runTool } from '../../../dist/src/toolchain.js';
import { C_STAGE_RESOURCES } from '../../../dist/tools/c-arena-stage.js';
import { writeReport } from '../../../dist/tools/scrub-results.js';

const [module, output] = process.argv.slice(2);
assert.ok(module && output, 'candidate compiler module and artifact directory');
const root = resolve(output),
  clang = findClang();
assert.ok(clang.path);
await mkdir(root, { recursive: true });
await copyFile(module, join(root, 'module.c'));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const report = { status: 'running', compilerModuleSHA256: sha(await readFile(module)), rows: [] };
try {
  const exe = join(root, 'stage');
  const built = runTool(
    clang.path,
    [
      '-std=c11',
      '-O2',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-Wno-unused-parameter',
      '-fsanitize=undefined',
      '-fno-sanitize-recover=all',
      '-pthread',
      '-I',
      root,
      '-I',
      resolve('tools/native'),
      resolve('tools/native/c_arena_stage.c'),
      resolve('test/fixtures/c-arena-stage/fault_runtime.c'),
      '-o',
      exe,
    ],
    { timeoutMs: 240_000 },
  );
  await writeFile(join(root, 'build.log'), built.stderr);
  assert.ok(built.ok, built.stderr);
  const source = join(root, 'source.a0'),
    destination = join(root, 'output.c'),
    prior = Buffer.from('prior artifact\r\n');
  await writeFile(source, 'fn probe\nret add A 1\nend\n');
  for (const [mode, expected] of [
    ['load', 5],
    ['alloc', 4],
    ['finish', 65],
    ['nonbyte', 69],
  ]) {
    await writeFile(destination, prior);
    const ran = runTool(
      exe,
      [source, destination, ...Object.values(C_STAGE_RESOURCES).map(String)],
      { env: { ...process.env, A0_STAGE_FAULT: mode }, timeoutMs: 180_000 },
    );
    assert.equal(ran.status, expected, `${mode}: ${ran.stderr}`);
    assert.ok((await readFile(destination)).equals(prior));
    report.rows.push({ fault: mode, status: expected, atomicRefusal: true });
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = { message: error.message, stack: error.stack };
}
assert.equal(sha(await readFile(module)), report.compilerModuleSHA256, 'compiler module immutable');
await writeReport(join(root, 'report.json'), report);
console.log(JSON.stringify(report));
process.exitCode = report.status === 'passed' ? 0 : 1;
