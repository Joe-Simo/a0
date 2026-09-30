import assert from 'node:assert/strict';
import { test } from 'node:test';
import { A0Error, parseAndValidate, run, type TypedFunc } from '../src/core.js';
import { EditSession } from '../src/edit.js';

const SRC = [
  'fn sq u32 -> u32\na mul p0 p0\nret a\nend',
  'fn twice u32 -> u32\nx call sq p0\ny add x x\nret y\nend',
].join('\n');

const call = (session: EditSession, name: string, arg: number): unknown =>
  run(session.program.byName.get(name) as TypedFunc, [arg]);

test('handle line is implied when one function handle is open', () => {
  const session = new EditSession(parseAndValidate(SRC));
  session.open('twice', { scope: 'deps' });
  session.openProgram({ scope: 'deps', target: 'twice' });
  // Bare edit lines edit the open function handle.
  session.apply('y add x 1');
  assert.equal(call(session, 'twice', 3), 10);
  // Whole blocks and removals need no handle either; `end` may be left out.
  session.apply('fn cube u32 -> u32\ns call sq p0\nc mul s p0\nret c');
  assert.equal(call(session, 'cube', 2), 8);
  session.apply('-fn cube');
  assert.equal(session.program.byName.has('cube'), false);
  // Edit lines followed by an explicit program section still apply atomically.
  session.apply('y add x 2\ng0\nfn inc u32 -> u32\nr add p0 1\nret r');
  assert.equal(call(session, 'twice', 3), 11);
  assert.equal(call(session, 'inc', 3), 4);
  // Explicit handles keep working; an unknown handle is still rejected.
  session.apply('e0\ny add x x');
  assert.equal(call(session, 'twice', 3), 18);
  assert.throws(() => session.apply('e7\ny add x x'), /unknown handle 'e7'/);
});

test('an implied handle must be unambiguous', () => {
  const session = new EditSession(parseAndValidate(SRC));
  assert.throws(() => session.apply('a mul p0 3'), /invalid handle/);
  session.open('sq');
  session.open('twice');
  assert.throws(() => session.apply('a mul p0 3'), /invalid handle/);
  // With only a program handle open, the reply edits the program.
  const program = new EditSession(parseAndValidate(SRC));
  program.openProgram();
  program.apply('fn sq u32 -> u32\na mul p0 3\nret a');
  assert.equal(call(program, 'twice', 2), 12);
});

test('optional end closes blocks at the next fn, -fn, or end of reply', () => {
  const session = new EditSession(parseAndValidate(SRC));
  session.openProgram();
  session.apply(
    'g0\nfn dbl u32 -> u32\na add p0 p0\nret a\n-fn twice\nfn quad u32 -> u32\na call dbl p0\nb call dbl a\nret b\nfn sq u32 -> u32 end',
  );
  assert.deepEqual(
    session.program.functions.map((f) => f.name),
    ['sq', 'dbl', 'quad'],
  );
  assert.equal(call(session, 'quad', 3), 12);
});

test('numbered views take line-addressed edits', () => {
  const session = new EditSession(parseAndValidate(SRC));
  const view = session.open('twice', { scope: 'deps', numbered: true });
  assert.equal(
    view.text,
    'e0\nfn twice u32 -> u32\n1 x call sq p0\n2 y add x x\n3 ret y\nend\nfn sq u32 -> u32 end',
  );
  // Replace line 2: no header resent.
  session.apply('2 y add x 1');
  assert.equal(call(session, 'twice', 3), 10);
  // Insert after 2, replace 3 (numbers refer to the view before the reply).
  session.apply('2+ z mul y 2\n3 ret z');
  assert.equal(call(session, 'twice', 3), 20);
  assert.equal(session.view('e0').split('\n')[4], '3 z mul y 2');
  // Delete, insert at the top, and edit another function by name, in one atomic reply.
  session.apply('0+ k mov 5\n2 y add x k\n3-\n4 ret y\nsq:1 a add p0 p0');
  assert.equal(call(session, 'twice', 3), 11);
  // A failing line edit commits nothing.
  const before = session.view('e0');
  assert.throws(() => session.apply('1 x call sq q9'));
  assert.throws(() => session.apply('9 ret x'), /lines 1\.\.4/);
  assert.throws(() => session.apply('2 y add x 1\n2-'), /edited twice/);
  assert.throws(() => session.apply('sq:1 a add p0 true'));
  assert.equal(session.view('e0'), before);
  // Under a program handle, a line edit must name its function.
  const program = new EditSession(parseAndValidate(SRC));
  program.openProgram();
  assert.throws(() => program.apply('1 a mul p0 3'), /names no function/);
  program.apply('sq:1 a mul p0 3');
  assert.equal(call(program, 'twice', 2), 12);
});

test('view numbers copied into a fn block are dropped; line edits follow the block', () => {
  const session = new EditSession(parseAndValidate(SRC));
  session.open('twice', { numbered: true });
  // A whole block with the view's numbers (some lines unnumbered), then a line edit of twice.
  session.apply('fn sq u32 -> u32\n1 a mul p0 3\nret a\nend\n2 y add x 1');
  assert.equal(call(session, 'twice', 2), 7);
});

test('edit lines after a closed block edit the handled function; a new callee lands before it', () => {
  const base =
    'fn shl1 u32 -> u32\na shl p0 1\nret a\nend\nfn calc u32 -> u32\nr call shl1 p0\nret r\nend';
  for (const reply of [
    'fn inc u32 -> u32\na add p0 1\nret a\nend\na inc p0\nr shl1 a',
    'a call inc p0\nr call shl1 a\nfn inc u32 -> u32\na add p0 1\nret a\nend',
  ]) {
    const session = new EditSession(parseAndValidate(base));
    session.open('calc');
    session.openProgram();
    session.apply(reply);
    assert.deepEqual(
      session.program.functions.map((f) => f.name),
      ['shl1', 'inc', 'calc'],
    );
    assert.equal(call(session, 'calc', 4), 10);
  }
  // Lines of a block left open (no `end`) still belong to that block.
  const open = new EditSession(parseAndValidate(base));
  open.open('calc');
  open.apply('fn inc u32 -> u32\na add p0 1\nb add a 1\nret b');
  assert.equal(call(open, 'inc', 1), 3);
  // Under a program handle alone, instruction lines outside a block are rejected with the fix.
  const program = new EditSession(parseAndValidate(base));
  program.openProgram();
  assert.throws(
    () => program.apply('a add p0 1'),
    (e: unknown) =>
      e instanceof A0Error && /expected 'fn'/.test(e.message) && /fn NAME/.test(e.fix ?? ''),
  );
});
