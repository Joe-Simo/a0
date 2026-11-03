import assert from 'node:assert/strict';
import { isUtf8 } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseAndValidate, validate } from '../src/core.js';
import { formatDense } from '../src/dense.js';
import { revision } from '../src/edit.js';
import { parseSource } from '../src/source.js';

const invoke = (entry: string, args: string[]) =>
  spawnSync(process.execPath, [`dist/src/${entry}.js`, ...args], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, A0_NATIVE_CHECK: '0' },
  });
const bad = (text: string) =>
  Buffer.concat([Buffer.from('# '), Buffer.from([255]), Buffer.from(`\n${text}`)]);
const source = 'fn f\nx add A 1\nret x\nend\n';
const legacy = 'fn f u32 -> u32\nx add p0 1\nret x\nend\n';

async function fixture(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'a0-cli-utf8-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('both CLI entrypoints reject malformed source and dependency bytes', () =>
  fixture(async (root) => {
    for (const [entry, text] of [
      ['source-cli', source],
      ['cli', legacy],
    ] as const) {
      const file = join(root, 'main.a0');
      await writeFile(file, bad(text));
      const before = await readFile(file);
      const result = invoke(entry, ['check', file]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /encoded data|utf-8/i);
      assert.deepEqual(await readFile(file), before);
      assert.notEqual(invoke(entry, ['check', '--fix', file]).status, 0);
      assert.deepEqual(await readFile(file), before);
      await writeFile(file, `use "dep.a0"\n${text}`);
      await writeFile(join(root, 'dep.a0'), bad(''));
      assert.notEqual(invoke(entry, ['check', file]).status, 0);
    }
  }));

test('malformed patch bytes cannot overwrite output or source', () =>
  fixture(async (root) => {
    for (const [entry, text, operand] of [
      ['source-cli', source, 'A'],
      ['cli', legacy, 'p0'],
    ] as const) {
      const file = join(root, 'main.a0'),
        patch = join(root, 'change.patch'),
        out = join(root, 'out.a0');
      await writeFile(file, text);
      const fn = (
        entry === 'source-cli' ? validate(parseSource(text)) : parseAndValidate(text)
      ).byName.get('f');
      assert.ok(fn);
      await writeFile(
        patch,
        Buffer.concat([
          Buffer.from(`patch f ${revision(fn)}\nx add ${operand} 2 # `),
          Buffer.from([255]),
          Buffer.from('\nend\n'),
        ]),
      );
      await writeFile(out, 'sentinel');
      const result = invoke(entry, ['patch', file, patch, out]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /encoded data|utf-8/i);
      assert.equal(await readFile(out, 'utf8'), 'sentinel');
      assert.equal(await readFile(file, 'utf8'), text);
    }
  }));

test('valid Unicode source and patch comments still execute and emit valid UTF8', () =>
  fixture(async (root) => {
    const file = join(root, 'main.a0'),
      patch = join(root, 'change.patch'),
      out = join(root, 'out.a0');
    const text = `\ufeff# 😀 � Ω\n${source}`;
    await writeFile(file, text);
    const fn = validate(parseSource(text)).byName.get('f');
    assert.ok(fn);
    await writeFile(patch, `patch f ${revision(fn)}\nx add A 2 # 😀 �\nend\n`);
    const result = invoke('source-cli', ['patch', file, patch, out]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(isUtf8(await readFile(out)));
    assert.equal(invoke('source-cli', ['run', out, 'f', '1']).stdout, '3\n');
    assert.equal(await readFile(file, 'utf8'), text);
  }));

test('legacy conversion refuses malformed bytes without replacing an existing output', () =>
  fixture(async (root) => {
    const input = join(root, 'input.a0'),
      dense = join(root, 'input.a0d'),
      out = join(root, 'output.a0');
    await writeFile(input, bad(legacy));
    await writeFile(dense, bad(formatDense(parseAndValidate(legacy))));
    for (const [command, file] of [
      ['dense', input],
      ['canon', dense],
    ] as const) {
      await writeFile(out, 'sentinel');
      assert.notEqual(invoke('cli', [command, file, out]).status, 0);
      assert.equal(await readFile(out, 'utf8'), 'sentinel');
    }
  }));
