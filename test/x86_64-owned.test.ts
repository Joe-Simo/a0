import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { compile } from '../src/backends.js';
import { A0Error, formatTrap, makeIo, parseAndValidate, run, type Value } from '../src/core.js';
import { findClang } from '../src/toolchain.js';
import type { Case } from '../tools/corpus.js';
import { checkX86_64 } from '../tools/verify.js';
import { PREDICATE_BODIES, RECORD_CASES } from './fixtures/owned-programs.js';

const INPUTS = [
  [0, 0],
  [7, 13],
  [17, 3],
  [0xffffffff, 1],
  [1, 0xffffffff],
  [0x9e3779b9, 15],
];
const STEP = 'fn step u32 u32 u32 u32 -> u32\nn add p0 1\nret n\nend\n';
const PREDICATES =
  STEP +
  PREDICATE_BODIES.map(
    (body, i) =>
      `fn cond${i} u32 u32 u32 u32 -> bool\n${body}\nend\nfn probe${i} u32 u32 -> u32\nr loop cond${i} step 17 0 p0 p1\nret r\nend\n`,
  ).join('');

async function check(source: string, names: readonly string[], t: TestContext): Promise<void> {
  const p = parseAndValidate(source);
  const cases: Case[] = [];
  for (const name of names) {
    const fn = p.byName.get(name);
    assert.ok(fn);
    for (const args of INPUTS) {
      try {
        cases.push({ functionName: name, args, expected: run(fn, args) });
      } catch (e) {
        assert.ok(e instanceof A0Error && e.trap !== undefined);
        cases.push({ functionName: name, args, expected: 0, expectedTrap: formatTrap(e.trap) });
      }
    }
  }
  const report = await checkX86_64(p, cases, findClang());
  if (report.status === 'blocked') {
    t.skip(report.detail);
    return;
  }
  assert.equal(report.status, 'passed', JSON.stringify(report));
  assert.equal(report.cases, cases.length);
}

for (const [name, source] of RECORD_CASES)
  test(`x86 record ownership: ${name}`, async (t) => check(source, ['probe'], t));

test('x86 predicate branches preserve comparisons, mixed booleans, sharing and outside uses', async (t) => {
  await check(
    PREDICATES,
    PREDICATE_BODIES.map((_, i) => `probe${i}`),
    t,
  );
});

test('x86 predicate branches handle boolean state', async (t) => {
  await check(
    `fn pred bool u32 u32 -> bool
b lt p1 p2
c and p0 b
ret c
end
fn step bool u32 u32 -> bool
n xor p0 true
ret n
end
fn probe u32 u32 -> u32
a lt p0 p1
b loop pred step 17 a p0
r select b p0 p1
ret r
end
`,
    ['probe'],
    t,
  );
});

test('x86 materialized bit-test comparisons keep absorbed inputs live', async (t) => {
  await check(
    `fn probe u32 u32 -> u32
a and p0 8
q add p1 1
b eq a 0
c lt q 17
d and b c
r select d q 0
ret r
end
`,
    ['probe'],
    t,
  );
});

test('x86 strict predicates keep eager traps even when an earlier condition is false', async (t) => {
  await check(
    `profile strict
fn pred u32 u32 u32 -> bool
a lt p0 0
v div p2 p0
b ne v 0
r and a b
ret r
end
fn step u32 u32 u32 -> u32
n add p0 1
ret n
end
fn probe u32 u32 -> u32
c and p1 3
r loop pred step c 0 p0
ret r
end
`,
    ['probe'],
    t,
  );
});

