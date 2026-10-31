import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { parse } from '../src/core.js';
import { formatDense } from '../src/dense.js';

const moduleUrl = (path: string) => pathToFileURL(resolve(path)).href;
const cli = resolve('dist/src/cli.js');
const candidate = `import {main,reportCliError} from ${JSON.stringify(moduleUrl('dist/src/cli-main.js'))};
import {sourceMcpFrontend} from ${JSON.stringify(moduleUrl('dist/src/source-edit.js'))};
await main(JSON.parse(process.argv[1]),sourceMcpFrontend).catch(reportCliError);`;
const invoke = (args: string[], source = true) =>
  spawnSync(
    process.execPath,
    source ? ['--input-type=module', '-e', candidate, JSON.stringify(args)] : [cli, ...args],
    { encoding: 'utf8', env: { ...process.env, A0_NO_CACHE: '1' } },
  );

async function fixture(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'a0-source-cli-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('candidate CLI check, run, revision and output preserve the legacy program', () =>
  fixture(async (root) => {
    const legacy = join(root, 'legacy.a0'),
      source = join(root, 'source.a0');
    await writeFile(legacy, 'fn f u32 -> u32\nx shl p0 1\nret x\nend');
    await writeFile(source, 'fn f\nx << A 1\nret x\nend');
    for (const args of [['check'], ['revision'], ['run'], ['emit', 'c'], ['emit', 'js']]) {
      const tail = args[0] === 'revision' ? ['f'] : args[0] === 'run' ? ['f', '7'] : [];
      const before = invoke([...args, legacy, ...tail], false),
        after = invoke([...args, source, ...tail]);
      assert.equal(before.status, 0, before.stderr);
      assert.equal(after.status, 0, after.stderr);
      assert.equal(after.stdout, before.stdout, args.join(' '));
    }
    const view = invoke(['view', source, 'f']);
    assert.equal(view.status, 0, view.stderr);
    assert.match(view.stdout, /fn f _ -> _/);
    assert.match(view.stdout, /x << A 1/);
  }));

