import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parseAndValidate, run } from '../src/core.js';
import { fillRun, optimizeFunction } from '../src/optimize.js';

function program(length: number, count: number, stateRead = false, strict = false) {
  return parseAndValidate(`${strict ? 'profile strict\n' : ''}fn fill u32x${length} u32 u32x${length} -> u32x${length}
v get ${stateRead ? 'p0' : 'p2'} p1
x xor v p1
r set p0 p1 x
ret r
end
fn top u32x${length} u32x${length} -> u32x${length}
r fold fill ${count} p0 p1
ret r
end`);
}

for (const length of [16, 64]) {
  test(`independent full array fill exposes ${length} fixed elements with readonly input`, () => {
    const source = program(length, length).byName.get('top');
    assert.ok(source);
    const optimized = optimizeFunction(source).fn;
    assert.ok(!optimized.nodes.some((n) => n.op === 'fold'));
    let seed = 0x61703431;
    const next = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return seed >>> 0;
    };
    for (let sample = 0; sample < 12; sample += 1) {
      const initial = Array.from({ length }, next);
      const input = Array.from({ length }, next);
      const expected = input.map((v, i) => (v ^ i) >>> 0);
      assert.deepEqual(run(source, [initial, input]), expected);
      assert.deepEqual(run(optimized, [initial, input]), expected);
      // A loop-invariant extra may alias the initial state without observing updates.
      assert.deepEqual(run(optimized, [input, input]), expected);
    }
  });
}

for (const [name, length, count, stateRead, strict] of [
  ['partial overwrite', 16, 15, false, false],
  ['prior state dependency', 16, 16, true, false],
  ['oversized array', 65, 65, false, false],
  ['strict dynamic index', 16, 16, false, true],
] as const) {
  test(`independent fill expansion leaves ${name} on existing path`, () => {
    const source = program(length, count, stateRead, strict).byName.get('top');
    assert.ok(source);
    const optimized = optimizeFunction(source).fn;
    assert.ok(optimized.nodes.some((n) => n.op === 'fold'));
    const initial = Array.from({ length }, (_, i) => 0xffff_ffff - i);
    const input = Array.from({ length }, (_, i) => i * 31);
    assert.deepEqual(run(optimized, [initial, input]), run(source, [initial, input]));
  });
}

for (const value of ['7', 'p1', 'p2']) {
  test(`existing lane fill retains direct value operand ${value}`, () => {
    const p = parseAndValidate(`fn fill u32x16 u32 u32 -> u32x16
r set p0 p1 ${value}
ret r
end
fn top u32x16 u32 -> u32x16
r fold fill 16 p0 p1
ret r
end`);
    const source = p.byName.get('top');
    assert.ok(source);
    const optimized = optimizeFunction(source).fn;
    const fold = optimized.nodes.find((n) => n.op === 'fold');
    assert.ok(fold);
    assert.ok(fillRun(optimized, fold));
    const expected = Array.from({ length: 16 }, (_, i) =>
      value === '7' ? 7 : value === 'p1' ? i : 0xffff_ffff,
    );
    const args = [Array(16).fill(123), 0xffff_ffff];
    assert.deepEqual(run(source, args), expected);
    assert.deepEqual(run(optimized, args), expected);
  });
}

test('local producer/consumer fills remain available to loop fusion', () => {
  const p = parseAndValidate(`fn fill u32x16 u32 u32 -> u32x16
m rem p2 7
v add p1 m
r set p0 p1 v
ret r
end
fn top u32x16 u32 u32 -> u32
x fold fill 16 p0 p1
y fold fill 16 p0 p2
a get x 3
b get y 7
r xor a b
ret r
end`);
  const source = p.byName.get('top');
  assert.ok(source);
  const optimized = optimizeFunction(source).fn;
  assert.ok(optimized.nodes.some((n) => n.op === 'fold'));
  assert.equal(new Set(optimized.nodes.map((n) => n.id)).size, optimized.nodes.length);
  for (const a of [0, 1, 0xffff_ffff]) {
    for (const b of [0, 17, 0x8000_0000]) {
      const args = [Array(16).fill(0), a, b];
      const expected = ((a % 7) + 3) ^ ((b % 7) + 7);
      assert.equal(run(source, args), expected);
      assert.equal(run(optimized, args), expected);
    }
  }
});

test('state passed through an aggregate helper prevents independent expansion', () => {
  const p = parseAndValidate(`fn identity u32x16 -> u32x16
ret p0
end
fn fill u32x16 u32 u32x16 -> u32x16
q call identity p0
v get q p1
x xor v p1
r set p0 p1 x
ret r
end
fn top u32x16 u32x16 -> u32x16
r fold fill 16 p0 p1
ret r
end`);
  const source = p.byName.get('top');
  assert.ok(source);
  const optimized = optimizeFunction(source).fn;
  assert.ok(optimized.nodes.some((n) => n.op === 'fold'));
  const args = [Array.from({ length: 16 }, (_, i) => 31 - i), Array(16).fill(123)];
  assert.deepEqual(run(optimized, args), run(source, args));
});

test('a strict trapping helper retains the original fold and trap', () => {
  const p = parseAndValidate(`profile strict
fn divide u32 u32 -> u32
q div p0 p1
ret q
end
fn fill u32x16 u32 u32 -> u32x16
v call divide 7 p2
r set p0 p1 v
ret r
end
fn top u32x16 u32 -> u32x16
r fold fill 16 p0 p1
ret r
end`);
  const source = p.byName.get('top');
  assert.ok(source);
  const optimized = optimizeFunction(source).fn;
  assert.ok(optimized.nodes.some((n) => n.op === 'fold'));
  assert.throws(() => run(source, [Array(16).fill(0), 0]), /div|zero/i);
  assert.throws(() => run(optimized, [Array(16).fill(0), 0]), /div|zero/i);
  assert.deepEqual(run(optimized, [Array(16).fill(0), 2]), Array(16).fill(3));
});

test('a returned array with a local effectful consumer retains its producer', async () => {
  const p = parseAndValidate(
    await readFile('test/fixtures/independent-array/returned-local-use.a0', 'utf8'),
  );
  const source = p.byName.get('top');
  assert.ok(source);
  const optimized = optimizeFunction(source).fn;
  assert.ok(optimized.nodes.some((n) => n.op === 'fold'));
  assert.ok(optimized.nodes.some((n) => n.op === 'write'));
});
