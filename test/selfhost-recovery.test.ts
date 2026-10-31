import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { after, test } from 'node:test';
import { parseAndValidate, type Type } from '../src/core.js';
import { findClang } from '../src/toolchain.js';
import {
  a0OptimizeProgram,
  a0WasmFromSource,
  a0WasmFromTables,
  buildWasmTool,
  encodeChunk,
  typescriptBodies,
  typescriptWasm,
} from '../tools/selfhost-wasm.js';

const SKIP = process.env.A0W_TOOL ? false : findClang().path ? false : 'clang unavailable';
let root: string | undefined;
let tool: Promise<string> | undefined;
after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
function executable(): Promise<string> {
  tool ??= process.env.A0W_TOOL
    ? Promise.resolve(process.env.A0W_TOOL)
    : (async () => {
        await mkdir('.a0-cache', { recursive: true });
        root = await mkdtemp(resolve('.a0-cache', 'selfhost-recovery-'));
        return (await buildWasmTool(findClang(), undefined, root)).exe;
      })();
  return tool;
}
const layout = { ioInputCapacity: 2, ioOutputCapacity: 4 };
const depthSource = `fn leaf u32 -> u32
r add p0 1
ret r
end
fn relay u32 -> u32
r call leaf p0
ret r
end
fn inner u32 u32 -> u32
r call relay p0
ret r
end
fn outer u32 u32 -> u32
r fold inner 1 p0
ret r
end
fn top u32 -> u32
r fold outer p0 0
ret r
end`;

test('A0 Wasm maximum-depth call probe preserves a live dynamic outer bound', {
  skip: SKIP,
}, async () => {
  const exe = await executable();
  const program = parseAndValidate(depthSource);
  const source = a0WasmFromSource(exe, program, layout);
  assert.equal(source.code, 0);
  assert.ok(source.bytes);
  for (const bytes of [source.bytes, a0WasmFromTables(exe, program, layout).bytes]) {
    const { instance } = await WebAssembly.instantiate(bytes as BufferSource, {});
    const top = instance.exports.a0_top as (n: number) => number;
    for (const n of [0, 1, 2, 7, 31]) assert.equal(top(n), n, `top(${n})`);
    assert.deepEqual(bytes, typescriptWasm(program, layout, false));
  }
});

test('A0 Wasm source forwards SIMD and unroll options with zero-trip and wrapping parity', {
  skip: SKIP,
}, async () => {
  const exe = await executable();
  const program = parseAndValidate(`fn step u32 u32 u32 -> u32
r add p0 p2
ret r
end
fn top u32 u32 -> u32
r fold step p0 0 p1
ret r
end`);
  for (const simd of [false, true]) {
    for (const unroll of [1, 2, 4] as const) {
      const options = { simd, unroll };
      const result = a0WasmFromSource(exe, program, layout, false, options);
      assert.equal(result.code, 0);
      assert.ok(result.bytes);
      const tables = a0WasmFromTables(exe, program, layout, false, options).bytes;
      assert.deepEqual(result.bytes, tables, JSON.stringify(options));
      assert.deepEqual(result.bytes, typescriptWasm(program, layout, false, options));
      const { instance } = await WebAssembly.instantiate(result.bytes as BufferSource, {});
      const top = instance.exports.a0_top as (n: number, x: number) => number;
      for (const n of [0, 1, 2, 7, 31]) {
        for (const x of [0, 1, 0x80000001, 0xffffffff]) {
          assert.equal(top(n, x) >>> 0, Math.imul(n, x) >>> 0);
        }
      }
    }
  }
});

