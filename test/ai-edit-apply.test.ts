import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyTs, numbered, PROTOCOL_LINE_EDIT } from '../tools/ai-edit-apply.js';

const SRC = ['def f(x):', '    y = x + 1', '    return y', ''].join('\n');
const apply = (reply: string): string => {
  const r = applyTs('structured', SRC, reply, 'e0');
  assert.equal(r.error, undefined);
  return r.source;
};

test('line-edit: the text after the number and one space is the whole line, indentation included', () => {
  assert.equal(
    apply('2     y = x + 2'),
    ['def f(x):', '    y = x + 2', '    return y', ''].join('\n'),
  );
  // Without indentation the line is flush left: the reply, not the parser, decides.
  assert.equal(apply('2 y = x + 2'), ['def f(x):', 'y = x + 2', '    return y', ''].join('\n'));
  assert.equal(apply('2\ty = x'), ['def f(x):', '\ty = x', '    return y', ''].join('\n'));
});

test('line-edit: several new lines repeat one number and are inserted in order', () => {
  assert.equal(
    apply('+1     z = 1\n+1     z = z + 1'),
    ['def f(x):', '    z = 1', '    z = z + 1', '    y = x + 1', '    return y', ''].join('\n'),
  );
  assert.equal(
    apply('+0 # top\n+0 # second'),
    ['# top', '# second', ...SRC.trimEnd().split('\n'), ''].join('\n'),
  );
});

test('line-edit: consecutive numbers anchor each line after a different original line', () => {
  assert.equal(
    apply('+1 # a\n+2 # b'),
    ['def f(x):', '# a', '    y = x + 1', '# b', '    return y', ''].join('\n'),
  );
});

test('line-edit: delete, replace once, handle line optional, wrong handle rejected', () => {
  assert.equal(apply('-2'), ['def f(x):', '    return y', ''].join('\n'));
  assert.equal(
    apply('e0\n3     return x'),
    ['def f(x):', '    y = x + 1', '    return x', ''].join('\n'),
  );
  assert.match(applyTs('structured', SRC, '2 a\n2 b', 'e0').error ?? '', /duplicate/);
  assert.match(applyTs('structured', SRC, 'e1\n2 a', 'e0').error ?? '', /handle e0/);
  assert.match(applyTs('structured', SRC, '+function f()', 'e0').error ?? '', /bad edit line/);
});

test('line-edit: the system text states what the semantics pin', () => {
  assert.match(PROTOCOL_LINE_EDIT, /repeat the same number/);
  assert.match(PROTOCOL_LINE_EDIT, /leading indentation/);
  assert.match(PROTOCOL_LINE_EDIT, /\+0 for the top/);
  assert.equal(numbered(SRC).split('\n')[1], '2     y = x + 1');
});
