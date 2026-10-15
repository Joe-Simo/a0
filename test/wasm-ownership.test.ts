import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { compile } from '../src/backends.js';
import { parseAndValidate, run, type TypedFunc } from '../src/core.js';
import { emitWasmFunction, wasmModuleBytes } from '../src/wasm.js';
import { KERNELS } from '../tools/exec-bench-kernels.js';

test('wasm ownership: completed calls and iteration extras permit later updates', async () => {
  const p = parseAndValidate(await readFile('test/fixtures/wasm-readonly.a0', 'utf8'));
  const frame = (name: string): number => {
    const record = JSON.parse(emitWasmFunction(p.byName.get(name) as TypedFunc)) as {
      variants: { symbol: string; frame: number }[];
    };
    const owned = record.variants.find((v) => v.symbol === `a0o_${name}`);
    assert.ok(owned !== undefined, name);
    return owned.frame;
  };
  for (const name of ['aftercall', 'afterfold', 'afterloop', 'nested'])
    assert.equal(frame(name), 0, `${name} updates its owned state without a copy`);
  // The aggregate call result keeps its separate storage. A lazy call that reads the old
  // state after the update still forces a state copy.
  assert.equal(frame('aftercopy'), 64);
  assert.ok(frame('late') >= 64);
  const fn = p.byName.get('probe') as TypedFunc;
  const inputs = [0, 1, 15, 16, 17, 1029, 0x9e3779b9, 0xffffffff];
  for (const optimize of [false, true]) {
    const bytes = wasmModuleBytes(compile(p, 'wasm', { optimize, wasmExports: ['probe'] }).text);
    const { instance } = await WebAssembly.instantiate(bytes as BufferSource, {});
    const probe = instance.exports.a0_probe as (x: number, y: number) => number;
    for (const x of inputs)
      for (const y of inputs)
        assert.equal(probe(x, y) >>> 0, run(fn, [x, y]), `${x}, ${y}; optimize=${optimize}`);
  }
});

test('wasm ownership: probing before inserting does not copy the hash table', () => {
  const kernel = KERNELS.find((k) => k.name === 'hash1k');
  assert.ok(kernel !== undefined);
  const p = parseAndValidate(kernel.a0);
  const record = JSON.parse(emitWasmFunction(p.byName.get('hins') as TypedFunc)) as {
    variants: { frame: number }[];
  };
  assert.deepEqual(
    record.variants.map((v) => v.frame),
    [0, 0],
  );
});
