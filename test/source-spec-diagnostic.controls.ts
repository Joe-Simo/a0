/** Explicit compiled-target controls; required artifacts never skip and no timing is sampled. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { formatProgram, type Program, validate } from '../src/core.js';
import { A0Error } from '../src/diagnostics.js';
import { link } from '../src/link.js';
import { parseSource } from '../src/source.js';
import { linkSource } from '../src/source-link.js';
import type { NativeSourceResult } from '../src/source-native.js';
import { linkNativeSource, NativeSourceError } from '../src/source-native-link.js';
import { writeReport } from '../tools/scrub-results.js';
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
assert.equal(diagnostic.verification, true, 'verified spec companion required');
const c = await prepareSourceFrontend(cPath, diagnostic);
const direct = await prepareSourceFrontend(directPath, diagnostic);
const js = await prepareJsSource(jsPath);
assert.equal(c.build.diagnosticPorts, 'arena-v1');
assert.equal(direct.build.backend, 'direct-wasm');
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const closure = await link('compiler/source_frontend.a0', (path) => readFile(path, 'utf8'));
const sourceHash = hash(formatProgram(closure.program));
assert.equal(c.build.sourceSHA256, sourceHash);
assert.equal(direct.build.sourceSHA256, sourceHash);
assert.equal(js.build.sourceSHA256, sourceHash);
const factories = [
  ['C-derived', () => c.instantiate()],
  ['direct', () => direct.instantiate()],
  ['JS', () => js.instantiate(diagnostic)],
] as const;
const engines = factories.map(([name, create]) => [name, create()] as const);
const fn = (spec: string, params = 'u32', result = 'u32', ret = 'p0') =>
  `fn f ${params} -> ${result}\n${spec}ret ${ret}\nend\n`;
const inc = 'fn inc u32 u32 -> u32\nx add p0 1\nret x\nend\n';
const heavy = `${inc}fn heavy u32 -> bool\nx fold inc 20000 p0\ny eq x 0\nret y\nend\n`;
const div = 'fn test_div u32 -> bool\nx div p0 0\ny eq x 0\nret y\nend\n';
const sources: Readonly<Record<string, string>> = {
  missing: fn('ex 1 ->\n'),
  number: fn('ex 01 -> 1\n'),
  overflow: fn('ex 4294967296 -> 1\n'),
  word: fn('ex nope -> 1\n'),
  uppercase: fn('ex TRUE -> 1\n'),
  boolSuffixResult: fn('ex 1 -> trueX\n'),
  boolSuffixArgument: fn('ex trueX -> 1\n'),
  unicodeBmp: fn('ex é -> 1\n'),
  unicodeAstral: fn('ex 😀 -> 1\n'),
  emptyArray: fn('ex [] -> 1\n'),
  emptyRecord: fn('ex () -> 1\n'),
  singleton: fn('ex (1) -> 1\n'),
  arrow: fn('ex 1\n'),
  after: fn('ex 1 -> 1 extra\n'),
  fourth: fn('ex 1 -> 1\nex 2 -> 2\nex 3 -> 3\nex 4 -> 4\n'),
  duplicatePre: fn('pre eq p0 0\npre eq p0 1\n'),
  duplicatePost: fn('post eq r 0\npost eq r 1\n'),
  noPreOp: fn('pre\n'),
  noPostOp: fn('post\n'),
  contractArity: fn('pre eq p0\n'),
  contractOperand: fn('post eq r @\n'),
  repeatShape: fn('ex (1*2) -> 1\n'),
  repeatSeveral: fn('ex [1 2*3] -> 1\n'),
  repeatZero: fn('ex [1*0] -> 1\n'),
  repeatNegative: fn('ex [1*-1] -> 1\n'),
  repeatOver: fn('ex [1*4294967296] -> 1\n'),
  repeatBudget: fn('ex [1*2097153] -> 1\n'),
  repeatSuffix: fn('ex [1*12x] -> 1\n'),
  repeatBudgetSuffix: fn('ex [1*2097153x] -> 1\n'),
  repeatRepeat: fn('ex [1*1*2] -> 1\n'),
  io: fn('ex -> 0\n', 'io', 'io'),
  reference: fn('pre eq unknown 0\n'),
  referencePost: fn('post eq unknown r\n'),
  invalidFirstParameter: fn('pre eq p9 p0\n'),
  invalidLastParameter: fn('pre eq p0 p9\n'),
  invalidHugeParameter: fn('pre eq p999999999999999 p0\n'),
  wrongOperandType: fn('pre eq p0 true\n'),
  wrongResultType: fn('pre add p0 1\n'),
  postParameterLimit: fn('post eq r 0\n', Array<string>(64).fill('u32').join(' ')),
  unknownCallee: fn('post missing p0\n'),
  arity: fn('ex 1 2 -> 3\n'),
  noArguments: fn('ex 1 -> 0\n', '', 'u32', '0'),
  argumentShape: fn('ex [1 true] -> [1 2]\n', 'u32x2', 'u32x2'),
  nestedShape: fn('ex ([1 true] 2) -> ([1 2] 2)\n', '(u32x2,u32)', '(u32x2,u32)'),
  resultShape: fn('ex 1 -> true\n'),
  unequal: fn('ex 7 -> 8\n'),
  zeroArgUnequal: fn('ex -> 8\n', '', 'u32', '7'),
  arrayUnequal: fn('ex [1 2] -> [3 4]\n', 'u32x2', 'u32x2'),
  repeatedActual: fn('ex [1 2 3] -> [9*3]\n', 'u32x3', 'u32x3'),
  nestedUnequal: fn(
    'ex ([1 2] (true,)) -> ([3 4] (false,))\n',
    '(u32x2,(bool,))',
    '(u32x2,(bool,))',
  ),
  preFalse: fn('ex 7 -> 7\npre lt p0 3\n'),
  postFalse: fn('ex 7 -> 7\npost lt r 3\n'),
  emptyPreFalse: fn('ex -> 7\npre eq 0 1\n', '', 'u32', '7'),
  bodyDivzero: `profile strict\n${fn('ex 7 -> 7\nx div p0 0\n', 'u32', 'u32', 'x')}`,
  bodyBounds: 'profile strict\nfn f u32 -> u32\nex 5 -> 0\na arr 1 2\nb get a p0\nret b\nend\n',
  foldTrap:
    'profile strict\nfn step u32 u32 -> u32\nx div p0 0\nret x\nend\nfn f u32 -> u32\nex 7 -> 7\nx fold step 3 p0\nret x\nend\n',
  preDivzero: `profile strict\n${div}${fn('ex 7 -> 7\npre test_div p0\n')}`,
  postDivzero: `profile strict\n${div}${fn('ex 7 -> 7\npost test_div r\n')}`,
  bodyFuel: `${inc}${fn('ex 1 -> 20001\nx fold inc 20000 p0\n', 'u32', 'u32', 'x')}`,
  preFuel: `${heavy}${fn('ex 1 -> 1\npre heavy p0\n')}`,
  postFuel: `${heavy}${fn('ex 1 -> 1\npost heavy r\n')}`,
  grammarPriority: fn('ex nope -> 1\npre eq p9 p0\nx add p9 1\n'),
  bodyPriority: fn('ex 1 -> 2\npre eq p9 p0\nx add p9 1\n'),
  contractPriority: fn('ex true -> 1\npre eq p9 p0\n'),
  examplesTypePriority: fn('ex 1 -> 2\nex true -> 1\n'),
  unicodeCommentLocation: `# π 😀\r\n${fn('ex nope -> 1\n').replaceAll('\n', '\r\n')}`,
};
function reference(source: string, program?: Program): A0Error {
  try {
    validate(program ?? parseSource(source));
  } catch (error) {
    assert.ok(error instanceof A0Error);
    return error;
  }
  assert.fail('negative oracle must reject');
}
function rendered(result: NativeSourceResult, label: string): A0Error {
  assert.ok(!result.ok, label);
  assert.ok(
    result.diagnostic?.rendered.ok,
    `${label}: ${JSON.stringify(result.diagnostic?.rendered)}`,
  );
  return result.diagnostic.rendered.error;
}
const evidence: { name: string; sourceSHA256: string; jsonSHA256: string; id: string }[] = [];
const passedGroups: string[] = [];
test('complete spec JSON equals independent source oracle on C, direct and JS targets', () => {
  for (const [name, source] of Object.entries(sources)) {
    const expected = reference(source);
    const json = JSON.stringify(expected.toJSON());
    for (const [target, engine] of engines) {
      const result = engine.parse(source);
      assert.deepEqual(
        rendered(result, `${target}/${name}`).toJSON(),
        expected.toJSON(),
        `${target}/${name}`,
      );
      assert.ok(!result.ok && result.diagnostic && 'packet' in result.diagnostic);
      assert.equal(
        Buffer.from(result.diagnostic.packet.json).toString(),
        json,
        `${target}/${name}/JSON bytes`,
      );
    }
    evidence.push({
      name,
      sourceSHA256: hash(source),
      jsonSHA256: hash(json),
      id: expected.id as string,
    });
  }
  passedGroups.push('source-JSON');
});

test('successful specs, resource failures, options and retained packets preserve transport rules', () => {
  const success = fn('ex 1 -> 1\npre lt p0 3\npost eq r p0\n');
  const freshFuel = `${inc}fn f u32 -> u32\nex 1 -> 3001\nex 2 -> 3002\nx fold inc 3000 p0\nret x\nend\n`;
  assert.doesNotThrow(() => validate(parseSource(freshFuel)));
  const saved = engines.map(([, engine]) => engine.parse(sources.unequal as string));
  for (const [, engine] of engines) {
    assert.ok(engine.parse(success).ok);
    assert.ok(engine.parse(freshFuel).ok);
    for (const budget of [0, 1, 32, 128, 512]) {
      const result = engine.parse(success, budget);
      assert.ok(!result.ok);
      assert.ok(result.status >= 1 && result.status <= 5);
      assert.ok(result.diagnostic && !result.diagnostic.rendered.ok);
      assert.equal('error' in result.diagnostic.rendered, false);
    }
    assert.ok(engine.parse(success).ok);
  }
  for (const result of saved)
    assert.deepEqual(
      rendered(result, 'detached').toJSON(),
      reference(sources.unequal as string).toJSON(),
    );
  passedGroups.push('success-resource-detachment');
});

test('legacy wrapper, options and shared ordinary diagnostics remain compatible', async () => {
  const ordinary = 'fn f u32 -> u32\nret p9\nend\n';
  for (const options of [0, 1, 2]) {
    const configured = { ...diagnostic, options };
    const configuredC = await prepareSourceFrontend(cPath as string, configured);
    const configuredDirect = await prepareSourceFrontend(directPath as string, configured);
    const temporary = [
      configuredC.instantiate(),
      configuredDirect.instantiate(),
      js.instantiate(configured),
    ];
    try {
      for (const engine of temporary) {
        const result = engine.parse(sources.unequal as string);
        if (options <= 1)
          assert.deepEqual(
            rendered(result, 'options').toJSON(),
            reference(sources.unequal as string).toJSON(),
          );
        else {
          assert.ok(!result.ok && result.diagnostic && 'packet' in result.diagnostic);
          assert.equal(result.diagnostic.packet.status, 7);
          assert.equal(result.diagnostic.packet.json.length, 0);
        }
        const simple = engine.parse(ordinary);
        if (options <= 1)
          assert.deepEqual(rendered(simple, 'ordinary').toJSON(), reference(ordinary).toJSON());
      }
    } finally {
      for (const engine of temporary) engine.close();
    }
  }
  const legacy = await prepareSourceFrontend(cPath as string, { load: diagnostic.load });
  const engine = legacy.instantiate();
  try {
    const result = engine.parse(sources.unequal as string);
    assert.ok(!result.ok && result.diagnostic && 'packet' in result.diagnostic);
    assert.equal(result.diagnostic.packet.status, 7);
    assert.equal(result.diagnostic.packet.json.length, 0);
    assert.deepEqual(
      rendered(engine.parse(ordinary), 'legacy ordinary').toJSON(),
      reference(ordinary).toJSON(),
    );
  } finally {
    engine.close();
  }
  passedGroups.push('legacy-options');
});

test('source-less IR diagnostics retain synthetic locations and original checker priority', () => {
  for (const fixture of [
    'invalidFirstParameter',
    'invalidLastParameter',
    'wrongResultType',
    'postParameterLimit',
    'argumentShape',
    'unequal',
    'preFalse',
    'bodyFuel',
  ]) {
    const program = parseSource(sources[fixture] as string);
    const expected = reference('', program);
    for (const [name, engine] of engines) {
      const result = engine.checkProgram(program);
      assert.deepEqual(rendered(result, `${name}/${fixture}`).toJSON(), expected.toJSON());
    }
  }
  passedGroups.push('IR');
});

test('graph errors preserve structured owners, line policy and Unicode source maps', async () => {
  for (const fixture of ['preFalse', 'wrongResultType', 'argumentShape', 'reference', 'word']) {
    const units = new Map([
      ['/r/lib.a0', '# π 😀\nfn spec -> u32\nret 0\nend\nfn helper u32 -> u32\nret p0\nend\n'],
      ['/r/main.a0', `use "lib.a0"\n${sources[fixture]}`],
    ]);
    let expected: A0Error | undefined;
    try {
      await linkSource('/r/main.a0', async (path) => units.get(path) as string);
    } catch (error) {
      assert.ok(error instanceof A0Error);
      expected = error;
    }
    assert.ok(expected);
    for (const [name, engine] of engines) {
      await assert.rejects(
        linkNativeSource('/r/main.a0', async (path) => units.get(path) as string, engine),
        (error: unknown) => {
          assert.ok(error instanceof NativeSourceError);
          assert.ok(error.a0Error, `${name}/${fixture}`);
          assert.deepEqual(error.a0Error.toJSON(), expected.toJSON(), `${name}/${fixture}`);
          return true;
        },
      );
    }
  }
  passedGroups.push('graph');
});

test('verified companion provenance rejects missing inputs, altered roots and compiler records', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'a0-spec-diagnostic-'));
  try {
    await copyFile(
      join(rendererPath as string, 'diagnostic.wasm'),
      join(scratch, 'diagnostic.wasm'),
    );
    for (const change of [
      { inputs: diagnostic.build.inputs.slice(1) },
      { sourceSHA256: '0'.repeat(64) },
      { roots: { arena_diagnostic_options: diagnostic.build.roots.arena_diagnostic_options } },
      { options: { ...diagnostic.build.options, wasmSimd: false } },
    ]) {
      await writeFile(
        join(scratch, 'build.json'),
        JSON.stringify({ ...diagnostic.build, ...change }),
      );
      await assert.rejects(prepareSourceDiagnostic(scratch));
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  passedGroups.push('provenance');
});

test.after(async () => {
  for (const [, engine] of engines) engine.close();
  if (process.env.A0_SPEC_REPORT)
    await writeReport(process.env.A0_SPEC_REPORT, {
      schema: 1,
      scope:
        'Optional native spec diagnostic compatibility controls; no public cutover or performance claim.',
      frontendSourceSHA256: sourceHash,
      rendererWasmSHA256: diagnostic.build.wasmSHA256,
      targets: factories.map(([name]) => name),
      cases: evidence,
      sourceCaseCount: Object.keys(sources).length,
      passedGroups,
      complete: passedGroups.length === 6 && evidence.length === Object.keys(sources).length,
    });
});
