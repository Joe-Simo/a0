import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { A0Error, run } from '../src/core.js';
import { link } from '../src/link.js';

const skip =
  process.platform === 'win32' ? 'POSIX symlink fixtures require symlink privileges' : false;

test('aliased project roots preserve missing-import errors through missing parent directories', {
  skip,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'a0-link-alias-'));
  try {
    const physical = join(root, 'physical');
    const alias = join(root, 'alias');
    await mkdir(physical);
    await symlink(physical, alias, 'dir');
    await writeFile(
      join(physical, 'main.a0'),
      'use "new/sub/missing.a0"\nfn f -> u32\nret 0\nend\n',
    );
    const reads: string[] = [];
    await assert.rejects(
      link(
        join(alias, 'main.a0'),
        async (path) => {
          reads.push(path);
          return readFile(path, 'utf8');
        },
        { root: alias },
      ),
      (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
    );
    assert.deepEqual(reads, [join(alias, 'main.a0'), join(physical, 'new/sub/missing.a0')]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('missing imports through an outside symlink retain project-root confinement', {
  skip,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'a0-link-escape-'));
  try {
    const project = join(root, 'project');
    const outside = join(root, 'outside');
    await mkdir(project);
    await mkdir(outside);
    await symlink(outside, join(project, 'escape'), 'dir');
    await writeFile(
      join(project, 'main.a0'),
      'use "escape/new/missing.a0"\nfn f -> u32\nret 0\nend\n',
    );
    const reads: string[] = [];
    await assert.rejects(
      link(
        join(project, 'main.a0'),
        async (path) => {
          reads.push(path);
          return readFile(path, 'utf8');
        },
        { root: project },
      ),
      (error: unknown) => error instanceof A0Error && error.id === 'A0622',
    );
    assert.deepEqual(reads, [join(project, 'main.a0')]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('entry symlinks retain lexical identity and relative-import semantics', { skip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'a0-link-entry-'));
  try {
    await mkdir(join(root, 'sub'));
    await writeFile(join(root, 'dep.a0'), 'fn dep -> u32\nret 17\nend\n');
    await writeFile(join(root, 'sub/dep.a0'), 'fn dep -> u32\nret 23\nend\n');
    await writeFile(
      join(root, 'sub/main.a0'),
      'use "dep.a0"\nfn entry -> u32\nr call dep\nret r\nend\n',
    );
    await symlink(join(root, 'sub/main.a0'), join(root, 'entry.a0'), 'file');
    const linked = await link(join(root, 'entry.a0'), (path) => readFile(path, 'utf8'), { root });
    assert.deepEqual(
      linked.sources.map((source) => source.path),
      [join(root, 'dep.a0'), join(root, 'entry.a0')],
    );
    const entry = linked.program.byName.get('entry');
    assert.ok(entry);
    assert.equal(run(entry, []), 17);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
