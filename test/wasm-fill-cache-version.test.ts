import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  assemble,
  type CompileOptions,
  compile,
  emitFunction,
  FunctionCache,
  functionEmissionKey,
} from '../src/backends.js';
import { cacheKey, compileCached, DiskCache } from '../src/cache.js';
import { parseAndValidate } from '../src/core.js';

interface OldEmission {
  readonly provenance: {
    readonly commit: string;
    readonly compilerVersion: string;
    readonly target: string;
  };
  readonly source: string;
  readonly sourceSHA256: string;
  readonly records: readonly {
    readonly name: string;
    readonly descriptor: string;
    readonly diskKey: string;
    readonly bodySHA256: string;
    readonly body: string;
  }[];
}
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const fixture = JSON.parse(
  await readFile('test/fixtures/wasm-fill-cache/old-emission.json', 'utf8'),
) as OldEmission;
const program = parseAndValidate(fixture.source);
const zeroFixture = JSON.parse(
  await readFile('test/fixtures/wasm-read-array-zero/old65-emission.json', 'utf8'),
) as OldEmission;
const zeroProgram = parseAndValidate(zeroFixture.source);
const zeroOptions: CompileOptions = {
  wasmIo: { module: 'words', read: 'next', write: 'send' },
  wasmExports: ['collect'],
};
const fusedFixture = JSON.parse(
  await readFile('test/fixtures/wasm-read-array-cache/old66-emission.json', 'utf8'),
) as OldEmission;
const fusedProgram = parseAndValidate(fusedFixture.source);
const fusedOptions: CompileOptions = {
  ioInputCapacity: 7,
  ioOutputCapacity: 3,
  wasmExports: ['collect'],
};

function emittedCalls(body: string): string[] {
  const record = JSON.parse(body) as {
    variants: { code: (string | { call?: string })[] }[];
  };
  return record.variants.flatMap((variant) =>
    variant.code.flatMap((part) =>
      typeof part === 'object' && part.call !== undefined ? [part.call] : [],
    ),
  );
}

/** Independent wrap/EOF oracle, full-width words and borrowed/IO/result canaries. */
function checkReadFoldExecution(text: string): void {
  const module = new WebAssembly.Module(Buffer.from(text, 'base64'));
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  for (const input of [[], [0xffffffff], [0xffffffff, 0x80000000, 7]])
    for (const count of [0, 1, 2, 3, 4, 9]) {
      const instance = new WebAssembly.Instance(module);
      const memory = instance.exports.memory as WebAssembly.Memory;
      const heap = Number((instance.exports.__heap_base as WebAssembly.Global).value);
      if (heap + 1024 > memory.buffer.byteLength) memory.grow(1);
      const view = new DataView(memory.buffer);
      const result = heap + 64,
        array = heap + 256,
        stream = heap + 512,
        guard = 0x735a901f;
      const put = (at: number, value: number) => view.setUint32(at, value, true);
      const get = (at: number) => view.getUint32(at, true);
      const snapshot = (at: number, length: number) =>
        Array.from({ length }, (_, index) => get(at + index * 4));
      for (let at = heap; at < heap + 1024; at += 4) put(at, guard);
      const original = [9, 10, 11];
      for (const [index, word] of original.entries()) put(array + index * 4, word);
      for (const [index, word] of input.entries()) put(stream + index * 4, word);
      put(stream + 7 * 4, input.length);
      put(stream + 8 * 4, 0);
      put(stream + 12 * 4, 0);
      const sourceBefore = snapshot(array - 4, 5),
        inputBefore = snapshot(stream - 4, 9);
      const expected = [...original];
      for (let trip = 0; trip < count; trip++) expected[trip % 3] = input[trip] ?? 0;
      const collect = instance.exports.a0_collect as (...args: number[]) => void;
      collect(result, array, stream, count);
      assert.deepEqual(snapshot(result, 4), [...expected, stream]);
      assert.deepEqual(snapshot(array - 4, 5), sourceBefore, 'borrowed array changed');
      assert.deepEqual(snapshot(stream - 4, 9), inputBefore, 'IO input changed');
      assert.equal(get(stream + 8 * 4), Math.min(count, input.length));
      assert.deepEqual(snapshot(stream + 9 * 4, 3), [guard, guard, guard]);
      assert.equal(get(stream + 12 * 4), 0);
      for (const at of [result - 4, result + 16, stream + 13 * 4]) assert.equal(get(at), guard);
    }
}

