import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { findClang, findGcc } from '../src/toolchain.js';
import { buildNativeCheck } from '../tools/native-check.js';

const skip =
  findClang().path === undefined && findGcc().path === undefined ? 'C compiler unavailable' : false;
let prepared: Promise<{ exe: string; file: string }> | undefined;
let directory: string | undefined;
after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});
function prepare() {
  prepared ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'a0-native-bench-'));
    directory = dir;
    const { exe } = await buildNativeCheck({ dir: join(dir, 'native') });
    const file = join(dir, 'input.a0');
    await writeFile(file, 'fn f -> u32\nret 41\nend\nfn echo u32 -> u32\nret p0\nend\n');
    return { exe, file };
  })();
  return prepared;
}
function bench(exe: string, file: string, count: string, fn = 'f') {
  return spawnSync(exe, ['bench', file, fn, count], {
    encoding: 'utf8',
    env: { ...process.env, A0_CLI: '0' },
    timeout: 10000,
  });
}

test('native benchmark refuses nonpositive, malformed and overflowing counts without a measurement', {
  skip,
}, async () => {
  const { exe, file } = await prepare();
  for (const count of [
    '',
    '0',
    '000',
    '-1',
    '+1',
    ' 1',
    '1 ',
    '1junk',
    '1.5',
    '1e2',
    'NaN',
    'Infinity',
    '9'.repeat(80),
  ]) {
    const result = bench(exe, file, count);
    assert.equal(result.error, undefined, count);
    assert.notEqual(result.status, 0, count);
    assert.equal(result.stdout, '', count);
    assert.match(result.stderr, /iterations.*positive.*integer/, count);
  }
});

test('native benchmark preserves valid counts, random input sequence and checksum protocol', {
  skip,
}, async () => {
  const { exe, file } = await prepare();
  for (const count of ['1', '2', '3', '0003']) {
    const result = bench(exe, file, count);
    assert.equal(result.status, 0, result.stderr);
    const row = result.stdout.trim().split(/\s+/);
    assert.equal(row.length, 2);
    assert.ok(Number.isFinite(Number(row[0])) && Number(row[0]) >= 0);
    assert.equal(Number(row[1]), Number(count) % 2 ? 41 : 0);
  }
  let state = 0x9e3779b9,
    expected = 0;
  for (let i = 0; i < 7; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    expected = (expected ^ state) >>> 0;
  }
  const result = bench(exe, file, '7', 'echo');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(Number(result.stdout.trim().split(/\s+/)[1]), expected);
});