test('x86 record states containing io preserve values and output order', async (t) => {
  const p = parseAndValidate(`fn step (u32x8,io) u32 u32 -> (u32x8,io)
h at p0 0
tok at p0 1
v get h p1
a set h p1 p2
t write tok v
r rec a t
ret r
end
fn probe u32 io -> u32
a arr p0 1 2 3 4 5 6 7
s rec a p1
r fold step 9 s p0
h at r 0
v get h 0
ret v
end
`);
  const fn = p.byName.get('probe');
  assert.ok(fn);
  const cases: Case[] = INPUTS.map(([x]) => {
    const io = makeIo([]);
    const args: Value[] = [x as number];
    return {
      functionName: 'probe',
      args,
      expected: run(fn, [...args, io]),
      input: [],
      expectedOutput: [...io.output],
    };
  });
  const report = await checkX86_64(p, cases, findClang());
  if (report.status === 'blocked') {
    t.skip(report.detail);
    return;
  }
  assert.equal(report.status, 'passed', JSON.stringify(report));
});

test('x86 predicate effects run before branching on a false conjunction', async (t) => {
  const p = parseAndValidate(`fn pred io u32 u32 -> bool
r read p0
v at r 0
a lt p1 0
b ne v 0
c and a b
ret c
end
fn step io u32 u32 -> io
ret p0
end
fn probe u32 io -> u32
t loop pred step 3 p1 p0
r read t
v at r 0
ret v
end
`);
  const fn = p.byName.get('probe');
  assert.ok(fn);
  const input = [11, 22];
  const io = makeIo(input);
  const expected = run(fn, [7, io]);
  assert.equal(expected, 22);
  const cases: Case[] = [
    { functionName: 'probe', args: [7], input, expected, expectedOutput: [...io.output] },
  ];
  const report = await checkX86_64(p, cases, findClang());
  if (report.status === 'blocked') {
    t.skip(report.detail);
    return;
  }
  assert.equal(report.status, 'passed', JSON.stringify(report));
});

const bodyOf = (text: string, name: string): string => {
  const body = new RegExp(`a0_${name}:[\\s\\S]*?\\n\\tret\\n`).exec(text)?.[0];
  assert.ok(body);
  return body;
};

test('x86 inlined predicate conjunctions branch without materializing booleans', () => {
  const text = compile(parseAndValidate(PREDICATES), 'x86_64', {
    optimize: false,
    x86Platform: 'linux',
  }).text;
  assert.doesNotMatch(bodyOf(text, 'probe4'), /\tset(?:e|ne|b|be|a|ae) /);
});

test('x86 shared predicate DAGs keep linear code size', () => {
  const emit = (depth: number): string => {
    const nodes = ['v0 lt p0 p2'];
    for (let i = 1; i <= depth; i++) nodes.push(`v${i} and v${i - 1} v${i - 1}`);
    return compile(
      parseAndValidate(
        `fn pred u32 u32 u32 -> bool\n${nodes.join('\n')}\nret v${depth}\nend\nfn step u32 u32 u32 -> u32\nn add p0 1\nret n\nend\nfn probe u32 u32 -> u32\nr loop pred step 17 0 p0\nret r\nend\n`,
      ),
      'x86_64',
      { optimize: false, x86Platform: 'linux' },
    ).text;
  };
  const small = bodyOf(emit(8), 'probe');
  const large = bodyOf(emit(12), 'probe');
  assert.doesNotMatch(large, /\tcall a0_pred/);
  assert.ok(large.length < 3 * small.length);
});

test('x86 owned record updates copy the array only at construction', () => {
  const src = `fn step (u32x128,u32) u32 u32 -> (u32x128,u32)
h at p0 0
c at p0 1
v get h p1
w add v p2
a set h p1 w
n add c v
s rec a n
ret s
end
fn probe u32 u32 -> u32
a arr ${Array(128).fill('0').join(' ')}
s rec a p0
r fold step 17 s p1
h at r 0
v get h p0
c at r 1
out add v c
ret out
end
`;
  const text = compile(parseAndValidate(src), 'x86_64', {
    optimize: false,
    x86Platform: 'linux',
  }).text;
  assert.equal([...bodyOf(text, 'probe').matchAll(/\tcall \.La0copy/g)].length, 1);
});
