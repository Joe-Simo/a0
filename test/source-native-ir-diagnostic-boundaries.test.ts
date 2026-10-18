import assert from 'node:assert/strict';
import { test } from 'node:test';
import { A0Error, parse, validate } from '../src/core.js';
import { parseSource } from '../src/source.js';
import type { NativeIrBuilder } from '../src/source-native-compose.js';
import { encodeNativeProgram } from '../src/source-native-program.js';
import { irDiagnosticCases } from './fixtures/native-diagnostics/ir-cases.js';

function builder(): NativeIrBuilder {
  let handle = 0;
  return {
    initialize() {},
    symbol: () => 0,
    type: () => 0,
    upload: () => ++handle,
    get: () => 0,
    set() {},
  };
}
const base = {
  name: 'f',
  params: [],
  result: 'u32' as const,
  nodes: [],
  ret: { kind: 'u32' as const, value: 0 },
};

test('structured diagnostic cases independently select the documented catalog and priority', () => {
  assert.deepEqual(
    [...new Set(irDiagnosticCases().map((row) => row.id))].sort(),
    [21, 301, 302, 304, 305, 306, 307],
  );
  for (const row of irDiagnosticCases())
    assert.throws(
      () => validate(row.program),
      (error) => {
        assert.ok(error instanceof A0Error);
        assert.equal(error.id, `A${String(row.id).padStart(4, '0')}`, row.name);
        return true;
      },
    );
});

test('unrepresentable numbers and UTF16 strings refuse before native checking without changing bytes', () => {
  for (const value of [-1, 0.5, 0x1_0000_0000, Infinity, NaN])
    assert.throws(
      () =>
        encodeNativeProgram({ functions: [{ ...base, ret: { kind: 'u32', value } }] }, builder()),
      /unrepresentable native program IR: expected a u32 word/,
    );
  for (const value of [-1, 0.5, 0x1_0000_0000, Infinity, NaN]) {
    const program = {
      functions: [
        {
          ...base,
          nodes: [{ id: 'x', op: 'mov' as const, args: [{ kind: 'u32' as const, value }] }],
        },
      ],
    };
    assert.throws(
      () => validate(program),
      (error) => error instanceof A0Error && error.id === 'A0308',
    );
    assert.throws(
      () => encodeNativeProgram(program, builder()),
      /unrepresentable native program IR: expected a u32 word/,
    );
  }
  for (const name of ['\ud800', '\udfff', 'a\ud800z', '\udc00\ud800']) {
    assert.throws(
      () => encodeNativeProgram({ functions: [{ ...base, name }] }, builder()),
      /unpaired UTF-16 surrogate/,
    );
    assert.throws(
      () =>
        encodeNativeProgram(
          { functions: [{ ...base, ret: { kind: 'node', id: name } }] },
          builder(),
        ),
      /unpaired UTF-16 surrogate/,
    );
  }
  // Separately encoded span strings must not join into a surrogate pair with
  // different UTF-8 extents than the string pool's recorded offsets.
  assert.throws(
    () =>
      encodeNativeProgram(
        {
          functions: [
            {
              ...base,
              ret: { kind: 'node', id: '\ud800' },
              nodes: [{ id: 'x', op: 'mov', args: [{ kind: 'node', id: '\udc00' }] }],
            },
          ],
        },
        builder(),
      ),
    /unpaired UTF-16 surrogate/,
  );
  assert.throws(
    () => encodeNativeProgram({ functions: [base], uses: ['\ud800', '\udc00'] }, builder()),
    /unpaired UTF-16 surrogate/,
  );
  // Valid Unicode scalar strings remain representable, including invalid A0 names.
  for (const name of ['λ', '😀', 'a😀λ', '\u0000', ''])
    assert.doesNotThrow(() => encodeNativeProgram({ functions: [{ ...base, name }] }, builder()));
});

test('source literal syntax retains parser diagnostics before whole-program checking', () => {
  for (const read of [parse, parseSource])
    for (const [literal, id] of [
      ['4294967296', 'A0004'],
      ['-1', 'A0003'],
      ['0.5', 'A0003'],
    ] as const) {
      const source = `fn f -> u32\nx mov ${literal}\nret x\nend\nfn Bad -> u32\nret 0\nend\n`;
      assert.throws(
        () => validate(read(source)),
        (error) => {
          assert.ok(error instanceof A0Error);
          assert.equal(error.id, id);
          assert.equal(
            error.line,
            2,
            'literal parse failure precedes later invalid function/checking',
          );
          return true;
        },
      );
    }
  for (const read of [parse, parseSource])
    for (const literal of ['4294967296', '-1', '0.5'])
      assert.throws(
        () => read(`fn f -> u32\nx add ${literal}\nret x\nend\n`),
        (error) => error instanceof A0Error && error.id === 'A0014',
      );
});
