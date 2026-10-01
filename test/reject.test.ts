import assert from 'node:assert/strict';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CORPUS_DIR, check, loadCases, uncovered } from '../tools/reject-corpus.js';

test('reject corpus: every case raises its diagnostic and its fix gives the expected program', () => {
  const cases = loadCases();
  assert.ok(cases.length >= 30, `${cases.length} cases`);
  const results = cases.map((c) => check(c, false));
  const failing = results.filter((r) => r.problems.length > 0);
  assert.deepEqual(
    failing.map((r) => `${r.name}: ${r.problems.join('; ')}`),
    [],
  );
  // Both kinds are present, and every exact fix is exercised by a case.
  assert.ok(cases.some((c) => c.kind === 'edit'));
  assert.deepEqual(uncovered(results), []);
});

test('reject corpus: --bless rewrites the expectations and is idempotent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'a0-reject-'));
  try {
    await cp(CORPUS_DIR, dir, { recursive: true });
    const before = new Map<string, string>();
    for (const f of await readdir(dir))
      if (/\.(a0|edit)$/.test(f)) before.set(f, await readFile(join(dir, f), 'utf8'));
    // Break the expectations of one exact-fix case and one suggestion case, then bless.
    const exact = loadCases(dir).find((c) => c.name === 'op-case');
    const typo = loadCases(dir).find((c) => c.name === 'typo-op');
    assert.ok(exact !== undefined && typo !== undefined);
    await writeFile(exact.path, exact.text.replace(/^# err: .*/, '# err: A0001 9'));
    await writeFile(exact.fixedPath, 'garbage\n');
    await writeFile(typo.path, typo.text.replace(/^# err: .*/, '# err: A0001 9'));
    assert.ok(
      check(loadCases(dir).find((c) => c.name === 'op-case') as never, false).problems.length > 0,
    );
    for (const c of loadCases(dir)) check(c, true);
    for (const [f, text] of before)
      assert.equal(await readFile(join(dir, f), 'utf8'), text, `${f} after bless`);
    assert.deepEqual(
      loadCases(dir).map((c) => check(c, false).problems),
      loadCases(dir).map(() => []),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reject corpus: a missing exact-fix case is reported by the coverage check', () => {
  const results = loadCases()
    .map((c) => check(c, false))
    .filter((r) => !r.outcome.exercised.includes('A0003/hex'));
  assert.deepEqual(uncovered(results), [
    'A0003/hex: a hexadecimal literal becomes its decimal value',
  ]);
});
