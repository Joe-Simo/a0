import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { nativeSource } from '../src/source-native.js';
import { nativeDiagnosticRenderer } from '../src/source-native-render.js';

const module = new WebAssembly.Module(await readFile('seed/source-frontend/frontend.wasm'));
const simple = 'fn identity\nret A\nend\n';

test('optional diagnostics preserve ABI3 success and raw failures without legacy ports', () => {
  let loads = 0;
  const plain = nativeSource(module),
    optional = nativeSource(module, {
      load: () => {
        loads++;
        throw new Error('must stay lazy');
      },
    });
  try {
    assert.ok(optional.parse(simple).ok);
    for (const source of ['fn f\nret missing\nend\n', 'fn f\nend\n']) {
      const expected = plain.parse(source),
        actual = optional.parse(source);
      assert.ok(!expected.ok && !actual.ok);
      assert.deepEqual(actual.state, expected.state);
      assert.deepEqual(actual.specState, expected.specState);
      assert.deepEqual(actual.diagnostic, { rendered: { ok: false, reason: 'unavailable' } });
      assert.equal('diagnostic' in expected, false, 'unconfigured ABI3 result shape is unchanged');
    }
    assert.ok(optional.parse(simple).ok);
    assert.equal(loads, 0);
  } finally {
    plain.close();
    optional.close();
  }
});

test('diagnostic transport refuses a missing arena and rejects invalid options or renderer imports', () => {
  let loads = 0;
  const ports = {
    memory: new WebAssembly.Memory({ initial: 1 }),
    a0_runtime_read: () => {
      throw new Error('no IO permitted');
    },
    a0_runtime_write: () => {
      throw new Error('no IO permitted');
    },
    frontend_arena_token: () => 0,
    frontend_view: () => 0,
    frontend_view_length: () => 0,
  };
  const load = () => {
    loads++;
    return module;
  };
  assert.deepEqual(nativeDiagnosticRenderer(ports, { load }).snapshot(Array<number>(128).fill(0)), {
    rendered: { ok: false, reason: 'no-arena' },
  });
  assert.equal(loads, 0);
  for (const options of [-1, 0.5, 0x1_0000_0000, Infinity, NaN])
    assert.throws(
      () => nativeDiagnosticRenderer(ports, { load, options }),
      /invalid native diagnostic options/,
    );
  const live = nativeDiagnosticRenderer({ ...ports, frontend_arena_token: () => 1 }, { load });
  assert.throws(() => live.snapshot(Array<number>(128).fill(0)), /renderer imports/);
  assert.equal(loads, 1);
});
