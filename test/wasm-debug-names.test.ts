import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  type CompileOptions,
  compile,
  emitFunction,
  FunctionCache,
  functionEmissionKey,
} from '../src/backends.js';
import { parseAndValidate } from '../src/core.js';

const SOURCE = `fn step (u32x3,io) u32 u32 -> (u32x3,io)
array at p0 0
token at p0 1
word get array p1
written write token word
changed set array p1 p2
out rec changed written
ret out
end
fn exchange io u32 -> u32
array arr 7 8 9
state rec array p0
next fold step p1 state 11
result at next 0
out get result 0
ret out
end
fn read_word io -> u32
input read p0
word at input 0
ret word
end
fn pure u32 -> u32
out add p0 1
ret out
end
`;
const HOST = { module: 'host/字', read: 'input', write: 'output', readPresent: 'present' };
const bytes = (text: string): Buffer<ArrayBuffer> => Buffer.from(text, 'base64');

/** Independent decoder for the small standard metadata sections these tests inspect. */
class Metadata {
  at = 0;
  constructor(readonly bytes: Uint8Array) {}
  byte(): number {
    assert.ok(this.at < this.bytes.length);
    return this.bytes[this.at++] as number;
  }
  uint(): number {
    let result = 0,
      scale = 1;
    for (let n = 0; n < 5; n++) {
      const byte = this.byte();
      result += (byte & 127) * scale;
      if (!(byte & 128)) return result;
      scale *= 128;
    }
    throw new Error('invalid metadata LEB');
  }
  take(length: number): Uint8Array {
    const start = this.at;
    this.at += length;
    assert.ok(this.at <= this.bytes.length);
    return this.bytes.subarray(start, this.at);
  }
  text(): string {
    return new TextDecoder('utf-8', { fatal: true }).decode(this.take(this.uint()));
  }
}

function sections(bytes: Uint8Array) {
  const reader = new Metadata(bytes);
  reader.take(8);
  const sections: { id: number; payload: Uint8Array; raw: Uint8Array; custom?: string }[] = [];
  while (reader.at < bytes.length) {
    const start = reader.at,
      id = reader.byte(),
      payload = reader.take(reader.uint());
    sections.push({
      id,
      payload,
      raw: bytes.subarray(start, reader.at),
      ...(id === 0 ? { custom: new Metadata(payload).text() } : {}),
    });
  }
  return sections;
}

function withoutCustom(bytes: Uint8Array, name: string): Buffer {
  return Buffer.concat([
    bytes.subarray(0, 8),
    ...sections(bytes)
      .filter((section) => section.custom !== name)
      .map((section) => section.raw),
  ]);
}

function functionNames(module: WebAssembly.Module): Map<number, string> {
  const sections = WebAssembly.Module.customSections(module, 'name');
  assert.equal(sections.length, 1);
  const section = new Metadata(new Uint8Array(sections[0] as ArrayBuffer));
  assert.equal(section.byte(), 1, 'standard function-name subsection');
  const payload = new Metadata(section.take(section.uint()));
  assert.equal(section.at, section.bytes.length);
  const names = new Map<number, string>();
  for (let count = payload.uint(); count > 0; count--) {
    const index = payload.uint();
    assert.ok(!names.has(index), 'duplicate function index');
    names.set(index, payload.text());
  }
  assert.equal(payload.at, payload.bytes.length);
  return names;
}

function checkFunctionIndexes(bytes: Uint8Array): Map<number, string> {
  const module = new WebAssembly.Module(bytes as BufferSource),
    names = functionNames(module);
  const fnSection = sections(bytes).find((section) => section.id === 3);
  assert.ok(fnSection);
  const defined = new Metadata(fnSection.payload).uint();
  const imported = WebAssembly.Module.imports(module);
  assert.ok(imported.every((entry) => entry.kind === 'function'));
  assert.equal(names.size, defined + imported.length);
  assert.deepEqual(
    [...names.keys()],
    Array.from({ length: names.size }, (_, index) => index),
  );
  const exportSection = sections(bytes).find((section) => section.id === 7);
  assert.ok(exportSection);
  const exports = new Metadata(exportSection.payload);
  for (let count = exports.uint(); count > 0; count--) {
    const name = exports.text(),
      kind = exports.byte(),
      index = exports.uint();
    if (kind === 0) assert.equal(names.get(index), name, 'export names use final indexes');
  }
  assert.equal(exports.at, exports.bytes.length);
  return names;
}

test('Wasm debug names preserve default bytes and every existing section', () => {
  // Captured before debug names were added. Only the existing a0 version section is excluded.
  const recordedDefault = [
    '5ddb41f1c6a110842abae9ad87d0af50cbf0a60ee4872689a99f15b63619dd1a',
    'f0ae59cfe290a47214e5ff966e703cb6948f047ccdbfaea2dbc5cfb494e99c5b',
  ];
  for (const [profile, strict] of [false, true].entries()) {
    const program = parseAndValidate(`${strict ? 'profile strict\n' : ''}${SOURCE}`);
    const defaultBytes = bytes(compile(program, 'wasm').text);
    assert.equal(
      createHash('sha256').update(withoutCustom(defaultBytes, 'a0')).digest('hex'),
      recordedDefault[profile],
    );
    assert.deepEqual(bytes(compile(program, 'wasm', { wasmDebugNames: false }).text), defaultBytes);
    assert.equal(
      WebAssembly.Module.customSections(new WebAssembly.Module(defaultBytes), 'name').length,
      0,
    );
    for (const optimize of [false, true])
      for (const wasmSimd of [false, true])
        for (const wasmIo of [undefined, HOST]) {
          const options: CompileOptions = {
            optimize,
            wasmSimd,
            ...(wasmIo === undefined ? {} : { wasmIo }),
          };
          const plain = bytes(compile(program, 'wasm', options).text);
          const named = bytes(compile(program, 'wasm', { ...options, wasmDebugNames: true }).text);
          assert.ok(WebAssembly.validate(named));
          assert.deepEqual(withoutCustom(named, 'name'), plain);
          assert.deepEqual(
            WebAssembly.Module.exports(new WebAssembly.Module(named)),
            WebAssembly.Module.exports(new WebAssembly.Module(plain)),
          );
          assert.deepEqual(
            WebAssembly.Module.imports(new WebAssembly.Module(named)),
            WebAssembly.Module.imports(new WebAssembly.Module(plain)),
          );
          const names = checkFunctionIndexes(named);
          assert.ok(
            [...names.values()].includes('a0o_step'),
            'owned variant retains its distinct symbol',
          );
          if (strict) assert.ok([...names.values()].includes('rt:trap'));
        }
  }
});

