import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { run } from '../src/core.js';
import { link } from '../src/link.js';

test('Wasm inline setup preserves loop contexts when the child frame is unavailable', async () => {
  const program = (await link('compiler/emit_wasm.a0', (p) => readFile(p, 'utf8'))).program;
  const setup = program.byName.get('wxhost');
  assert.ok(setup);
  for (const depth of [0, 1, 2, 3]) {
    const machine = Array.from({ length: 512 }, () => Array<number>(128).fill(0));
    const put = (index: number, value: number) => {
      (machine[index >>> 7] as number[])[index & 127] = value;
    };
    // A fourth frame would start at word640, the first loop context. Retain
    // a runtime count operand and a node identity there as corruption sentinels.
    put(649, 93);
    put(658, 2);
    put(659, 11);
    put(640 + 176 * depth, 37);
    put(641 + 176 * depth, 41);
    const expected = machine.map((row) => row.slice());
    if (depth < 3) {
      const frame = 128 + 128 * (depth + 1);
      (expected[(frame + 33) >>> 7] as number[])[(frame + 33) & 127] = 37;
      (expected[(frame + 35) >>> 7] as number[])[(frame + 35) & 127] = 41;
    }
    assert.deepEqual(
      run(setup, [machine, 0, depth, 2], { fuel: 1_000_000 }),
      expected,
      `parent frame${depth}`,
    );
  }
});
