import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validate } from '../src/core.js';
import { A0Error, type Diagnostic, diag } from '../src/diagnostics.js';
import { parseSource } from '../src/source.js';
import { type NativeDiagnosticPacket, nativeDiagnostic } from '../src/source-native-diagnostic.js';

interface Fixture {
  readonly name: string;
  readonly source: string;
  readonly status: number;
  readonly facts: number[];
  readonly jsonText: string;
  readonly sourceSHA256: string;
  readonly jsonUTF8SHA256: string;
  readonly packetSHA256: string;
}
const fixtures = JSON.parse(
  await readFile('test/fixtures/native-diagnostics/packets.json', 'utf8'),
) as {
  provenance: { commit: string; entry: string; driverSHA256: { O0: string; O2: string } };
  cases: Fixture[];
};
const hash = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');
const packetOf = (fixture: Fixture): NativeDiagnosticPacket => ({
  status: fixture.status,
  facts: [...fixture.facts],
  json: Buffer.from(fixture.jsonText),
});
function reference(source: string): A0Error {
  try {
    validate(parseSource(source));
  } catch (error) {
    assert.ok(error instanceof A0Error);
    return error;
  }
  assert.fail('negative reference source');
}
const first = fixtures.cases[0];
assert.ok(first);

// Frozen packets are actual outputs of the independent seed-built A0 renderer at both O0/O2.
test('native diagnostic packets preserve complete core errors and original source locations', () => {
  assert.equal(fixtures.provenance.commit, 'c95daca1f6fb69f2de3a6827d7542dd7abd5f53c');
  assert.equal(fixtures.provenance.entry, 'arena_parse_diagnostic_options');
  for (const digest of Object.values(fixtures.provenance.driverSHA256))
    assert.match(digest, /^[0-9a-f]{64}$/);
  for (const fixture of fixtures.cases) {
    assert.equal(hash(fixture.source), fixture.sourceSHA256);
    const packet = packetOf(fixture);
    assert.equal(hash(packet.json), fixture.jsonUTF8SHA256);
    const raw = Buffer.alloc((130 + packet.json.length) * 4);
    raw.writeUInt32LE(packet.status);
    packet.facts.forEach((word, index) => {
      raw.writeUInt32LE(word, (index + 1) * 4);
    });
    raw.writeUInt32LE(packet.json.length, 129 * 4);
    packet.json.forEach((word, index) => {
      raw.writeUInt32LE(word, (130 + index) * 4);
    });
    assert.equal(hash(raw), fixture.packetSHA256);
    const result = nativeDiagnostic(packet);
    if (fixture.status !== 0) {
      assert.equal(result.ok, false);
      continue;
    }
    assert.ok(result.ok, fixture.name);
    const expected = reference(fixture.source);
    assert.deepEqual(result.error.toJSON(), JSON.parse(fixture.jsonText), fixture.name);
    assert.deepEqual(result.error.toJSON(), expected.toJSON(), fixture.name);
    assert.equal(result.error.detail, expected.detail);
    assert.equal(result.error.message, expected.message, 'line prefix is added exactly once');
    assert.equal(result.location.line, fixture.facts[2]);
    const source = Buffer.from(fixture.source),
      start = result.location.byteStart;
    assert.equal(result.location.utf16Start, source.subarray(0, start).toString('utf8').length);
    assert.equal(
      result.location.utf16Length,
      source.subarray(start, start + result.location.byteLength).toString('utf8').length,
    );
  }
});

test('link origin mapping retains structured repairs and separate absolute/local spans', () => {
  const fixture = fixtures.cases.find((row) => row.name === 'undefined-node-suggestion');
  assert.ok(fixture);
  const packet = packetOf(fixture),
    shifted = [...packet.facts];
  shifted[2] = (shifted[2] as number) + 10;
  shifted[3] = (shifted[3] as number) + 101;
  shifted[12] = (shifted[12] as number) + 99;
  shifted[11] = (shifted[11] as number) + 101;
  const result = nativeDiagnostic({ ...packet, facts: shifted }, [
    {
      path: 'lib/helper.a0',
      firstLine: 11,
      lineCount: 6,
      byteStart: 101,
      byteLength: Buffer.byteLength(fixture.source),
      utf16Start: 99,
    },
  ]);
  assert.ok(result.ok);
  const expected = reference(fixture.source);
  assert.deepEqual(
    result.error.toJSON(),
    expected.rewrite(`lib/helper.a0:3: ${expected.detail}`).toJSON(),
  );
  assert.equal(result.error.line, undefined);
  assert.equal(result.location.localLine, 3);
  assert.equal(result.location.localByteStart, fixture.facts[3]);
  assert.equal(result.location.localUtf16Start, fixture.facts[12]);
  assert.equal(result.location.byteStart, shifted[3]);
  assert.deepEqual(result.error.edits, expected.edits);
});

test('global errors retain their unowned public message even with a physical sidecar location', () => {
  // Transport control for a global checker error; no native global-limit rendering claim.
  const facts = [...first.facts];
  facts[0] = 8;
  facts[1] = 29;
  facts[2] = 1;
  facts[3] = 0;
  facts[4] = 0;
  facts[7] = 0xffffffff;
  facts[12] = 0;
  facts[13] = 0;
  const expected = diag('A0029');
  const result = nativeDiagnostic(
    { status: 0, facts, json: Buffer.from(JSON.stringify(expected.toJSON())) },
    [
      {
        path: 'entry.a0',
        firstLine: 1,
        lineCount: 6,
        byteStart: 0,
        byteLength: Buffer.byteLength(first.source),
      },
    ],
  );
  assert.ok(result.ok);
  assert.deepEqual(result.error.toJSON(), expected.toJSON());
  assert.equal(result.location.path, 'entry.a0');
});

