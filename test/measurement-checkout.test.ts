import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { committedTree } from '../tools/measurement-checkout.js';

test('measurement identity binds committed source and refuses unstaged, staged and untracked changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'a0-measurement-checkout-'));
  const git = (...args: string[]): string => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git('init', '-q');
    git('config', 'user.name', 'Measurement test');
    git('config', 'user.email', 'measurement@example.invalid');
    await writeFile(join(dir, '.gitignore'), 'scratch/\n');
    await writeFile(join(dir, 'source'), 'first\n');
    git('add', '.');
    git('commit', '-qm', 'initial');
    const initial = committedTree(dir);
    assert.equal(initial.commit, git('rev-parse', 'HEAD'));
    assert.equal(initial.tree, git('rev-parse', 'HEAD:'));
    await mkdir(join(dir, 'scratch'));
    await writeFile(join(dir, 'scratch', 'output'), 'ignored measurement output');
    assert.deepEqual(committedTree(dir), initial);
    await writeFile(join(dir, 'new-source'), 'untracked');
    assert.throws(() => committedTree(dir), /clean committed checkout/);
    await rm(join(dir, 'new-source'));
    await writeFile(join(dir, 'source'), 'changed\n');
    assert.throws(() => committedTree(dir), /clean committed checkout/);
    git('add', 'source');
    assert.throws(() => committedTree(dir), /clean committed checkout/);
    git('commit', '-qm', 'changed');
    const next = committedTree(dir);
    assert.notEqual(next.commit, initial.commit);
    assert.notEqual(next.tree, initial.tree);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
