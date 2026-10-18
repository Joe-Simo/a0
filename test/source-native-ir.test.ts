import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeNativeSource, decodeNativeUnit } from '../src/source-native-ir.js';

function fixture(depth: number) {
  const state = Array<number>(128).fill(0);
  state[24] = 0xffff_ffff;
  const tables = new Map<number, Uint32Array>();
  for (const offset of [
    32, 35, 38, 41, 44, 47, 50, 53, 56, 59, 62, 68, 71, 74, 97, 100, 103, 106, 115, 118, 121, 124,
  ])
    tables.set(offset, new Uint32Array());
  tables.set(32, Uint32Array.of(1, 0, 0, 0, 0, 0, 0, 0xffff_ffff, 0, 0));
  tables.set(41, Uint32Array.of(0, 0, 1, depth, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0));
  tables.set(47, Uint32Array.of(1, 0, 0, 0, 0));
  tables.set(50, Uint32Array.of(depth));
  tables.set(
    68,
    Uint32Array.from(
      Array.from({ length: depth + 1 }, (_, id) =>
        id === 0 ? [0, 0, 0, 0, 0] : [3, id - 1, 1, 0, 0],
      ).flat(),
    ),
  );
  tables.set(103, Uint32Array.of(1, 0, 0));
  const specs = new Map(
    [32, 35, 38, 41, 44, 47, 50, 62].map((offset) => [offset, new Uint32Array()]),
  );
  return { state, tables, specs };
}

test('native IR decoding handles deep shared types without recursive host calls', () => {
  const { state, tables, specs } = fixture(8192);
  const result = decodeNativeSource(state, tables, ['identity'], '', specs);
  const fn = result.program.functions[0];
  assert.ok(fn);
  assert.equal(fn.result, fn.params[0], 'interned type identity is preserved');
  let type = fn.result,
    depth = 0;
  while (typeof type !== 'string') {
    assert.equal(type.kind, 'arr');
    assert.ok(type.kind === 'arr');
    assert.equal(type.length, 1);
    type = type.elem;
    depth++;
  }
  assert.equal(depth, 8192);
  assert.equal(type, 'u32');
  assert.equal(result.typed.byName.get('identity'), result.typed.functions[0]);
});

test('native IR decoding rejects truncated rows and cyclic or forward type references', () => {
  for (const words of [Uint32Array.of(0), Uint32Array.of(3, 0, 1, 0, 0)]) {
    const { state, tables, specs } = fixture(0);
    tables.set(68, words);
    assert.throws(
      () => decodeNativeSource(state, tables, ['identity'], '', specs),
      /frontend IR|type children/,
    );
  }
});

test('source-unit IR decoding requires no whole-program type or iteration tables', () => {
  const { state, tables, specs } = fixture(0);
  tables.delete(97);
  tables.delete(103);
  const program = decodeNativeUnit(state, tables, ['identity'], '', specs);
  assert.equal(program.functions[0]?.name, 'identity');
  assert.deepEqual(program.functions[0]?.ret, { kind: 'param', index: 0 });
  assert.throws(() => decodeNativeSource(state, tables, ['identity'], '', specs), /frontend IR/);
});
