import assert from 'node:assert/strict';
import { test } from 'node:test';
import { A0Error, parse, parseAndValidate, run, type TypedFunc } from '../src/core.js';
import { EditSession, stripCodeFences, validateOrdered } from '../src/edit.js';

const SRC = [
  'fn sq u32 -> u32\na mul p0 p0\nret a\nend',
  'fn twice u32 -> u32\nx call sq p0\ny add x x\nret y\nend',
  'fn cube u32 -> u32\ns mul p0 p0\nc mul s p0\nret c\nend',
].join('\n');

const call = (s: EditSession, name: string, arg: number): unknown =>
  run(s.program.byName.get(name) as TypedFunc, [arg]);
const names = (s: EditSession): string[] => s.program.functions.map((f) => f.name);

test('a reply wrapped in a markdown code block is the reply inside it', () => {
  assert.equal(stripCodeFences('```a0\ny add x 1\n```'), 'y add x 1');
  assert.equal(stripCodeFences('y add x 1'), 'y add x 1');
  const s = new EditSession(parseAndValidate(SRC));
  s.open('twice');
  s.apply('```\ny add x 1\n```');
  assert.equal(call(s, 'twice', 3), 10);
  // The same with an explicit handle line inside the fence.
  const t = new EditSession(parseAndValidate(SRC));
  const h = t.open('twice').handle;
  t.apply(`\`\`\`text\n${h}\ny add x 1\n\`\`\``);
  assert.equal(call(t, 'twice', 3), 10);
});

test('an edit that calls a function defined below it moves that function above its first caller', () => {
  const s = new EditSession(parseAndValidate(SRC));
  s.open('sq');
  // sq now calls cube, which the program defines after it.
  s.apply('a call cube p0');
  assert.deepEqual(names(s), ['cube', 'sq', 'twice']);
  assert.equal(call(s, 'sq', 2), 8);
  // Deterministic: the same edit on the same program gives the same order and revision.
  const u = new EditSession(parseAndValidate(SRC));
  u.open('sq');
  u.apply('a call cube p0');
  assert.deepEqual(names(u), names(s));
});

test('the reorder never hides a cycle or another error', () => {
  const s = new EditSession(parseAndValidate(SRC));
  s.open('cube');
  // cube calling twice, which calls sq (above cube): fine, no move needed or possible to fail.
  s.apply('c call twice p0');
  assert.deepEqual(names(s), ['sq', 'twice', 'cube']);
  // A cycle (sq calls cube, cube calls sq) is still the original diagnostic.
  const t = new EditSession(parseAndValidate(SRC));
  t.open('sq');
  t.apply('a call cube p0');
  const hc = t.open('cube').handle;
  assert.throws(
    () =>
      t.apply(`${hc}
c call sq p0`),
    (e: unknown) => e instanceof A0Error && ['A0102', 'A0103'].includes(e.id ?? ''),
  );
  const prog = parse(
    'fn a u32 -> u32\nx call b p0\nret x\nend\nfn b u32 -> u32\ny call a p0\nret y\nend',
  );
  assert.throws(
    () => validateOrdered(prog),
    (e: unknown) => e instanceof A0Error && e.id === 'A0102',
  );
});

test('-id followed by the old node text, not replaced, has an exact delete fix', () => {
  const s = new EditSession(parseAndValidate(SRC));
  s.open('twice');
  const reply = '-x call sq p0\ny add p0 p0';
  try {
    s.apply(reply);
    assert.fail('rejected');
  } catch (e) {
    assert.ok(e instanceof A0Error);
    assert.equal(e.id, 'A0504');
    assert.equal(e.applicability, 'exact');
    assert.match(e.fix ?? '', /-x/);
    assert.deepEqual(
      e.edits?.map((x) => (x.op === 'lines' ? [x.rule, x.to] : x.op)),
      [['delete-text', '-x']],
    );
  }
  s.apply('fix all');
  assert.equal(call(s, 'twice', 3), 6);
});

test('a function that ends before its ret is told which line to write', () => {
  try {
    parseAndValidate('fn f u32 -> u32\na add p0 1\nend');
    assert.fail('accepted');
  } catch (e) {
    assert.ok(e instanceof A0Error);
    assert.equal(e.id, 'A0026');
    assert.match(e.fix ?? '', /write `ret a` before `end`/);
  }
});
