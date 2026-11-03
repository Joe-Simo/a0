import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const invoke = (...args: string[]) => spawnSync(process.execPath, ['tools/qualify-editor-installed.mjs', ...args], { encoding: 'utf8' });

test('installed editor fixture refuses existing directories and preserves their contents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'a0-installed-existing-'));
  try {
    await writeFile(join(root, 'keep.txt'), 'unchanged');
    const result = invoke('prepare', root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /EEXIST/);
    assert.equal(await readFile(join(root, 'keep.txt'), 'utf8'), 'unchanged');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('installed editor qualification refuses missing or unproven installations before starting an editor', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'a0-installed-refusal-'));
  const root = join(parent, 'fixture');
  try {
    const prepared = invoke('prepare', root);
    assert.equal(prepared.status, 0, prepared.stderr);
    const settings = JSON.parse(await readFile(join(root, 'profile/User/settings.json'), 'utf8'));
    assert.equal(Object.keys(settings).some((key) => /trust/i.test(key)), false);
    const missing = invoke('run', root, process.execPath);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /installed\.txt/);
    await writeFile(join(root, 'installed.txt'), 'some.other-extension@1.0.0\n');
    const unproven = invoke('run', root, process.execPath);
    assert.notEqual(unproven.status, 0);
    assert.match(unproven.stderr, /vendor CLI must list/);
    const manifest = JSON.parse(await readFile('editors/vscode/package.json', 'utf8'));
    await writeFile(join(root, 'installed.txt'), `a0lang.a0@${manifest.version}\n`);
    const absent = invoke('run', root, process.execPath);
    assert.notEqual(absent.status, 0);
    assert.match(absent.stderr, /Exactly one A0 installation/);
    await assert.rejects(readFile(join(root, 'server-started')), { code: 'ENOENT' });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
