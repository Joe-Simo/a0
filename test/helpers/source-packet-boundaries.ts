import assert from 'node:assert/strict';
import {
  type NativeSourceCompiler,
  SOURCE_COMPLETION_TAG,
  SOURCE_FRONTEND_CAPACITY,
} from './native-source-compiler.js';

/** Shared by all source emitters, including JavaScript and Java. No target oracle is used. */
export function assertSourcePacketBoundaries(compiler: NativeSourceCompiler): void {
  const prefix = 'fn packet_probe -> u32\nret 9\nend\n#';
  const exact = compiler.runSource(prefix + 'x'.repeat(SOURCE_FRONTEND_CAPACITY - prefix.length));
  assert.equal(exact.code, 0, exact.stderr);
  assert.ok(exact.text.length > 0);
  const over = compiler.runSource(
    prefix + 'x'.repeat(SOURCE_FRONTEND_CAPACITY + 1 - prefix.length),
  );
  assert.equal(over.code, 4);
  assert.equal(over.text, '');

  const valid = Buffer.from('fn packet_probe -> u32\nret 9\nend\n', 'utf8');
  for (const words of [
    [0],
    [32, 102, 110],
    [valid.length, ...valid],
    [valid.length, ...valid, (SOURCE_COMPLETION_TAG ^ 1) >>> 0],
    [12, 102, 110, 32, SOURCE_COMPLETION_TAG],
  ]) {
    const got = compiler.runWords(words);
    assert.equal(got.code, 2, got.stderr);
    assert.equal(got.text, '');
  }
  const partialWord = compiler.runRaw(Buffer.from([1, 2, 3]));
  assert.equal(partialWord.code, 64, 'generic transport rejects an incomplete binary word');
  assert.equal(partialWord.text, '');
}
