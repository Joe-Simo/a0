import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isPlainCheck, nativeCheckBinary } from '../src/native-fast.js';
import { findClang, findGcc } from '../src/toolchain.js';
import { buildNativeCheck, NATIVE_A0 } from '../tools/native-check.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const entry = join(root, 'dist', 'src', 'a0.js');
const cli = join(root, 'dist', 'src', 'cli.js');
const skip =
  (findClang().path ?? findGcc().path) === undefined
    ? 'no C compiler (clang or gcc) on this machine'
    : false;

test('native fast path: only `check FILE.a0` with no flag is taken', () => {
  assert.ok(isPlainCheck(['check', 'a.a0']));
  for (const args of [
    ['check'],
    ['check', 'a.a0', 'b.a0'],
    ['check', '--json', 'a.a0'],
    ['check', 'a.a0', '--fix'],
    ['check', 'a.a0d'],
    ['--dense', 'check', 'a.a0'],
    ['run', 'a.a0'],
  ])
    assert.ok(!isPlainCheck(args), args.join(' '));
});

test('native fast path: where the checker is looked for', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a0-fast-'));
  try {
    const exe = join(dir, 'a0.exe');
    const sibling = join(dir, 'a0-check.exe');
    assert.equal(nativeCheckBinary(exe, {}, 'win32'), undefined);
    writeFileSync(sibling, '');
    assert.equal(nativeCheckBinary(exe, {}, 'win32'), sibling);
    // a node or bun process never looks beside itself; the variable names one or turns it off
    assert.equal(nativeCheckBinary(join(dir, 'node.exe'), {}, 'win32'), undefined);
    assert.equal(nativeCheckBinary(join(dir, 'bun'), {}, 'linux'), undefined);
    assert.equal(nativeCheckBinary(exe, { A0_NATIVE_CHECK: '0' }, 'win32'), undefined);
    assert.equal(nativeCheckBinary(exe, { A0_NATIVE_CHECK: sibling }, 'win32'), sibling);
    assert.equal(
      nativeCheckBinary(exe, { A0_NATIVE_CHECK: join(dir, 'none') }, 'win32'),
      undefined,
    );
    const unix = join(dir, 'a0');
    assert.equal(nativeCheckBinary(unix, {}, 'linux'), undefined);
    writeFileSync(join(dir, 'a0-check'), '');
    assert.equal(nativeCheckBinary(unix, {}, 'linux'), join(dir, 'a0-check'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('native fast path: `a0 check` prints the same bytes and exits the same, through the native checker or not', {
  skip,
  timeout: 600_000,
}, async () => {
  await buildNativeCheck();
  const native = existsSync(`${NATIVE_A0}.exe`) ? `${NATIVE_A0}.exe` : NATIVE_A0;
  const dir = mkdtempSync(join(tmpdir(), 'a0-fast-'));
  try {
    writeFileSync(join(dir, 'ok.a0'), 'fn f u32 -> u32\na add p0 1\nret a\nend\n');
    writeFileSync(join(dir, 'bad.a0'), 'fn f u32 -> u32\na add p0 true\nret a\nend\n');
    writeFileSync(join(dir, 'spec.a0'), 'fn f u32 -> u32\nex 1 -> 2\na add p0 1\nret a\nend\n');
    const files = [
      join(dir, 'ok.a0'),
      join(dir, 'bad.a0'),
      join(dir, 'spec.a0'),
      join(dir, 'missing.a0'),
      join(root, 'compiler', 'lex.a0'),
      join(root, 'compiler', 'check.a0'),
      join(root, 'examples', 'life.a0'),
    ];
    const run = (script: string, file: string, env: Record<string, string>) =>
      spawnSync(process.execPath, [script, 'check', file], {
        encoding: 'utf8',
        env: { ...process.env, ...env },
        maxBuffer: 1 << 26,
      });
    for (const file of files) {
      const reference = run(cli, file, {});
      const viaNative = run(entry, file, { A0_NATIVE_CHECK: native });
      const off = run(entry, file, { A0_NATIVE_CHECK: '0' });
      for (const r of [viaNative, off]) {
        assert.equal(r.status, reference.status, file);
        assert.equal(r.stdout, reference.stdout, file);
        assert.equal(r.stderr, reference.stderr, file);
      }
    }
    assert.equal(run(cli, files[0] as string, {}).status, 0);
    assert.equal(run(cli, files[1] as string, {}).status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
