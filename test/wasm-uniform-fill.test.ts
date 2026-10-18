import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { compile } from '../src/backends.js';
import { makeIo, parseAndValidate, run } from '../src/core.js';
import { link } from '../src/link.js';
import { wasmModuleBytes } from '../src/wasm.js';

const LENGTH = 17;
const COUNTS = [0, 1, 3, 4, 5, 7, 8, 15, 16, 17];
const SOURCE = `fn store u32x17 u32 u32 -> u32x17
out set p0 p1 p2
ret out
end
${COUNTS.map(
  (count) => `fn fill_${count} u32x17 u32 -> u32x17
out fold store ${count} p0 p1
ret out
end`,
).join('\n')}
fn fillstate (u32x17,io) u32 u32 -> (u32x17,io)
array at p0 0
token at p0 1
filled fold store 17 array p2
out rec filled token
ret out
end
fn repeat (u32x17,io) u32 -> (u32x17,io)
out fold fillstate 3 p0 p1
ret out
end
`;

test('direct Wasm uniform extra fills preserve partial arrays, tails and owned IO records', async () => {
  const program = parseAndValidate(SOURCE);
  let seed = 0xa917e25d;
  const random = (): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
  const values = [0, 1, 0x7fffffff, 0x80000000, 0xffffffff, ...Array.from({ length: 8 }, random)];
  const exports = [...COUNTS.map((count) => `fill_${count}`), 'repeat'];
  for (const optimize of [false, true])
    for (const wasmSimd of [false, true]) {
      const bytes = wasmModuleBytes(
        compile(program, 'wasm', { optimize, wasmSimd, wasmExports: exports }).text,
      );
      assert.equal(WebAssembly.validate(bytes as BufferSource), true);
      const { instance } = await WebAssembly.instantiate(bytes as BufferSource);
      const memory = instance.exports.memory as WebAssembly.Memory;
      const heap = Number((instance.exports.__heap_base as WebAssembly.Global).value);
      const out = heap + 16;
      const input = out + (LENGTH + 1) * 4 + 16;
      if (input + (LENGTH + 1) * 4 + 16 > memory.buffer.byteLength) memory.grow(1);
      const view = new DataView(memory.buffer);
      const token = 0xfedcba98;
      const guard = 0x519ec72a;
      for (const name of exports)
        for (const value of values) {
          const original = Array.from({ length: LENGTH }, random);
          for (const [i, word] of original.entries()) view.setUint32(input + i * 4, word, true);
          view.setUint32(input + LENGTH * 4, token, true);
          for (const at of [out - 4, out + (LENGTH + 1) * 4, input - 4, input + (LENGTH + 1) * 4])
            view.setUint32(at, guard, true);
          for (let i = 0; i <= LENGTH; i++) view.setUint32(out + i * 4, 0xdeadbeef, true);
          const fn = program.byName.get(name);
          assert.ok(fn);
          const state = name === 'repeat' ? [original, makeIo([])] : original;
          const expected = run(fn, [state, value], { fuel: 1e6 }) as readonly unknown[];
          const array = name === 'repeat' ? expected[0] : expected;
          const call = instance.exports[`a0_${name}`] as (
            out: number,
            input: number,
            value: number,
          ) => void;
          call(out, input, value);
          assert.deepEqual(
            Array.from({ length: LENGTH }, (_, i) => view.getUint32(out + i * 4, true)),
            array,
            `${name}/${value}; optimize=${optimize}, simd=${wasmSimd}`,
          );
          assert.deepEqual(
            Array.from({ length: LENGTH }, (_, i) => view.getUint32(input + i * 4, true)),
            original,
            'input value is preserved',
          );
          if (name === 'repeat') assert.equal(view.getUint32(out + LENGTH * 4, true), token);
          for (const at of [out - 4, out + (LENGTH + 1) * 4, input - 4, input + (LENGTH + 1) * 4])
            assert.equal(view.getUint32(at, true), guard, 'adjacent memory is preserved');
        }
    }
});

test('the unchanged A0 frontend validates through direct Wasm with default SIMD', async () => {
  const program = (await link('compiler/source_frontend.a0', (path) => readFile(path, 'utf8')))
    .program;
  for (const optimize of [false, true]) {
    const bytes = wasmModuleBytes(
      compile(program, 'wasm', {
        optimize,
        wasmExports: [
          'arena_parse_verify_begin',
          'arena_source_unit',
          'arena_verify_begin',
          'arena_verify_resume',
          'arena_verify_status',
          'source_ir_init',
          'source_ir_symbol',
          'source_ir_type',
        ],
      }).text,
    );
    assert.equal(WebAssembly.validate(bytes as BufferSource), true);
    assert.ok(new WebAssembly.Module(bytes as BufferSource));
  }
});
