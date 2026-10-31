import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { initSourceProject } from '../src/source-init.js';

test('standalone source initialization survives checkout removal and explicit relocation', {
  timeout: 180_000,
}, async (t) => {
  await mkdir(resolve('.a0-cache'), { recursive: true });
  const root = await mkdtemp(join(resolve('.a0-cache'), 'a0-standalone-'));
  const invoke = (exe: string, args: string[], cwd = root) =>
    spawnSync(exe, args, { cwd, encoding: 'utf8', timeout: 30_000 });
  const launch = (project: string, args: string[]) =>
    invoke(process.execPath, ['.a0/cli.mjs', ...args], project);
  const snapshot = async (project: string) =>
    Promise.all(
      ['.a0/cli.mjs', '.a0/init.json', '.a0/MODEL_GUIDE.txt', 'examples/a0-hello.a0'].map((p) =>
        readFile(join(project, p), 'utf8'),
      ),
    );
  try {
    const checkout = join(root, 'build checkout');
    await mkdir(join(checkout, 'dist'), { recursive: true });
    await cp(resolve('dist/src'), join(checkout, 'dist/src'), { recursive: true });
    await cp(resolve('dist/tools'), join(checkout, 'dist/tools'), { recursive: true });
    const install = join(root, 'install old');
    await mkdir(install);
    const filename = process.platform === 'win32' ? 'a0 source.exe' : 'a0 "$HOME" `false`';
    let exe = join(install, filename);
    const built = invoke('bun', [
      'build',
      '--compile',
      '--minify',
      '--bytecode',
      '--format=cjs',
      join(checkout, 'dist/src/source-standalone.js'),
      '--outfile',
      exe,
    ]);
    assert.equal(built.status, 0, built.stderr);
    await rename(checkout, join(root, 'removed checkout'));
    let project = join(root, 'project ü');
    assert.equal(invoke(exe, ['init', project]).status, 0);
    const first = await snapshot(project);
    assert.doesNotMatch(first[0] as string, /source-cli\.js|build checkout/);
    assert.match(first[0] as string, /spawnSync/);
    assert.equal(launch(project, ['check', 'examples/a0-hello.a0']).status, 0);
    assert.equal(launch(project, ['run', 'examples/a0-hello.a0', 'hello', '7']).stdout, '15\n');
    const revision = launch(project, ['revision', 'examples/a0-hello.a0', 'hello']).stdout;
    const idempotent = invoke(exe, ['init', project]);
    assert.equal(idempotent.status, 0, idempotent.stderr);
    assert.deepEqual(await snapshot(project), first);
    await writeFile(join(project, 'example.a0'), 'fn f\nv [A 7]\nx get v 0\nret << x 1\nend\n');
    assert.equal(launch(project, ['run', 'example.a0', 'f', '7']).stdout, '14\n');
    assert.notEqual(launch(project, ['check', 'example.a0', '--dense']).status, 0);

    const movedProject = join(root, 'project moved ü');
    await rename(project, movedProject);
    project = movedProject;
    const movedInstall = join(root, 'install moved ü');
    await rename(install, movedInstall);
    exe = join(movedInstall, filename);
    assert.notEqual(launch(project, ['check', 'example.a0']).status, 0);
    const before = await snapshot(project);
    await t.test(
      'regeneration rolls back after a manifest write failure',
      {
        skip: process.platform === 'win32' || process.getuid?.() === 0,
      },
      async () => {
        const manifest = join(project, '.a0/init.json');
        await chmod(manifest, 0o400);
        try {
          assert.notEqual(invoke(exe, ['init', project]).status, 0);
        } finally {
          await chmod(manifest, 0o600);
        }
        assert.deepEqual(
          await snapshot(project),
          before,
          'failed regeneration rolls back launcher',
        );
      },
    );
    const guide = join(project, '.a0/MODEL_GUIDE.txt');
    await writeFile(guide, 'owner-edited guide');
    const edited = await snapshot(project);
    assert.notEqual(invoke(exe, ['init', project]).status, 0);
    assert.deepEqual(await snapshot(project), edited, 'conflict refuses before any write');
    await writeFile(guide, before[2] as string);
    const regenerated = invoke(exe, ['init', project]);
    assert.equal(regenerated.status, 0, regenerated.stderr);
    assert.equal(launch(project, ['run', 'example.a0', 'f', '7']).stdout, '14\n');
    assert.equal(launch(project, ['revision', 'examples/a0-hello.a0', 'hello']).stdout, revision);
    await initSourceProject(project);
    assert.equal(launch(project, ['run', 'example.a0', 'f', '7']).stdout, '14\n');
    assert.equal(invoke(exe, ['init', project]).status, 0);
    assert.equal(launch(project, ['run', 'example.a0', 'f', '7']).stdout, '14\n');
    const bad = join(root, 'invalid invocation');
    await assert.rejects(
      initSourceProject(bad, { executable: 'relative' }),
      /INIT_INVALID_EXECUTABLE/,
    );
    await assert.rejects(initSourceProject(bad, { executable: root }), /INIT_INVALID_EXECUTABLE/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
