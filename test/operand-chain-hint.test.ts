import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAndValidate } from '../src/core.js';

const fixOf = (src: string): string | undefined => {
  try {
    parseAndValidate(src);
  } catch (e) {
    return (e as { fix?: string }).fix;
  }
  return undefined;
};

test('an associative op with too many operands names the chain that says it', () => {
  const fix = fixOf('fn f u32 u32 u32 -> u32\na and p0 p1 p2\nret a\nend\n');
  assert.equal(
    fix,
    'write exactly 2 operands after and; to combine 3 operands chain two at a time: at0 and p0 p1, then a and at0 p2',
  );
  assert.match(
    fixOf('fn f u32 u32 u32 u32 -> u32\na add p0 p1 p2 p3\nret a\nend\n') ?? '',
    /at1 add at0 p2, then a add at1 p3/,
  );
});

test('other wrong operand counts keep the generic fix', () => {
  assert.equal(
    fixOf('fn f u32 -> u32\na add p0\nret a\nend\n'),
    'write exactly 2 operands after add',
  );
  assert.equal(
    fixOf('fn f u32 u32 u32 -> u32\na sub p0 p1 p2\nret a\nend\n'),
    'write exactly 2 operands after sub',
  );
});