function checkZeroExecution(text: string): void {
  const module = new WebAssembly.Module(Buffer.from(text, 'base64'));
  assert.deepEqual(
    WebAssembly.Module.imports(module),
    [],
    'stale zero-fold body requires an unused host capability',
  );
  const instance = new WebAssembly.Instance(module);
  const memory = instance.exports.memory as WebAssembly.Memory;
  const heap = Number((instance.exports.__heap_base as WebAssembly.Global).value);
  if (heap + 256 > memory.buffer.byteLength) memory.grow(1);
  const view = new DataView(memory.buffer),
    input = heap + 128;
  for (const [index, word] of [7, 0xffffffff, 0x80000000].entries())
    view.setUint32(input + index * 4, word, true);
  const collect = instance.exports.a0_collect as (
    out: number,
    input: number,
    token: number,
    ignored: number,
  ) => void;
  collect(heap, input, 0x89abcdef, 0xffffffff);
  assert.deepEqual(
    Array.from({ length: 4 }, (_, index) => view.getUint32(heap + index * 4, true)),
    [7, 0xffffffff, 0x80000000, 0x89abcdef],
  );
  assert.deepEqual(
    Array.from({ length: 3 }, (_, index) => view.getUint32(input + index * 4, true)),
    [7, 0xffffffff, 0x80000000],
  );
}

/** Execute the corrected code, including full-width words and untouched input storage. */
function checkExecution(text: string): void {
  const bytes = Buffer.from(text, 'base64');
  assert.ok(WebAssembly.validate(bytes), 'an old invalid SIMD body escaped cache invalidation');
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes));
  const memory = instance.exports.memory as WebAssembly.Memory;
  const heap = Number((instance.exports.__heap_base as WebAssembly.Global).value);
  const input = heap + 128;
  if (input + 17 * 4 > memory.buffer.byteLength) memory.grow(1);
  const view = new DataView(memory.buffer);
  const original = Array.from({ length: 17 }, (_, index) => (0xa917e25d ^ index) >>> 0);
  for (const [index, value] of original.entries()) view.setUint32(input + index * 4, value, true);
  const fill = instance.exports.a0_fill as (out: number, input: number, value: number) => void;
  for (const word of [0, 0x80000000, 0xffffffff]) {
    fill(heap, input, word);
    assert.deepEqual(
      Array.from({ length: 17 }, (_, index) => view.getUint32(heap + index * 4, true)),
      Array<number>(17).fill(word),
    );
    assert.deepEqual(
      Array.from({ length: 17 }, (_, index) => view.getUint32(input + index * 4, true)),
      original,
    );
  }
}

test('the retained pre-fix emission records reproduce the invalid SIMD fill', () => {
  assert.equal(fixture.provenance.commit, '768375accc9949f00c069a71bf3b9ff7af717704');
  assert.equal(fixture.provenance.compilerVersion, 'a0c-0.1.63');
  assert.equal(fixture.provenance.target, 'wasm');
  assert.equal(hash(fixture.source), fixture.sourceSHA256);
  assert.deepEqual(
    fixture.records.map((record) => record.name),
    program.functions.map((fn) => fn.name),
  );
  for (const record of fixture.records) {
    assert.equal(hash(record.body), record.bodySHA256);
    assert.equal(cacheKey(`emit|${record.descriptor}`), record.diskKey);
  }
  const text = assemble(
    'wasm',
    fixture.records.map((record) => record.body),
    program,
  );
  assert.equal(WebAssembly.validate(Buffer.from(text, 'base64')), false);
});

test('the retained65 zero-loop body reproduces an unintended host read import', () => {
  assert.equal(zeroFixture.provenance.compilerVersion, 'a0c-0.1.65');
  assert.equal(hash(zeroFixture.source), zeroFixture.sourceSHA256);
  for (const record of zeroFixture.records) {
    assert.equal(hash(record.body), record.bodySHA256);
    assert.equal(cacheKey(`emit|${record.descriptor}`), record.diskKey);
  }
  const text = assemble(
    'wasm',
    zeroFixture.records.map((record) => record.body),
    zeroProgram,
    zeroOptions,
  );
  const module = new WebAssembly.Module(Buffer.from(text, 'base64'));
  assert.deepEqual(WebAssembly.Module.imports(module), [
    { module: 'words', name: 'next', kind: 'function' },
  ]);
  assert.throws(() => new WebAssembly.Instance(module), TypeError);
});

