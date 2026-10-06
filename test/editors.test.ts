import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Both are CommonJS packages: loaded by require, typed by their own declarations.
const require = createRequire(import.meta.url);
const { loadWASM, OnigScanner, OnigString } =
  require('vscode-oniguruma') as typeof import('vscode-oniguruma');
const { INITIAL, parseRawGrammar, Registry } =
  require('vscode-textmate') as typeof import('vscode-textmate');

// dist/test/editors.test.js -> repository root
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const grammarDir = join(root, 'editors', 'tree-sitter-a0');
// tree-sitter-cli is a root devDependency: the normal `bun install` provides it.
const cli = join(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tree-sitter.exe' : 'tree-sitter',
);

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
      files.some((f) => f.replaceAll('\\', '/').includes(`/${dir}`)),
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

// Not a .a0 file in the repository: the spec lines of a sample there would be scanned by the
// spec-free pin of test/spec.test.ts, which keeps every repository program free of them.
const SPEC_SAMPLE = [
  'fn clamp_max u32 u32 -> u32',
  'ex 3 7 -> 3',
  'ex 9 7 -> 7',
  'pre lt p1 100',
  'post le r p1',
  'c lt p1 p0',
  'r select c p1 p0',
  'ret r',
  'end',
  '',
  'fn first_pair (u32,bool) -> u32',
  'ex (4;true) -> 4',
  'v at p0 0',
  'ret v',
  'end',
  '',
  'fn sum3 u32x3 -> u32',
  'ex [1;2;3] -> 6',
  'a get p0 0',
  'b get p0 1',
  'c get p0 2',
  'd add a b',
  'e add d c',
  'ret e',
  'end',
  '',
].join('\n');

test('tree-sitter parses spec lines and highlights their words as keywords, by place', () => {
  assert.ok(existsSync(cli), `missing ${cli}; run: bun install`);
  const dir = mkdtempSync(join(tmpdir(), 'a0-ts-'));
  try {
    const sample = join(dir, 'specs.a0');
    writeFileSync(sample, SPEC_SAMPLE);
    const parsed = treeSitter(['parse', '--quiet', sample]);
    assert.equal(parsed.status, 0, `${parsed.stdout}${parsed.stderr}`);
    const query = treeSitter(['query', 'queries/highlights.scm', sample]);
    assert.equal(query.status, 0, query.stderr);
    // `ex` three times in the first function and one each below, `pre` and `post` once.
    const text = SPEC_SAMPLE.split('\n');
    const captured = (word: string): number =>
      [
        ...query.stdout.matchAll(
          /capture: \d+ - keyword, start: \((\d+), (\d+)\), end: \((\d+), (\d+)\)/g,
        ),
      ].filter((m) => text[Number(m[1])]?.slice(Number(m[2]), Number(m[4])) === word).length;
    assert.equal(captured('ex'), 4);
    assert.equal(captured('pre'), 1);
    assert.equal(captured('post'), 1);
    // A node called `ex` or `pre` stays a node: the grammar parses it as an instruction.
    const named = join(dir, 'named.a0');
    writeFileSync(named, 'fn g u32 -> u32\nex add p0 1\npre add ex 1\nret pre\nend\n');
    const tree = treeSitter(['parse', named]);
    assert.equal(tree.status, 0, tree.stderr);
    assert.equal((tree.stdout.match(/\(instruction/g) ?? []).length, 2);
    assert.doesNotMatch(tree.stdout, /\((example|contract)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The scopes the TextMate grammar gives each word of each line (`word` -> scopes of its token). */
async function tokenize(source: string): Promise<Map<string, string[]>[]> {
  const wasm = readFileSync(join(root, 'node_modules', 'vscode-oniguruma', 'release', 'onig.wasm'));
  await loadWASM(
    wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer,
  );
  const registry = new Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (patterns) => new OnigScanner(patterns),
      createOnigString: (s) => new OnigString(s),
    }),
    loadGrammar: async () =>
      parseRawGrammar(
        readFileSync(join(root, 'editors', 'vscode', 'syntaxes', 'a0.tmLanguage.json'), 'utf8'),
        'a0.tmLanguage.json',
      ),
  });
  const grammar = await registry.loadGrammar('source.a0');
  assert.ok(grammar !== null);
  let stack = INITIAL;
  const out: Map<string, string[]>[] = [];
  for (const line of source.split('\n')) {
    const r = grammar.tokenizeLine(line, stack);
    stack = r.ruleStack;
    const words = new Map<string, string[]>();
    for (const t of r.tokens) {
      const w = line.slice(t.startIndex, t.endIndex).trim();
      if (w !== '' && !words.has(w)) words.set(w, t.scopes);
    }
    out.push(words);
  }
  return out;
}

test('TextMate grammar scopes spec lines by place and keeps nodes called ex, pre and post', async () => {
  const lines = await tokenize(
    [
      'fn f u32 u32 -> u32', // 0
      'ex 1 [2;3] -> 5', // 1
      'ex true -> false # note', // 2
      'pre lt p0 100', // 3
      'post call ok r', // 4
      'a add p0 1', // 5
      'pre add a 0', // 6   a node called pre, below the first node
      'ret a', // 7
      'end', // 8
      '', // 9
      'fn g u32 -> u32', // 10
      'ex add p0 1', // 11  a node called ex (no arrow)
      'ret ex', // 12
      'end', // 13
    ].join('\n'),
  );
  const scope = (line: number, word: string): string => (lines[line]?.get(word) ?? []).join(' ');
  assert.match(scope(0, 'fn'), /storage\.type\.function\.a0/);
  assert.match(scope(0, '->'), /keyword\.operator\.arrow\.a0/);
  assert.match(scope(1, 'ex'), /keyword\.other\.spec\.a0/);
  assert.match(scope(1, '->'), /keyword\.operator\.arrow\.a0/);
  assert.match(scope(1, '1'), /constant\.numeric\.integer\.a0/);
  assert.match(scope(2, 'true'), /constant\.language\.boolean\.a0/);
  assert.match(scope(2, '# note'), /comment\.line\.number-sign\.a0/);
  assert.match(scope(3, 'pre'), /keyword\.other\.spec\.a0/);
  assert.match(scope(3, 'lt'), /keyword\.operator\.word\.a0/);
  assert.match(scope(4, 'post'), /keyword\.other\.spec\.a0/);
  assert.match(scope(4, 'ok'), /entity\.name\.function\.call\.a0/);
  assert.match(scope(5, 'a'), /variable\.other\.definition\.a0/);
  // Below the first node, `pre` is a node's name.
  assert.match(scope(6, 'pre'), /variable\.other\.definition\.a0/);
  assert.doesNotMatch(scope(6, 'pre'), /keyword\.other\.spec/);
  assert.match(scope(7, 'ret'), /keyword\.control\.return\.a0/);
  assert.match(scope(8, 'end'), /keyword\.control\.end\.a0/);
  // An `ex` without an arrow is the first node of g.
  assert.match(scope(11, 'ex'), /variable\.other\.definition\.a0/);
  assert.match(scope(13, 'end'), /keyword\.control\.end\.a0/);
});
