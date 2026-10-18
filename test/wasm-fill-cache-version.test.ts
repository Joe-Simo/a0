import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { assemble, compile, FunctionCache } from '../src/backends.js';
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

test('the SIMD fill fix rejects pre-fix in-memory emission cache entries', () => {
  const cache = new FunctionCache();
  for (const record of fixture.records) cache.set(record.descriptor, record.body);
  const result = compile(program, 'wasm', {}, cache);
  checkExecution(result.text);
  assert.equal(result.cacheHits, 0);
  assert.equal(result.cacheMisses, program.functions.length);
});

test('the SIMD fill fix rejects persisted pre-fix emission cache entries', async () => {
  const scratch = join(process.cwd(), '.a0-tmp');
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, 'wasm-fill-cache-'));
  try {
    const previous = new DiskCache(directory);
    for (const record of fixture.records) await previous.put(record.diskKey, record.body);
    const cache = new DiskCache(directory);
    const result = await compileCached(program, 'wasm', cache);
    checkExecution(result.text);
    assert.equal(result.hits, 0);
    assert.equal(result.misses, program.functions.length);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
