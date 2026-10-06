import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { applyDiff, selfCheck } from '../tools/app-edit-bench.js';
import { verdict, wilson } from '../tools/app-edit-summary.js';
import { APP_TASKS } from '../tools/app-edit-tasks.js';

test('app-edit set: 14 tasks, the file matches its seal', async () => {
  assert.equal(APP_TASKS.length, 14);
  const text = await readFile('tools/app-edit-tasks.ts', 'utf8');
  const seal = (await readFile('tools/app-edit-tasks.sha256', 'utf8')).split(/\s+/)[0];
  assert.equal(createHash('sha256').update(text).digest('hex'), seal);
});

test('app-edit diff applier: hunks by their old text, line numbers break ties', () => {
  const src = 'a\nb\nc\nb\nd\n';
  const d = (h: string): string => `--- a/front.ts\n+++ b/front.ts\n${h}`;
  assert.deepEqual(applyDiff(src, d('@@ -2,1 +2,1 @@\n-b\n+B\n')), { source: 'a\nB\nc\nb\nd\n' });
  assert.deepEqual(applyDiff(src, d('@@ -4,1 +4,1 @@\n-b\n+B\n')), { source: 'a\nb\nc\nB\nd\n' });
  assert.deepEqual(applyDiff(src, d('@@ -1,2 +1,3 @@\n a\n+x\n b\n@@ -5,1 +6,1 @@\n-d\n+e\n')), {
    source: 'a\nx\nb\nc\nb\ne\n',
  });
  assert.match(applyDiff(src, d('@@ -1,1 +1,1 @@\n-z\n+y\n')).error ?? '', /do not occur/);
  assert.match(applyDiff(src, 'just text').error ?? '', /before the first hunk/);
  // a fenced reply is unwrapped
  assert.deepEqual(applyDiff(src, `\`\`\`diff\n${d('@@ -5 +5 @@\n-d\n+D\n')}\`\`\`\n`), {
    source: 'a\nb\nc\nb\nD\n',
  });
});

test('app-edit verdict and intervals', () => {
  assert.equal(verdict({ accepted: 10, cost: 900 }, { accepted: 10, cost: 1000 }), 'a0');
  assert.equal(verdict({ accepted: 9, cost: 900 }, { accepted: 10, cost: 1000 }), 'mixed');
  assert.equal(verdict({ accepted: 10, cost: 1100 }, { accepted: 12, cost: 1000 }), 'ts');
  assert.equal(verdict({ accepted: 10, cost: 1000 }, { accepted: 10, cost: 1040 }), 'tie');
  assert.deepEqual(wilson(14, 14), [0.785, 1]);
});

test('app-edit self-check: references pass, start programs fail, wrong replies apply and fail', {
  timeout: 600_000,
}, async () => {
  const r = await selfCheck();
  for (const row of r.rows)
    assert.ok(
      row.referencePasses && row.startFails && row.wrongFails && row.wrongApplies,
      JSON.stringify(row),
    );
  assert.equal(r.rows.length, 28);
  assert.ok(r.ok);
});
