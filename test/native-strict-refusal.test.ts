import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { findClang, findGcc } from '../src/toolchain.js';
import { buildNativeCheck } from '../tools/native-check.js';

const skip =
  findClang().path === undefined && findGcc().path === undefined ? 'C compiler unavailable' : false;
let prepared: Promise<{ exe: string; dir: string }> | undefined;
let directory: string | undefined;
after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});
function prepare() {
  prepared ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'a0-native-strict-'));
    directory = dir;
    const { exe } = await buildNativeCheck({ dir: join(dir, 'native') });
    return { exe, dir };
  })();
  return prepared;
}
const division = 'fn f -> u32\nx div 7 0\nret x\nend\n';
function invoke(exe: string, args: string[], input = '', cli = '0') {
  return spawnSync(exe, args, {
    encoding: 'utf8',
    input,
    env: { ...process.env, A0_CLI: cli },
    timeout: 10000,
  });
}

test('native run, bench and calls refuse strict execution before any result or IO', {
  skip,
}, async () => {
  const { exe, dir } = await prepare();
  const file = join(dir, 'strict.a0');
  for (const body of [
    division,
    'fn f -> u32\na arr 1 2\nx get a 2\nret x\nend\n',
    'fn f -> u32\nret 7\nend\n',
    'fn f io -> u32\nw write p0 77\nr read w\nx at r 0\nret x\nend\n',
  ]) {
    await writeFile(file, `profile strict\n${body}`);
    for (const args of [
      ['run', file, 'f'],
      ['bench', file, 'f', '1'],
      ['calls', file],
    ]) {
      const result = invoke(exe, args, '0 0\n');
      assert.equal(result.status, 65, `${args[0]}: ${result.stderr}`);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /strict.*unsupported|unsupported.*strict/);
    }
  }
});

test('native strict refusal follows the parser through comments and Unicode spaces', {
  skip,
}, async () => {
  const { exe, dir } = await prepare();
  const file = join(dir, 'prefix.a0');
  for (const [prefix, status] of [
    ['', 65],
    ['\n# leading comment\n\n  ', 65],
    ['\uFEFF', 1],
    ['\u00a0', 1],
  ] as const) {
    await writeFile(file, `${prefix}profile strict\n${division}`);
    const result = invoke(exe, ['run', file, 'f']);
    assert.equal(result.status, status, result.stderr);
    assert.equal(result.stdout, '');
    if (status === 1) assert.match(result.stderr, /parse error/);
  }
});

test('native canonical execution and contextual profile names remain supported', {
  skip,
}, async () => {
  const { exe, dir } = await prepare();
  const file = join(dir, 'canonical.a0');
  for (const source of [
    division,
    `# profile strict\n${division}`,
    'fn f -> u32\nprofile mov 4294967295\nret profile\nend\n',
  ]) {
    await writeFile(file, source);
    const result = invoke(exe, ['run', file, 'f']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.replace(/\r/g, ''), '4294967295\n');
  }
  await writeFile(file, `profile strict extra\n${division}`);
  const malformed = invoke(exe, ['run', file, 'f']);
  assert.equal(malformed.status, 1);
  assert.equal(malformed.stdout, '');
  assert.doesNotMatch(malformed.stderr, /unsupported/);
});

test('configured native launcher preserves the full CLI strict trap behavior', {
  skip,
}, async () => {
  const { exe, dir } = await prepare();
  const file = join(dir, 'launcher.a0');
  await writeFile(file, `profile strict\n${division}`);
  const cli = resolve('dist/src/cli.js');
  const expected = spawnSync(process.execPath, [cli, 'run', file, 'f'], { encoding: 'utf8' });
  const actual = invoke(exe, ['run', file, 'f'], '', cli);
  assert.equal(actual.status, expected.status);
  assert.equal(actual.stdout, expected.stdout);
  assert.equal(actual.stderr, expected.stderr);
  assert.match(actual.stderr, /trap divzero/);
});
