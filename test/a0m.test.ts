import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { link } from '../src/link.js';
import { expandSource } from '../tools/a0m.js';

test('a0m: expansion of macros and templates', () => {
  const text = expandSource(
    [
      '@rd v p0 p1',
      '#@template t',
      'fn %NAME% u32 -> u32',
      '?r add p0 1',
      '!r add p0 2',
      'ret r',
      'end',
      '#@end',
      '@inst t up NEST=1',
      '@inst t down NEST=0',
    ].join('\n'),
  );
  assert.equal(
    text,
    [
      'v_a shr p1 7',
      'v_b get p0 v_a',
      'v_c and p1 127',
      'v get v_b v_c',
      'fn up u32 -> u32',
      'r add p0 1',
      'ret r',
      'end',
      'fn down u32 -> u32',
      'r add p0 2',
      'ret r',
      'end',
      '',
    ].join('\n'),
  );
  assert.throws(() => expandSource('@nope x'), /unknown macro nope/);
});

test('compiler/shape.a0 is the expansion of compiler/shape.a0m, and it links', async () => {
  const source = await readFile('compiler/shape.a0m', 'utf8');
  assert.equal(expandSource(source), await readFile('compiler/shape.a0', 'utf8'));
  const linked = await link('compiler/shape.a0', (path) => readFile(path, 'utf8'));
  assert.ok(linked.program.functions.some((f) => f.name === 'shfuse'));
  assert.ok(linked.program.functions.some((f) => f.name === 'shpass'));
});
