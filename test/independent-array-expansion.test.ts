import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAndValidate, run } from '../src/core.js';
import { optimizeFunction } from '../src/optimize.js';

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
