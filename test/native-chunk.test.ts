import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { link } from '../src/link.js';
import { findClang, findGcc, runTool } from '../src/toolchain.js';
import { buildNativeCheck } from '../tools/native-check.js';
import { cleanup, compare, materialize, mutants, tempDir } from '../tools/native-check-diff.js';

const compiler = findClang().path ?? findGcc().path;
const skip = compiler === undefined ? 'no C compiler (clang or gcc) on this machine' : false;

/** The chunked plan under test: a byte margin far below the front end's, so every source is cut. */
const FORCED = '--chunk-bytes=3000';
/** The unchunked plan: the whole program as one chunk (halved only where the front end refuses it). */
const WHOLE = '--chunk-bytes=0';

/** The chunks the driver announces on stderr for a run (A0_CHUNK_TRACE). */
function chunkCount(exe: string, flags: readonly string[], path: string): number {
  const r = runTool(exe, ['check', ...flags, path], {
    env: { ...process.env, A0_CHUNK_TRACE: '1' },
    timeoutMs: 600_000,
  });
  return r.stderr.split('\n').filter((l) => l.startsWith('chunk ')).length;
}

test('chunked check: forced small chunks give the unchunked check verdict and revisions, and the TypeScript checker', {
  skip,
  timeout: 1_800_000,
}, async () => {
  const dir = tempDir();
  try {
    const { exe } = await buildNativeCheck({ dir: join(dir, 'native') });
    const sources = ['compiler', 'site'].flatMap((d) =>
      readdirSync(d)
        .filter((f) => f.endsWith('.a0'))
        .sort()
        .map((f) => `${d}/${f}`),
    );
    assert.ok(sources.length >= 20, `${sources.length} sources`);
    let split = 0;
    let whole = 0;
    for (const path of sources) {
      const p = { label: path, path };
      const unchunked = await compare(exe, p, [WHOLE]);
      const chunked = await compare(exe, p, [FORCED]);
      assert.equal(chunked.outcome, 'same', `${path} chunked`);
      assert.equal(unchunked.outcome, 'same', `${path} whole`);
      // where the unchunked check fits (one chunk), it is the same verdict and revisions as the chunked one
      if (chunkCount(exe, [WHOLE], path) === 1) {
        whole += 1;
        assert.deepEqual(
          chunked.native,
          unchunked.native,
          `${path}: chunked differs from unchunked`,
        );
      }
      // the forced plan really cuts the source
      if (chunkCount(exe, [FORCED], path) > 1) split += 1;
      else assert.fail(`${path}: the forced plan did not split it`);
    }
    assert.ok(whole >= 4, `${whole} sources fit one chunk`);
    assert.equal(split, sources.length);

    // Rejections across chunk boundaries: seeded one-line edits of each linked source (as the
    // differential of tools/native-check-diff.ts makes them), each checked in the forced plan.
    let rejected = 0;
    for (const [i, path] of sources.entries()) {
      const text = (await link(path, (p) => Promise.resolve(readFileSync(p, 'utf8')))).text;
      for (const m of materialize(join(dir, `mutant-${i}`), mutants(text, 2, 0x5eed + i))) {
        const row = await compare(exe, m, [FORCED]);
        assert.equal(row.outcome, 'same', `${m.label} chunked`);
        if (!row.reference.ok) rejected += 1;
      }
    }
    assert.ok(rejected > 0, 'no mutant is rejected');
    console.log(
      `# chunked check: ${sources.length} sources, ${whole} fit one chunk, ${rejected} rejected mutants`,
    );
  } finally {
    cleanup(dir);
  }
});
