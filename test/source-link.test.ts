import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { test } from 'node:test';
import { compile } from '../src/backends.js';
import { formatProgram, run } from '../src/core.js';
import { link } from '../src/link.js';
import { migrateProject, migrateSourceProject } from '../src/migrate.js';
import { linkSource } from '../src/source-link.js';
import { TARGETS } from '../src/targets.js';

const read = (path: string): Promise<string> => readFile(path, 'utf8');

test('source linking resolves imports once and maps nested validation failures to physical origins', async () => {
  const root = resolve('test/source-virtual');
  const files: Record<string, string> = {
    'inc.a0': 'profile strict\nfn inc\nret add A 1\nend\n',
    'main.a0': 'profile strict\nuse "inc.a0"\nfn main\na inc 41\nret a\nend\n',
  };
  const reads: string[] = [];
  const load = async (path: string): Promise<string> => {
    reads.push(basename(path));
    const text = files[basename(path)];
    assert.ok(text !== undefined);
    return text;
  };
  const options = { root, canonicalPath: async (path: string) => path };
  const linked = await linkSource(join(root, 'main.a0'), load, options);
  assert.deepEqual(reads, ['main.a0', 'inc.a0']);
  const main = linked.program.byName.get('main');
  assert.ok(main);
  assert.equal(run(main, []), 42);
  files['main.a0'] = 'profile strict\nuse "inc.a0"\nfn main\na inc true\nret a\nend\n';
  await assert.rejects(linkSource(join(root, 'main.a0'), load, options), /main\.a0:4:/);
  files['main.a0'] = 'profile strict\nuse "main.a0"\nfn main\nret 0\nend\n';
  await assert.rejects(linkSource(join(root, 'main.a0'), load, options), /cycle/);
});

test('whole-project source migration preserves legacy and Dense programs on every backend', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'a0-source-migrate-'));
  try {
    const input = join(scratch, 'input');
    await mkdir(join(input, 'lib'), { recursive: true });
    const entry = join(input, 'main.a0');
    await writeFile(
      entry,
      '# main\nuse "lib/inc.a0" # import\nfn main -> u32\na call inc 41\nret a\nend\n',
    );
    await writeFile(
      join(input, 'lib/inc.a0'),
      '# increment\nfn inc u32 -> u32\na add p0 1\nret a\nend\n',
    );
    const before = await link(entry, read, { root: input });
    const denseRoot = join(scratch, 'dense');
    const dense = await migrateProject(entry, denseRoot, input);
    for (const [name, source, root] of [
      ['legacy', entry, input],
      ['dense', join(denseRoot, dense.entry), denseRoot],
    ]) {
      assert.ok(name && source && root);
      const output = join(scratch, `converted-${name}`);
      const manifest = await migrateSourceProject(source, output, root);
      assert.equal(manifest.entry, 'main.a0');
      assert.ok(manifest.files.every((file) => file.destination.endsWith('.a0')));
      const after = await linkSource(join(output, manifest.entry), read, { root: output });
      assert.equal(formatProgram(after.program), formatProgram(before.program));
      const main = after.program.byName.get('main');
      assert.ok(main);
      assert.equal(run(main, []), 42);
      for (const target of TARGETS)
        assert.deepEqual(compile(after.program, target), compile(before.program, target), target);
      await assert.rejects(migrateSourceProject(source, output, root), /EEXIST/);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
