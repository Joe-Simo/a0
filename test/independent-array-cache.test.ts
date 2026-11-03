import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { compile, emitFunction, FunctionCache, functionEmissionKey } from '../src/backends.js';
import { cacheKey, compileCached, DiskCache } from '../src/cache.js';
import { parseAndValidate, run } from '../src/core.js';

interface Fixture {
  provenance: { commit: string; compilerVersion: string };
  source: string;
  sourceSHA256: string;
  records: {
    name: string;
    descriptor: string;
    diskKey: string;
    body: string;
    bodySHA256: string;
  }[];
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const fixture = JSON.parse(
  await readFile('test/fixtures/independent-array/old82-emission.json', 'utf8'),
) as Fixture;
const program = parseAndValidate(fixture.source);
function check(text: string) {
  const module = new WebAssembly.Module(Buffer.from(text, 'base64'));
  const instance = new WebAssembly.Instance(module);
  const call = instance.exports.a0_mat4 as (a: number, b: number) => number;
  const reference = program.byName.get('mat4');
  assert.ok(reference);
  for (const args of [
    [0, 0],
    [7, 31],
    [0xffff_ffff, 0x8000_0000],
  ])
    assert.equal(call(args[0] ?? 0, args[1] ?? 0) >>> 0, run(reference, args));
}

test('independent array cache fixture captures the actual previous compiler', () => {
  assert.equal(fixture.provenance.commit, '9812428ed0fb8edccc1ff905ff5c4e4caab6a836');
  assert.equal(fixture.provenance.compilerVersion, 'a0c-0.1.82');
  assert.equal(hash(fixture.source), fixture.sourceSHA256);
  for (const record of fixture.records) {
    assert.equal(hash(record.body), record.bodySHA256);
    assert.equal(cacheKey(`emit|${record.descriptor}`), record.diskKey);
    const fn = program.byName.get(record.name);
    assert.ok(fn);
    assert.equal(
      functionEmissionKey('wasm', fn).replace(/^[^|]+/, fixture.provenance.compilerVersion),
      record.descriptor,
    );
    if (record.name === 'mat4') assert.notEqual(emitFunction('wasm', fn), record.body);
  }
});

test('independent array optimization rejects old in-memory cache entries', () => {
  const cache = new FunctionCache();
  for (const record of fixture.records) cache.set(record.descriptor, record.body);
  const cold = compile(program, 'wasm', {}, cache);
  assert.equal(cold.cacheHits, 0);
  assert.equal(cold.cacheMisses, program.functions.length);
  check(cold.text);
  const warm = compile(program, 'wasm', {}, cache);
  assert.equal(warm.cacheHits, program.functions.length);
  assert.equal(warm.text, cold.text);
});

test('independent array optimization rejects old persistent cache entries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'a0-independent-cache-'));
  try {
    const cache = new DiskCache(directory);
    for (const record of fixture.records) await cache.put(record.diskKey, record.body);
    const cold = await compileCached(program, 'wasm', cache);
    assert.equal(cold.hits, 0);
    assert.equal(cold.misses, program.functions.length);
    check(cold.text);
    const warm = await compileCached(program, 'wasm', cache);
    assert.equal(warm.hits, program.functions.length);
    assert.equal(warm.text, cold.text);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