test('candidate CLI patch preserves revisions, grammar, atomic rejection and imports', () =>
  fixture(async (root) => {
    const file = join(root, 'main.a0'),
      patch = join(root, 'change.patch'),
      out = join(root, 'out.a0');
    await writeFile(join(root, 'lib.a0'), 'fn inc\nret add A 1\nend');
    await writeFile(file, 'use "lib.a0"\nfn f\nx inc A\nret x\nend');
    const before = invoke(['revision', file, 'f']);
    assert.equal(before.status, 0, before.stderr);
    await writeFile(patch, `patch f ${before.stdout.trim()}\nx << A 2\nend`);
    const result = invoke(['patch', file, patch, out]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(await readFile(out, 'utf8'), /x << A 2/);
    assert.equal(invoke(['run', out, 'f', '3']).stdout, '12\n');
    const stale = join(root, 'stale.a0');
    const rejected = invoke(['patch', out, patch, stale]);
    assert.notEqual(rejected.status, 0);
    await assert.rejects(access(stale));
    assert.match(await readFile(file, 'utf8'), /use "lib.a0"/);
  }));

test('candidate CLI respects strict overrides and refuses unmigrated or legacy options', () =>
  fixture(async (root) => {
    const file = join(root, 'main.a0');
    await writeFile(file, 'fn f\nx div A 0\nret x\nend');
    assert.equal(invoke(['run', file, 'f', '1']).stdout, '4294967295\n');
    const strict = invoke(['run', file, 'f', '1', '--profile', 'strict']);
    assert.notEqual(strict.status, 0);
    assert.match(strict.stderr, /zero/i);
    for (const args of [
      ['check', file, '--dense'],
      ['check', file, '--dense=a0'],
    ])
      assert.notEqual(invoke(args).status, 0);
  }));

test('candidate CLI exact fixes validate and retain candidate syntax', () =>
  fixture(async (root) => {
    const file = join(root, 'main.a0');
    await writeFile(file, 'fn f\nx mod A 2\nret x\nend');
    const result = invoke(['check', file, '--fix']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(await readFile(file, 'utf8'), /x rem A 2/);
  }));

test('candidate CLI example repair uses the selected grammar', () =>
  fixture(async (root) => {
    const file = join(root, 'example.a0');
    const source = 'fn f _x2 -> _x2\nex [1 2] -> [2 1]\nret A\nend';
    await writeFile(file, source);
    const rejected = invoke(['check', file, '--json']);
    assert.notEqual(rejected.status, 0);
    const diagnostic = JSON.parse(rejected.stdout).diagnostics[0];
    const replacement = diagnostic.fix.match(/`(ex [^`]+)`/)?.[1];
    assert.equal(replacement, 'ex [1 2] -> [1 2]');
    assert.equal(await readFile(file, 'utf8'), source);
    await writeFile(file, source.replace('ex [1 2] -> [2 1]', replacement));
    const accepted = invoke(['check', file]);
    assert.equal(accepted.status, 0, accepted.stderr);
  }));

test('importing CLI implementation performs no command', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `await import(${JSON.stringify(moduleUrl('dist/src/cli-main.js'))});`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

for (const spelling of ['legacy', 'dense-extension', 'dense-flag'] as const) {
  test(`candidate CLI imports ${spelling} projects into its bound grammar`, () =>
    fixture(async (root) => {
      const input = join(root, 'input'),
        output = join(root, 'converted');
      await mkdir(input);
      const dense = spelling !== 'legacy';
      const extension = spelling === 'dense-extension' ? '.a0d' : '.a0';
      const helper = '# helper\nfn inc u32 -> u32\nn add p0 1\nret n\nend\n';
      const entry = `# entry\nuse "lib${extension}"\nfn f u32 -> u32\nn call inc p0\nret n\nend\n`;
      const encode = (text: string) =>
        dense ? formatDense(parse(text), { comments: true, known: new Map([['inc', 1]]) }) : text;
      const entryFile = join(input, `main${extension}`),
        helperFile = join(input, `lib${extension}`);
      const originalEntry = encode(entry),
        originalHelper = encode(helper);
      await writeFile(entryFile, originalEntry);
      await writeFile(helperFile, originalHelper);
      const legacyFlag = spelling === 'dense-flag' ? ['--dense'] : [];
      const result = invoke(['migrate', entryFile, output, `--root=${input}`, ...legacyFlag]);
      assert.equal(result.status, 0, result.stderr);
      const manifest = JSON.parse(result.stdout);
      assert.equal(manifest.entry, 'main.a0');
      assert.equal(manifest.files.length, 2);
      assert.ok(
        manifest.files.every((f: { destination: string }) => f.destination.endsWith('.a0')),
      );
      const converted = join(output, manifest.entry);
      assert.equal(invoke(['check', converted]).status, 0);
      assert.equal(invoke(['run', converted, 'f', '7']).stdout, '8\n');
      assert.match(await readFile(converted, 'utf8'), /# entry/);
      assert.match(await readFile(join(output, 'lib.a0'), 'utf8'), /# helper/);
      for (const target of ['c', 'js']) {
        const before = invoke(['emit', target, entryFile, ...legacyFlag], false);
        const after = invoke(['emit', target, converted]);
        assert.equal(before.status, 0, before.stderr);
        assert.equal(after.status, 0, after.stderr);
        assert.equal(after.stdout, before.stdout);
      }
      assert.equal(await readFile(entryFile, 'utf8'), originalEntry);
      assert.equal(await readFile(helperFile, 'utf8'), originalHelper);
      assert.notEqual(invoke(['migrate', entryFile, output, ...legacyFlag]).status, 0);
      assert.notEqual(invoke(['migrate', entryFile, join(root, 'bad'), '--dense=a0']).status, 0);
    }));
}

test('candidate CLI refuses migration when its frontend has no import capability', () =>
  fixture(async (root) => {
    const file = join(root, 'main.a0'),
      destination = join(root, 'converted');
    await writeFile(file, 'fn f u32 -> u32\nret p0\nend');
    const script = `import {main,reportCliError} from ${JSON.stringify(moduleUrl('dist/src/cli-main.js'))};
import {sourceMcpFrontend} from ${JSON.stringify(moduleUrl('dist/src/source-edit.js'))};
const {migrateLegacy, ...frontend} = sourceMcpFrontend;
await main(JSON.parse(process.argv[1]),frontend).catch(reportCliError);`;
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', script, JSON.stringify(['migrate', file, destination])],
      { encoding: 'utf8' },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no legacy import capability/);
    await assert.rejects(access(destination));
  }));