test('retained66 records reproduce fusion and a current-key cache control really reuses them', () => {
  assert.equal(fusedFixture.provenance.commit, '0ecbfaf0e5f5b66cdabc7ee077e6f4c599844ae1');
  assert.equal(fusedFixture.provenance.compilerVersion, 'a0c-0.1.66');
  assert.equal(hash(fusedFixture.source), fusedFixture.sourceSHA256);
  assert.deepEqual(
    fusedFixture.records.map((record) => record.name),
    fusedProgram.functions.map((fn) => fn.name),
  );
  const currentKeyControl = new FunctionCache();
  for (const record of fusedFixture.records) {
    assert.equal(hash(record.body), record.bodySHA256);
    assert.equal(cacheKey(`emit|${record.descriptor}`), record.diskKey);
    const fn = fusedProgram.byName.get(record.name);
    assert.ok(fn);
    const currentKey = functionEmissionKey('wasm', fn, fusedOptions);
    // Exact captured descriptors share the unchanged semantic/options suffix, only version differs.
    assert.equal(
      currentKey.replace(/^[^|]+/, fusedFixture.provenance.compilerVersion),
      record.descriptor,
    );
    currentKeyControl.set(currentKey, record.body);
    if (record.name === 'collect') {
      assert.ok(emittedCalls(record.body).includes('io:read'));
      assert.ok(!emittedCalls(record.body).includes('a0o_receive'));
      const freshCalls = emittedCalls(emitFunction('wasm', fn, fusedOptions));
      assert.ok(freshCalls.includes('a0o_receive'));
      assert.ok(!freshCalls.includes('io:read'));
    }
  }
  const retained = assemble(
    'wasm',
    fusedFixture.records.map((record) => record.body),
    fusedProgram,
    fusedOptions,
  );
  const reused = compile(fusedProgram, 'wasm', fusedOptions, currentKeyControl);
  assert.equal(reused.cacheHits, fusedProgram.functions.length);
  assert.equal(reused.cacheMisses, 0);
  assert.equal(reused.text, retained);
  assert.notEqual(reused.text, compile(fusedProgram, 'wasm', fusedOptions).text);
  checkReadFoldExecution(reused.text);
});

for (const control of [
  { name: 'SIMD fill', fixture, program, options: {}, check: checkExecution },
  {
    name: 'literal-zero read fold',
    fixture: zeroFixture,
    program: zeroProgram,
    options: zeroOptions,
    check: checkZeroExecution,
  },
  {
    name: 'read-array default',
    fixture: fusedFixture,
    program: fusedProgram,
    options: fusedOptions,
    check: checkReadFoldExecution,
  },
]) {
  test(`${control.name} fix rejects pre-fix in-memory emission cache entries`, () => {
    const cache = new FunctionCache();
    for (const record of control.fixture.records) cache.set(record.descriptor, record.body);
    const result = compile(control.program, 'wasm', control.options, cache);
    control.check(result.text);
    assert.equal(result.cacheHits, 0);
    assert.equal(result.cacheMisses, control.program.functions.length);
    assert.equal(result.text, compile(control.program, 'wasm', control.options).text);
    const warm = compile(control.program, 'wasm', control.options, cache);
    assert.equal(warm.cacheHits, control.program.functions.length);
    assert.equal(warm.cacheMisses, 0);
    assert.equal(warm.text, result.text);
  });

  test(`${control.name} fix rejects persisted pre-fix emission cache entries`, async () => {
    const scratch = join(process.cwd(), '.a0-tmp');
    await mkdir(scratch, { recursive: true });
    const directory = await mkdtemp(join(scratch, 'wasm-fill-cache-'));
    try {
      const previous = new DiskCache(directory);
      for (const record of control.fixture.records) await previous.put(record.diskKey, record.body);
      const cache = new DiskCache(directory);
      const result = await compileCached(control.program, 'wasm', cache, control.options);
      control.check(result.text);
      assert.equal(result.hits, 0);
      assert.equal(result.misses, control.program.functions.length);
      assert.equal(result.text, compile(control.program, 'wasm', control.options).text);
      const warm = await compileCached(
        control.program,
        'wasm',
        new DiskCache(directory),
        control.options,
      );
      assert.equal(warm.hits, control.program.functions.length);
      assert.equal(warm.misses, 0);
      assert.equal(warm.text, result.text);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
