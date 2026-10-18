/** Independent flat spelling fixtures; compiled artifacts are required and never skipped. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Diagnostic } from '../src/diagnostics.js';
import type { NativeSourceResult } from '../src/source-native.js';
import { prepareJsSource } from '../tools/source-js-load.js';
import { prepareSourceDiagnostic, prepareSourceFrontend } from '../tools/source-native-load.js';

const cPath = process.env.A0_SPEC_C_ARTIFACT;
const directPath = process.env.A0_SPEC_DIRECT_ARTIFACT;
const jsPath = process.env.A0_SPEC_JS_ARTIFACT;
const rendererPath = process.env.A0_SPEC_RENDERER;
assert.ok(
  cPath && directPath && jsPath && rendererPath,
  'A0_SPEC_{C,DIRECT,JS}_ARTIFACT/RENDERER required',
);
const diagnostic = await prepareSourceDiagnostic(rendererPath);
assert.equal(diagnostic.verification, true);
const c = await prepareSourceFrontend(cPath, diagnostic);
const direct = await prepareSourceFrontend(directPath, diagnostic);
const js = await prepareJsSource(jsPath);
assert.equal(c.build.diagnosticPorts, 'arena-v1');
assert.equal(direct.build.backend, 'direct-wasm');
assert.equal(c.build.sourceSHA256, direct.build.sourceSHA256);
assert.equal(c.build.sourceSHA256, js.build.sourceSHA256);
const engines = [
  ['C-derived', c.instantiate()],
  ['direct', direct.instantiate()],
  ['JS', js.instantiate(diagnostic)],
] as const;

interface Fixture {
  readonly name: string;
  readonly source: string;
  readonly example: string;
  readonly repaired: string;
  readonly expected: Diagnostic;
}
// Values, complete JSON and repaired lines are handwritten. No previous source
// reader, formatter or diagnostic text is used to construct these expectations.
const repairs: readonly Fixture[] = [
  {
    name: 'array',
    source: 'fn f u32x2 -> u32x2\nex [1 2] -> [3 4]\nret p0\nend\n',
    example: 'ex [1 2] -> [3 4]',
    repaired: 'ex [1 2] -> [1 2]',
    expected: {
      code: 'structure',
      id: 'A0715',
      message: 'f: ex 1 failed: input [1 2], expected [3 4], got [1 2]',
      line: null,
      expected: '[3 4]',
      actual: '[1 2]',
      fix: 'if f is right, change the line to `ex [1 2] -> [1 2]`; if the example is right, fix f; `-ex [1 2] -> [3 4]` removes it',
      applicability: 'maybe',
      edits: [],
      spec: {
        function: 'f',
        ex: 1,
        line: 'ex',
        input: '[1 2]',
        expected: '[3 4]',
        actual: '[1 2]',
      },
    },
  },
  {
    name: 'record',
    source: 'fn f (u32,bool) -> (u32,bool)\nex (1 true) -> (2 false)\nret p0\nend\n',
    example: 'ex (1 true) -> (2 false)',
    repaired: 'ex (1 true) -> (1 true)',
    expected: {
      code: 'structure',
      id: 'A0715',
      message: 'f: ex 1 failed: input (1 true), expected (2 false), got (1 true)',
      line: null,
      expected: '(2 false)',
      actual: '(1 true)',
      fix: 'if f is right, change the line to `ex (1 true) -> (1 true)`; if the example is right, fix f; `-ex (1 true) -> (2 false)` removes it',
      applicability: 'maybe',
      edits: [],
      spec: {
        function: 'f',
        ex: 1,
        line: 'ex',
        input: '(1 true)',
        expected: '(2 false)',
        actual: '(1 true)',
      },
    },
  },
  {
    name: 'singleton record',
    source: 'fn f (u32) -> (u32)\nex (7,) -> (8,)\nret p0\nend\n',
    example: 'ex (7,) -> (8,)',
    repaired: 'ex (7,) -> (7,)',
    expected: {
      code: 'structure',
      id: 'A0715',
      message: 'f: ex 1 failed: input (7,), expected (8,), got (7,)',
      line: null,
      expected: '(8,)',
      actual: '(7,)',
      fix: 'if f is right, change the line to `ex (7,) -> (7,)`; if the example is right, fix f; `-ex (7,) -> (8,)` removes it',
      applicability: 'maybe',
      edits: [],
      spec: { function: 'f', ex: 1, line: 'ex', input: '(7,)', expected: '(8,)', actual: '(7,)' },
    },
  },
  {
    name: 'repeated array',
    source: 'fn f u32x3 -> u32x3\nex [7*3] -> [9*3]\nret p0\nend\n',
    example: 'ex [7*3] -> [9*3]',
    repaired: 'ex [7*3] -> [7*3]',
    expected: {
      code: 'structure',
      id: 'A0715',
      message: 'f: ex 1 failed: input [7*3], expected [9*3], got [7*3]',
      line: null,
      expected: '[9*3]',
      actual: '[7*3]',
      fix: 'if f is right, change the line to `ex [7*3] -> [7*3]`; if the example is right, fix f; `-ex [7*3] -> [9*3]` removes it',
      applicability: 'maybe',
      edits: [],
      spec: {
        function: 'f',
        ex: 1,
        line: 'ex',
        input: '[7*3]',
        expected: '[9*3]',
        actual: '[7*3]',
      },
    },
  },
  {
    name: 'explicit equal elements use canonical repetition',
    source: 'fn f u32x3 -> u32x3\nex [7 7 7] -> [9 9 9]\nret p0\nend\n',
    example: 'ex [7 7 7] -> [9 9 9]',
    repaired: 'ex [7*3] -> [7*3]',
    expected: {
      code: 'structure',
      id: 'A0715',
      message: 'f: ex 1 failed: input [7*3], expected [9*3], got [7*3]',
      line: null,
      expected: '[9*3]',
      actual: '[7*3]',
      fix: 'if f is right, change the line to `ex [7*3] -> [7*3]`; if the example is right, fix f; `-ex [7*3] -> [9*3]` removes it',
      applicability: 'maybe',
      edits: [],
      spec: {
        function: 'f',
        ex: 1,
        line: 'ex',
        input: '[7*3]',
        expected: '[9*3]',
        actual: '[7*3]',
      },
    },
  },
  {
    name: 'nested array and singleton bool record',
    source:
      'fn f (u32x2,(bool)) -> (u32x2,(bool))\nex ([1 2] (true,)) -> ([3 4] (false,))\nret p0\nend\n',
    example: 'ex ([1 2] (true,)) -> ([3 4] (false,))',
    repaired: 'ex ([1 2] (true,)) -> ([1 2] (true,))',
    expected: {
      code: 'structure',
      id: 'A0715',
      message:
        'f: ex 1 failed: input ([1 2] (true,)), expected ([3 4] (false,)), got ([1 2] (true,))',
      line: null,
      expected: '([3 4] (false,))',
      actual: '([1 2] (true,))',
      fix: 'if f is right, change the line to `ex ([1 2] (true,)) -> ([1 2] (true,))`; if the example is right, fix f; `-ex ([1 2] (true,)) -> ([3 4] (false,))` removes it',
      applicability: 'maybe',
      edits: [],
      spec: {
        function: 'f',
        ex: 1,
        line: 'ex',
        input: '([1 2] (true,))',
        expected: '([3 4] (false,))',
        actual: '([1 2] (true,))',
      },
    },
  },
];

function rendered(result: NativeSourceResult, label: string): Diagnostic {
  assert.equal(result.ok, false, `${label}: negative source`);
  assert.ok(!result.ok && result.diagnostic?.rendered.ok, `${label}: native renderer required`);
  return result.diagnostic.rendered.error.toJSON();
}

for (const [target, engine] of engines) {
  test(`${target}: aggregate diagnostics and applied example repairs use flat spelling`, () => {
    for (const fixture of repairs) {
      const label = `${target}/${fixture.name}`;
      const actual = rendered(engine.parse(fixture.source), label);
      assert.deepEqual(actual, fixture.expected, label);
      assert.ok(actual.fix);
      const match = /^if f is right, change the line to `(ex [^`\n]+)`;/.exec(actual.fix);
      assert.ok(match, `${label}: example repair`);
      const replacement = match[1];
      assert.equal(replacement, fixture.repaired, label);
      assert.ok(replacement);
      const lines = fixture.source.split('\n');
      const positions = lines.flatMap((line, index) => (line === fixture.example ? [index] : []));
      assert.equal(positions.length, 1, `${label}: one original example`);
      const position = positions[0];
      assert.ok(position !== undefined);
      lines[position] = replacement;
      const repaired = engine.parse(lines.join('\n'));
      assert.ok(repaired.ok, `${label}: native checker accepts its suggested example`);
      assert.equal(repaired.status, 0, label);
    }
  });

  test(`${target}: aggregate preconditions and nested shape faults retain complete JSON`, () => {
    const pre = 'fn f u32x2 -> u32x2\nex [1 2] -> [1 2]\npre eq 0 1\nret p0\nend\n';
    assert.deepEqual(rendered(engine.parse(pre), `${target}/precondition`), {
      code: 'structure',
      id: 'A0716',
      message: 'f: ex 1 breaks pre: the input [1 2] does not satisfy pre',
      line: null,
      expected: null,
      actual: null,
      fix: 'make f satisfy its pre on ex 1, or change that example or the pre line; `-ex ARGS -> RESULT` removes an example',
      applicability: 'maybe',
      edits: [],
      spec: { function: 'f', ex: 1, line: 'pre', input: '[1 2]' },
    } satisfies Diagnostic);
    assert.ok(engine.parse(pre.replace('pre eq 0 1', 'pre eq 1 1')).ok);
    const shape =
      'fn f (u32x2,(bool)) -> (u32x2,(bool))\nex ([1 true] (true,)) -> ([1 2] (true,))\nret p0\nend\n';
    assert.deepEqual(rendered(engine.parse(shape), `${target}/shape`), {
      code: 'structure',
      id: 'A0714',
      message: 'spec of f: ex 1 argument 0.0[1] is true, which is not a u32',
      line: null,
      expected: 'u32',
      actual: 'true',
      fix: null,
      applicability: null,
      edits: [],
    } satisfies Diagnostic);
    assert.ok(engine.parse(shape.replace('[1 true]', '[1 2]')).ok);
  });

  test(`${target}: literal grammar hints contain accepted native example values`, () => {
    const invalid = 'fn f u32 -> u32\nex nope -> 1\nret p0\nend\n';
    const actual = rendered(engine.parse(invalid), `${target}/literal hint`);
    assert.deepEqual(actual, {
      code: 'structure',
      id: 'A0714',
      message: "line 2: spec of f: 'nope' is not a literal",
      line: 2,
      expected: null,
      actual: null,
      fix: 'a literal is a number, true, false, an array [1 2 3] or a record (1 true)',
      applicability: 'maybe',
      edits: [],
      spec: { function: 'f', ex: null },
    } satisfies Diagnostic);
    assert.ok(actual.fix);
    const match = /an array (\[[^\]]+\]) or a record (\([^)]*\))$/.exec(actual.fix);
    assert.ok(match, `${target}: both aggregate hint values`);
    for (const [index, type] of ['u32x3', '(u32,bool)'].entries()) {
      const literal = match[index + 1];
      assert.ok(literal);
      const source = `fn f ${type} -> ${type}\nex ${literal} -> ${literal}\nret p0\nend\n`;
      assert.ok(
        engine.parse(source).ok,
        `${target}: native parser accepts displayed ${type} value`,
      );
    }
  });
}

test.after(() => {
  for (const [, engine] of engines) engine.close();
});