test('Wasm names follow import pruning and final helper/variant indexes', () => {
  for (const strict of [false, true]) {
    const program = parseAndValidate(`${strict ? 'profile strict\n' : ''}${SOURCE}`);
    const emitted = (wasmExports: readonly string[]) =>
      bytes(compile(program, 'wasm', { wasmIo: HOST, wasmExports, wasmDebugNames: true }).text);
    const empty = emitted([]);
    assert.deepEqual(WebAssembly.Module.imports(new WebAssembly.Module(empty)), []);
    assert.deepEqual([...checkFunctionIndexes(empty)], []);
    const pure = emitted(['pure']);
    assert.deepEqual(WebAssembly.Module.imports(new WebAssembly.Module(pure)), []);
    assert.deepEqual([...checkFunctionIndexes(pure)], [[0, 'a0_pure']]);
    const write = emitted(['exchange']);
    assert.deepEqual(WebAssembly.Module.imports(new WebAssembly.Module(write)), [
      { module: HOST.module, name: HOST.write, kind: 'function' },
    ]);
    const writeNames = checkFunctionIndexes(write);
    assert.equal(writeNames.get(0), 'io:write');
    assert.ok([...writeNames.values()].includes('a0o_step'));
    assert.ok(![...writeNames.values()].includes('a0_read_word'));
    assert.ok(![...writeNames.values()].includes('a0_pure'));
    const both = emitted(['exchange', 'read_word']);
    const names = checkFunctionIndexes(both);
    assert.equal(names.get(0), 'io:read');
    assert.equal(names.get(1), 'io:write');
    if (strict) assert.equal(names.get(2), 'io:present');
    else assert.ok(![...names.values()].includes('io:present'));
  }
});

test('Wasm function-name maps encode indexes beyond one LEB byte', () => {
  const source =
    Array.from({ length: 130 }, (_, index) => `fn f${index} u32 -> u32\nret p0\nend\n`).join('') +
    'fn sink io -> io\nout write p0 0\nret out\nend\n';
  const program = parseAndValidate(source);
  const named = bytes(compile(program, 'wasm', { wasmIo: HOST, wasmDebugNames: true }).text);
  const names = checkFunctionIndexes(named);
  assert.equal(names.size, 132);
  assert.equal(names.get(0), 'io:write');
  assert.equal(names.get(127), 'a0_f126');
  assert.equal(names.get(128), 'a0_f127');
  assert.equal(names.get(131), 'a0_sink');
});

test('debug names reuse function cache bodies and preserve host IO behavior', () => {
  for (const strict of [false, true])
    for (const optimize of [false, true]) {
      const program = parseAndValidate(`${strict ? 'profile strict\n' : ''}${SOURCE}`);
      const options: CompileOptions = {
        optimize,
        wasmIo: HOST,
        wasmExports: ['exchange', 'read_word', 'pure'],
      };
      const namedOptions = { ...options, wasmDebugNames: true };
      const cache = new FunctionCache();
      const plain = compile(program, 'wasm', options, cache);
      assert.equal(plain.cacheMisses, program.functions.length);
      const cached = compile(program, 'wasm', namedOptions, cache);
      assert.equal(cached.cacheHits, program.functions.length);
      assert.equal(cached.cacheMisses, 0);
      assert.equal(cached.text, compile(program, 'wasm', namedOptions).text);
      assert.equal(compile(program, 'wasm', options, cache).text, plain.text);
      for (const fn of program.functions) {
        assert.equal(
          functionEmissionKey('wasm', fn, options),
          functionEmissionKey('wasm', fn, namedOptions),
        );
        assert.equal(emitFunction('wasm', fn, options), emitFunction('wasm', fn, namedOptions));
      }
      for (const text of [plain.text, cached.text]) {
        const events: unknown[] = [];
        const token = 0xfedcba98;
        const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes(text)), {
          [HOST.module]: {
            [HOST.read]: (handle: number) => {
              events.push(['read', handle >>> 0]);
              return -1;
            },
            [HOST.write]: (handle: number, word: number) => {
              events.push(['write', handle >>> 0, word >>> 0]);
            },
            [HOST.readPresent]: (handle: number) => {
              events.push(['present', handle >>> 0]);
              return 1;
            },
          },
        });
        const exchange = instance.exports.a0_exchange as (token: number, count: number) => number;
        const read = instance.exports.a0_read_word as (token: number) => number;
        const pure = instance.exports.a0_pure as (word: number) => number;
        assert.equal(exchange(token, 0), 7);
        assert.equal(exchange(token, 2), 11);
        assert.equal(read(token) >>> 0, 0xffffffff);
        assert.equal(pure(0xffffffff), 0);
        assert.deepEqual(events, [
          ['write', token, 7],
          ['write', token, 8],
          ['read', token],
          ...(strict ? [['present', token]] : []),
        ]);
      }
    }
});
