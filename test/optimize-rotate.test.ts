import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAndValidate, run, type TypedFunc } from '../src/core.js';
import { optimizeFunction } from '../src/optimize.js';

function fn(source: string): TypedFunc {
  const name = source.split(/\s+/)[1] ?? '';
  const f = parseAndValidate(source).byName.get(name);
  if (f === undefined) throw new Error(`missing ${name}`);
  return f;
}

/** xorshift32 stream of u32 inputs, the same every run. */
function* inputs(n: number): Generator<number> {
  let s = 0x9e3779b9;
  for (let i = 0; i < n; i += 1) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    yield s >>> 0;
  }
}

/** The program: a chain whose third term `n` is a slow product, joined in the middle. */
const chain = (op: string): string => `fn c u32 u32 u32 -> u32
m mul p0 p1
n mul m p2
a ${op} p1 p2
b ${op} a n
c ${op} b p0
ret c
end`;

/** The operand of the final node that is not the early partial result. */
function lastOperands(f: TypedFunc): { op: string; args: string[] } {
  const last = f.nodes.at(-1);
  if (last === undefined) throw new Error('empty');
  return {
    op: last.op,
    args: last.args.map((a) =>
      a.kind === 'node' ? (f.nodes.find((n) => n.id === a.id)?.op ?? '?') : a.kind,
    ),
  };
}

for (const op of ['add', 'mul', 'xor', 'and', 'or'] as const) {
  test(`optimizer rotates a ${op} chain so the slow operand joins last, same values`, () => {
    const f = fn(chain(op));
    const g = optimizeFunction(f).fn;
    // the final node joins the product `n` (a mul) last; before, it joined the early sum with p2
    const shape = lastOperands(g);
    assert.equal(shape.op, op);
    assert.ok(!shape.args.includes('param'), `${op}: last node is ${JSON.stringify(shape)}`);
    assert.ok(shape.args.includes('mul'), `${op}: last node is ${JSON.stringify(shape)}`);
    const it = inputs(300);
    for (let i = 0; i < 100; i += 1) {
      const args = [it.next().value, it.next().value, it.next().value] as number[];
      assert.equal(run(g, args), run(f, args), `${op} ${args.join(' ')}`);
    }
  });
}

test('a chain whose late operand already joins last is left alone', () => {
  const f = fn(`fn c u32 u32 u32 -> u32
m mul p0 p1
n mul m p2
a add p0 p1
b add a p2
c add b n
ret c
end`);
  const g = optimizeFunction(f).fn;
  assert.deepEqual(lastOperands(g).args, ['add', 'mul']);
  assert.equal(g.nodes.length, 5);
});

test('a serial sum of four inputs becomes two sums joined, one level shallower', () => {
  const f = fn(`fn c u32 u32 u32 u32 -> u32
a add p0 p1
b add a p2
c add b p3
ret c
end`);
  const g = optimizeFunction(f).fn;
  // ((p0 + p1) + p2) + p3 is (p0 + p1) + (p2 + p3): the late p3 no longer waits for p2
  assert.deepEqual(lastOperands(g).args, ['add', 'add']);
  assert.equal(g.nodes.length, 3);
  for (const args of [
    [1, 2, 3, 4],
    [0xffff_ffff, 0xffff_fffe, 0x8000_0000, 7],
  ] as const) {
    assert.equal(run(g, [...args]), run(f, [...args]));
  }
});

test('an inner sum with another use is not rotated (it would add work)', () => {
  const f = fn(`fn c u32 u32 u32 -> u32
m mul p0 p1
n mul m p2
a add p0 p1
b add a n
c add b p2
d add a c
ret d
end`);
  const g = optimizeFunction(f).fn;
  assert.equal(g.nodes.length, f.nodes.length);
  for (const args of [
    [1, 2, 3],
    [0xffff_ffff, 0x1234_5678, 0x8000_0001],
  ] as const) {
    assert.equal(run(g, [...args]), run(f, [...args]));
  }
});

test('a literal in the chain keeps the literal outermost, and the late operand is next', () => {
  const f = fn(`fn c u32 u32 u32 -> u32
m mul p0 p1
n mul m p2
a add p0 p2
b add a n
c add b p1
d add c 3
ret d
end`);
  const g = optimizeFunction(f).fn;
  const last = g.nodes.at(-1);
  assert.equal(last?.op, 'add');
  assert.deepEqual(last?.args[1], { kind: 'u32', value: 3 });
  const it = inputs(120);
  for (let i = 0; i < 40; i += 1) {
    const args = [it.next().value, it.next().value, it.next().value] as number[];
    assert.equal(run(g, args), run(f, args));
  }
});
