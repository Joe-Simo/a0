import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { init } from '../src/agents.js';
import { makeIo, parseAndValidate, run, validate } from '../src/core.js';
import { formatDense } from '../src/dense.js';
import { programRevision } from '../src/edit.js';
import { migrateSourceProject } from '../src/migrate.js';
import { assertNoPlaintextWriters } from '../src/plaintext-write.js';
import { formatSource, parseSource } from '../src/source.js';
import { SOURCE_EXAMPLES, SOURCE_GUIDE, SOURCE_STARTER } from '../src/source-guide.js';
import { initSourceProject } from '../src/source-init.js';
import { linkSource } from '../src/source-link.js';

const moduleUrl = (p: string) => pathToFileURL(resolve(p)).href;
const bound = `import {main,reportCliError} from ${JSON.stringify(moduleUrl('dist/src/cli-main.js'))};import {sourceMcpFrontend} from ${JSON.stringify(moduleUrl('dist/src/source-edit.js'))};await main(JSON.parse(process.argv[1]),sourceMcpFrontend).catch(reportCliError);`;
const invoke = (root: string, args: string[], input?: string) =>
  spawnSync(process.execPath, ['.a0/cli.mjs', ...args], {
    cwd: root,
    encoding: 'utf8',
    input,
    timeout: 30000,
    env: { ...process.env, A0_NO_CACHE: '1' },
  });
