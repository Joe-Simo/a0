import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// dist/test/editors.test.js -> repository root
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const grammarDir = join(root, 'editors', 'tree-sitter-a0');
// tree-sitter-cli is a root devDependency: the normal `bun install` provides it.
const cli = join(root, 'node_modules', '.bin', 'tree-sitter');

const treeSitter = (args: string[]) =>
  spawnSync(cli, args, { cwd: grammarDir, encoding: 'utf8', maxBuffer: 1 << 26 });

test('tree-sitter grammar parses every .a0 file in the repository without errors', () => {
  assert.ok(existsSync(cli), `missing ${cli}; run: bun install`);
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((f) => f.endsWith('.a0'))
    // The reject corpus holds programs that are invalid on purpose: its rejected cases are not
    // grammar input (its fixed programs and bases are).
    .filter(
      (f) => !f.startsWith('corpus/reject/') || f.endsWith('.fixed.a0') || f.includes('/bases/'),
    )
    .map((f) => join(root, f))
    .filter((f) => existsSync(f));
  for (const dir of ['results/', 'examples/', 'compiler/', 'site/'])
    assert.ok(
      files.some((f) => f.includes(`/${dir}`)),
      `no .a0 files found under ${dir}`,
    );
  const gen = treeSitter(['generate']);
  assert.equal(gen.status, 0, gen.stderr);
  const parsed = treeSitter(['parse', '--quiet', ...files]);
  const failures = `${parsed.stdout}${parsed.stderr}`
    .split('\n')
    .filter((line) => /\(ERROR|\(MISSING/.test(line));
  assert.deepEqual(failures, []);
  assert.equal(parsed.status, 0, parsed.stderr);
});

test('tree-sitter corpus tests and highlight query pass', () => {
  assert.ok(existsSync(cli), `missing ${cli}; run: bun install`);
  const corpus = treeSitter(['test']);
  assert.equal(corpus.status, 0, `${corpus.stdout}${corpus.stderr}`);
  const query = treeSitter([
    'query',
    'queries/highlights.scm',
    join(root, 'editors', 'linguist', 'samples', 'A0', 'kernels.a0'),
  ]);
  assert.equal(query.status, 0, query.stderr);
  for (const capture of ['keyword', 'function', 'operator', 'type.builtin', 'comment'])
    assert.match(query.stdout, new RegExp(`capture: \\d+ - ${capture.replace('.', '\\.')},`));
});
