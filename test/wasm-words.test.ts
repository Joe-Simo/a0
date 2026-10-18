import assert from 'node:assert/strict';
import test from 'node:test';
import { readWasmWord, readWasmWords, writeWasmWord, writeWasmWords } from '../src/wasm-words.js';

const hostOrders = new Uint8Array(Uint32Array.of(1).buffer)[0] === 1 ? [true, false] : [false];

test('Wasm word storage keeps little-endian bytes through both host-order paths', () => {
  for (const nativeLittleEndian of hostOrders) {
    const memory = new ArrayBuffer(24);
    writeWasmWords(
      memory,
      4,
      Uint32Array.of(0x01020304, 0xaabbccdd, 0xffffffff),
      nativeLittleEndian,
    );
    assert.deepEqual(
      [...new Uint8Array(memory).slice(4, 16)],
      [4, 3, 2, 1, 221, 204, 187, 170, 255, 255, 255, 255],
    );
    assert.deepEqual(
      [...readWasmWords(memory, 4, 3, nativeLittleEndian)],
      [0x01020304, 0xaabbccdd, 0xffffffff],
    );
    writeWasmWord(memory, 4, 0xfedcba98);
    assert.equal(readWasmWord(memory, 4), 0xfedcba98);
  }
});
test('Wasm word storage preserves overlapping inputs and rejects invalid extents', () => {
  for (const nativeLittleEndian of hostOrders) {
    const memory = new ArrayBuffer(20);
    const input = new Uint32Array(memory, 0, 3);
    input.set([1, 2, 3]);
    writeWasmWords(memory, 4, input, nativeLittleEndian);
    assert.deepEqual([...readWasmWords(memory, 4, 3, nativeLittleEndian)], [1, 2, 3]);
    for (const [offset, count] of [
      [1, 1],
      [-4, 1],
      [20, 1],
      [0, -1],
      [0, 0.5],
    ])
      assert.throws(
        () => readWasmWords(memory, offset as number, count as number, nativeLittleEndian),
        RangeError,
      );
    assert.throws(() => writeWasmWord(memory, 20, 1), RangeError);
  }
});
