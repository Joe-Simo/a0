import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { getEncoding } from 'js-tiktoken';
import { PHASES } from '../tools/primer-compare-summary.js';

test('set DL is sealed and has the registered mix', async () => {
  const seal = readFileSync('tools/ai-edit-tasks-dl.sha256', 'utf8').split(/\s+/)[0];
  assert.equal(
    createHash('sha256').update(readFileSync('tools/ai-edit-tasks-dl.ts')).digest('hex'),
    seal,
  );
  const { TASKS_DL } = await import('../tools/ai-edit-tasks-dl.js');
  assert.equal(TASKS_DL.length, 30);
  const all = TASKS_DL.map((t) => t.a0Source + t.reference.a0);
  assert.ok(all.filter((s) => / loop /.test(s)).length >= 6);
  assert.ok(all.filter((s) => / text "/.test(s)).length >= 5);
  assert.ok(all.filter((s) => /\b(read|write|puts) /.test(s)).length >= 7);
});

test('primer D1 is 189 tokens and the lenient phase is registered', () => {
  const d1 = readFileSync('experiments/primers/dense/D1.txt', 'utf8');
  assert.equal(getEncoding('o200k_base').encode(d1).length, 189);
  assert.equal(PHASES.lenient?.margin, 2);
  assert.equal(PHASES.lenient?.primers.dense, 'experiments/primers/dense/D1.txt');
});
