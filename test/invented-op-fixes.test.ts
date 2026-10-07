import assert from 'node:assert/strict';
import { test } from 'node:test';
import { A0Error, parseAndValidate, run, type TypedFunc } from '../src/core.js';
import { EditSession } from '../src/edit.js';
import { fixAll } from '../src/fix.js';

const SRC = [
  'fn sq u32 -> u32\na mul p0 p0\nret a\nend',
  'fn pick u32 u32 -> u32\nx add p0 p1\nret x\nend',
  'fn flag bool -> bool\nb mov p0\nret b\nend',
].join('\n');

const val = (s: EditSession, name: string, ...args: unknown[]): unknown =>
  run(s.program.byName.get(name) as TypedFunc, args as never);

function rejection(s: EditSession, reply: string): A0Error {
  try {
    s.apply(reply);
  } catch (e) {
    assert.ok(e instanceof A0Error);
    return e;
  }
  throw new Error('accepted');
}

test('max and min on two u32 are an exact compare and select under a fresh id', () => {
  const s = new EditSession(parseAndValidate(SRC));
  s.open('pick');
  const e = rejection(s, 'x max p0 p1');
  assert.equal(e.id, 'A0102');
  assert.equal(e.applicability, 'exact');
  assert.deepEqual(
    e.edits.map((d) => d.op === 'lines' && d.rule),
    ['max'],
  );
  s.apply('fix all');
  assert.equal(val(s, 'pick', 3, 9), 9);
  assert.equal(val(s, 'pick', 9, 3), 9);
  assert.equal(val(s, 'pick', 4, 4), 4);
  const t = new EditSession(parseAndValidate(SRC));
  t.open('pick');
  assert.equal(rejection(t, 'x min p0 p1').applicability, 'exact');
  t.apply('fix all');
  assert.equal(val(t, 'pick', 3, 9), 3);
  assert.equal(val(t, 'pick', 9, 3), 3);
});

test('the fresh id of max avoids an id the function already has', () => {
  const s = new EditSession(
    parseAndValidate('fn f u32 u32 -> u32\nxt0 add p0 1\nx mov p1\nret x\nend'),
  );
  s.open('f');
  const e = rejection(s, 'x max xt0 p1');
  assert.equal(e.applicability, 'exact');
  const edit = e.edits[0];
  assert.ok(edit?.op === 'lines');
  assert.ok(edit.to.startsWith('xt1 gt'));
  s.apply('fix all');
  assert.equal(val(s, 'f', 5, 2), 6);
  assert.equal(val(s, 'f', 0, 2), 2);
});

test('max on a bool or with three operands has no exact fix, only the hint', () => {
  const s = new EditSession(parseAndValidate(SRC));
  s.open('flag');
  const e = rejection(s, 'b max p0 p0');
  assert.notEqual(e.applicability, 'exact');
  assert.ok(e.edits.length === 0);
  s.open('pick');
  const f = rejection(s, 'x max p0 p1 p0');
  assert.notEqual(f.applicability, 'exact');
});

test('not on one bool is xor with true; on a u32 it is a hint only', () => {
  const s = new EditSession(parseAndValidate(SRC));
  s.open('flag');
  const e = rejection(s, 'b not p0');
  assert.equal(e.applicability, 'exact');
  s.apply('fix all');
  assert.equal(val(s, 'flag', true), false);
  assert.equal(val(s, 'flag', false), true);
  const t = new EditSession(parseAndValidate(SRC));
  t.open('sq');
  const f = rejection(t, 'a not p0');
  assert.notEqual(f.applicability, 'exact');
  assert.match(f.fix ?? '', /eq x 0/);
});

test('hint-only names say what to write: neg, abs, cmp', () => {
  for (const [name, re] of [
    ['neg', /sub 0 x/],
    ['abs', /unsigned/],
    ['cmp', /eq ne lt le gt ge/],
  ] as const) {
    const s = new EditSession(parseAndValidate(SRC));
    s.open('sq');
    const e = rejection(s, `a ${name} p0 1`);
    assert.notEqual(e.applicability, 'exact', name);
    assert.match(e.fix ?? '', re, name);
  }
});

test('an add, mul, and, or or xor with more than two operands is an exact chain', () => {
  for (const [op, expect] of [
    ['add', 6],
    ['mul', 6],
    ['xor', 0],
    ['and', 0],
    ['or', 3],
  ] as const) {
    const s = new EditSession(parseAndValidate(SRC));
    s.open('sq');
    const e = rejection(s, `a ${op} 1 2 3`);
    assert.equal(e.id, 'A0014');
    assert.equal(e.applicability, 'exact', op);
    s.apply('fix all');
    assert.equal(val(s, 'sq', 5), expect, op);
  }
  const s = new EditSession(parseAndValidate(SRC));
  s.open('sq');
  rejection(s, 'a add p0 p0 p0 p0');
  s.apply('fix all');
  assert.equal(val(s, 'sq', 5), 20);
});

