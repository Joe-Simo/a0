import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { compile, FunctionCache } from '../src/backends.js';
import { A0Error, formatTrap, makeIo, parseAndValidate, run } from '../src/core.js';
import type { Trap } from '../src/diagnostics.js';
import { link } from '../src/link.js';
import { wasmModuleBytes } from '../src/wasm.js';
import { wasmTrap } from '../tools/verify.js';

const SOURCE = `fn step io u32 -> io
input read p0
word at input 0
next at input 1
out write next word
ret out
end
fn exchange io u32 -> io
head write p0 4294967295
message arr 0 4294967295 2147483648 9
prefix puts head message
out fold step p1 prefix
ret out
end
fn pure u32 -> u32
out add p0 1
ret out
end
fn identity io -> io
ret p0
end
`;
const HOST = {
  module: 'arena/λ',
  read: 'read/字',
  write: 'write/word',
  readPresent: 'read/present',
};

/** Ignore the compiler-version custom section; preserve every executable/layout byte. */
function standardHash(bytes: Uint8Array): string {
  const hash = createHash('sha256');
  hash.update(bytes.subarray(0, 8));
  for (let at = 8; at < bytes.length; ) {
    const start = at;
    const id = bytes[at++];
    let size = 0;
    let shift = 0;
    for (;;) {
      const byte = bytes[at++] as number;
      size |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    at += size;
    if (id !== 0) hash.update(bytes.subarray(start, at));
  }
  return hash.digest('hex');
}

test('direct Wasm buffered default retains its complete executable and layout bytes', () => {
  // Recorded from the pre-host-import backend, independently of the new assembly path.
  const expected = [
    '30508b8980d78d6249172c710bc8786acb9af7dcfed5a1c8d00c558a5a2df764',
    '44777f1f051d5337999521ec5adddd63d1b2d03d9939838fc5282c6a5e7441e8',
  ];
  for (const [i, strict] of [false, true].entries()) {
    const program = parseAndValidate(`${strict ? 'profile strict\n' : ''}${SOURCE}`);
    const bytes = wasmModuleBytes(compile(program, 'wasm').text);
    assert.equal(standardHash(bytes), expected[i]);
    assert.deepEqual(WebAssembly.Module.imports(new WebAssembly.Module(bytes as BufferSource)), []);
  }
});

for (const strict of [false, true])
  for (const optimize of [false, true])
    test(`direct Wasm host streams retain words, effect order and input traps: strict=${strict}, optimize=${optimize}`, async () => {
      const program = parseAndValidate(`${strict ? 'profile strict\n' : ''}${SOURCE}`);
      const fn = program.byName.get('exchange');
      assert.ok(fn);
      const bytes = wasmModuleBytes(
        compile(program, 'wasm', { optimize, wasmIo: HOST, wasmExports: ['exchange'] }).text,
      );
      const module = new WebAssembly.Module(bytes as BufferSource);
      assert.deepEqual(WebAssembly.Module.imports(module), [
        { module: HOST.module, name: HOST.read, kind: 'function' },
        { module: HOST.module, name: HOST.write, kind: 'function' },
        ...(strict ? [{ module: HOST.module, name: HOST.readPresent, kind: 'function' }] : []),
      ]);
      for (const input of [[], [0], [0, 0xffffffff, 0x80000000, 0x7fffffff]])
        for (const count of new Set([0, 1, input.length, input.length + 2])) {
          const reference = makeIo(input);
          let trap: Trap | undefined;
          try {
            assert.equal(run(fn, [reference, count], { fuel: 1e6 }), reference);
          } catch (error) {
            assert.ok(error instanceof A0Error && error.trap);
            trap = error.trap;
          }
          const token = 0xfedcba98;
          let position = 0;
          let present = false;
          const output: number[] = [];
          const events: unknown[] = [];
          const instance = new WebAssembly.Instance(module, {
            [HOST.module]: {
              [HOST.read]: (handle: number) => {
                assert.equal(handle >>> 0, token);
                present = position < input.length;
                const word = present ? (input[position++] as number) : 0;
                events.push(['read', word]);
                return word;
              },
              [HOST.write]: (handle: number, word: number) => {
                assert.equal(handle >>> 0, token);
                output.push(word >>> 0);
                events.push(['write', word >>> 0]);
              },
              [HOST.readPresent]: (handle: number) => {
                assert.equal(handle >>> 0, token);
                events.push(['present', present]);
                return present ? 1 : 0;
              },
            },
          });
          const exchange = instance.exports.a0_exchange as (token: number, count: number) => number;
          if (trap === undefined) assert.equal(exchange(token, count) >>> 0, token);
          else {
            assert.throws(() => exchange(token, count), WebAssembly.RuntimeError);
            const actual = wasmTrap(instance.exports);
            assert.ok(actual);
            assert.equal(formatTrap(actual), formatTrap(trap));
          }
          assert.deepEqual(output, reference.output);
          assert.equal(position, reference.position);
          const expectedEvents: unknown[] = [0xffffffff, 4, 0, 0xffffffff, 0x80000000, 9].map(
            (word) => ['write', word],
          );
          for (let i = 0; i < count; i++) {
            const available = i < input.length;
            const word = input[i] ?? 0;
            expectedEvents.push(['read', word]);
            if (strict) expectedEvents.push(['present', available]);
            if (strict && !available) break;
            expectedEvents.push(['write', word]);
          }
          assert.deepEqual(events, expectedEvents);
        }
    });

test('direct Wasm host imports follow exported reachability and strict presence requirements', () => {
  const program = parseAndValidate(`profile strict\n${SOURCE}`);
  const withoutPresence = { module: HOST.module, read: HOST.read, write: HOST.write };
  assert.throws(
    () => compile(program, 'wasm', { wasmIo: withoutPresence, wasmExports: ['exchange'] }),
    /readPresent for strict input/,
  );
  for (const name of ['pure', 'identity']) {
    const bytes = wasmModuleBytes(
      compile(program, 'wasm', { wasmIo: withoutPresence, wasmExports: [name] }).text,
    );
    const module = new WebAssembly.Module(bytes as BufferSource);
    assert.deepEqual(WebAssembly.Module.imports(module), []);
    const instance = new WebAssembly.Instance(module);
    const call = instance.exports[`a0_${name}`] as (value: number) => number;
    assert.equal(call(0xffffffff) >>> 0, name === 'pure' ? 0 : 0xffffffff);
    assert.equal(instance.exports.a0_exchange, undefined);
  }
  const identity = parseAndValidate('fn keep io -> io\nret p0\nend\n');
  const bytes = wasmModuleBytes(compile(identity, 'wasm', { wasmIo: HOST }).text);
  const module = new WebAssembly.Module(bytes as BufferSource);
  assert.deepEqual(
    WebAssembly.Module.imports(module),
    [],
    'unused helpers/imports are pruned without an explicit export list',
  );
  assert.equal(
    (new WebAssembly.Instance(module).exports.a0_keep as (token: number) => number)(0xfedcba98) >>>
      0,
    0xfedcba98,
  );
});

test('direct Wasm host import names and buffered layouts share cached function bodies', () => {
  for (const strict of [false, true]) {
    const program = parseAndValidate(`${strict ? 'profile strict\n' : ''}${SOURCE}`);
    for (const optimize of [false, true]) {
      const cache = new FunctionCache();
      const buffered = compile(program, 'wasm', { optimize }, cache);
      for (const wasmIo of [
        HOST,
        { module: 'different', read: 'a', write: 'b', readPresent: 'c' },
      ]) {
        const actual = compile(program, 'wasm', { optimize, wasmIo }, cache);
        assert.equal(actual.cacheHits, program.functions.length);
        assert.equal(actual.text, compile(program, 'wasm', { optimize, wasmIo }).text);
        assert.ok(new WebAssembly.Module(wasmModuleBytes(actual.text) as BufferSource));
      }
      assert.equal(compile(program, 'wasm', { optimize }, cache).text, buffered.text);
    }
  }
});

test('direct Wasm read-only and write-only exports retain their distinct import signatures', () => {
  const program = parseAndValidate(`profile strict
fn receive io -> (u32,io)
out read p0
ret out
end
fn send io -> io
out write p0 4294967295
ret out
end
`);
  const token = 0xfedcba98;
  const withoutPresence = { module: HOST.module, read: HOST.read, write: HOST.write };
  const writeBytes = wasmModuleBytes(
    compile(program, 'wasm', {
      wasmIo: withoutPresence,
      wasmExports: ['send'],
    }).text,
  );
  const writeModule = new WebAssembly.Module(writeBytes as BufferSource);
  assert.deepEqual(WebAssembly.Module.imports(writeModule), [
    { module: HOST.module, name: HOST.write, kind: 'function' },
  ]);
  const output: unknown[] = [];
  const writeInstance = new WebAssembly.Instance(writeModule, {
    [HOST.module]: {
      [HOST.write]: (handle: number, word: number) => output.push([handle >>> 0, word >>> 0]),
    },
  });
  assert.equal((writeInstance.exports.a0_send as (token: number) => number)(token) >>> 0, token);
  assert.deepEqual(output, [[token, 0xffffffff]]);
  const readBytes = wasmModuleBytes(
    compile(program, 'wasm', {
      wasmIo: HOST,
      wasmExports: ['receive'],
    }).text,
  );
  const readModule = new WebAssembly.Module(readBytes as BufferSource);
  assert.deepEqual(WebAssembly.Module.imports(readModule), [
    { module: HOST.module, name: HOST.read, kind: 'function' },
    { module: HOST.module, name: HOST.readPresent, kind: 'function' },
  ]);
  const calls: string[] = [];
  const readInstance = new WebAssembly.Instance(readModule, {
    [HOST.module]: {
      [HOST.read]: (handle: number) => {
        assert.equal(handle >>> 0, token);
        calls.push('read');
        return 0x80000000;
      },
      [HOST.readPresent]: (handle: number) => {
        assert.equal(handle >>> 0, token);
        calls.push('present');
        return 1;
      },
    },
  });
  const memory = readInstance.exports.memory as WebAssembly.Memory;
  const out = Number((readInstance.exports.__heap_base as WebAssembly.Global).value);
  if (out + 8 > memory.buffer.byteLength) memory.grow(1);
  (readInstance.exports.a0_receive as (out: number, token: number) => void)(out, token);
  const view = new DataView(memory.buffer);
  assert.equal(view.getUint32(out, true), 0x80000000);
  assert.equal(view.getUint32(out + 4, true), token);
  assert.deepEqual(calls, ['read', 'present']);
});

test('the unchanged A0 frontend links two generic host word imports through direct Wasm', async () => {
  const program = (await link('compiler/source_frontend.a0', (path) => readFile(path, 'utf8')))
    .program;
  const bytes = wasmModuleBytes(
    compile(program, 'wasm', {
      wasmIo: { module: 'arena', read: 'read', write: 'write' },
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
  const module = new WebAssembly.Module(bytes as BufferSource);
  assert.deepEqual(WebAssembly.Module.imports(module), [
    { module: 'arena', name: 'read', kind: 'function' },
    { module: 'arena', name: 'write', kind: 'function' },
  ]);
});
