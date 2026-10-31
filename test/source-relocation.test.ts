import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const invoke = (root: string, args: string[], compiler?: string) =>
  spawnSync(
    process.execPath,
    [compiler ? join(compiler, 'dist/src/source-cli.js') : '.a0/cli.mjs', ...args],
    { cwd: root, encoding: 'utf8', timeout: 30000, env: { ...process.env, A0_NO_CACHE: '1' } },
  );
async function snapshot(root: string) {
  const out: Record<string, string> = {};
  const walk = async (p: string) => {
    for (const e of await readdir(join(root, p), { withFileTypes: true })) {
      const n = join(p, e.name);
      if (e.isDirectory()) await walk(n);
      else out[n] = await readFile(join(root, n), 'utf8');
    }
  };
  await walk('');
  return out;
}

test('isolated moved project and compiler regenerate exact bindings and roll back failed regeneration', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'a0-relocation-'));
  try {
    const compiler = join(root, 'compiler # α'),
      movedCompiler = join(root, 'moved compiler # β');
    await mkdir(compiler);
    await cp('dist', join(compiler, 'dist'), { recursive: true });
    await writeFile(join(compiler, 'package.json'), '{"type":"module"}');
    await cp('MODEL_GUIDE.txt', join(compiler, 'MODEL_GUIDE.txt'));
    await symlink(resolve('node_modules'), join(compiler, 'node_modules'), 'dir');
    const project = join(root, 'project # γ'),
      movedProject = join(root, 'moved project # δ');
    await mkdir(project);
    assert.equal(invoke(project, ['init', project], compiler).status, 0);
    await writeFile(join(project, 'owner.txt'), 'preserve owner bytes');
    const baseline = invoke(project, ['emit', 'js', 'examples/a0-hello.a0']);
    assert.equal(baseline.status, 0, baseline.stderr);
    const revision = invoke(project, ['revision', 'examples/a0-hello.a0', 'hello']).stdout;
    const beforeMove = await snapshot(project);
    await rename(project, movedProject);
    assert.equal(
      invoke(movedProject, ['run', 'examples/a0-hello.a0', 'hello', '7']).stdout,
      '15\n',
    );
    assert.equal(invoke(movedProject, ['init', movedProject], compiler).status, 0);
    assert.deepEqual(await snapshot(movedProject), beforeMove);
    await rename(compiler, movedCompiler);
    assert.notEqual(invoke(movedProject, ['check', 'examples/a0-hello.a0']).status, 0);
    const manifest = join(movedProject, '.a0/init.json');
    await chmod(manifest, 0o444);
    const beforeFailure = await snapshot(movedProject);
    const refused = invoke(movedProject, ['init', movedProject], movedCompiler);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /EACCES/);
    assert.deepEqual(await snapshot(movedProject), beforeFailure);
    await chmod(manifest, 0o644);
    const rebound = invoke(movedProject, ['init', movedProject], movedCompiler);
    assert.equal(rebound.status, 0, rebound.stderr);
    assert.equal(
      invoke(movedProject, ['emit', 'js', 'examples/a0-hello.a0']).stdout,
      baseline.stdout,
    );
    assert.equal(
      invoke(movedProject, ['revision', 'examples/a0-hello.a0', 'hello']).stdout,
      revision,
    );
    assert.equal(
      invoke(movedProject, ['run', 'examples/a0-hello.a0', 'hello', '7']).stdout,
      '15\n',
    );
    assert.equal(await readFile(join(movedProject, 'owner.txt'), 'utf8'), 'preserve owner bytes');
    const after = await snapshot(movedProject);
    for (const [p, text] of Object.entries(beforeMove))
      if (!['.a0/cli.mjs', '.a0/init.json'].includes(p)) assert.equal(after[p], text, p);
    assert.notEqual(after['.a0/cli.mjs'], beforeMove['.a0/cli.mjs']);
    assert.equal(invoke(movedProject, ['explain', '--verify']).status, 0);
    const current = await snapshot(movedProject);
    assert.equal(invoke(movedProject, ['init', movedProject], movedCompiler).status, 0);
    assert.deepEqual(await snapshot(movedProject), current);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
