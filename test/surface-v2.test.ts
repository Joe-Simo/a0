import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatProgram, parse } from '../src/core.js';
import { generateCorpus } from '../tools/corpus.js';
import { KERNELS } from '../tools/exec-bench-kernels.js';
import { canonicalOfV2, formatV2, inferResults, normalizeV2 } from '../tools/surface-v2.js';

// Research prototype (docs/design/surface-v2.md): the converter is lossless over the kernels and
// the generated corpus, in every printed style it can read back.

const roundTrip = (src: string, infer: boolean): void => {
  const p = parse(src);
  const back = (text: string): string =>
    infer ? inferResults(canonicalOfV2(text)) : canonicalOfV2(text);
  const style = { inferResult: infer };
  assert.equal(formatProgram(parse(back(formatV2(p, style)))), formatProgram(p));
  const n = normalizeV2(p);
  assert.equal(formatProgram(parse(back(formatV2(n, style)))), formatProgram(n));
};

test('v2: canonical to v2 to canonical is lossless on the kernels', () => {
  for (const k of KERNELS) {
    roundTrip(k.a0, false);
    roundTrip(k.a0, true);
  }
});

test('v2: lossless on the generated corpus', () => {
  const program = { functions: generateCorpus().functions };
  roundTrip(formatProgram(program), false);
});

test('v2: normalisation keeps behaviour and nests single-use values', () => {
  const p = parse('fn f u32 u32 -> u32\na mul p0 p1\nb add a p1\nret b\nend\n');
  assert.equal(formatV2(normalizeV2(p)).trim(), 'fn f(A,B)\n(A*B)+B');
});

test('v2: mixed operators without parentheses are an error, never a regrouping', () => {
  assert.throws(() => canonicalOfV2('fn f(A,B,C)\nA+B*C\n'), /parenthesise/);
  assert.equal(
    formatProgram(parse(canonicalOfV2('fn f(A,B,C)\nA+(B*C)\n'))),
    formatProgram(parse('fn f u32 u32 u32 -> u32\na mul p1 p2\nb add p0 a\nret b\nend\n')),
  );
});

test('v2: parameters take the writer names and print as capital letters', () => {
  const p = parse(canonicalOfV2('fn f(x,y)\nx-y\n'));
  assert.equal(formatV2(p).trim(), 'fn f(A,B)\nA-B');
});

test('v2: a changed operator reads back as a different program', () => {
  const p = parse(
    'fn rotl u32 u32 -> u32\nl shl p0 p1\nn sub 32 p1\nr shr p0 n\no or l r\nret o\nend\n',
  );
  const text = formatV2(normalizeV2(p));
  const mutated = text.replace('A<<B', 'A>>B');
  assert.notEqual(formatProgram(parse(canonicalOfV2(mutated))), formatProgram(normalizeV2(p)));
});
