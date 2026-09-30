import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAndValidate, run, type TypedFunc } from '../src/core.js';
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
