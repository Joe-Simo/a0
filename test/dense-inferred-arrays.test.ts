import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatProgram, parse, type Type } from '../src/core.js';
import { parseDense } from '../src/dense.js';
import { readDenseA0, readOnce } from '../src/dense-a0.js';

test('self-hosted reader infers scalar array results from literals, text, operations and calls', () => {
  for (const source of [
    'fn f\n[1 2]\n',
    'fn f\n[true false]\n',
    'fn f\n[[1 2] [3 4] [5 6]]\n',
    'fn f\n[[true false] [false true]]\n',
    'fn f\n"hello"\n',
    'fn f\nget [[1 2] [3 4]] A\n',
    'fn f\nset [1 2] A B\n',
    'fn f\nselect eq A 0 [1 2] [3 4]\n',
    'fn f\n[1 2]\nfn g\nf\n',
  ]) {
    const got = readOnce(source);
    assert.equal(got.err, false, source);
    assert.equal(formatProgram(parse(got.text)), formatProgram(parseDense(source)), source);
  }
});

test('inferred array descriptors retain dimensions at their encoding boundaries across imports', () => {
  const array = (elem: Type, length: number): Type => ({ kind: 'arr', elem, length });
  const types = [
    ...[1, 2, 4096, 4097, 65536].map((n) => array('u32', n)),
    array('bool', 65536),
    array(array('bool', 1), 4096),
    array(array('bool', 4096), 1),
    array(array('u32', 256), 256),
  ];
  for (const result of types) {
    const signatures = new Map([['external', { params: ['u32'] as Type[], result }]]);
    const source = 'fn f\nexternal A\n';
    const got = readDenseA0(source, signatures, 'imported.a0d');
    const want = parseDense(source, { imports: signatures });
    assert.equal(formatProgram(parse(got.text)), formatProgram(want));
  }
});
