import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parseAndValidate, run } from '../src/core.js';
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

test('shared A0 opcode table classifies exact spellings and refuses malformed or long words', async () => {
  const program = parseAndValidate(await readFile('compiler/wordkey.a0', 'utf8'));
  const key = program.byName.get('wordkey');
  const opcode = program.byName.get('opcode');
  assert.ok(key && opcode);
  // Numeric word-IR operation order, independent of the key algorithm.
  const words = [
    'mov',
    'add',
    'sub',
    'mul',
    'and',
    'or',
    'xor',
    'shl',
    'shr',
    'div',
    'rem',
    'eq',
    'ne',
    'lt',
    'le',
    'gt',
    'ge',
    'select',
    'call',
    'fold',
    'loop',
    'arr',
    'rec',
    'text',
    'get',
    'set',
    'at',
    'put',
    'read',
    'write',
    'puts',
    'cadd',
    'csub',
    'cmul',
    'cdiv',
    'crem',
    'cget',
  ];
  const expected = new Map(words.map((word, index) => [word, index + 1]));
  expected.set('udiv', 10);
  expected.set('urem', 11);
  const classify = (word: string): number => {
    const bytes = [...new TextEncoder().encode(word)];
    const page = Array.from({ length: 128 }, (_, i) => bytes[i] ?? 0);
    const value = run(key, [page, bytes.length]);
    assert.equal(value, wordKey(word) ?? 0, word);
    return run(opcode, [value]) as number;
  };
  for (const [word, code] of expected) assert.equal(classify(word), code, word);
  const invalid = [
    '',
    'ADD',
    '<<',
    '>>',
    'a\u0000dd',
    'é',
    '_',
    '______',
    '9'.repeat(6),
    'a'.repeat(129),
    '1'.repeat(257),
  ];
  for (const word of expected.keys())
    invalid.push(`_${word}`, `${word}_`, `${word}0`, `${word}A`, `${word}é`);
  for (const word of invalid) assert.equal(classify(word), 0, word);
});