test('a chain whose fresh id clashes stops at the next diagnostic instead of guessing', () => {
  const s = new EditSession(
    parseAndValidate('fn f u32 -> u32\nat0 add p0 7\na mov at0\nret a\nend'),
  );
  s.open('f');
  // In an edit reply a line with an existing id replaces that node: the fix is not offered as exact.
  const e = rejection(s, 'a add p0 1 2');
  assert.equal(e.id, 'A0014');
  assert.notEqual(e.applicability, 'exact');
  assert.throws(() => s.apply('fix all'));
  assert.equal(val(s, 'f', 5), 12);
});

test('a symbol where the op belongs is the op, with the operand count of the op', () => {
  const pairs: [string, string][] = [
    ['==', 'eq'],
    ['!=', 'ne'],
    ['<', 'lt'],
    ['<=', 'le'],
    ['>', 'gt'],
    ['>=', 'ge'],
  ];
  for (const [sym, op] of pairs) {
    const src = `fn f u32 u32 -> bool\na ${sym} p0 p1\nret a\nend\n`;
    let err: A0Error | undefined;
    try {
      parseAndValidate(src);
    } catch (e) {
      err = e as A0Error;
    }
    assert.equal(err?.id, 'A0011', sym);
    assert.equal(err?.applicability, 'exact', sym);
    const out = fixAll(src, (t) => void parseAndValidate(t));
    assert.equal(out.error, undefined, sym);
    assert.match(out.text, new RegExp(`a ${op} p0 p1`), sym);
  }
  for (const [sym, op] of [
    ['+', 'add'],
    ['-', 'sub'],
    ['*', 'mul'],
    ['/', 'div'],
    ['%', 'rem'],
    ['&', 'and'],
    ['|', 'or'],
    ['^', 'xor'],
    ['<<', 'shl'],
    ['>>', 'shr'],
    ['&&', 'and'],
    ['||', 'or'],
  ] as const) {
    const src = `fn f u32 u32 -> u32\na ${sym} p0 p1\nret a\nend\n`;
    const out = fixAll(src, (t) => void parseAndValidate(t));
    assert.equal(out.error, undefined, sym);
    assert.match(out.text, new RegExp(`a ${op} p0 p1`), sym);
  }
  // A wrong operand count is not guessed.
  const bad = fixAll(
    'fn f u32 u32 -> bool\na == p0\nret a\nend\n',
    (t) => void parseAndValidate(t),
  );
  assert.ok(bad.error !== undefined);
  assert.notEqual(bad.error.applicability, 'exact');
});

test('A0_NEW_FIXES=off gives the diagnostics as they were: no exact fix, no named hint', () => {
  process.env.A0_NEW_FIXES = 'off';
  try {
    const s = new EditSession(parseAndValidate(SRC));
    s.open('pick');
    for (const reply of ['x max p0 p1', 'x add p0 p1 p0']) {
      const e = rejection(s, reply);
      assert.notEqual(e.applicability, 'exact', reply);
    }
    s.open('flag');
    const n = rejection(s, 'b not p0');
    assert.notEqual(n.applicability, 'exact');
    assert.doesNotMatch(n.fix ?? '', /xor x true/);
    const sym = fixAll(
      'fn f u32 u32 -> bool\na == p0 p1\nret a\nend\n',
      (t) => void parseAndValidate(t),
    );
    assert.notEqual(sym.error?.applicability, 'exact');
  } finally {
    delete process.env.A0_NEW_FIXES;
  }
});

test('the same reply gives the same fixed text every time', () => {
  const run1 = (): string => {
    const s = new EditSession(parseAndValidate(SRC));
    s.open('pick');
    rejection(s, 'x max p0 p1');
    s.apply('fix all');
    return s.program.functions.map((f) => f.nodes.map((n) => n.id).join(',')).join(';');
  };
  assert.equal(run1(), run1());
});

test('set AA is sealed and has the registered mix', async () => {
  const { createHash } = await import('node:crypto');
  const { readFileSync } = await import('node:fs');
  const seal = readFileSync('tools/ai-edit-tasks-aa.sha256', 'utf8').split(/\s+/)[0];
  assert.equal(
    createHash('sha256').update(readFileSync('tools/ai-edit-tasks-aa.ts')).digest('hex'),
    seal,
  );
  const { TASKS_AA } = await import('../tools/ai-edit-tasks-aa.js');
  assert.ok(TASKS_AA.length >= 28);
  const all = TASKS_AA.map((t) => t.a0Source + t.reference.a0);
  assert.ok(all.filter((s) => / loop /.test(s)).length >= 7);
  assert.ok(all.filter((s) => / text "/.test(s)).length >= 6);
  assert.ok(all.filter((s) => /\b(read|write|puts) /.test(s)).length >= 7);
});