test('A0 Wasm source SIMD option controls an actual vector reduction', { skip: SKIP }, async () => {
  const exe = await executable();
  const program = parseAndValidate(`fn sum u32 u32 u32x16 -> u32
v get p2 p1
r add p0 v
ret r
end
fn top u32x16 -> u32
r fold sum 16 0 p0
ret r
end`);
  const modules: Uint8Array[] = [];
  for (const simd of [false, true]) {
    const result = a0WasmFromSource(exe, program, layout, false, { simd });
    assert.equal(result.code, 0);
    assert.ok(result.bytes);
    assert.deepEqual(result.bytes, typescriptWasm(program, layout, false, { simd }));
    modules.push(result.bytes);
    const { instance } = await WebAssembly.instantiate(result.bytes as BufferSource, {});
    const memory = instance.exports.memory as WebAssembly.Memory;
    const ptr = Number((instance.exports.__heap_base as WebAssembly.Global).value);
    if (ptr + 64 > memory.buffer.byteLength) memory.grow(1);
    new Uint32Array(memory.buffer, ptr, 16).fill(0xffffffff);
    const top = instance.exports.a0_top as (ptr: number) => number;
    assert.equal(top(ptr) >>> 0, 0xfffffff0);
  }
  assert.notDeepEqual(modules[0], modules[1], 'fixture must exercise vector emission');
});

for (const type of ['u32', 'bool']) {
  for (const op of ['eq', 'ne']) {
    for (const reverse of [false, true]) {
      test(`A0 optimizer literal select identity ${type} ${op} reversed=${reverse}`, {
        skip: SKIP,
      }, async () => {
        const literal = type === 'u32' ? '0' : 'false';
        const args = reverse ? `${literal} p0` : `p0 ${literal}`;
        const arms = op === 'eq' ? `${literal} p0` : `p0 ${literal}`;
        const program = parseAndValidate(
          `fn f ${type} -> ${type}\nc ${op} ${args}\nr select c ${arms}\nret r\nend`,
        );
        const result = a0OptimizeProgram(await executable(), program);
        assert.deepEqual(result.bodies, typescriptBodies(program));
        assert.equal(result.bodies[0]?.nodes.length, 0);
      });
    }
  }
}

test('A0 optimizer retains a near-miss literal select', { skip: SKIP }, async () => {
  const program = parseAndValidate('fn f u32 -> u32\nc eq p0 0\nr select c 1 p0\nret r\nend');
  const result = a0OptimizeProgram(await executable(), program);
  assert.deepEqual(result.bodies, typescriptBodies(program));
  assert.equal(result.bodies[0]?.nodes.length, 2);
});

test('A0 table interning uses structural types independently of property insertion order', () => {
  const program = parseAndValidate('fn f u32x2 -> u32x2\nr mov p0\nret r\nend');
  const fn = program.functions[0];
  assert.ok(fn);
  const reordered: Type = { elem: 'u32', length: 2, kind: 'arr' };
  const canonical = encodeChunk([fn], 0, 1);
  const modified = encodeChunk([{ ...fn, result: reordered }], 0, 1);
  assert.deepEqual(modified.words, canonical.words);
  const different = encodeChunk([{ ...fn, result: { kind: 'arr', length: 3, elem: 'u32' } }], 0, 1);
  assert.notDeepEqual(different.words, canonical.words);
  const differentElement = encodeChunk(
    [{ ...fn, result: { kind: 'arr', length: 2, elem: 'bool' } }],
    0,
    1,
  );
  assert.notDeepEqual(differentElement.words, canonical.words);
  const records = parseAndValidate('fn f (u32,bool) (bool,u32) -> (u32,bool)\nret p0\nend');
  const tables = encodeChunk(records.functions, 0, 1);
  assert.notEqual(tables.tb.typeIndex.get('(u32,bool)'), tables.tb.typeIndex.get('(bool,u32)'));
});

test('A0 optimizer cache does not hide a different unavailable compiler', {
  skip: SKIP,
}, async () => {
  const exe = await executable();
  const program = parseAndValidate('fn identity u32 -> u32\nret p0\nend');
  const result = a0OptimizeProgram(exe, program);
  assert.throws(() => a0OptimizeProgram(`${exe}.missing`, program), /failed/);
  assert.equal(a0OptimizeProgram(exe, program), result);
});
