import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  assemble,
  type CompileOptions,
  compile,
  emitFunction,
  FunctionCache,
} from '../src/backends.js';
import {
  A0Error,
  formatTrap,
  makeIo,
  parseAndValidate,
  run,
  type TypedProgram,
  type Value,
} from '../src/core.js';
import type { Trap } from '../src/diagnostics.js';
import { wasmTrap } from '../tools/verify.js';

type Kind = 'exact' | 'computed' | 'effect' | 'extra-param';
const HOST = { module: 'words', read: 'next', write: 'send', readPresent: 'present' };
const INPUT = 7,
  OUTPUT = 3,
  GUARD = 0x735a901f;

function source(length: number, swapped: boolean, kind: Kind = 'exact'): string {
  const type = swapped ? `(io,u32x${length})` : `(u32x${length},io)`;
  const record = (array: string, token: string) =>
    swapped ? `${token} ${array}` : `${array} ${token}`;
  const extra = kind === 'extra-param' ? ' 9' : '';
  return `fn receive ${type} u32${kind === 'extra-param' ? ' u32' : ''} -> ${type}
array at p0 ${swapped ? 1 : 0}
token at p0 ${swapped ? 0 : 1}
input read token
word at input 0
next at input 1
${kind === 'computed' ? 'value xor word 2779096485\n' : ''}${kind === 'effect' ? 'sent write next word\n' : ''}changed set array p1 ${kind === 'computed' ? 'value' : 'word'}
out rec ${record('changed', kind === 'effect' ? 'sent' : 'next')}
ret out
end
fn collect u32x${length} io u32 -> ${type}
initial rec ${record('p0', 'p1')}
out fold receive p2 initial${extra}
ret out
end
fn preserve u32x${length} io u32 -> (${type},u32x${length})
initial rec ${record('p0', 'p1')}
saved at initial ${swapped ? 1 : 0}
changed fold receive p2 initial${extra}
out rec changed saved
ret out
end
fn state ${type} u32 -> ${type}
out fold receive p1 p0${extra}
ret out
end
fn again ${type} u32 u32 -> ${type}
out fold receive p2 p0${extra}
ret out
end
fn nested u32x${length} io u32 -> ${type}
initial rec ${record('p0', 'p1')}
out fold again 2 initial p2
ret out
end
`;
}

function calls(program: TypedProgram, name: string, options: CompileOptions): string[] {
  const fn = program.byName.get(name);
  assert.ok(fn);
  const record = JSON.parse(emitFunction('wasm', fn, options)) as {
    variants: { code: (string | { call?: string })[] }[];
  };
  return record.variants.flatMap((variant) =>
    variant.code.flatMap((part) =>
      typeof part === 'object' && part.call !== undefined ? [part.call] : [],
    ),
  );
}

