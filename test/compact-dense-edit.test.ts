import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseAndValidate, run, type TypedFunc, type Value } from '../src/core.js';

// docs/history/2026-10-09-compact-dense-edit-accuracy-preregistration.md
test('set CD is sealed and every task passes the draw checks', async () => {
  const seal = readFileSync('tools/ai-edit-tasks-cd.sha256', 'utf8').split(/\s+/)[0];
  assert.equal(
    createHash('sha256').update(readFileSync('tools/ai-edit-tasks-cd.ts')).digest('hex'),
    seal,
  );
  const { TASKS_CD } = await import('../tools/ai-edit-tasks-cd.js');
  assert.equal(TASKS_CD.length, 45);
  const passes = (src: string, t: (typeof TASKS_CD)[number]): boolean => {
    const p = parseAndValidate(src);
    return t.tests.every((x) => {
      try {
        const got = run(p.byName.get(x.fn) as TypedFunc, x.args as Value[], { fuel: 1_000_000 });
        return JSON.stringify(got) === JSON.stringify(x.expected);
      } catch {
        return false;
      }
    });
  };
  for (const t of TASKS_CD) {
    assert.ok(t.tests.length >= 8, t.id);
    assert.ok(passes(t.reference.a0, t), t.id);
    assert.ok(!passes(t.a0Source, t), t.id);
    for (const w of t.wrongEdits) assert.ok(!passes(w, t), t.id);
  }
});