test('renderer refusals never become a partial A0Error', () => {
  for (const fixture of fixtures.cases.filter((row) => row.status !== 0)) {
    const result = nativeDiagnostic(packetOf(fixture));
    assert.ok(!result.ok);
    assert.equal(result.reason, fixture.status === 4 ? 'resource' : 'no-diagnostic');
    assert.equal(result.status, fixture.status);
  }
  const facts = [...first.facts];
  facts[1] = 714;
  const refused = nativeDiagnostic({ status: 7, facts, json: new Uint8Array() });
  assert.ok(!refused.ok);
  assert.equal(refused.reason, 'unsupported');
  for (const status of [1, 2, 3, 5]) {
    const transport = nativeDiagnostic({ status, facts, json: new Uint8Array() });
    assert.ok(!transport.ok);
    assert.equal(transport.reason, 'transport');
    assert.equal(transport.status, status);
  }
  assert.throws(
    () => nativeDiagnostic({ status: 7, facts, json: Buffer.from('{}') }),
    /partial JSON/,
  );
  assert.throws(
    () => nativeDiagnostic({ status: 8, facts, json: new Uint8Array() }),
    /unknown renderer refusal/,
  );
});

test('adapter preserves spec fault transport without fabricating native spec renderer coverage', () => {
  // Future renderer payload control only: native spec JSON remains unsupported today.
  const error = diag('A0716', ['f', '1', '2', '3'], {
    spec: { function: 'f', ex: 1, line: 'ex', input: '2', expected: '3', actual: '4' },
  });
  const facts = [...first.facts];
  facts[1] = 716;
  const result = nativeDiagnostic({
    status: 0,
    facts,
    json: Buffer.from(JSON.stringify(error.toJSON())),
  });
  assert.ok(result.ok);
  assert.deepEqual(result.error.toJSON(), error.toJSON());
  assert.deepEqual(result.error.spec, error.spec);
});

test('malformed native packets fail closed instead of losing public fields', () => {
  const base = packetOf(first),
    original = JSON.parse(first.jsonText) as Diagnostic;
  const malformed = (change: object): void => {
    assert.throws(
      () =>
        nativeDiagnostic({
          ...base,
          json: Buffer.from(JSON.stringify({ ...original, ...change })),
        }),
      /invalid native diagnostic packet/,
    );
  };
  malformed({ id: 'A0201' });
  malformed({ code: 'type' });
  malformed({ message: 'missing required line prefix' });
  malformed({ expected: 1 });
  malformed({ newField: 'must not silently discard' });
  malformed({ applicability: 'exact', fix: null, edits: [] });
  malformed({ edits: [{ op: 'lines', rule: 'case', text: 'x', to: 'y', line: 0 }] });
  malformed({ spec: { function: 'f', ex: -1 } });
  assert.throws(() => nativeDiagnostic({ ...base, facts: base.facts.slice(1) }), /128-word facts/);
  assert.throws(
    () => nativeDiagnostic({ status: 4, facts: new Array<number>(128), json: new Uint8Array() }),
    /128-word facts/,
  );
  const facts = [...base.facts];
  facts[20] = 0;
  assert.throws(() => nativeDiagnostic({ ...base, facts }), /incomplete renderer facts/);
  for (const status of [0, 1, 2, 3, 4, 5, 7, 9]) {
    const corrupted = [...base.facts];
    corrupted[0] = status;
    assert.throws(
      () => nativeDiagnostic({ ...base, facts: corrupted }),
      /unsupported source failure status/,
    );
  }
  const outside = [...base.facts];
  outside[3] = 0xffffffff;
  assert.throws(() => nativeDiagnostic({ ...base, facts: outside }), /span outside source/);
  assert.throws(
    () => nativeDiagnostic({ ...base, json: new Uint8Array([0xff]) }),
    /encoded data|UTF-8/i,
  );
  assert.throws(() => nativeDiagnostic({ ...base, json: Buffer.from('{') }), SyntaxError);
  const origin = {
    path: 'unit.a0',
    firstLine: 1,
    lineCount: 6,
    byteStart: 0,
    byteLength: Buffer.byteLength(first.source),
  };
  assert.throws(() => nativeDiagnostic(base, [origin, origin]), /ambiguous origin/);
  assert.throws(
    () => nativeDiagnostic(base, [{ ...origin, byteLength: origin.byteLength + 1 }]),
    /origin/,
  );
  assert.throws(() => nativeDiagnostic(base, [{ ...origin, utf16Start: 1 }]), /origin/);
  const invalidUtf16 = [...base.facts];
  invalidUtf16[12] = (invalidUtf16[3] as number) + 1;
  assert.throws(() => nativeDiagnostic({ ...base, facts: invalidUtf16 }), /UTF16 span/);
  assert.throws(
    () => nativeDiagnostic(base, [{ ...origin, byteLength: 1 }]),
    /span outside origin/,
  );
});

test('decoded snapshots do not retain mutable native packet storage', () => {
  const fixture = fixtures.cases.find((row) => row.name === 'associative-chain');
  assert.ok(fixture);
  const packet = packetOf(fixture),
    result = nativeDiagnostic(packet);
  assert.ok(result.ok);
  const expected = result.error.toJSON();
  (packet.facts as number[]).fill(0);
  packet.json.fill(0);
  assert.equal(result.facts[1], 14);
  assert.deepEqual(result.error.toJSON(), expected);
});
