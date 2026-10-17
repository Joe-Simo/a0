import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compile } from '../src/backends.js';
import { formatProgram, formatSource, parse, run } from '../src/core.js';
import { parseDense } from '../src/dense.js';
import { programRevision } from '../src/edit.js';
import { link } from '../src/link.js';
import { migrateProject } from '../src/migrate.js';
import { TARGETS } from '../src/targets.js';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const read = (path: string): Promise<string> => readFile(path, 'utf8');
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');

test('migration refuses sealed source closures and destinations before publishing plaintext', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'a0-migrate-sealed-'));
  try {
    const project = join(scratch, 'input');
    const nested = join(project, 'lib');
    const entry = join(project, 'main.a0');
    const output = join(scratch, 'output');
    await mkdir(nested, { recursive: true });
    await writeFile(entry, 'use "lib/inc.a0"\nfn main -> u32\na call inc 1\nret a\nend\n');
    await writeFile(join(nested, 'inc.a0'), 'fn inc u32 -> u32\na add p0 1\nret a\nend\n');
    for (const phase of ['on', 'off', 'sealing', 'unsealing']) {
      const store = join(project, '.a0-seal');
      await mkdir(store);
      await writeFile(join(store, 'head.json'), JSON.stringify({ format: 'a0-vault-1', phase }));
      await assert.rejects(migrateProject(entry, output), /SEALED_USE_UNLOCK_SESSION/);
      const cli = spawnSync(
        process.execPath,
        [join(root, 'dist/src/cli.js'), 'migrate', entry, output],
        {
          encoding: 'utf8',
        },
      );
      assert.notEqual(cli.status, 0);
      assert.match(cli.stderr, /SEALED_USE_UNLOCK_SESSION/);
      await assert.rejects(access(output));
      await rm(store, { recursive: true });
    }
    const store = join(nested, '.a0-seal');
    await mkdir(store);
    await writeFile(join(store, 'head.json'), '{"format":"a0-vault-1","phase":"on"}');
    await assert.rejects(migrateProject(entry, output), /SEALED_USE_UNLOCK_SESSION/);
    await assert.rejects(access(output));
    await rm(store, { recursive: true });
    const sealedOutput = join(scratch, 'sealed-output');
    await mkdir(join(sealedOutput, '.a0-seal'), { recursive: true });
    await writeFile(
      join(sealedOutput, '.a0-seal/head.json'),
      '{"format":"a0-vault-1","phase":"on"}',
    );
    await assert.rejects(
      migrateProject(entry, join(sealedOutput, 'copy')),
      /SEALED_USE_UNLOCK_SESSION/,
    );
    await assert.rejects(access(join(sealedOutput, 'copy')));
    const alias = join(scratch, 'alias');
    const physicalParent = join(sealedOutput, 'nested');
    await mkdir(physicalParent);
    await symlink(physicalParent, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(
      migrateProject(entry, join(alias, 'missing', 'copy')),
      /SEALED_USE_UNLOCK_SESSION/,
    );
    await assert.rejects(access(join(physicalParent, 'missing')));
    await rm(join(sealedOutput, '.a0-seal'), { recursive: true });
    const manifest = await migrateProject(entry, join(alias, 'missing', 'copy'));
    assert.equal(manifest.entry, 'main.a0d');
    await access(join(physicalParent, 'missing', 'copy', manifest.entry));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('migration preserves imports, comments, contracts, revisions and all backend output', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'a0-migrate-test-'));
  try {
    const project = join(scratch, 'input');
    await mkdir(join(project, 'lib'), { recursive: true });
    const helper = '# increment\nfn inc u32 -> u32\na add p0 1 # wrapping\nret a\nend\n';
    const main =
      '# entry\nuse "lib/inc.a0" # dependency\nfn main u32 -> u32\nex 3 -> 4\na call inc p0\nret a # result\nend # done\n';
    await writeFile(join(project, 'lib/inc.a0'), helper);
    await writeFile(join(project, 'main.a0'), main);
    const entry = join(project, 'main.a0');
    const output = join(scratch, 'output');
    const manifest = await migrateProject(entry, output);
    assert.equal(manifest.entry, 'main.a0d');
    assert.equal(manifest.files.length, 2);
    assert.equal(await read(entry), main);
    assert.equal(await read(join(project, 'lib/inc.a0')), helper);
    const migrated = await read(join(output, manifest.entry));
    assert.match(migrated, /use "lib\/inc.a0d" # dependency/);
    for (const f of manifest.files) {
      assert.equal(f.beforeSha256, hash(await read(join(project, f.source))));
      assert.equal(f.afterSha256, hash(await read(join(output, f.destination))));
    }
    const before = await link(entry, read, { root: project });
    const after = await link(join(output, manifest.entry), read, { root: output });
    assert.equal(formatProgram(after.program), formatProgram(before.program));
    assert.equal(programRevision(after.program), manifest.revision);
    for (const target of TARGETS)
      assert.equal(
        compile(after.program, target).text,
        compile(before.program, target).text,
        target,
      );
    const fn = after.program.byName.get('main');
    assert.ok(fn);
    assert.equal(run(fn, [0xffff_ffff]), 0);
    assert.equal(run(fn, [3]), 4);
    const second = join(scratch, 'second');
    const again = await migrateProject(join(output, manifest.entry), second);
    for (const f of again.files)
      assert.equal(await read(join(second, f.destination)), await read(join(output, f.source)));
    const saved = JSON.parse(await read(join(output, 'a0-migration.json')));
    assert.deepEqual(saved, manifest);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('migration never overwrites a destination or publishes invalid or cyclic projects', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'a0-migrate-test-'));
  try {
    const entry = join(scratch, 'main.a0');
    const output = join(scratch, 'output');
    await writeFile(entry, 'fn main -> u32\nret 1\nend\n');
    await mkdir(output);
    await assert.rejects(migrateProject(entry, output), /EEXIST/);
    assert.deepEqual(await readdir(output), []);
    await writeFile(join(output, 'keep'), 'existing data');
    await assert.rejects(migrateProject(entry, output), /EEXIST/);
    assert.equal(await read(join(output, 'keep')), 'existing data');
    await writeFile(entry, 'fn main -> u32\na add p0 1\nret a\nend\n');
    const bad = join(scratch, 'bad');
    await assert.rejects(migrateProject(entry, bad));
    await assert.rejects(access(bad));
    await writeFile(entry, 'use "main.a0"\nfn main -> u32\nret 1\nend\n');
    await assert.rejects(migrateProject(entry, bad), /cycle/);
    await assert.rejects(access(bad));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('migration retains strict semantics and compiler CLI checks the result', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'a0-migrate-test-'));
  try {
    const source = 'profile strict # checked\n\nfn main u32 -> u32\na div 1 p0\nret a\nend\n';
    const entry = join(scratch, 'main.a0');
    await writeFile(entry, source);
    const output = join(scratch, 'output');
    const cli = join(root, 'dist/src/cli.js');
    const child = spawnSync(process.execPath, [cli, 'migrate', entry, output], {
      encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stderr);
    const manifest = JSON.parse(child.stdout);
    const check = spawnSync(process.execPath, [cli, 'check', join(output, manifest.entry)], {
      encoding: 'utf8',
    });
    assert.equal(check.status, 0, check.stderr);
    const linked = await link(join(output, manifest.entry), read, { root: output });
    assert.equal(linked.program.profile, 'strict');
    const before = await link(entry, read, { root: scratch });
    assert.equal(formatSource(before.program), formatSource(linked.program));
    assert.equal(
      formatSource(parse(source)),
      formatSource(parseDense(await read(join(output, manifest.entry)))),
    );
    const fn = linked.program.byName.get('main');
    assert.ok(fn);
    assert.throws(() => run(fn, [0]));
    assert.equal(run(fn, [1]), 1);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('migration accepts legacy Dense trees stored in .a0 files without changing imports semantics', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'a0-migrate-test-'));
  try {
    const entry = join(scratch, 'main.a0');
    await writeFile(join(scratch, 'inc.a0'), 'fn inc + A 1\n');
    await writeFile(entry, 'use "inc.a0"\n\nfn main inc A\n');
    const before = await link(entry, read, { root: scratch, dense: true });
    const output = join(scratch, 'output');
    const manifest = await migrateProject(entry, output, scratch, true);
    const after = await link(join(output, manifest.entry), read, { root: output });
    assert.equal(formatProgram(after.program), formatProgram(before.program));
    assert.match(await read(join(output, manifest.entry)), /use "inc.a0d"/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('migration refuses invalid UTF-8 rather than silently changing source bytes', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'a0-migrate-test-'));
  try {
    const entry = join(scratch, 'main.a0');
    const bytes = Buffer.concat([
      Buffer.from('# comment '),
      Buffer.from([0xff]),
      Buffer.from('\nfn main -> u32\nret 1\nend\n'),
    ]);
    await writeFile(entry, bytes);
    const output = join(scratch, 'output');
    await assert.rejects(migrateProject(entry, output), /valid UTF-8/);
    assert.deepEqual(await readFile(entry), bytes);
    await assert.rejects(access(output));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
