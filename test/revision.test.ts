import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { sha256Hex } from '../src/revision.js';

const native = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

test('sha256Hex equals node:crypto on the padding edges, multi-byte text and long input', () => {
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(
    sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  for (let n = 0; n < 200; n++) {
    const s = 'x'.repeat(n);
    assert.equal(sha256Hex(s), native(s), `length ${n}`);
  }
  const text = 'fn é ∀ 𝔸 ;\n'.repeat(5000);
  assert.equal(sha256Hex(text), native(text));
});
