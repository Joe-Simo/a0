import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { getEncoding } from 'js-tiktoken';
import { compareRule, decide, PHASES } from '../tools/primer-compare-summary.js';

test('set Y is sealed and has the registered mix', async () => {
  const seal = readFileSync('tools/ai-edit-tasks-y.sha256', 'utf8').split(/\s+/)[0];
  assert.equal(
    createHash('sha256').update(readFileSync('tools/ai-edit-tasks-y.ts')).digest('hex'),
    seal,
  );
  const { TASKS_Y } = await import('../tools/ai-edit-tasks-y.js');
  assert.equal(TASKS_Y.length, 28);
  const all = TASKS_Y.map((t) => t.a0Source + t.reference.a0);
  assert.ok(all.filter((s) => / loop /.test(s)).length >= 8);
  assert.ok(all.filter((s) => / text "/.test(s)).length >= 6);
  assert.ok(all.filter((s) => /\b(read|write|puts) /.test(s)).length >= 8);
});

test('the shipped guide is the 244-token V3 and the skill and plugin copies follow it', () => {
  const read = (p: string): string => readFileSync(p, 'utf8');
  const v3 = read('experiments/primers/shrink/V3.txt');
  assert.equal(read('MODEL_GUIDE.min.txt'), v3);
  assert.equal(read('skills/a0/references/primer.txt'), v3);
  assert.equal(read('plugin/skills/a0/references/primer.txt'), v3);
  assert.equal(getEncoding('o200k_base').encode(v3).length, 244);
});

test('phase rules: margins, the per-set condition and both models', () => {
  assert.equal(PHASES.v3?.margin, 1);
  assert.equal(PHASES.dense?.margin, 2);
  assert.equal(PHASES.dense?.perSetMargin, 2);
  assert.equal(compareRule({ accepted: 20, cost: 100 }, { accepted: 19, cost: 90 }, 1).pass, true);
  assert.equal(compareRule({ accepted: 20, cost: 100 }, { accepted: 18, cost: 90 }, 1).pass, false);
  assert.equal(
    compareRule({ accepted: 20, cost: 100 }, { accepted: 20, cost: 100 }, 1).pass,
    false,
  );
  const sets = [
    { base: 16, variant: 16 },
    { base: 28, variant: 25 },
  ];
  assert.equal(
    compareRule({ accepted: 44, cost: 100 }, { accepted: 42, cost: 90 }, 2, sets, 2).pass,
    false,
  );
  assert.equal(decide({ haiku: { pass: true }, sonnet: { pass: true } }).change, true);
  assert.equal(decide({ haiku: { pass: true }, sonnet: { pass: false } }).change, false);
});
