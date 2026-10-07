import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { getEncoding } from 'js-tiktoken';
import { parseAndValidate } from '../src/core.js';
import { formatDiagnostic } from '../src/diagnostics.js';
import { decide, MARGIN, shrinkRule } from '../tools/primer-shrink-summary.js';

const read = (p: string): string => readFileSync(p, 'utf8');
const enc = getEncoding('o200k_base');
const tokens = (p: string): number => enc.encode(read(p)).length;
const diag = (s: string): string => {
  try {
    parseAndValidate(s);
  } catch (e) {
    return formatDiagnostic(e);
  }
  throw new Error('accepted');
};

test('primer shrink: set X is sealed and the variants shrink in the registered order', () => {
  const seal = read('tools/ai-edit-tasks-x.sha256').split(/\s+/)[0];
  assert.equal(
    createHash('sha256').update(readFileSync('tools/ai-edit-tasks-x.ts')).digest('hex'),
    seal,
  );
  const s = tokens('experiments/primers/shrink/S.txt');
  const v1 = tokens('experiments/primers/shrink/V1.txt');
  const v2 = tokens('experiments/primers/shrink/V2.txt');
  const v3 = tokens('experiments/primers/shrink/V3.txt');
  assert.ok(s > v1 && v1 > v2 && v2 > v3, `${s} ${v1} ${v2} ${v3}`);
});

test('primer shrink: every rule V1 and V2 drop from the primer is carried by a diagnostic that fires on the mistake', () => {
  // loop: the arity diagnostic now states the rule.
  assert.match(
    diag('fn f u32 -> u32\na loop p0\nret a\nend'),
    /fix: write `loop P F n s args\.\.\.`: P and F are functions defined above/,
  );
  // text, loop, io: an unknown op names them with their shape; forward references and recursion keep their message.
  const unknown = diag('fn f u32 -> u32\na while p0 3\nret a\nend');
  assert.match(unknown, /callees must be defined earlier; recursion is unsupported/);
  assert.match(unknown, /text "s"/);
  assert.match(unknown, /loop P F n s a\.\.\./);
  assert.match(unknown, /read t -> \(u32,io\)/);
  assert.match(unknown, /puts t a -> io/);
  // use: a misplaced link line is told how to write it.
  assert.match(diag('use a.a0\nfn f u32 -> u32\nret p0\nend'), /use "relative\/path\.a0"/);
});

test('primer shrink: the registered rule and the decision', () => {
  assert.equal(MARGIN, 1);
  assert.deepEqual(shrinkRule({ accepted: 14, cost: 100 }, { accepted: 13, cost: 90 }), {
    acceptanceHeld: true,
    cheaper: true,
    pass: true,
  });
  assert.equal(shrinkRule({ accepted: 14, cost: 100 }, { accepted: 12, cost: 90 }).pass, false);
  assert.equal(shrinkRule({ accepted: 14, cost: 100 }, { accepted: 16, cost: 100 }).pass, false);
  const rule = {
    haiku: { V1: { pass: true }, V2: { pass: true } },
    sonnet: { V1: { pass: true }, V2: { pass: false } },
  };
  const cost = { haiku: { V1: 100, V2: 90 }, sonnet: { V1: 80, V2: 70 } };
  assert.deepEqual(decide(rule, cost), { change: true, chosen: 'V1' });
  assert.deepEqual(
    decide({ haiku: { V1: { pass: true } }, sonnet: { V1: { pass: false } } }, cost),
    {
      change: false,
      chosen: null,
    },
  );
});
