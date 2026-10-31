import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeSource } from '../src/source-native.js';
import { nativeSourceArtifact } from '../tools/source-native-artifact.js';

test('example-result failures retain owned renderer context without changing later success', async () => {
  const engine = nativeSource(await nativeSourceArtifact());
  try {
    const failed = engine.parse('fn f\nex 1 -> 2\nret A\nend\n');
    assert.ok(!failed.ok);
    assert.equal(failed.state[1], 715);
    assert.ok((failed.state[127] ?? 0) > 0);
    assert.equal(failed.state[96], 1);
    const saved = JSON.stringify(failed);
    const good = engine.parse('fn f\nex 1 -> 1\nret A\nend\n');
    assert.ok(good.ok);
    assert.equal(JSON.stringify(failed), saved);
    assert.equal(good.program.functions[0]?.name, 'f');
  } finally {
    engine.close();
  }
});
