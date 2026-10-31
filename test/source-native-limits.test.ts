import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeSource } from '../src/source-native.js';
import { nativeSourceArtifact } from '../tools/source-native-artifact.js';

test('native type-limit failures retain the rejected dimension limit through header initialization', async () => {
  const engine = nativeSource(await nativeSourceArtifact());
  try {
    for (const [type, limit] of [
      ['boolx2097153', 2097152],
      ['(bool,bool)x1048577', 1048576],
      ['(bool,bool,bool)x699051', 699050],
      ['boolx2x1048577', 1048576],
      ['_x65537', 65536],
      ['(io,bool)x65537', 65536],
    ] as const) {
      for (const signature of [`${type} -> _`, `-> ${type}`]) {
        const result = engine.parseUnit(`fn f ${signature}\nret 0\nend\n`);
        assert.equal(result.ok, false, signature);
        assert.equal(result.state[1], 1, signature);
        assert.equal(result.state[5], 4, signature);
        assert.equal(result.state[95], limit, signature);
      }
    }
    const accepted = engine.parse('fn f\nret A\nend\n');
    assert.ok(accepted.ok);
    assert.equal(accepted.typed.functions[0]?.params.length, 1);
  } finally {
    engine.close();
  }
});

test('native source-unit limits retain text, function and pure-value boundaries', async () => {
  const engine = nativeSource(await nativeSourceArtifact());
  // An explicit caller budget separates language boundaries from allocation refusal.
  const budget = 0xffff_ffff;
  const cases: readonly (readonly [string, string, boolean])[] = [
    ['largest u32 dimension', 'fn f u32x65536 -> u32\nret 0\nend\n', true],
    ['oversized u32 dimension', 'fn f u32x65537 -> u32\nret 0\nend\n', false],
    ['wide boolean value', 'fn f boolx65537 -> u32\nret 0\nend\n', true],
    ['largest boolean value', 'fn f boolx2097152 -> u32\nret 0\nend\n', true],
    ['oversized boolean value', 'fn f boolx2097153 -> u32\nret 0\nend\n', false],
    ['IO array', 'fn f (io,u32)x65536 -> u32\nret 0\nend\n', false],
  ];
  try {
    for (const [name, source, accepted] of cases)
      assert.equal(engine.parseUnit(source, budget).ok, accepted, name);
    for (const [length, accepted] of [
      [65536, true],
      [65537, false],
    ] as const) {
      const text = `fn f -> u32\na text "${'x'.repeat(length)}"\nret 0\nend\n`;
      assert.equal(engine.parseUnit(text, budget).ok, accepted, `${length} text bytes`);
      const source = Array.from({ length }, (_, id) => `fn f${id} -> u32\nret 0\nend\n`).join('');
      assert.equal(engine.parseUnit(source, budget).ok, accepted, `${length} functions`);
    }
  } finally {
    engine.close();
  }
});
