import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAndValidate, run, type TypedFunc } from '../src/core.js';
import { optimizeFunction } from '../src/optimize.js';

/** The last function of `source` (the one under test). */
function last(source: string): TypedFunc {
  const fns = parseAndValidate(source).functions;
  const f = fns.at(-1);
  if (f === undefined) throw new Error('no function');
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

const ZEROS = (n: number): string => Array.from({ length: n }, () => '0').join(' ');

/** A fill of `len` elements by `count` trips storing f(i, p2), then reads `reads`. */
function program(len: number, count: number, f: string, reads: string, profile = ''): string {
  return `${profile}fn put u32x${len} u32 u32 -> u32x${len}
${f}
n set p0 p1 v
ret n
end
fn k u32 u32 -> u32
z arr ${ZEROS(len)}
a fold put ${count} z p0
${reads}
end`;
}

const hasFold = (f: TypedFunc): boolean => f.nodes.some((n) => n.op === 'fold');

function sameValues(f: TypedFunc, g: TypedFunc): void {
  const it = inputs(400);
  for (let i = 0; i < 200; i += 1) {
    const args = [it.next().value, it.next().value] as number[];
    assert.equal(run(g, args), run(f, args), args.join(' '));
  }
  for (const args of [
    [0, 0],
    [0xffff_ffff, 15],
    [7, 16],
    [1, 0xffff_ffff],
  ])
    assert.equal(run(g, args), run(f, args), args.join(' '));
}

const READ2 = 'x get a p1\ny get a 3\ns add x y\nret s';

test('a read of a whole-length fill run is f at the wrapped index; the fold is dead', () => {
  const f = last(program(16, 16, 'v add p1 p2', READ2));
  const g = optimizeFunction(f).fn;
  assert.equal(hasFold(g), false, JSON.stringify(g.nodes));
  assert.ok(!g.nodes.some((n) => n.op === 'get' || n.op === 'arr'));
  sameValues(f, g);
});

test('a masked index below a shorter trip count reads through', () => {
  const f = last(program(16, 12, 'w mul p1 p2\nv xor w 5', 'm and p1 7\nx get a m\nret x'));
  const g = optimizeFunction(f).fn;
  assert.equal(hasFold(g), false, JSON.stringify(g.nodes));
  sameValues(f, g);
});

test('an index not provably below the trip count keeps the fold', () => {
  // count 12 < length 16 (more trips than expand unrolls): elements 12..15 keep the initial
  // zeros, so p1 cannot read through
  const f = last(program(16, 12, 'v add p1 p2', 'x get a p1\nret x'));
  const g = optimizeFunction(f).fn;
  assert.equal(hasFold(g), true);
  sameValues(f, g);
});

test('a literal index at or past the trip count keeps the fold', () => {
  const f = last(program(16, 12, 'v add p1 p2', 'x get a 13\nret x'));
  const g = optimizeFunction(f).fn;
  assert.equal(hasFold(g), true);
  sameValues(f, g);
});

test('under strict an unbounded index does not wrap, so it keeps the fold', () => {
  const f = last(program(16, 16, 'v add p1 p2', 'x get a p1\nret x', 'profile strict\n'));
  const g = optimizeFunction(f).fn;
  assert.ok(g.nodes.some((n) => n.op === 'get'));
});

test('a fill value costlier than FUSE_RECOMPUTE_COST is not copied into reads', () => {
  const f = last(program(16, 16, 'w mul p1 p2\nu mul w p1\nv add u 9', READ2));
  const g = optimizeFunction(f).fn;
  assert.equal(hasFold(g), true);
  sameValues(f, g);
});
