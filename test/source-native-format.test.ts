import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { nativeSource } from '../src/source-native.js';
import { nativeSourceFormatter } from '../src/source-native-format.js';

const module = new WebAssembly.Module(await readFile('seed/source-frontend/frontend.wasm'));
const simple = 'fn identity\nret A\nend\n';

test('optional formatting remains lazy without live ports and enforces private result ownership', () => {
  let loads = 0;
  const plain = nativeSource(module);
  const engine = nativeSource(module, undefined, {
    load() {
      loads++;
      throw new Error('must stay lazy');
    },
  });
  const peer = nativeSource(module, undefined, {
    load() {
      throw new Error('must stay lazy');
    },
  });
  try {
    const beforeMemory = engine.memoryBytes;
    const first = engine.parse(simple);
    assert.ok(first.ok);
    const parsedMemory = engine.memoryBytes;
    assert.deepEqual(engine.format(first), { ok: false, reason: 'unavailable' });
    assert.deepEqual(engine.revision(first), { ok: false, reason: 'unavailable' });
    assert.equal(engine.memoryBytes, parsedMemory, 'no companion memory loaded');
    assert.ok(parsedMemory >= beforeMemory);
    assert.deepEqual(plain.format(plain.parse(simple)), { ok: false, reason: 'unavailable' });
    assert.throws(() => engine.format({ ...first }), /current result owned/);
    assert.throws(() => peer.revision(first), /current result owned/);
    const later = engine.parse(simple);
    assert.ok(later.ok);
    assert.throws(() => engine.format(first), /current result owned/);
    assert.throws(() => engine.revision(first), /current result owned/);
    engine.close();
    assert.throws(() => engine.format(later), /closed/);
    assert.equal(loads, 0);
  } finally {
    plain.close();
    engine.close();
    peer.close();
  }
});

test('formatter capability validates transport-only requests without loading a missing arena', () => {
  let loads = 0;
  const ports = {
    memory: new WebAssembly.Memory({ initial: 1 }),
    a0_runtime_read() {
      throw new Error('no IO');
    },
    a0_runtime_write() {
      throw new Error('no IO');
    },
    frontend_arena_token: () => 0,
    frontend_view: () => 0,
    frontend_view_length: () => 0,
  };
  const load = () => {
    loads++;
    return module;
  };
  const formatter = nativeSourceFormatter(ports, { load });
  const page = new Uint32Array(128);
  assert.deepEqual(formatter.format(page, page), { ok: false, reason: 'no-arena' });
  assert.deepEqual(formatter.revision(page, page), { ok: false, reason: 'no-arena' });
  for (const functionIndex of [-1, 0.5, NaN, Infinity, 0x1_0000_0000]) {
    assert.throws(() => formatter.format(page, page, { functionIndex }), /function index/);
    assert.throws(() => formatter.revision(page, page, { functionIndex }), /function index/);
  }
  assert.equal(loads, 0);
  const live = nativeSourceFormatter({ ...ports, frontend_arena_token: () => 1 }, { load });
  assert.throws(() => live.format(page, page), /component imports/);
  assert.equal(loads, 1);
});
