import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { getEncoding } from 'js-tiktoken';
import { formatDiagnostic, parseAndValidate } from '../src/core.js';
import { A0Error } from '../src/diagnostics.js';
import { EditSession } from '../src/edit.js';
import { compareRule, PHASES } from '../tools/primer-compare-summary.js';

const SRC = 'fn f u32 u32 -> u32\na add p0 p1\nret a\nend\n';
const FOLD =
  'fn step u32 u32 -> u32\ns add p0 p1\nret s\nend\nfn g u32 -> u32\nr fold step 3 0\nret r\nend\n';

function withHints<T>(on: boolean, body: () => T): T {
  const before = process.env.A0_LAZY_HINTS;
  if (on) process.env.A0_LAZY_HINTS = 'on';
  else delete process.env.A0_LAZY_HINTS;
  try {
    return body();
  } finally {
    if (before === undefined) delete process.env.A0_LAZY_HINTS;
    else process.env.A0_LAZY_HINTS = before;
  }
}

function reject(source: string, fn: string, reply: string, session?: EditSession): string {
  const s = session ?? new EditSession(parseAndValidate(source));
  if (session === undefined) s.open(fn, { scope: 'deps' });
  try {
    s.apply(reply);
  } catch (e) {
    assert.ok(e instanceof A0Error);
    return formatDiagnostic(e, false);
  }
  throw new Error('expected a rejection');
}

test('set Z is sealed and has the registered mix', async () => {
  const seal = readFileSync('tools/ai-edit-tasks-z.sha256', 'utf8').split(/\s+/)[0];
  assert.equal(
    createHash('sha256').update(readFileSync('tools/ai-edit-tasks-z.ts')).digest('hex'),
    seal,
  );
  const { TASKS_Z } = await import('../tools/ai-edit-tasks-z.js');
  assert.ok(TASKS_Z.length >= 28);
  const all = TASKS_Z.map((t) => t.a0Source + t.reference.a0);
  assert.ok(all.filter((s) => / loop /.test(s)).length >= 8);
  assert.ok(all.filter((s) => / text "/.test(s)).length >= 6);
  assert.ok(all.filter((s) => /\b(read|write|puts) /.test(s)).length >= 8);
});

test('the V4 primer is the registered 137-token text', () => {
  const v4 = readFileSync('experiments/primers/lazy/V4.txt', 'utf8');
  assert.equal(getEncoding('o200k_base').encode(v4).length, 137);
  assert.match(v4, /Errors explain the rest/);
});

test('without A0_LAZY_HINTS a rejection is exactly the V3-era text', () => {
  const msg = withHints(false, () => reject(SRC, 'f', 'b add a 1 2\nret b\n'));
  assert.doesNotMatch(msg, /rules:/);
  assert.doesNotMatch(msg, /add a b:/);
});

test('with the hints on: the op signature, the rule card once, the op table for an unknown op', () => {
  withHints(true, () => {
    const session = new EditSession(parseAndValidate(SRC));
    session.open('f', { scope: 'deps' });
    const first = reject(SRC, 'f', 'b eq a p9\nret b\n', session);
    assert.match(first, /rules: one op per line/);
    const second = reject(SRC, 'f', 'b eq a p9\nret b\n', session);
    assert.doesNotMatch(second, /rules: one op per line/);
    const unknown = reject(SRC, 'f', 'b frobnicate a\nret b\n');
    assert.match(unknown, /ops: add sub mul/);
    assert.match(unknown, /fold F n s a\.\.\./);
    const typed = reject(
      'fn f io u32 -> io\na write p0 p1\nret a\nend\n',
      'f',
      'b add a 1\nret b\n',
    );
    assert.match(typed, /add a b: u32 u32 -> u32/);
  });
});

test('the view of a function that uses fold ends with the fold legend, other views do not', () => {
  const view = (src: string, fn: string): string =>
    new EditSession(parseAndValidate(src)).open(fn, { scope: 'deps' }).text;
  withHints(true, () => {
    assert.match(view(FOLD, 'g'), /# fold F n s a\.\.\./);
    assert.doesNotMatch(view(SRC, 'f'), /# fold/);
  });
  withHints(false, () => assert.doesNotMatch(view(FOLD, 'g'), /# fold/));
});

test('phase v4: both models, not higher at the 10-task horizon, one task of margin', () => {
  assert.equal(PHASES.v4?.baseline, 'V3');
  assert.equal(PHASES.v4?.margin, 1);
  assert.equal(
    compareRule({ accepted: 20, cost: 100 }, { accepted: 19, cost: 100 }, 1, [], null, true).pass,
    true,
  );
  assert.equal(
    compareRule({ accepted: 20, cost: 100 }, { accepted: 19, cost: 101 }, 1, [], null, true).pass,
    false,
  );
  assert.equal(
    compareRule({ accepted: 20, cost: 100 }, { accepted: 18, cost: 50 }, 1, [], null, true).pass,
    false,
  );
});
