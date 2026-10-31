import assert from 'node:assert/strict';
import { test } from 'node:test';
import { run, validate } from '../src/core.js';
import { DIAGNOSTICS, diagnosticIds, type Spec } from '../src/diagnostics.js';
import { explain, verifyExamples } from '../src/explain.js';
import { formatSource, parseSource } from '../src/source.js';
import { candidateExample, explainSource, verifySourceExamples } from '../src/source-explain.js';
import { SOURCE_GUIDE } from '../src/source-guide.js';

test('candidate diagnostic source, edit, patch and runtime examples preserve exact rejection codes', () => {
  assert.deepEqual(verifySourceExamples(), []);
  assert.deepEqual(verifyExamples(), []);
  const kinds = new Set<string>();
  let count = 0;
  for (const id of diagnosticIds()) {
    const ex = (DIAGNOSTICS[id] as Spec).example;
    if (ex) {
      kinds.add(ex.kind);
      count++;
    }
    assert.equal(explainSource(id), explainSource(id));
  }
  assert.ok(count > 60);
  assert.deepEqual([...kinds].sort(), ['edit', 'patch', 'run', 'source']);
  assert.match(explainSource('A0005')!, /add A 1/);
  assert.doesNotMatch(explainSource('A0005')!, /\bp0\b/);
  assert.match(explainSource('A0005')!, /node \.a0\/cli\.mjs check --fix/);
  assert.equal(explainSource('not-a-code'), undefined);
  assert.notEqual(explainSource('A0005'), explain('A0005'));
});

test('candidate diagnostic conversion preserves quoted bytes and comment contents', () => {
  const original = 'fn f u32 -> u32\n# p0 u32 shl\ns text "p0 u32 shl"\nr get s 0\nret r\nend\n';
  const ex = candidateExample({ kind: 'source', bad: original, good: original });
  const converted = typeof ex.good === 'function' ? ex.good() : ex.good;
  assert.ok(converted.includes('"p0 u32 shl"'));
  assert.ok(converted.includes('# p0 u32 shl'));
  assert.equal(run(validate(parseSource(converted)).byName.get('f')!, [0]), 112);
});

test('candidate guide spells parameters after Z exactly as the parser and formatter', () => {
  const p = validate(parseSource(`fn f ${Array(27).fill('_').join(' ')} -> _\nret p26\nend\n`));
  assert.equal(
    run(
      p.byName.get('f')!,
      Array.from({ length: 27 }, (_, i) => i),
    ),
    26,
  );
  assert.match(formatSource(p), /ret p26/);
  assert.match(SOURCE_GUIDE, /p26 p27/);
  assert.doesNotMatch(SOURCE_GUIDE, /Z AA AB/);
});
