import assert from 'node:assert/strict';
import { test } from 'node:test';
import { A0Error, validate } from '../src/core.js';
import { parseSource } from '../src/source.js';
import { sourceDiagnostic, sourceExampleResult } from '../src/source-diagnostic.js';

for (const [type, input, wrong] of [
  ['_x2', '[1 2]', '[2 1]'],
  ['(_,bool)', '(7 true)', '(8 false)'],
  ['_x2x2', '[[1 2] [3 4]]', '[[4 3] [2 1]]'],
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
    assert.equal(projected.detail, original.detail);
    assert.deepEqual(projected.spec, original.spec);
    assert.equal(projected.actual, original.actual);
    assert.equal(projected.expected, original.expected);
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
