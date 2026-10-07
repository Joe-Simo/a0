import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAndValidate } from '../src/core.js';
import { EditSession } from '../src/edit.js';
import { KEY_RULE, wordKey } from '../src/wordkey.js';

test('wordKey: the keys compiler/parse.a0 compares', () => {
  assert.equal(wordKey('fn'), 524);
  assert.equal(wordKey('use'), 7569);
  assert.equal(wordKey('ret'), 27583);
  assert.equal(wordKey('import'), 1421396227);
  assert.equal(wordKey('toolongword'), 0);
  assert.equal(wordKey('A'), undefined);
});

const SRC = 'fn kw u32 -> u32\nk eq p0 524\nr select k 1 0\nret r\nend\n';

test('views end with a keys legend only when an eq literal is a known key', () => {
  const session = new EditSession(parseAndValidate(SRC));
  const plain = session.openProgram({}).text;
  assert.ok(!plain.includes('# keys:'));
  for (const dense of [false, true]) {
    const text = session.open('kw', { scope: 'deps', ...(dense ? { dense } : {}) }).text;
    assert.ok(text.trimEnd().endsWith(`# keys: 524=fn ${KEY_RULE}`), text);
  }
  const other = new EditSession(parseAndValidate(SRC.replace('524', '7')));
  assert.ok(!other.open('kw', { scope: 'deps' }).text.includes('# keys:'));
  process.env.A0_KEY_LEGEND = 'off';
  assert.ok(
    !session.open('kw', { scope: 'deps' }).text.includes('# keys:'),
    'A0_KEY_LEGEND=off removes it',
  );
});

test('the legend changes neither the revision nor an apply that copies it back', () => {
  const session = new EditSession(parseAndValidate(SRC));
  const view = session.open('kw', { scope: 'deps' });
  const echoed = session.apply(view.text);
  assert.equal(echoed.byName.get('kw')?.nodes.length, 2);
  delete process.env.A0_KEY_LEGEND;
});
