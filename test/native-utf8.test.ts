import assert from 'node:assert/strict';
import { isUtf8 } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { findClang, findGcc, runTool, spawnWithInput } from '../src/toolchain.js';
import { buildNativeCheck } from '../tools/native-check.js';
import { utf8Cases } from './fixtures/source-utf8-native/cases.js';

const compiler = findClang().path ?? findGcc().path;
const skip = compiler === undefined ? 'C compiler unavailable' : false;

test('native UTF8 validator matches independent byte validity at O0 and O2', { skip }, async () => {
  assert.ok(compiler);
  const dir = await mkdtemp(join(tmpdir(), 'a0-native-utf8-'));
  try {
    const cases = utf8Cases();
    assert.ok(cases.length > 65000);
    const input = Buffer.from(
      cases
        .map((value) => [...value].map((byte) => byte.toString(16).padStart(2, '0')).join(' '))
        .join('\n') + '\n',
    );
    const expected = cases.map((value) => (isUtf8(value) ? '1' : '0')).join('\n') + '\n';
    for (const level of [0, 2]) {
      const exe = join(dir, `check-${level}${process.platform === 'win32' ? '.exe' : ''}`);
      const built = runTool(compiler, [
        '-std=c11',
        `-O${level}`,
        '-Wall',
        '-Wextra',
        '-Werror',
        '-I',
        resolve('tools/native'),
        resolve('test/fixtures/source-utf8-native/driver.c'),
        '-o',
        exe,
      ]);
      assert.ok(built.ok, built.stderr);
      const result = spawnWithInput(exe, input, { timeout: 30000, maxBuffer: 4 << 20 });
      assert.equal(result.status, 0, result.stderr.toString());
      assert.equal(result.stdout.toString().replace(/\r\n/g, '\n'), expected);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('native checker and fast fallback reject malformed entry and dependency bytes', {
  skip,
  timeout: 600000,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'a0-native-source-utf8-'));
  try {
    const { exe } = await buildNativeCheck({ dir: join(dir, 'native') });
    const file = join(dir, 'input.a0'),
      dep = join(dir, 'dep.a0');
    const valid = 'fn f u32 -> u32\nret p0\nend\n';
    const invalid = Buffer.concat([
      Buffer.from('# '),
      Buffer.from([255]),
      Buffer.from('\n' + valid),
    ]);
    await writeFile(file, invalid);
    const check = () =>
      spawnSync(exe, ['check', file], { encoding: 'utf8', env: { ...process.env, A0_CLI: '0' } });
    const rejected = check();
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /valid UTF-8/);
    const fast = spawnSync(process.execPath, ['dist/src/a0.js', 'check', file], {
      encoding: 'utf8',
      env: { ...process.env, A0_NATIVE_CHECK: exe },
    });
    assert.notEqual(fast.status, 0);
    assert.match(fast.stderr, /encoded data|utf-8/i);
    const wrapper = join(dir, 'full-cli.js');
    await writeFile(
      wrapper,
      `void import(${JSON.stringify(pathToFileURL(resolve('dist/src/cli.js')).href)});\n`,
    );
    const launched = spawnSync(exe, ['check', file], {
      encoding: 'utf8',
      env: { ...process.env, A0_CLI: wrapper, A0_NODE: process.execPath },
    });
    assert.notEqual(launched.status, 0);
    assert.match(launched.stderr, /encoded data|utf-8/i);
    await writeFile(file, `use "dep.a0"\n${valid}`);
    await writeFile(dep, Buffer.concat([Buffer.from('# '), Buffer.from([255]), Buffer.from('\n')]));
    assert.notEqual(check().status, 0);
    await writeFile(file, '# 😀 � Ω\n' + valid);
    const accepted = check();
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.ok(isUtf8(await readFile(file)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