async function fixture(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'a0-init-source-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const visit = async (dir: string) => {
    for (const e of await readdir(join(root, dir), { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await visit(p);
      else out[p] = await readFile(join(root, p), 'utf8');
    }
  };
  await visit('');
  return out;
}

test('candidate primer examples validate, execute contracts, preserve revisions and cover IO', () => {
  const blocks = [...SOURCE_EXAMPLES.matchAll(/```a0\n([\s\S]*?)```/g)].map((m) => m[1] as string);
  assert.equal(blocks.length, 5);
  for (const m of SOURCE_GUIDE.matchAll(/```a0\n([\s\S]*?)```/g))
    validate(parseSource(m[1] as string));
  for (const text of blocks) {
    const p = validate(parseSource(text));
    assert.equal(programRevision(validate(parseSource(formatSource(p)))), programRevision(p));
  }
  const p = validate(parseSource(blocks[4] as string));
  const io = makeIo([17]);
  run(p.byName.get('echo')!, [io]);
  assert.deepEqual(io.output, [17]);
  assert.equal(run(validate(parseSource(SOURCE_STARTER)).byName.get('hello')!, [7]), 15);
});

test('candidate init generates one executable frontend across starter, guides, rules and hooks', () =>
  fixture(async (root) => {
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', bound, JSON.stringify(['init', root])],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(join(root, '.a0/MODEL_GUIDE.txt'), 'utf8'), SOURCE_GUIDE);
    const check = invoke(root, ['check', 'examples/a0-hello.a0']);
    assert.equal(check.status, 0, check.stderr);
    assert.equal(invoke(root, ['run', 'examples/a0-hello.a0', 'hello', '7']).stdout, '15\n');
    for (const p of [
      'AGENTS.md',
      '.cursor/rules/a0.mdc',
      '.windsurf/rules/a0.md',
      '.github/instructions/a0.instructions.md',
    ]) {
      const text = await readFile(join(root, p), 'utf8');
      assert.ok(text.includes('node .a0/cli.mjs'));
      assert.doesNotMatch(text, /`a0 (check|run|emit|mcp)/);
    }
    const hook = JSON.parse(await readFile(join(root, '.gemini/settings.json'), 'utf8')).hooks
      .AfterTool[0].hooks[0].command;
    assert.equal(hook, 'node .a0/cli.mjs hook');
    assert.equal(
      invoke(
        root,
        ['hook'],
        JSON.stringify({ cwd: root, tool_input: { file_path: 'examples/a0-hello.a0' } }),
      ).stdout,
      '',
    );
    await writeFile(join(root, 'bad.a0'), 'fn bad\nx add A missing\nret x\nend\n');
    assert.match(
      invoke(root, ['hook'], JSON.stringify({ cwd: root, tool_input: { file_path: 'bad.a0' } }))
        .stdout,
      /block/,
    );
    const badHook = invoke(
      root,
      ['hook'],
      JSON.stringify({ cwd: root, tool_input: { file_path: 'bad.a0' } }),
    );
    assert.match(badHook.stdout, /node \.a0\/cli\.mjs check/);
    const help = invoke(root, []);
    assert.match(help.stderr, /node \.a0\/cli\.mjs check/);
    assert.doesNotMatch(help.stderr, /a0 dense|a0 canon/);
    await rm(join(root, 'bad.a0'));
    const before = await snapshot(root);
    await initSourceProject(root);
    assert.deepEqual(await snapshot(root), before);
    await assertNoPlaintextWriters(root);
  }));

test('candidate init upgrades exact legacy generated rules and preserves user prefixes', () =>
  fixture(async (root) => {
    await writeFile(join(root, 'AGENTS.md'), '# My project\n');
    await init(root);
    const legacy = await snapshot(root);
    await initSourceProject(root);
    const after = await readFile(join(root, 'AGENTS.md'), 'utf8');
    assert.ok(after.startsWith('# My project\n'));
    assert.equal(after.split('<!-- a0:init -->').length, 2);
    assert.ok(after.includes('node .a0/cli.mjs'));
    assert.notEqual(
      await readFile(join(root, '.a0/MODEL_GUIDE.txt'), 'utf8'),
      legacy['.a0/MODEL_GUIDE.txt'],
    );
    assert.equal(invoke(root, ['run', 'examples/a0-hello.a0', 'hello', '7']).stdout, '15\n');
  }));

test('candidate init refuses modified rules before writing and preserves initialized edits', () =>
  fixture(async (root) => {
    await init(root);
    await writeFile(join(root, '.cursor/rules/a0.mdc'), 'owner custom rule');
    const before = await snapshot(root);
    await assert.rejects(initSourceProject(root), /INIT_CONFLICT/);
    assert.deepEqual(await snapshot(root), before);
    await writeFile(join(root, '.cursor/rules/a0.mdc'), before['.cursor/rules/a0.mdc'] as string);
    await rm(join(root, '.cursor/rules/a0.mdc'));
    await initSourceProject(root);
    await writeFile(join(root, 'examples/a0-hello.a0'), 'fn hello\nret 5\nend\n');
    const edited = await snapshot(root);
    await assert.rejects(initSourceProject(root), /INIT_CONFLICT/);
    assert.deepEqual(await snapshot(root), edited);
  }));

test('candidate init refuses sealed, active, interrupted and symlink targets without source writes', () =>
  fixture(async (root) => {
    const sealed = join(root, 'sealed');
    await mkdir(join(sealed, '.a0-seal'), { recursive: true });
    await writeFile(
      join(sealed, '.a0-seal/head.json'),
      JSON.stringify({ format: 'a0-vault-1', phase: 'on' }),
    );
    const before = await snapshot(sealed);
    await assert.rejects(initSourceProject(sealed), /SEALED_USE_UNLOCK_SESSION/);
    assert.deepEqual(await snapshot(sealed), before);
    const active = join(root, 'active');
    await mkdir(join(active, '.a0-init-lock'), { recursive: true });
    await assert.rejects(initSourceProject(active), /INIT_ACTIVE_OR_INTERRUPTED/);
    const unsafe = join(root, 'unsafe');
    await mkdir(unsafe);
    await symlink(sealed, join(unsafe, '.a0'), 'dir');
    await assert.rejects(initSourceProject(unsafe), /MIGRATION_SYMLINK/);
    assert.deepEqual(await snapshot(sealed), before);
    const parallel = join(root, 'parallel');
    const results = await Promise.allSettled([
      initSourceProject(parallel),
      initSourceProject(parallel),
    ]);
    assert.ok(results.some((r) => r.status === 'fulfilled'));
    await initSourceProject(parallel);
    await assertNoPlaintextWriters(parallel);
  }));

test('candidate init requires legacy source import and preserves migrated revisions', () =>
  fixture(async (root) => {
    const legacy = join(root, 'legacy');
    await mkdir(legacy);
    await writeFile(
      join(legacy, 'main.a0d'),
      formatDense(parseAndValidate('fn f u32 -> u32\nx add p0 1\nret x\nend\n')),
    );
    const before = await snapshot(legacy);
    await assert.rejects(initSourceProject(legacy));
    assert.deepEqual(await snapshot(legacy), before);
    const converted = join(root, 'converted');
    await migrateSourceProject(join(legacy, 'main.a0d'), converted, legacy);
    const entry = join(converted, 'main.a0');
    const revision = programRevision(
      (await linkSource(entry, (p) => readFile(p, 'utf8'), { root: converted })).program,
    );
    await initSourceProject(converted);
    assert.equal(
      programRevision(
        (await linkSource(entry, (p) => readFile(p, 'utf8'), { root: converted })).program,
      ),
      revision,
    );
    assert.deepEqual(await snapshot(legacy), before);
    assert.equal(invoke(converted, ['run', 'main.a0', 'f', '7']).stdout, '8\n');
  }));

test(
  'candidate init rolls back generated files after a real filesystem write failure',
  { skip: process.platform === 'win32' || process.getuid?.() === 0 },
  () =>
    fixture(async (root) => {
      await writeFile(join(root, 'AGENTS.md'), '# Keep owner instructions\n');
      await mkdir(join(root, '.a0'));
      const before = await snapshot(root);
      await chmod(join(root, '.a0'), 0o500);
      try {
        await assert.rejects(
          initSourceProject(root),
          (e: unknown) => (e as NodeJS.ErrnoException).code === 'EACCES',
        );
      } finally {
        await chmod(join(root, '.a0'), 0o700);
      }
      assert.deepEqual(await snapshot(root), before);
      await assertNoPlaintextWriters(root);
    }),
);

test('candidate init configures VS Code launcher arguments and preserves unrelated owner settings', () =>
  fixture(async (root) => {
    await mkdir(join(root, '.vscode'));
    await writeFile(
      join(root, '.vscode/settings.json'),
      JSON.stringify({ 'editor.fontSize': 15, 'a0.server.path': 'a0' }),
    );
    await initSourceProject(root);
    const config = JSON.parse(await readFile(join(root, '.vscode/settings.json'), 'utf8'));
    assert.deepEqual(config, {
      'editor.fontSize': 15,
      'a0.server.path': 'node',
      'a0.server.args': ['.a0/cli.mjs'],
    });
    config['editor.fontSize'] = 17;
    await writeFile(join(root, '.vscode/settings.json'), JSON.stringify(config));
    await initSourceProject(root);
    assert.equal(
      JSON.parse(await readFile(join(root, '.vscode/settings.json'), 'utf8'))['editor.fontSize'],
      17,
    );
    config['a0.server.path'] = 'owner-compiler';
    await writeFile(join(root, '.vscode/settings.json'), JSON.stringify(config));
    const before = await snapshot(root);
    await assert.rejects(initSourceProject(root), /INIT_CONFLICT/);
    assert.deepEqual(await snapshot(root), before);
  }));
