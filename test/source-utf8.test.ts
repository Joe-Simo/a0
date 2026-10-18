import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { nativeSource } from '../src/source-native.js';
import type { NativeIrBuilder } from '../src/source-native-compose.js';
import { encodeNativeProgram } from '../src/source-native-program.js';
import { decodeSourceUtf8, losslessSourceString } from '../src/source-utf8.js';

const module = new WebAssembly.Module(await readFile('seed/source-frontend/frontend.wasm'));
const simple = 'fn identity\nret A\nend\n';

test('source strings and UTF8 bytes refuse lossy transport before native parsing, preserving scalars and BOM', () => {
  const engine = nativeSource(module);
  try {
    for (const value of ['\ud800', '\udfff', 'x\ud800y', '\udfff\ud800']) {
      assert.throws(() => losslessSourceString(value), /unpaired UTF-16/);
      for (const source of [
        value,
        `# ${value}\n${simple}`,
        `fn f\na text "${value}"\nret a\nend\n`,
      ]) {
        assert.throws(() => engine.parse(source), /native source: unpaired UTF-16/);
        assert.throws(() => engine.parseUnit(source), /native source: unpaired UTF-16/);
      }
    }
    for (const value of ['', 'abc', '\ufeff', '😀', '\ufffd', 'Ω\ud800\udc00']) {
      assert.equal(losslessSourceString(value), value);
      assert.equal(decodeSourceUtf8(new TextEncoder().encode(value)), value);
    }
    const source = `\ufeff# 😀 Ω \ufffd\n${simple}`;
    assert.ok(engine.parse(source).ok);
    for (const bytes of [
      [0xc0, 0xaf],
      [0xe2, 0x82],
      [0xed, 0xa0, 0x80],
      [0xf4, 0x90, 0x80, 0x80],
      [0x80],
    ])
      assert.throws(() => decodeSourceUtf8(Uint8Array.from(bytes)), TypeError);
    assert.ok(engine.parse(simple).ok, 'transport refusal does not poison the next native parse');
  } finally {
    engine.close();
  }
});

test('structured identity spans refuse split surrogate pairs before joining and retain IR context', () => {
  let calls = 0;
  const unexpected = (): never => {
    calls++;
    throw new Error('must refuse before native initialization');
  };
  const builder: NativeIrBuilder = {
    initialize: unexpected,
    upload: unexpected,
    symbol: unexpected,
    type: unexpected,
    get: unexpected,
    set: unexpected,
  };
  for (const uses of [['\ud800', '\udc00'], ['\ud800'], ['\udc00']])
    assert.throws(
      () => encodeNativeProgram({ functions: [], uses }, builder),
      /unrepresentable native program IR: unpaired UTF-16 surrogate/,
    );
  assert.equal(calls, 0);
});
