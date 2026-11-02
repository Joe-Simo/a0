import assert from 'node:assert/strict';
import { test } from 'node:test';
import { A0Error, validate } from '../src/core.js';
import { EditSession, programRevision } from '../src/edit.js';
import { sourceLspFrontend } from '../src/lsp-frontend.js';
import { parseSource } from '../src/source.js';
import { sourceDiagnostic, sourceExampleResult } from '../src/source-diagnostic.js';
import { sourceEditSyntax } from '../src/source-edit.js';
import { linkSource } from '../src/source-link.js';

for (const [type, input, wrong] of [
  ['_x2', '[1 2]', '[2 1]'],
  ['(_,bool)', '(7 true)', '(8 false)'],
  ['_x2x2', '[[1 2] [3 4]]', '[[4 3] [2 1]]'],
  ['_x3', '[1*3]', '[2*3]'],
] as const) {
  test(`source example repair is executable for ${type}`, () => {
    const source = `fn f ${type} -> ${type}\nex ${input} -> ${wrong}\nret A\nend`;
    let original: A0Error | undefined;
    try {
      validate(parseSource(source));
    } catch (error) {
      assert.ok(error instanceof A0Error);
      original = error;
    }
    assert.ok(original);
    const projected = sourceDiagnostic(original);
    assert.equal(projected.id, original.id);
    assert.equal(
      projected.detail,
      `f: ex 1 failed: input ${input}, expected ${wrong}, got ${input}`,
    );
    assert.deepEqual(projected.spec, { ...original.spec, input, expected: wrong, actual: input });
    assert.equal(projected.actual, input);
    assert.equal(projected.expected, wrong);
    const replacement = projected.fix?.match(/`(ex [^`]+)`/)?.[1];
    assert.ok(replacement);
    assert.doesNotThrow(() =>
      validate(parseSource(source.replace(`ex ${input} -> ${wrong}`, replacement))),
    );
    assert.equal(sourceDiagnostic(projected).fix, projected.fix);
    assert.match(original.fix ?? '', /;/);
  });
}

test('unrelated and trap diagnostics are preserved by identity', () => {
  const error = new A0Error('unrelated');
  assert.equal(sourceDiagnostic(error), error);
  const trap = new A0Error('trap', undefined, {
    id: 'A0715',
    spec: {
      function: 'f',
      ex: 1,
      line: 'ex',
      input: '1',
      expected: '2',
      actual: 'trap',
    },
  });
  assert.equal(sourceDiagnostic(trap), trap);
});

test('source quick-fix literal rendering accepts values and refuses malformed diagnostic data', () => {
  assert.equal(sourceExampleResult('[1;2]'), '[1 2]');
  assert.equal(sourceExampleResult('[1;]'), '[1]');
  assert.equal(sourceExampleResult('(7;)'), '(7,)');
  assert.equal(sourceExampleResult('[(1;true);(2;false)]'), '[(1 true) (2 false)]');
  for (const invalid of ['', 'trap', '[1;;2]', 'true false', '1\nret 0', '(1;true) trailing'])
    assert.equal(sourceExampleResult(invalid), undefined, invalid);
  assert.equal(sourceExampleResult('['.repeat(10_000) + '1' + ']'.repeat(10_000)), undefined);
  assert.equal(sourceExampleResult('1'.repeat((2 << 20) + 1)), undefined);
});

const traps = [
  { body: 'x div 1 A\nret x', bad: '0 -> 1', good: '1 -> 1', kind: 'divzero' },
  { body: 'x [7]\ny get x A\nret y', bad: '2 -> 7', good: '0 -> 7', kind: 'bounds' },
];
const program = (body: string, example?: string) =>
  `profile strict\nfn f\n${example === undefined ? '' : `ex ${example}\n`}${body}\nend\n`;
function failure(source: string): A0Error {
  try {
    validate(parseSource(source));
  } catch (error) {
    assert.ok(error instanceof A0Error);
    return error;
  }
  return assert.fail('expected a real example failure');
}

test('source diagnostic formatting preserves real runtime example failures', () => {
  for (const row of traps) {
    const error = failure(program(row.body, row.bad));
    assert.equal(error.id, 'A0715');
    assert.match(error.actual ?? '', new RegExp(`trap ${row.kind}`));
    assert.equal(sourceDiagnostic(error), error);
  }
});

test('runtime example rejection rolls back a source edit and permits the next valid edit', () => {
  for (const row of traps) {
    const session = new EditSession(validate(parseSource(program(row.body))), {
      syntax: sourceEditSyntax,
    });
    session.open('f');
    const before = programRevision(session.program);
    const expected = failure(program(row.body, row.bad));
    assert.throws(
      () => session.apply(`+ex ${row.bad}`),
      (error) => {
        assert.ok(error instanceof A0Error);
        assert.deepEqual(error.toJSON(), expected.toJSON());
        return true;
      },
    );
    assert.equal(programRevision(session.program), before);
    session.apply(`+ex ${row.good}`);
    assert.notEqual(programRevision(session.program), before);
    assert.equal(session.program.byName.get('f')?.spec?.examples.length, 1);
  }
});

test('source frontend keeps linked runtime diagnostics and dependency ownership intact', async () => {
  for (const row of traps) {
    const files = new Map([
      ['/project/main.a0', 'profile strict\nuse "child.a0"\nfn main\nret A\nend\n'],
      ['/project/child.a0', program(row.body, row.bad)],
    ]);
    const read = async (path: string) => {
      const source = files.get(path);
      assert.notEqual(source, undefined);
      return source as string;
    };
    const options = { root: '/project', canonicalPath: async (path: string) => path };
    let expected: A0Error | undefined;
    await assert.rejects(linkSource('/project/main.a0', read, options), (error) => {
      assert.ok(error instanceof A0Error);
      expected = error;
      return true;
    });
    assert.ok(expected);
    assert.match(expected.message, /child\.a0/);
    await assert.rejects(sourceLspFrontend.link('/project/main.a0', read, options), (error) => {
      assert.ok(error instanceof A0Error);
      assert.deepEqual(error.toJSON(), expected?.toJSON());
      return true;
    });
  }
});

test('source mismatch details use the same literal spelling as executable repairs', () => {
  const original = failure('fn f _x2 -> _x2\nex [1 2] -> [2 1]\nret A\nend\n');
  const projected = sourceDiagnostic(original);
  assert.equal(projected.detail, 'f: ex 1 failed: input [1 2], expected [2 1], got [1 2]');
  assert.equal(projected.expected, '[2 1]');
  assert.equal(projected.actual, '[1 2]');
  assert.deepEqual(projected.spec, {
    ...original.spec,
    input: '[1 2]',
    expected: '[2 1]',
    actual: '[1 2]',
  });
  assert.deepEqual(sourceDiagnostic(projected).toJSON(), projected.toJSON());
  assert.match(original.detail, /;/, 'legacy diagnostic is not mutated');
  assert.equal(sourceExampleResult(projected.actual as string), '[1 2]');
  const located = sourceDiagnostic(original.rewrite(`/project/child.a0:2: ${original.detail}`));
  assert.equal(located.detail, `/project/child.a0:2: ${projected.detail}`);
  assert.equal(located.specOwner, original.specOwner);
  const custom = new A0Error('custom context', 12, {
    ...original.detailOf(),
    applicability: 'maybe',
  });
  const customProjected = sourceDiagnostic(custom);
  assert.equal(customProjected.detail, custom.detail);
  assert.equal(customProjected.line, 12);
  assert.equal(customProjected.code, custom.code);
  assert.equal(customProjected.applicability, custom.applicability);
});

test('source diagnostic result decoding accepts current spelling and legacy serialization', () => {
  for (const [encoded, expected] of [
    ['[1 2]', '[1 2]'],
    ['[7*3]', '[7*3]'],
    ['(7,)', '(7,)'],
    ['[(1 true) (2 false)]', '[(1 true) (2 false)]'],
    ['[1;2]', '[1 2]'],
    ['(7;)', '(7,)'],
  ])
    assert.equal(sourceExampleResult(encoded as string), expected);
});
