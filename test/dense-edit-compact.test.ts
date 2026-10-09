import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { formatFunction, parseAndValidate } from '../src/core.js';
import { EditSession } from '../src/edit.js';

// The compact style of the edit view (ViewOptions.compact) is off by default: a dense view without
// it is the text it was before the option existed, and replies are read as plain dense text.
const src = readFileSync('examples/kernels.a0', 'utf8');

test('compact edit view: off by default, the dense view is unchanged', () => {
  const s = new EditSession(parseAndValidate(src));
  const plain = s.open('clamp_max', { dense: true }).text.split('\n').slice(1).join('\n');
  const off = s
    .open('clamp_max', { dense: true, compact: false })
    .text.split('\n')
    .slice(1)
    .join('\n');
  assert.equal(off, plain);
  assert.equal(plain, 'fn clamp_max\nc lt B A\nr select c B A');
  // without `dense` the option is ignored
  const canon = s.open('clamp_max').text.split('\n').slice(1).join('\n');
  assert.equal(s.open('clamp_max', { compact: true }).text.split('\n').slice(1).join('\n'), canon);
});

test('compact edit view: prints the compact spellings and reads compact replies', () => {
  const s = new EditSession(parseAndValidate(src));
  const v = s.open('clamp_max', { dense: true, compact: true });
  assert.equal(v.text, `${v.handle}\nfn clamp_max\nc<B A\nr?c B A`);
  // an edit line in the compact spelling
  s.apply(`${v.handle}\nc>B A`);
  assert.match(formatFunction(s.program.byName.get('clamp_max') as never), /c gt p1 p0/);
  // a whole function in the compact spelling
  const w = s.open('is_even', { dense: true, compact: true });
  s.apply(`${w.handle}\nfn is_even\nm&A 1\nz=m 1`);
  assert.match(formatFunction(s.program.byName.get('is_even') as never), /eq m 1/);
});

test('compact edit view: a plain dense handle does not read the compact `?`', () => {
  const s = new EditSession(parseAndValidate(src));
  const v = s.open('clamp_max', { dense: true });
  assert.throws(() => s.apply(`${v.handle}\nr?c A B`));
});
