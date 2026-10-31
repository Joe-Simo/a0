import assert from 'node:assert/strict';
import { test } from 'node:test';
import { A0Error, run, validate } from '../src/core.js';
import { EditSession, programRevision } from '../src/edit.js';
import { formatSource, parseSource } from '../src/source.js';
import { sourceEditSyntax } from '../src/source-edit.js';

const source = 'fn sq\na mul A A\nret a\nend\nfn f\nb call sq A\nc add b 1\nret c\nend';
const session = () => new EditSession(validate(parseSource(source)), { syntax: sourceEditSyntax });
const result = (s: EditSession, name = 'f', n = 3) => {
  const fn = s.program.byName.get(name);
  assert.ok(fn);
  return run(fn, [n]);
};

test('source example rejection preserves revision and supplies an executable repair', () => {
  const s = new EditSession(validate(parseSource('fn f _x2 -> _x2\nret A\nend')), {
    syntax: sourceEditSyntax,
  });
  s.open('f');
  const before = programRevision(s.program);
  let replacement: string | undefined;
  assert.throws(
    () => s.apply('+ex [1 2] -> [2 1]'),
    (error: unknown) => {
      assert.ok(error instanceof A0Error);
      assert.equal(error.id, 'A0715');
      replacement = error.fix?.match(/`(ex [^`]+)`/)?.[1];
      assert.equal(replacement, 'ex [1 2] -> [1 2]');
      return true;
    },
  );
  assert.equal(programRevision(s.program), before);
  s.apply(`+${replacement}`);
  assert.notEqual(programRevision(s.program), before);
});

test('candidate editor binds views, partial edits, aliases and numbered edits to one grammar', () => {
  const s = session();
  const view = s.open('f', { scope: 'deps', numbered: true });
  assert.match(view.text, /fn f _ -> _/);
  assert.match(view.text, /b sq A/);
  s.apply('2 c << b 1');
  assert.equal(result(s), 18);
  s.apply('ret >> b 1');
  assert.equal(result(s), 4);
  assert.throws(() => s.open('f', { dense: true }));
  assert.equal(
    programRevision(validate(parseSource(formatSource(s.program)))),
    programRevision(s.program),
  );
});

test('candidate editor preserves atomic rejection and whole-function compatibility', () => {
  const s = session();
  s.openProgram();
  s.apply('fn f\nb call sq A\nc add b 2\nret c\nend');
  assert.equal(result(s), 11);
  const before = programRevision(s.program);
  assert.throws(() => s.apply('fn f\nret absent\nend'));
  assert.equal(programRevision(s.program), before);
  s.apply('fn inc\nx add A 1\nret x\nend');
  assert.equal(result(s, 'inc'), 4);
  s.apply('-fn inc');
  assert.equal(s.program.byName.has('inc'), false);
});

test('candidate node reader preserves aggregates and unused explicit parameters', () => {
  const s = new EditSession(validate(parseSource('fn f _ _ -> _\nx add A 1\nret x\nend')), {
    syntax: sourceEditSyntax,
  });
  s.open('f');
  s.apply('x add A 2');
  assert.equal(s.program.byName.get('f')?.params.length, 2);
  const aggregate = new EditSession(validate(parseSource('fn f\nv [A,2]\nx get v 0\nret x\nend')), {
    syntax: sourceEditSyntax,
  });
  aggregate.open('f');
  aggregate.apply('v [A,3]');
  assert.equal(result(aggregate), 3);
});

test('candidate specs and numbered replacement preserve revision and validation', () => {
  const s = session();
  s.open('sq');
  s.apply('+ex 3 -> 9');
  const before = programRevision(s.program);
  assert.throws(() => s.apply('a add A A'));
  assert.equal(programRevision(s.program), before);
  s.apply('-ex 3 -> 9\na << A 1');
  assert.equal(result(s, 'sq'), 6);
  const view = s.open('sq', { numbered: true });
  assert.match(view.text, /1 a << A 1/);
  s.apply(`${view.handle}\n1 a << A 2`);
  assert.equal(result(s, 'sq'), 12);
});

test('candidate numbered views omit comments without removing stored comments', () => {
  const s = new EditSession(
    validate(
      parseSource('# before\nfn f # header\n# node\nx add A 1 # inline\nret x\nend\n# tail'),
    ),
    { syntax: sourceEditSyntax },
  );
  const view = s.open('f', { numbered: true });
  assert.match(view.text, /fn f _ -> _\n1 x add A 1\n2 ret x\nend$/);
  s.apply('x add A 2');
  assert.equal(result(s), 5);
  assert.match(formatSource(s.program), /# header/);
});
