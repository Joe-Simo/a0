import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { findClang, findGcc, runTool } from '../src/toolchain.js';
import { buildNativeCheck } from '../tools/native-check.js';

const compiler = findClang().path ?? findGcc().path;
const skip = compiler === undefined ? 'C compiler unavailable' : false;
let prepared: Promise<{ dir: string; exe: string; limit: number }> | undefined;
let directory: string | undefined;
after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});
function prepare() {
  prepared ??= (async () => {
    assert.ok(compiler);
    const dir = await mkdtemp(join(tmpdir(), 'a0-native-import-'));
    directory = dir;
    const { exe } = await buildNativeCheck({ dir: join(dir, 'native') });
    const c = join(dir, 'limit.c'),
      binary = join(dir, process.platform === 'win32' ? 'limit.exe' : 'limit');
    await writeFile(
      c,
      '#if defined(__linux__) && !defined(_DEFAULT_SOURCE)\n#define _DEFAULT_SOURCE\n#endif\n#include <limits.h>\n#include <stdio.h>\n#include <unistd.h>\nint main(void){printf("%d\\n",PATH_MAX);return 0;}\n',
    );
    const built = runTool(compiler, ['-std=c11', c, '-o', binary]);
    assert.ok(built.ok, built.stderr);
    const result = runTool(binary, []);
    assert.ok(result.ok, result.stderr);
    const limit = Number(result.stdout.trim());
    assert.ok(Number.isSafeInteger(limit) && limit > 0);
    await writeFile(join(dir, 'dep.a0'), 'fn dep -> u32\nret 41\nend\n');
    return { dir, exe, limit };
  })();
  return prepared;
}
const body = 'fn f -> u32\nx call dep\nret x\nend\n';
function native(exe: string, file: string) {
  return spawnSync(exe, ['run', file, 'f'], {
    encoding: 'utf8',
    env: { ...process.env, A0_CLI: '0' },
  });
}

test('native imports reject embedded NUL instead of resolving a shorter existing path', {
  skip,
}, async () => {
  const { dir, exe } = await prepare();
  const file = join(dir, 'nul.a0');
  await writeFile(file, `use "dep.a0\0ignored"\n${body}`);
  const before = await readFile(file),
    result = native(exe, file);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /NUL.*use path/);
  assert.deepEqual(await readFile(file), before);
  const fast = spawnSync(process.execPath, ['dist/src/a0.js', 'check', file], {
    encoding: 'utf8',
    env: { ...process.env, A0_NATIVE_CHECK: exe, A0_CLI: '0' },
  });
  assert.notEqual(fast.status, 0);
  assert.equal(fast.stdout, '');
});

test('native import paths reject capacity overflow before truncation', { skip }, async () => {
  const { dir, exe, limit } = await prepare();
  const file = join(dir, 'long.a0');
  await writeFile(file, `use "${'x'.repeat(limit)}"\n${body}`);
  const overflow = native(exe, file);
  assert.notEqual(overflow.status, 0);
  assert.match(overflow.stderr, /use path.*too long/);
  await writeFile(file, `use "${'x'.repeat(limit - 1)}"\n${body}`);
  const boundary = native(exe, file);
  assert.notEqual(boundary.status, 0);
  assert.doesNotMatch(boundary.stderr, /use path.*too long/);
  // POSIX path normalization can expose the original aliasing: a valid PATH_MAX-1
  // prefix plus a suffix used to resolve the existing shorter file.
  if (process.platform === 'linux') {
    const start = `${dir}/`,
      tail = 'dep.a0';
    const padding = limit - 1 - Buffer.byteLength(start) - Buffer.byteLength(tail);
    assert.ok(padding > 0);
    const prefix = start + './'.repeat(Math.floor(padding / 2)) + (padding % 2 ? '/' : '') + tail;
    assert.equal(Buffer.byteLength(prefix), limit - 1);
    assert.ok((await stat(prefix)).isFile());
    await writeFile(file, `use "${prefix}ignored"\n${body}`);
    const alias = native(exe, file);
    assert.notEqual(alias.status, 0);
    assert.equal(alias.stdout, '');
    assert.match(alias.stderr, /use path.*too long/);
  }
});

test('valid native imports and NUL text remain supported', { skip }, async () => {
  const { dir, exe } = await prepare();
  await writeFile(join(dir, 'dep space.a0'), 'fn dep -> u32\nret 41\nend\n');
  const file = join(dir, 'valid.a0');
  await writeFile(file, `use "dep space.a0"\n${body}`);
  const imported = native(exe, file);
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout.replace(/\r/g, ''), '41\n');
  await writeFile(
    file,
    '# NUL stays legal in a comment: \0\nfn f -> u32\nx text "a\0b"\ny get x 1\nret y\nend\n',
  );
  const text = native(exe, file);
  assert.equal(text.status, 0, text.stderr);
  assert.equal(text.stdout.replace(/\r/g, ''), '0\n');
});