function check(
  program: TypedProgram,
  module: WebAssembly.Module,
  length: number,
  swapped: boolean,
  host: boolean,
  name: 'collect' | 'preserve' | 'state' | 'nested',
  count: number,
  input: readonly number[],
): void {
  const original = Array.from(
    { length },
    (_, index) => (0x9955aaee ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0,
  );
  const effectiveInput = host ? input : input.slice(0, INPUT);
  const io = makeIo(effectiveInput);
  const referenceState: Value = swapped ? [io, original] : [original, io];
  const fn = program.byName.get(name);
  assert.ok(fn);
  let expected: Value | undefined, trap: Trap | undefined;
  try {
    expected = run(fn, name === 'state' ? [referenceState, count] : [original, io, count], {
      fuel: 1e6,
    });
  } catch (error) {
    assert.ok(error instanceof A0Error && error.trap);
    trap = error.trap;
  }
  const events: unknown[][] = [],
    output: number[] = [];
  let position = 0,
    present = false;
  const token = host ? 0xfedcba98 : 0;
  const instance = new WebAssembly.Instance(
    module,
    host
      ? {
          [HOST.module]: {
            [HOST.read]: (handle: number) => {
              assert.equal(handle >>> 0, token);
              present = position < input.length;
              const word = present ? (input[position++] as number) : 0;
              events.push(['read', word]);
              return word;
            },
            [HOST.readPresent]: (handle: number) => {
              assert.equal(handle >>> 0, token);
              events.push(['present', present]);
              return Number(present);
            },
            [HOST.write]: (handle: number, word: number) => {
              assert.equal(handle >>> 0, token);
              output.push(word >>> 0);
              events.push(['write', word >>> 0]);
            },
          },
        }
      : {},
  );
  const memory = instance.exports.memory as WebAssembly.Memory;
  const heap = Number((instance.exports.__heap_base as WebAssembly.Global).value);
  const end = heap + 4096;
  if (memory.buffer.byteLength < end)
    memory.grow(Math.ceil((end - memory.buffer.byteLength) / 65536));
  const view = new DataView(memory.buffer);
  const array = heap + 64,
    initial = heap + 512,
    result = heap + 1024,
    stream = heap + 2048;
  const ioToken = host ? token : stream;
  const arrayOffset = swapped ? 4 : 0,
    tokenOffset = swapped ? 0 : length * 4;
  const resultWords = length + 1 + (name === 'preserve' ? length : 0);
  const put = (at: number, word: number) => view.setUint32(at, word, true);
  const get = (at: number) => view.getUint32(at, true);
  for (let at = heap; at < end; at += 4) put(at, GUARD);
  for (const [index, word] of original.entries()) {
    put(array + index * 4, word);
    put(initial + arrayOffset + index * 4, word);
  }
  put(initial + tokenOffset, ioToken);
  for (let index = 0; index < INPUT; index++) put(stream + index * 4, input[index] ?? GUARD);
  put(stream + INPUT * 4, input.length);
  put(stream + (INPUT + 1) * 4, 0);
  put(stream + (INPUT + 2 + OUTPUT) * 4, 0);
  const snapshot = (at: number, words: number) =>
    Array.from({ length: words }, (_, index) => get(at + index * 4));
  const sourceSnapshot = snapshot(array - 4, length + 2);
  const stateSnapshot = snapshot(initial - 4, length + 3);
  const inputSnapshot = snapshot(stream - 4, INPUT + 2);
  const call = instance.exports[`a0_${name}`] as (...args: number[]) => void;
  if (trap === undefined) {
    call(...(name === 'state' ? [result, initial, count] : [result, array, ioToken, count]));
    assert.ok(expected);
    const state = name === 'preserve' ? (expected as readonly Value[])[0] : expected;
    assert.deepEqual(
      snapshot(result + arrayOffset, length),
      (state as readonly Value[])[swapped ? 1 : 0],
    );
    assert.equal(get(result + tokenOffset), ioToken);
    if (name === 'preserve')
      assert.deepEqual(
        snapshot(result + (length + 1) * 4, length),
        (expected as readonly Value[])[1],
      );
  } else {
    assert.throws(
      () =>
        call(...(name === 'state' ? [result, initial, count] : [result, array, ioToken, count])),
      WebAssembly.RuntimeError,
    );
    const actual = wasmTrap(instance.exports);
    assert.ok(actual);
    assert.equal(formatTrap(actual), formatTrap(trap));
  }
  assert.equal(get(result - 4), GUARD);
  assert.equal(get(result + resultWords * 4), GUARD);
  assert.deepEqual(snapshot(array - 4, length + 2), sourceSnapshot, 'borrowed input array changed');
  assert.deepEqual(
    snapshot(initial - 4, length + 3),
    stateSnapshot,
    'borrowed input record changed',
  );
  assert.deepEqual(snapshot(stream - 4, INPUT + 2), inputSnapshot, 'IO input or canaries changed');
  if (host) {
    assert.equal(position, io.position);
    assert.deepEqual(output, io.output);
    if (trap === undefined) {
      const attempts = count * (name === 'nested' ? 2 : 1);
      assert.equal(events.filter((event) => event[0] === 'read').length, attempts);
    }
  } else {
    assert.equal(get(stream + (INPUT + 1) * 4), io.position);
    const outputLength = Math.min(OUTPUT, io.output.length);
    assert.equal(get(stream + (INPUT + 2 + OUTPUT) * 4), outputLength);
    assert.deepEqual(snapshot(stream + (INPUT + 2) * 4, outputLength), io.output.slice(0, OUTPUT));
  }
}

test('read-array folds preserve values, ownership, wrapping and EOF across layouts', () => {
  for (const length of [1, 3, 4, 17])
    for (const swapped of [false, true]) {
      const program = parseAndValidate(source(length, swapped));
      const counts = [...new Set([0, 1, length - 1, length, length + 1, length * 2 + 3])];
      const words = Array.from(
        { length: length * 3 + 5 },
        (_, index) => [0, 0xffffffff, 0x80000000, 1, 0x7fffffff][index % 5] as number,
      );
      for (const optimize of [false, true])
        for (const wasmSimd of [false, true])
          for (const host of [false, true]) {
            const options: CompileOptions = {
              optimize,
              wasmSimd,
              ioInputCapacity: INPUT,
              ioOutputCapacity: OUTPUT,
              wasmExports: ['collect', 'preserve', 'state', 'nested'],
              ...(host ? { wasmIo: HOST } : {}),
            };
            for (const name of ['collect', 'preserve', 'state', 'again']) {
              const emitted = calls(program, name, options);
              assert.ok(emitted.includes('a0o_receive'));
              assert.ok(!emitted.includes('io:read'));
            }
            const module = new WebAssembly.Module(
              Buffer.from(compile(program, 'wasm', options).text, 'base64'),
            );
            for (const name of ['collect', 'preserve', 'state', 'nested'] as const)
              for (const count of counts)
                for (const input of [[], words.slice(0, Math.max(1, length - 1)), words])
                  check(program, module, length, swapped, host, name, count, input);
          }
    }
});

test('extra/computed callbacks retain their calls and independent effects', () => {
  for (const kind of ['computed', 'effect', 'extra-param'] as const)
    for (const optimize of [false, true]) {
      const program = parseAndValidate(source(3, false, kind));
      for (const host of [false, true]) {
        const options: CompileOptions = {
          optimize,
          wasmExports: ['collect'],
          ioInputCapacity: INPUT,
          ioOutputCapacity: OUTPUT,
          ...(host ? { wasmIo: HOST } : {}),
        };
        assert.ok(calls(program, 'collect', options).includes('a0o_receive'));
        const module = new WebAssembly.Module(
          Buffer.from(compile(program, 'wasm', options).text, 'base64'),
        );
        for (const count of [0, 1, 3, 8])
          check(program, module, 3, false, host, 'collect', count, [0, 0xffffffff, 9, 0x80000000]);
      }
    }
});

test('read-array callbacks preserve effects across names and pure projection order', () => {
  const reordered = source(3, true)
    .replace(
      'array at p0 1\ntoken at p0 0\ninput read token\nword at input 0\nnext at input 1',
      'token at p0 0\ninput read token\nnext at input 1\narray at p0 1\nword at input 0',
    )
    .replaceAll('receive', 'gather')
    .replaceAll('array', 'buffer')
    .replaceAll('token', 'channel')
    .replaceAll('input', 'packet');
  const program = parseAndValidate(reordered);
  for (const optimize of [false, true])
    for (const host of [false, true]) {
      const options: CompileOptions = {
        optimize,
        wasmExports: ['collect'],
        ioInputCapacity: INPUT,
        ioOutputCapacity: OUTPUT,
        ...(host ? { wasmIo: HOST } : {}),
      };
      const emitted = calls(program, 'collect', options);
      assert.ok(emitted.includes('a0o_gather'));
      assert.ok(!emitted.includes('io:read'));
      const module = new WebAssembly.Module(
        Buffer.from(compile(program, 'wasm', options).text, 'base64'),
      );
      for (const count of [0, 2, 8])
        check(program, module, 3, true, host, 'collect', count, [0, 0xffffffff, 0x80000000, 7]);
    }
});

test('strict folds retain pre-change emission, callback frames and precise input/bounds traps', () => {
  const program = parseAndValidate(`profile strict\n${source(3, false)}`);
  // Recorded from the pre-change backend; emission records carry no compiler-version banner.
  const recorded = [
    'd43a7ac70e9cd4dfab1b574c9ca6d72a6d2c20372a41952f50a8c3344825e1b7',
    'd43a7ac70e9cd4dfab1b574c9ca6d72a6d2c20372a41952f50a8c3344825e1b7',
  ];
  for (const [index, optimize] of [false, true].entries()) {
    const fn = program.byName.get('collect');
    assert.ok(fn);
    assert.equal(
      createHash('sha256')
        .update(emitFunction('wasm', fn, { optimize }))
        .digest('hex'),
      recorded[index],
    );
    for (const host of [false, true]) {
      const options: CompileOptions = {
        optimize,
        wasmExports: ['collect', 'nested'],
        ioInputCapacity: INPUT,
        ioOutputCapacity: OUTPUT,
        ...(host ? { wasmIo: HOST } : {}),
      };
      assert.ok(calls(program, 'collect', options).includes('a0o_receive'));
      const module = new WebAssembly.Module(
        Buffer.from(compile(program, 'wasm', options).text, 'base64'),
      );
      for (const name of ['collect', 'nested'] as const)
        for (const [count, input] of [
          [0, []],
          [2, [0, 1]],
          [1, []],
          [3, [7]],
          [4, [1, 2, 3, 4, 5]],
        ] as const)
          check(program, module, 3, false, host, name, count, input);
    }
  }
});

test('read-array fold bodies round-trip through the ordinary function cache', () => {
  const program = parseAndValidate(source(4, true));
  for (const optimize of [false, true]) {
    const options: CompileOptions = { optimize, wasmExports: ['collect'], wasmIo: HOST };
    const cache = new FunctionCache();
    const first = compile(program, 'wasm', options, cache);
    assert.equal(first.cacheMisses, program.functions.length);
    const second = compile(program, 'wasm', options, cache);
    assert.equal(second.cacheHits, program.functions.length);
    assert.equal(second.text, first.text);
    assert.equal(second.text, compile(program, 'wasm', options).text);
    const module = new WebAssembly.Module(Buffer.from(second.text, 'base64'));
    check(program, module, 4, true, true, 'collect', 11, [0xffffffff, 0, 0x80000000, 7]);
  }
});

test('literal zero folds preserve complete pre-change bytes and import pruning for every layout', async () => {
  const fixture = JSON.parse(
    await readFile('test/fixtures/wasm-read-array-zero/old-emission.json', 'utf8'),
  ) as {
    source: string;
    records: Record<string, string[]>;
    variants: { optimize: boolean; wasmSimd: boolean; wasmUnroll: 1 | 2 | 4; sha256: string }[];
  };
  const program = parseAndValidate(fixture.source);
  for (const variant of fixture.variants) {
    const oldBodies = fixture.records[variant.sha256];
    assert.ok(oldBodies);
    assert.equal(
      createHash('sha256').update(JSON.stringify(oldBodies)).digest('hex'),
      variant.sha256,
    );
    for (const host of [false, true])
      for (const wasmExports of [undefined, ['collect'], []])
        for (const wasmDebugNames of [false, true])
          for (const capacity of [3, 17]) {
            const options: CompileOptions = {
              optimize: variant.optimize,
              wasmSimd: variant.wasmSimd,
              wasmUnroll: variant.wasmUnroll,
              wasmDebugNames,
              ioInputCapacity: capacity,
              ioOutputCapacity: capacity,
              ...(host ? { wasmIo: HOST } : {}),
              ...(wasmExports === undefined ? {} : { wasmExports }),
            };
            // The retained, independent old emission records pass through the same assembler/version.
            // Thus this compares every module byte without exempting any debug/version metadata.
            const expected = assemble('wasm', oldBodies, program, options);
            const actual = compile(program, 'wasm', options).text;
            assert.equal(actual, expected);
            const module = new WebAssembly.Module(Buffer.from(actual, 'base64'));
            if (wasmExports !== undefined) {
              assert.deepEqual(WebAssembly.Module.imports(module), []);
              new WebAssembly.Instance(module);
            }
          }
  }
});

test('high unsigned read-fold counts reach the third host read and propagate its exception', () => {
  for (const length of [3, 4])
    for (const swapped of [false, true]) {
      const program = parseAndValidate(source(length, swapped));
      const fn = program.byName.get('collect');
      assert.ok(fn);
      for (const count of [0x80000000, 0xffffffff]) {
        const stop = new Error('stop on third read');
        const referenceReads: number[] = [];
        const input = new Proxy([0xffffffff, 0x80000000, 0], {
          get(target, key, receiver) {
            if (key === '0' || key === '1' || key === '2') {
              referenceReads.push(Number(key));
              if (key === '2') throw stop;
            }
            return Reflect.get(target, key, receiver);
          },
        });
        const original = Array.from({ length }, (_, index) => index + 17);
        const io = makeIo(input);
        assert.throws(
          () => run(fn, [original, io, count], { fuel: 1e5 }),
          (error) => error === stop,
        );
        assert.deepEqual(referenceReads, [0, 1, 2]);
        assert.equal(io.position, 2, 'the reference must stop during its third runtime read');
        for (const optimize of [false, true])
          for (const wasmSimd of [false, true]) {
            let attempts = 0;
            const module = new WebAssembly.Module(
              Buffer.from(
                compile(program, 'wasm', {
                  optimize,
                  wasmSimd,
                  wasmIo: HOST,
                  wasmExports: ['collect'],
                }).text,
                'base64',
              ),
            );
            const token = 0x89abcdef;
            const instance = new WebAssembly.Instance(module, {
              [HOST.module]: {
                [HOST.read]: (handle: number) => {
                  assert.equal(handle >>> 0, token);
                  if (++attempts === 3) throw stop;
                  return attempts === 1 ? -1 : 0x80000000;
                },
              },
            });
            const memory = instance.exports.memory as WebAssembly.Memory;
            const heap = Number((instance.exports.__heap_base as WebAssembly.Global).value);
            if (memory.buffer.byteLength < heap + 1024) memory.grow(1);
            const view = new DataView(memory.buffer),
              array = heap + 64,
              result = heap + 256;
            for (let at = heap; at < heap + 1024; at += 4) view.setUint32(at, GUARD, true);
            for (const [index, word] of original.entries())
              view.setUint32(array + index * 4, word, true);
            const call = instance.exports.a0_collect as (
              out: number,
              array: number,
              token: number,
              count: number,
            ) => void;
            assert.throws(
              () => call(result, array, token, count),
              (error) => error === stop,
            );
            assert.equal(attempts, 3);
            assert.deepEqual(
              Array.from({ length }, (_, index) => view.getUint32(array + index * 4, true)),
              original,
            );
            for (const at of [array - 4, array + length * 4, result - 4, result + (length + 1) * 4])
              assert.equal(view.getUint32(at, true), GUARD);
          }
      }
    }
});
