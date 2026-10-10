import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { findClang } from '../src/toolchain.js';
import { buildProgram, type Keys, wasmTool } from '../tools/site-build.js';
import {
  codeDigest,
  importClosure,
  KEEP,
  openCache,
  readEntry,
  type SiteCache,
  writeEntry,
} from '../tools/site-cache.js';
import { buildGenerator, generate } from '../tools/site-gen.js';

// The cache tests keep their files under .a0-cache (git-ignored): a path with no spaces, which the
// generator's `f` lines need, and nothing in the repository's tracked tree.
const SCRATCH = '.a0-cache';
const skip = findClang().path === undefined ? 'clang not found' : false;

async function scratch(prefix: string): Promise<string> {
  await mkdir(SCRATCH, { recursive: true });
  return mkdtemp(join(SCRATCH, prefix));
}

async function put(root: string, path: string, text: string): Promise<void> {
  await mkdir(join(root, dirname(path)), { recursive: true });
  await writeFile(join(root, path), text, 'utf8');
}

test('the code digest covers the files a module reaches through imports and no other', async () => {
  const root = await scratch('site-cache-closure-');
  try {
    await put(
      root,
      'tools/a.ts',
      "import { x } from './b.js';\nexport * from '../src/c.js';\nimport 'node:fs';\nconst d = import('./d.js');\n",
    );
    await put(root, 'tools/b.ts', 'export const x = 1;\n');
    await put(root, 'src/c.ts', 'export const c = 2;\n');
    await put(root, 'tools/d.ts', 'export const d = 3;\n');
    await put(root, 'tools/unrelated.ts', 'export const u = 4;\n');
    assert.deepEqual(importClosure(['tools/a.ts'], root), [
      'src/c.ts',
      'tools/a.ts',
      'tools/b.ts',
      'tools/d.ts',
    ]);
    const before = codeDigest(['tools/a.ts'], root);
    await put(root, 'tools/unrelated.ts', 'export const u = 5;\n');
    assert.equal(codeDigest(['tools/a.ts'], root), before, 'a file no import reaches is not in it');
    await put(root, 'src/c.ts', 'export const c = 3;\n');
    assert.notEqual(codeDigest(['tools/a.ts'], root), before, 'a file a module reaches is');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a cache entry is a hit only while each of its files matches its digest', async () => {
  const root = await scratch('site-cache-entry-');
  try {
    const cache: SiteCache = openCache({ dir: join(root, 'cache') });
    await writeEntry(cache, 'kind', 'k1', { a: 'one', b: 'two' });
    const hit = await readEntry(cache, 'kind', 'k1');
    assert.equal(hit?.get('a')?.toString('utf8'), 'one');
    assert.equal(hit?.get('b')?.toString('utf8'), 'two');
    assert.equal(await readEntry(cache, 'kind', 'missing'), undefined);
    await writeFile(join(root, 'cache', 'kind', 'k1', 'a'), 'changed');
    assert.equal(await readEntry(cache, 'kind', 'k1'), undefined, 'a changed file is a miss');
    await writeEntry(cache, 'kind', 'k1', { a: 'one', b: 'two' });
    await rm(join(root, 'cache', 'kind', 'k1', 'b'));
    assert.equal(await readEntry(cache, 'kind', 'k1'), undefined, 'a missing file is a miss');
    await writeEntry(cache, 'kind', 'k1', { a: 'one', b: 'two' });
    assert.ok(await readEntry(cache, 'kind', 'k1'), 'the entry is written again');
    assert.equal(
      await readEntry(openCache({ enabled: false }), 'kind', 'k1'),
      undefined,
      'with the cache off nothing hits',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the cache keeps the newest entries of a kind and no more', async () => {
  const root = await scratch('site-cache-prune-');
  try {
    const cache = openCache({ dir: join(root, 'cache') });
    for (let i = 0; i < KEEP + 2; i += 1) await writeEntry(cache, 'kind', `k${i}`, { a: `${i}` });
    assert.equal(readdirSync(join(root, 'cache', 'kind')).length, KEEP);
    assert.ok(await readEntry(cache, 'kind', `k${KEEP + 1}`), 'the newest is kept');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The page program is the expensive artifact (the optimizer and emitter run as a subprocess per
// chunk): build it without the cache, build it into an empty cache, then rebuild it from the
// cache. The three must be the same bytes, and only the last may be a hit.
test('a page program rebuilt from the cache has the same bytes as one built without it', {
  skip,
  timeout: 1_800_000,
}, async () => {
  const root = await scratch('site-cache-program-');
  try {
    const cache = openCache({ dir: join(root, 'cache') });
    const off = openCache({ enabled: false });
    // the wasm tool is built once, into the empty cache (a miss), and the three runs share it
    const tool = await wasmTool(findClang(), cache, () => undefined);
    const code = codeDigest(['tools/site-build.ts']);
    const notes: boolean[] = [];
    const keysFor = (c: SiteCache): Keys => ({
      cache: c,
      tool: tool.digest,
      code,
      note: (hit) => notes.push(hit),
    });
    const dirs = ['off', 'miss', 'hit'].map((d) => join(root, d));
    for (const d of dirs) await mkdir(d, { recursive: true });
    const [offDir, missDir, hitDir] = dirs as [string, string, string];
    const reference = await buildProgram(tool.exe, 'page.a0', 'page', keysFor(off), offDir);
    const miss = await buildProgram(tool.exe, 'page.a0', 'page', keysFor(cache), missDir);
    const hit = await buildProgram(tool.exe, 'page.a0', 'page', keysFor(cache), hitDir);
    assert.deepEqual(notes, [false, true], 'the empty cache misses, the next run hits');
    assert.deepEqual(miss, reference);
    assert.deepEqual(hit, reference);
    const wasm = await readFile(join(offDir, 'page.wasm'));
    assert.ok(wasm.equals(await readFile(join(missDir, 'page.wasm'))), 'miss: same wasm');
    assert.ok(wasm.equals(await readFile(join(hitDir, 'page.wasm'))), 'hit: same wasm');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// A changed template, or a file a template names, is a different generator input: the generated
// source is built again, and the stored one is still there for the original input.
test('a changed template or data file invalidates the generated source, and the generator binary is restored', {
  skip,
  timeout: 1_800_000,
}, async () => {
  const root = await scratch('site-cache-template-');
  try {
    const cache = openCache({ dir: join(root, 'cache') });
    const bin = await buildGenerator('sitegen', { cache, buildDir: join(root, 'generator') });
    const seen: boolean[] = [];
    const onCache = (hit: boolean): void => {
      seen.push(hit);
    };
    const committed = await readFile('site/page.a0', 'utf8');
    assert.equal(await generate(bin, 'site/gen/page.tpl', { cache, onCache }), committed);
    assert.equal(await generate(bin, 'site/gen/page.tpl', { cache, onCache }), committed);
    assert.deepEqual(seen, [false, true], 'the first generation misses, the second hits');

    // the generator binary restored from the cache generates the same page
    const restored: boolean[] = [];
    const again = await buildGenerator('sitegen', {
      cache,
      buildDir: join(root, 'generator-again'),
      onCache: (hit) => restored.push(hit),
    });
    assert.deepEqual(restored, [true]);
    assert.equal(await generate(again, 'site/gen/page.tpl', { cache }), committed);

    // one word of a template changes: a miss, and the page says the new word
    const tpl = await readFile('site/gen/page.tpl', 'utf8');
    const wordTpl = join(root, 'word.tpl');
    await writeFile(
      wordTpl,
      tpl.replace('A0 checks it before it lands', 'A0 checks it before it is kept'),
    );
    const changed = await generate(bin, wordTpl, { cache, onCache });
    assert.equal(seen[2], false, 'a changed template misses');
    assert.match(changed, /A0 checks it before it is kept/);

    // a file a template names (its style sheet, copied so it can change) is part of the input
    const css = join(root, 'style.css');
    await writeFile(css, await readFile('site/gen/style.css', 'utf8'));
    const cssTpl = join(root, 'css.tpl');
    await writeFile(cssTpl, tpl.replace('f css site/gen/style.css', `f css ${css}`));
    await generate(bin, cssTpl, { cache, onCache });
    await writeFile(css, `${await readFile(css, 'utf8')}\n/* changed for the test */\n`);
    const cssChanged = await generate(bin, cssTpl, { cache, onCache });
    assert.deepEqual(seen.slice(3), [false, false], 'the template and then the changed file miss');
    assert.match(cssChanged, /changed for the test/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
