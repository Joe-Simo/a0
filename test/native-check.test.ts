import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { findClang, findGcc } from '../src/toolchain.js';
import { buildNativeCheck } from '../tools/native-check.js';
import { cleanup, compare, programSet, type Row, tempDir } from '../tools/native-check-diff.js';

const compiler = findClang().path ?? findGcc().path;
const skip = compiler === undefined ? 'no C compiler (clang or gcc) on this machine' : false;

/**
 * Programs the native checker declines (exit 65: a function over a capacity of the self-hosted
 * front end, tools/native/a0.c `give_up`); the command line then uses the TypeScript checker.
 * site/bench.a0 holds functions of more than 2730 nodes (compiler/parse.a0 `fecap`).
 */
const DECLINED = new Set(['site/bench.a0']);

test('native check: same verdict as the TypeScript checker on the corpus, the sources and their mutants', {
  skip,
  timeout: 1_800_000,
}, async () => {
  const dir = tempDir();
  try {
    // its own build directory: the test files of this suite run side by side
    const { exe } = await buildNativeCheck({ dir: join(dir, 'native') });
    const rows: Row[] = [];
    let largest = 0;
    for (const p of await programSet(dir, 24)) {
      const row = await compare(exe, p);
      rows.push(row);
      if (row.outcome === 'same' && row.reference.ok) largest = Math.max(largest, row.bytes);
    }
    assert.deepEqual(
      rows.filter((r) => r.outcome !== 'same' && r.outcome !== 'unsupported'),
      [],
    );
    assert.deepEqual(
      rows.filter((r) => r.outcome === 'unsupported' && !DECLINED.has(r.label)).map((r) => r.label),
      [],
    );
    // the programs are the ones the task names: the front end's own sources and the app edits
    for (const label of [
      'compiler/check.a0',
      'compiler/lex.a0',
      'compiler/boot.a0',
      'site/ui.a0',
      'examples/life.a0',
      'app-edit/start',
    ])
      assert.ok(
        rows.some((r) => r.label === label && r.outcome === 'same'),
        label,
      );
    assert.equal(rows.filter((r) => r.label.startsWith('app-edit/')).length, 15);
    assert.ok(rows.filter((r) => r.label.startsWith('mutant-')).length >= 24);
    assert.ok(rows.filter((r) => r.label.startsWith('pair-')).length >= 12);
    assert.ok(rows.filter((r) => !r.reference.ok && r.outcome === 'same').length >= 60);
    // accepted whole, at 200 KB and beyond (the whole files; a linked program is larger still)
    assert.ok(largest >= 200_000, `largest accepted program ${largest} bytes`);
    assert.ok(statSync('compiler/emit_wasm.a0').size >= 200_000);
  } finally {
    cleanup(dir);
  }
});
