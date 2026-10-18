/** Explicit flat grammar controls on all native targets; historical TS is a comparison oracle. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { formatProgram, validate } from '../src/core.js';
import { A0Error } from '../src/diagnostics.js';
import { link } from '../src/link.js';
import { parseSource } from '../src/source.js';
import { linkSource } from '../src/source-link.js';
import type { NativeSourceResult, NativeUnitResult } from '../src/source-native.js';
import { linkNativeSource, NativeSourceError } from '../src/source-native-link.js';
import { writeReport } from '../tools/scrub-results.js';
import { prepareJsSource } from '../tools/source-js-load.js';
import { prepareSourceDiagnostic, prepareSourceFrontend } from '../tools/source-native-load.js';

const cPath = process.env.A0_SPEC_C_ARTIFACT;
const directPath = process.env.A0_SPEC_DIRECT_ARTIFACT;
const jsPath = process.env.A0_SPEC_JS_ARTIFACT;
const rendererPath = process.env.A0_SPEC_RENDERER;
assert.ok(cPath && directPath && jsPath && rendererPath, 'current native artifacts required');
const diagnostic = await prepareSourceDiagnostic(rendererPath);
assert.equal(diagnostic.verification, true);
const c = await prepareSourceFrontend(cPath, diagnostic);
const direct = await prepareSourceFrontend(directPath, diagnostic);
const js = await prepareJsSource(jsPath);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const closure = await link('compiler/source_frontend.a0', (path) => readFile(path, 'utf8'));
const sourceHash = hash(formatProgram(closure.program));
for (const build of [c.build, direct.build, js.build])
  assert.equal(build.sourceSHA256, sourceHash, 'current frontend closure required');
const engines = [
  ['C-derived', c.instantiate()],
  ['direct', direct.instantiate()],
  ['JS', js.instantiate(diagnostic)],
] as const;
const identity = (literal: string, type: string) =>
  `fn f ${type} -> ${type}\nex ${literal} -> ${literal}\nret p0\nend\n`;
const example = (literal: string) => `fn f -> u32\nex -> ${literal}\nret 0\nend\n`;
const accepted = {
  whitespace: identity('[1 2]', 'u32x2'),
  comma: identity('[1,2]', 'u32x2'),
  mixed: identity('[1, 2 3]', 'u32x3'),
  padded: identity('[ 1 ,\t2 ]', 'u32x2'),
  unicodeWhitespace: identity('[1\u00a02\u20283]', 'u32x3'),
  oneArrayElement: identity('[7]', 'u32x1'),
  singletonRecord: identity('(7,)', '(u32)'),
  paddedSingletonRecord: identity('( 7 , )', '(u32)'),
  recordWhitespace: identity('(7 true)', '(u32,bool)'),
  recordComma: identity('(7,true)', '(u32,bool)'),
  nested: identity('([1,2] (true,) false)', '(u32x2,(bool),bool)'),
  repeatOne: identity('[7*1]', 'u32x1'),
  repeatTwo: identity('[7*2]', 'u32x2'),
  repeatThree: identity('[7*3]', 'u32x3'),
  spacedRepeat: identity('[7 \t* 2]', 'u32x2'),
  nestedRepeat: identity('[[7]*2]', 'u32x1x2'),
  adjacentArrayArguments: 'fn f u32x1 u32x1 -> u32x1\nex [1][2]->[1]\nret p0\nend\n',
  adjacentNumberArrayArguments: 'fn f u32 u32x1 -> u32\nex 1[2]->1\nret p0\nend\n',
  adjacentNumberBoolArguments: 'fn f u32 bool -> u32\nex 1true->1\nret p0\nend\n',
  compactArrow: 'fn f u32x1 -> u32x1\nex [1]->[1]\nret p0\nend\n',
  crlfComment: `# π 😀\r\n${identity('[1 2]', 'u32x2').replaceAll('\n', '\r\n')}`,
};
const rejected = {
  arraySemicolon: example('[1;2]'),
  arraySpacedSemicolon: example('[1 ;2]'),
  recordSemicolon: example('(1;true)'),
  singletonSemicolon: example('(1;)'),
  nestedSemicolon: example('([1;2] true)'),
  arrayTrailingComma: example('[1,]'),
  longArrayTrailingComma: example('[1,2,]'),
  recordTrailingComma: example('(1,true,)'),
  spacedRecordTrailingComma: example('(1 true , )'),
  nestedTrailingComma: example('([1,] true)'),
  adjacentScalars: example('[1true]'),
  adjacentNested: example('[[1][2]]'),
  adjacentRecord: example('[1(true,)]'),
  adjacentNumberArray: example('[1[2]]'),
  doubledComma: example('[1,,2]'),
  emptyArray: example('[]'),
  emptyRecord: example('()'),
  singletonNoComma: example('(1)'),
  repeatRecord: example('(1*2)'),
  repeatAfterSeveral: example('[1 2*3]'),
  repeatThenComma: example('[1*2,3]'),
  repeatThenStar: example('[1*2*3]'),
  repeatThenWord: example('[1*2x]'),
  repeatLeadingZero: example('[1*02]'),
  repeatZero: example('[1*0]'),
  repeatOverBudget: example('[1*2097153]'),
  unfinishedArray: example('['),
  unfinishedRecord: example('('),
  unfinishedAfterComma: example('[1,'),
  unfinishedRecordAfterComma: example('(1,'),
  missingArrayClose: example('[1'),
  missingRecordClose: example('(1'),
  missingOuterClose: example('[[1]'),
  missingRepeatCount: example('[1*'),
  missingRepeatClose: example('[1*2'),
  unfinishedBeforeComment: example('[1 # no close'),
  noFinalLf: example('[1').trimEnd(),
};
function expectedError(source: string): A0Error {
  try {
    validate(parseSource(source));
  } catch (error) {
    assert.ok(error instanceof A0Error);
    return error;
  }
  assert.fail('negative source must be rejected');
}
function compareFailure(
  result: NativeSourceResult | NativeUnitResult,
  expected: A0Error,
  label: string,
): void {
  assert.ok(!result.ok, label);
  assert.equal(result.status, 6, label);
  assert.equal(result.state[1], 714, label);
  assert.ok(result.diagnostic?.rendered.ok, `${label}: complete A0 diagnostic required`);
  assert.deepEqual(result.diagnostic.rendered.error.toJSON(), expected.toJSON(), label);
  assert.ok('packet' in result.diagnostic);
  assert.equal(
    Buffer.from(result.diagnostic.packet.json).toString(),
    JSON.stringify(expected.toJSON()),
    `${label}/JSON bytes`,
  );
}
const passed: string[] = [];
test('one flat aggregate grammar preserves valid spellings and top-level argument adjacency', () => {
  for (const [name, source] of Object.entries(accepted)) {
    const expected = validate(parseSource(source));
    for (const [target, engine] of engines) {
      const result = engine.parse(source);
      assert.ok(result.ok, `${target}/${name}`);
      assert.equal(formatProgram(result.program), formatProgram(expected), `${target}/${name}`);
      const unit = engine.parseUnit(source);
      assert.ok(unit.ok, `${target}/${name}/unit`);
      const graph = engine.checkUnits([unit], 'canonical');
      assert.ok(graph.ok, `${target}/${name}/graph`);
      assert.equal(formatProgram(graph.program), formatProgram(expected), `${target}/${name}/IR`);
      assert.ok(engine.checkProgram(expected).ok, `${target}/${name}/structured IR`);
    }
  }
  passed.push('accepted');
});
test('invalid separators, adjacency and incomplete aggregates return complete native A0714 JSON', () => {
  for (const [name, source] of Object.entries(rejected)) {
    const expected = expectedError(source);
    assert.equal(expected.id, 'A0714', name);
    for (const [target, engine] of engines) {
      compareFailure(engine.parse(source), expected, `${target}/${name}`);
      compareFailure(engine.parseUnit(source), expected, `${target}/${name}/unit`);
    }
  }
  passed.push('rejected');
});
test('aggregate grammar refusal precedes validation and keeps graph ownership and Unicode locations', async () => {
  for (const fixture of ['arraySemicolon', 'recordTrailingComma', 'missingArrayClose'] as const) {
    const source = (rejected[fixture] as string).replace('ret 0', 'ret p9');
    const whole = `# π 😀\n${source}`;
    const expected = expectedError(whole);
    for (const [target, engine] of engines)
      compareFailure(engine.parse(whole), expected, `${target}/${fixture}/priority`);
    const units = new Map([
      ['/r/lib.a0', '# π 😀\nfn spec -> u32\nret 0\nend\n'],
      ['/r/main.a0', `use "lib.a0"\n${source}`],
    ]);
    let graphError: A0Error | undefined;
    try {
      await linkSource('/r/main.a0', async (path) => units.get(path) as string);
    } catch (error) {
      assert.ok(error instanceof A0Error);
      graphError = error;
    }
    assert.ok(graphError);
    for (const [target, engine] of engines)
      await assert.rejects(
        linkNativeSource('/r/main.a0', async (path) => units.get(path) as string, engine),
        (error: unknown) => {
          assert.ok(error instanceof NativeSourceError);
          assert.ok(error.a0Error, `${target}/${fixture}`);
          assert.deepEqual(error.a0Error.toJSON(), graphError.toJSON(), `${target}/${fixture}`);
          return true;
        },
      );
  }
  passed.push('priority-graph');
});
test.after(async () => {
  for (const [, engine] of engines) engine.close();
  if (process.env.A0_SPEC_GRAMMAR_REPORT)
    await writeReport(process.env.A0_SPEC_GRAMMAR_REPORT, {
      schema: 1,
      scope: 'Flat aggregate grammar correctness controls; no performance or public cutover claim.',
      frontendSourceSHA256: sourceHash,
      rendererWasmSHA256: diagnostic.build.wasmSHA256,
      targets: engines.map(([name]) => name),
      accepted: Object.entries(accepted).map(([name, source]) => ({
        name,
        sourceSHA256: hash(source),
      })),
      rejected: Object.entries(rejected).map(([name, source]) => ({
        name,
        sourceSHA256: hash(source),
        diagnosticJSONSHA256: hash(JSON.stringify(expectedError(source).toJSON())),
      })),
      passed,
      complete: passed.length === 3,
    });
});
