import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseBenchmarkOptions } from '../tools/benchmark-options.js';

const known = {
  languages: ['python', 'rust'],
  kernels: ['affine', 'mix'],
  defaultOut: 'default.json',
};
const parse = (args: string[]) => parseBenchmarkOptions(args, known);

test('benchmark defaults and valid selections retain their exact meaning', () => {
  assert.deepEqual(parse([]), {
    langs: null,
    kernels: null,
    samples: 7,
    scale: 1,
    out: 'default.json',
    help: false,
  });
  const selected = parse([
    '--langs=python',
    '--kernels=mix,affine,mix',
    '--samples=3',
    '--scale=2.5',
    '--out=a=b.json',
  ]);
  assert.ok(selected.langs);
  assert.ok(selected.kernels);
  assert.deepEqual([...selected.langs], ['python']);
  assert.deepEqual([...selected.kernels], ['mix', 'affine']);
  assert.equal(selected.samples, 3);
  assert.equal(selected.scale, 2.5);
  assert.equal(selected.out, 'a=b.json');
  assert.equal(parse(['--langs=']).langs?.size, 0);
  assert.equal(parse(['--help']).help, true);
  assert.equal(parse(['-h']).help, true);
});

test('benchmark numeric options reject nonfinite, empty, fractional sample and unsafe values', () => {
  for (const value of [
    '',
    ' ',
    'NaN',
    'Infinity',
    '-Infinity',
    '0',
    '-1',
    '1.5',
    '9007199254740992',
  ])
    assert.throws(() => parse([`--samples=${value}`]), /samples/);
  for (const value of ['', ' ', 'NaN', 'Infinity', '-Infinity', '0', '-1', '0.5'])
    assert.throws(() => parse([`--scale=${value}`]), /scale/);
});

test('benchmark selections and missing values fail instead of producing empty reports', () => {
  for (const option of [
    '--kernels=',
    '--kernels=missing',
    '--kernels=affine,missing',
    '--kernels=affine,',
    '--langs=missing',
    '--langs=python,',
    '--out=',
    '--out= ',
    '--samples',
    '--scale',
    '--kernels',
    '--langs',
    '--out',
    '--other=1',
  ])
    assert.throws(() => parse([option]), option);
});

test('benchmark CLI rejects invalid arguments before creating or overwriting a report', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'a0-benchmark-options-'));
  try {
    const out = join(dir, 'report.json');
    for (const arg of [
      '--kernels=missing',
      '--kernels=',
      '--samples=Infinity',
      '--samples=1.5',
      '--scale=NaN',
      '--langs=missing',
    ]) {
      const result = spawnSync(
        process.execPath,
        ['dist/tools/exec-bench.js', arg, `--out=${out}`],
        { encoding: 'utf8', timeout: 10000 },
      );
      assert.notEqual(result.status, 0, arg);
      assert.equal(result.error, undefined, arg);
      assert.match(
        result.stderr,
        /unknown or empty selection|positive safe integer|finite and at least 1/,
      );
      await assert.rejects(stat(out), { code: 'ENOENT' });
    }
    await writeFile(out, 'existing report');
    const result = spawnSync(
      process.execPath,
      ['dist/tools/exec-bench.js', '--kernels=missing', `--out=${out}`],
      { encoding: 'utf8', timeout: 10000 },
    );
    assert.notEqual(result.status, 0);
    assert.equal(await readFile(out, 'utf8'), 'existing report');
    const help = spawnSync(process.execPath, ['dist/tools/exec-bench.js', '--help'], {
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /kernels: affine/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
