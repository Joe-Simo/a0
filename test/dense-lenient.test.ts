import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  A0Error,
  formatProgram,
  makeIo,
  parseAndValidate,
  run,
  type TypedFunc,
  validate,
} from '../src/core.js';
import { formatDense, parseDense } from '../src/dense.js';
import { EditSession } from '../src/edit.js';

// The lenient forms are accepted on input only: the printer never writes them, so every dense text the
// formatter produces reads back exactly as before (test/dense.test.ts round-trips the whole corpus).

const run1 = (src: string, name: string, args: number[]): unknown =>
  run(validate(parseDense(src)).byName.get(name) as TypedFunc, args);

test('dense leniency: hex and binary literals', () => {
  assert.equal(run1('fn f and A 0x5F', 'f', [0xff]), 0x5f);
  assert.equal(run1('fn f add A 0b101', 'f', [1]), 6);
  assert.throws(() => parseDense('fn f add A 0x1FFFFFFFF'), /exceeds u32/);
  // the canonical text of the program has plain decimals
  assert.ok(formatProgram(parseDense('fn f and A 0x5F')).includes('95'));
});

test('dense leniency: mod is rem, unless a value or function is called mod', () => {
  assert.equal(run1('fn f mod A 4', 'f', [11]), 3);
  assert.equal(run1('fn f add mod A 4 1', 'f', [11]), 4);
  // a named value `mod` is still a name
  assert.equal(run1('fn f\nmod add A 1\nmul mod 2', 'f', [3]), 8);
  // and so is a function
  assert.equal(run1('fn mod add A B\nfn g mod A 5', 'g', [1]), 6);
});

test('dense leniency: s and i are the state and the index of a step, names defined above win', () => {
  const src = 'fn step u32 u32 u32x4 -> u32\nadd s get C i\nfn total u32x4 -> u32 fold step 4 0 A';
  assert.equal(run1(src, 'total', [[1, 2, 3, 4] as never]) as number, 10);
  // the printer's output never contains them; a value named i is a value
  assert.equal(run1('fn f\ni add A 1\nmul i i', 'f', [2]), 9);
  assert.equal(run1('fn f fold {add s i} 4 0', 'f', []), 6);
});

test('dense leniency: io is the one io parameter of a typed header', () => {
  const src = 'fn echo io -> io\nr read io\nwrite at r 1 at r 0';
  const p = validate(parseDense(src));
  const io = makeIo([7]);
  run(p.byName.get('echo') as TypedFunc, [io] as never);
  assert.deepEqual(io.output, [7]);
  // two io parameters (or none) leave the word unresolved, with the usual message
  assert.throws(
    () => parseDense('fn f u32 -> u32\nio'),
    (e) => e instanceof A0Error && /'io' is not an operation/.test(e.message),
  );
});

test('dense leniency: a header that lists the parameter letters declares them', () => {
  const src = 'fn month A B C\nt mul A 5\nsub t C\nfn id A';
  const p = parseDense(src);
  assert.equal(p.functions[0]?.params.length, 3);
  assert.equal(p.functions[1]?.params.length, 1);
  assert.equal(run1(src, 'month', [2, 9, 3]), 7);
  // a lone letter is the body, letters out of order are no declaration
  assert.equal(run1('fn id A', 'id', [4]), 4);
  assert.throws(() => parseDense('fn f B A\nA'), A0Error);
});

test('dense leniency: a duplicate id is an error in a file, a shadowing in an edit reply', () => {
  assert.throws(
    () => parseDense('fn f\nx add A 1\nx mul x 2\nx'),
    (e) => e instanceof A0Error && /duplicate id 'x'/.test(e.message),
  );
  const session = new EditSession(
    parseAndValidate(
      'fn f u32 -> u32\na add p0 0\nret a\nend\nfn g u32 -> u32\na add p0 1\nret a\nend',
    ),
  );
  session.open('g', { dense: true });
  session.apply('e0\nfn g\nx add A 1\nx mul x 2\nx');
  assert.equal(run(session.program.byName.get('g') as TypedFunc, [3]), 8);
});

test('dense leniency: a reply without types keeps the signature of the function it replaces', () => {
  const base = parseAndValidate(
    `fn step u32 u32 u32x4 -> u32
a get p2 p1
b add p0 a
ret b
end
fn total u32x4 -> u32
a fold step 4 0 p0
ret a
end`,
  );
  const session = new EditSession(base);
  session.open('total', { dense: true, scope: 'deps' });
  // `fn step` without types: the body uses A B C, as the old step does, so its types stay
  session.apply('e0\nfn step\nel get C B\nsq mul el el\nadd A sq');
  assert.equal(run(session.program.byName.get('total') as TypedFunc, [[1, 2, 3, 4] as never]), 30);
  // a reply that uses fewer parameters than the old function keeps no types (the count is its own)
  const s2 = new EditSession(base);
  s2.open('total', { dense: true, scope: 'deps' });
  assert.throws(() => s2.apply('e0\nfn step get A B'), A0Error);
});

test('dense leniency: the formatter output is unchanged by it', () => {
  const p = validate(parseDense('fn f u32x4 -> u32\ns fold {add A get C B} 4 0 A\ns'));
  assert.equal(formatDense(p), formatDense(validate(parseDense(formatDense(p)))));
});
