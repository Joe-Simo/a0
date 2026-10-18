import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse, validate } from '../src/core.js';
import { validateOrderedWith } from '../src/edit.js';

test('ordered program checking preserves a transport refusal after a genuine ordering diagnostic', () => {
  const program = parse('fn first u32 -> u32\nx call later p0\nret x\nend\nfn later u32 -> u32\nret p0\nend\n');
  const saved = structuredClone(program);
  const refusal = new Error('checker transport unavailable');
  let checks = 0;
  assert.throws(() => validateOrderedWith(program, (candidate) => {
    checks++;
    if (checks === 2) throw refusal;
    return validate(candidate);
  }), error => error === refusal);
  assert.equal(checks, 2);
  assert.deepEqual(program, saved);
});
