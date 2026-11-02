import assert from 'node:assert/strict';
import { resolve } from 'node:path';
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
      [resolve('/project/main.a0'), 'profile strict\nuse "child.a0"\nfn main\nret A\nend\n'],
      [resolve('/project/child.a0'), program(row.body, row.bad)],
    ]);
    const read = async (path: string) => {
      const source = files.get(path);
      assert.notEqual(source, undefined);
      return source as string;
    };
    const options = { root: resolve('/project'), canonicalPath: async (path: string) => path };
    let expected: A0Error | undefined;
    await assert.rejects(linkSource(resolve('/project/main.a0'), read, options), (error) => {
      assert.ok(error instanceof A0Error);
      expected = error;
      return true;
    });
    assert.ok(expected);
    assert.match(expected.message, /child\.a0/);
    await assert.rejects(
      sourceLspFrontend.link(resolve('/project/main.a0'), read, options),
      (error) => {
        assert.ok(error instanceof A0Error);
        assert.deepEqual(error.toJSON(), expected?.toJSON());
        return true;
      },
    );
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

for (const [type, input, actual] of [
  ['_x2', '[1 2 3]', '[1 2 3]'],
  ['(_,bool)', '(1 true 2)', '(1 true 2)'],
  ['_x2x2', '[[1 2] [3 4] [5 6]]', '[[1 2] [3 4] [5 6]]'],
  ['_x2', '(1,)', '(1,)'],
] as const) {
  test(`source spec type error preserves ${type} ownership and projects ${input}`, () => {
    const original = failure(`fn f ${type} -> _\nex ${input} -> 0\nret 0\nend\n`);
    assert.equal(original.id, 'A0714');
    const projected = sourceDiagnostic(original);
    assert.equal(projected.actual, actual);
    assert.equal(projected.expected, original.expected);
    assert.equal(projected.specOwner, original.specOwner);
    assert.ok(projected.detail.includes(` is ${actual}, which is not a `));
    assert.deepEqual(sourceDiagnostic(projected).toJSON(), projected.toJSON());
    assert.match(original.actual ?? '', /;/);
  });
}

test('source type projection preserves unrelated and malformed A0714 diagnostics', () => {
  for (const actual of ['[1;2]', 'not-a-value']) {
    const custom = new A0Error('custom type message', 2, {
      id: 'A0714',
      expected: 'u32x2',
      actual,
      specOwner: 'f',
    });
    assert.equal(sourceDiagnostic(custom), custom);
  }
});

for (const [type, value] of [
  ['_x2', '[1 2]'],
  ['(_,bool)', '(1 true)'],
  ['_x2x2', '[[1 2] [3 4]]'],
] as const) {
  for (const kind of ['pre', 'post'] as const) {
    test(`source ${kind} failure preserves ${type} values in source spelling`, () => {
      const original = failure(
        `fn f ${type} -> ${type}\nex ${value} -> ${value}\n${kind} eq 0 1\nret A\nend\n`,
      );
      assert.equal(original.id, 'A0716');
      const projected = sourceDiagnostic(original);
      assert.equal(projected.spec?.input, value);
      assert.ok(projected.detail.includes(`the input ${value}`));
      if (kind === 'post') assert.ok(projected.detail.includes(`gives ${value}, which`));
      assert.deepEqual(sourceDiagnostic(projected).toJSON(), projected.toJSON());
      const located = sourceDiagnostic(
        original.rewrite(`/project/contracts.a0:3: ${original.detail}`),
      );
      assert.equal(located.detail, `/project/contracts.a0:3: ${projected.detail}`);
      assert.equal(located.specOwner, original.specOwner);
      assert.match(original.spec?.input ?? '', /;/);
    });
  }
}

test('source post failure handles an empty input and aggregate result', () => {
  const original = failure('fn f -> _x2\nex -> [1 2]\npost eq 0 1\nx [1 2]\nret x\nend\n');
  const projected = sourceDiagnostic(original);
  assert.equal(projected.id, 'A0716');
  assert.equal(projected.spec?.input, '');
  assert.match(projected.detail, /input \(none\) gives \[1 2\], which/);
});

test('source contract projection preserves runtime failures and custom messages', () => {
  for (const kind of ['pre', 'post'] as const) {
    const original = failure(
      `profile strict\nfn test _ -> bool\nx div A 0\ny eq x 0\nret y\nend\nfn f _ -> _\nex 1 -> 1\n${kind} call test ${kind === 'pre' ? 'A' : 'r'}\nret A\nend\n`,
    );
    assert.equal(original.id, 'A0716');
    assert.equal(sourceDiagnostic(original), original);
  }
  const custom = new A0Error('custom contract message', undefined, {
    id: 'A0716',
    spec: { function: 'f', ex: 1, line: 'pre', input: '[1;2]' },
  });
  assert.equal(sourceDiagnostic(custom), custom);
});

for (const kind of ['pre', 'post'] as const) {
  test(`source ${kind} rejection preserves revision and allows a valid follow-up`, () => {
    const session = new EditSession(
      validate(parseSource('fn f _x2 -> _x2\nex [1 2] -> [1 2]\nret A\nend\n')),
      { syntax: sourceEditSyntax },
    );
    session.open('f');
    const before = programRevision(session.program);
    assert.throws(
      () => session.apply(`+${kind} eq 0 1`),
      (error) => {
        assert.ok(error instanceof A0Error);
        assert.equal(error.id, 'A0716');
        assert.equal(error.spec?.input, '[1 2]');
        return true;
      },
    );
    assert.equal(programRevision(session.program), before);
    session.apply(`+${kind} eq 0 0`);
    assert.notEqual(programRevision(session.program), before);
  });
}
