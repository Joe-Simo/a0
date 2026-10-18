/** Explicit experimental controls: A0_DIRECT_SOURCE_ARTIFACT=DIR node --test dist/test/source-direct.controls.js. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compile } from '../src/backends.js';
import { formatSource } from '../src/core.js';
import {
  type NativeSourceResult,
  type NativeUnitResult,
  nativeSource,
} from '../src/source-native.js';
import { nativeSourceArtifact } from '../tools/source-native-artifact.js';
import { prepareSourceFrontend } from '../tools/source-native-load.js';

const directory = process.env.A0_DIRECT_SOURCE_ARTIFACT;
assert.ok(directory, 'A0_DIRECT_SOURCE_ARTIFACT is required; these controls never skip');
const prepared = await prepareSourceFrontend(directory);
assert.equal(prepared.build.backend, 'direct-wasm', 'a direct frontend artifact is required');
const baseline = await nativeSourceArtifact();
const simple = 'fn identity\nret A\nend\n';

function sameState(
  actual: Pick<NativeSourceResult, 'ok' | 'status' | 'state' | 'specState'>,
  expected: Pick<NativeSourceResult, 'ok' | 'status' | 'state' | 'specState'>,
): void {
  assert.equal(actual.ok, expected.ok);
  assert.equal(actual.status, expected.status);
  assert.deepEqual(actual.state, expected.state, 'parsed state words');
  assert.deepEqual(actual.specState, expected.specState, 'spec state words');
}

function sameProgram(actual: NativeSourceResult, expected: NativeSourceResult): void {
  sameState(actual, expected);
  assert.ok(actual.ok && expected.ok);
  assert.equal(formatSource(actual.program), formatSource(expected.program));
  assert.equal(compile(actual.typed, 'c').text, compile(expected.typed, 'c').text);
  for (const fn of actual.typed.functions)
    for (const [name, callee] of fn.calls)
      assert.equal(callee, actual.typed.byName.get(name), 'typed callee identity');
}

test('direct adapter preserves session recovery, exact failure facts and closure', () => {
  const direct = prepared.instantiate(),
    reference = nativeSource(baseline);
  try {
    const controls = [
      'fn broken\nend\n',
      'fn wrong -> bool\nret 1\nend\n',
      'fn wrong\nex 1 -> 9\nx add A 1\nret x\nend\n',
      'profile strict\nfn wrong\npre lt A 3\nex 4 -> 4\nret A\nend\n',
    ];
    for (const source of controls) {
      const expected = reference.parse(source);
      assert.equal(expected.ok, false, 'independent negative control');
      sameState(direct.parse(source), expected);
      sameProgram(direct.parse(simple), reference.parse(simple));
    }
    for (const budget of [0, 1, 2, 32, 128, 512, 4096, 16_000_000]) {
      const expected = reference.parse(simple, budget);
      sameState(direct.parse(simple, budget), expected);
      if (budget < new TextEncoder().encode(simple).length) assert.equal(expected.status, 4);
      sameProgram(direct.parse(simple), reference.parse(simple));
      const expectedUnit = reference.parseUnit(simple, budget);
      sameState(direct.parseUnit(simple, budget), expectedUnit);
      sameProgram(direct.parse(simple), reference.parse(simple));
    }
    for (const budget of [-1, 0.5, 0x1_0000_0000, NaN, Infinity]) {
      assert.throws(() => direct.parse(simple, budget), /allocation budget/);
      assert.throws(() => direct.parseUnit(simple, budget), /allocation budget/);
      assert.throws(() => direct.checkUnits([], 'canonical', budget), /allocation budget/);
    }
    const unit = direct.parseUnit(simple);
    assert.ok(unit.ok);
    direct.close();
    direct.close();
    assert.throws(() => direct.parse(simple), /closed/);
    assert.throws(() => direct.parseUnit(simple), /closed/);
    assert.throws(() => direct.checkUnits([unit], 'canonical'), /closed/);
    assert.ok(direct.memoryBytes > 0, 'retained memory remains observable after close');
  } finally {
    direct.close();
    reference.close();
  }
});

test('direct source units retain exact type, text and source-byte boundaries through memory growth', () => {
  const direct = prepared.instantiate(),
    reference = nativeSource(baseline);
  const budget = 0xffff_ffff;
  const controls: readonly (readonly [string, string, boolean])[] = [
    ['largest u32 array', 'fn f _x65536 -> _\nret 0\nend\n', true],
    ['oversized u32 array', 'fn f _x65537 -> _\nret 0\nend\n', false],
    ['wide boolean array', 'fn f boolx65537 -> _\nret 0\nend\n', true],
    ['largest boolean array', 'fn f boolx2097152 -> _\nret 0\nend\n', true],
    ['oversized boolean array', 'fn f boolx2097153 -> _\nret 0\nend\n', false],
    ['IO array', 'fn f (io,_)x65536 -> _\nret 0\nend\n', false],
    ['largest text', `fn f\nx text "${'x'.repeat(65536)}"\nret 0\nend\n`, true],
    ['oversized text', `fn f\nx text "${'x'.repeat(65537)}"\nret 0\nend\n`, false],
  ];
  try {
    const retained = direct.parseUnit('# retained\nfn saved\nret A\nend\n');
    const referenceRetained = reference.parseUnit('# retained\nfn saved\nret A\nend\n');
    assert.ok(retained.ok && referenceRetained.ok);
    const original = formatSource(retained.program);
    const initialBytes = direct.memoryBytes;
    for (const [label, source, accepted] of controls) {
      const expected = reference.parseUnit(source, budget);
      assert.equal(expected.ok, accepted, label);
      const actual = direct.parseUnit(source, budget);
      sameState(actual, expected);
      if (actual.ok && expected.ok)
        assert.equal(formatSource(actual.program), formatSource(expected.program), label);
    }
    for (const [bytes, accepted] of [
      [2_097_152, true],
      [2_097_153, false],
    ] as const) {
      const source = `#${'x'.repeat(bytes - simple.length - 2)}\n${simple}`;
      assert.equal(Buffer.byteLength(source), bytes);
      const expected = reference.parseUnit(source, budget);
      assert.equal(expected.ok, accepted, `${bytes} source bytes`);
      sameState(direct.parseUnit(source, budget), expected);
      if (!accepted) {
        assert.equal(expected.status, 6);
        assert.equal(expected.state[1], 16);
      }
    }
    assert.ok(direct.memoryBytes > initialBytes, 'arena memory must actually grow in this control');
    assert.equal(formatSource(retained.program), original, 'old decoded views survive growth');
    sameProgram(
      direct.checkUnits([retained], 'canonical'),
      reference.checkUnits([referenceRetained], 'canonical'),
    );
    sameProgram(direct.parse(simple), reference.parse(simple));
  } finally {
    direct.close();
    reference.close();
  }
});

test('direct IR builder keeps mutable host pages, aggregate results and owned unit snapshots separate', () => {
  const direct = prepared.instantiate(),
    foreign = prepared.instantiate(),
    reference = nativeSource(baseline);
  const graphs = [
    [
      '# tuple helper\nfn helper (_,bool) -> (_,bool)\na at A 0\nb at A 1\nc (a b)\nret c\nend\n',
      'use "helper.a0"\nfn top -> (_,bool)\na (5 true)\nb helper a\nret b\nend\n',
    ],
    [
      'profile strict\n# array helper\nfn helper _x3 -> _x3\nex [7*3] -> [7 7 7]\nret A\nend\n',
      'profile strict\nuse "helper.a0"\nfn top -> _x3\nex -> [7*3]\na [7*3]\nb helper a\nret b\nend\n',
    ],
    [
      'fn helper _x128 -> _x128\nret A\nend\n',
      'use "helper.a0"\nfn top -> _x128\na [7*128]\nb helper a\nret b\nend\n',
    ],
  ];
  try {
    for (const sources of graphs) {
      const units = sources.map((source) => direct.parseUnit(source));
      const expectedUnits = sources.map((source) => reference.parseUnit(source));
      assert.ok(units.every((unit) => unit.ok));
      assert.ok(expectedUnits.every((unit) => unit.ok));
      const profile = sources[0]?.startsWith('profile strict') ? 'strict' : 'canonical';
      const expected = reference.checkUnits(expectedUnits, profile);
      assert.ok(expected.ok);
      sameProgram(direct.checkUnits(units, profile), expected);
      const first = units[0];
      assert.ok(first?.ok);
      Reflect.set(first.state, '0', 99);
      Reflect.set(first.program.functions[0] as object, 'name', 'caller_mutation');
      Reflect.set(first.program.functions[0] as object, 'comments', { leading: ['# changed'] });
      const firstNode = first.program.functions[0]?.nodes[0];
      if (firstNode !== undefined) Reflect.set(firstNode, 'op', 'caller_mutation');
      sameProgram(direct.checkUnits(units, profile), expected);
      assert.throws(() => foreign.checkUnits(units, profile), /owned/);
      assert.throws(() => reference.checkUnits(units, profile), /owned/);
      assert.throws(() => direct.checkUnits([{ ...first } as NativeUnitResult], profile), /owned/);
      const refused = direct.checkUnits(units, profile, 0);
      assert.equal(refused.ok, false);
      assert.equal(refused.status, 4);
      sameProgram(direct.parse(simple), reference.parse(simple));
      sameProgram(direct.checkUnits(units, profile), expected);
      const failedUnit = direct.parseUnit('fn broken\nend\n');
      assert.equal(failedUnit.ok, false);
      assert.throws(() => direct.checkUnits([failedUnit], profile), /owned/);
      sameProgram(direct.checkUnits(units, profile), expected);
    }
    const failedSpec = 'fn f\nex 1 -> 9\nx add A 1\nret x\nend\n';
    const unit = direct.parseUnit(failedSpec),
      expectedUnit = reference.parseUnit(failedSpec);
    assert.ok(unit.ok && expectedUnit.ok, 'spec checking is deferred until graph checking');
    sameState(
      direct.checkUnits([unit], 'canonical'),
      reference.checkUnits([expectedUnit], 'canonical'),
    );
  } finally {
    direct.close();
    foreign.close();
    reference.close();
  }
});
