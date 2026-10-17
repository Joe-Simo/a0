import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { run, type TypedProgram } from '../src/core.js';
import { link } from '../src/link.js';

type Words = readonly (readonly number[])[];
const zero = (pages: number): number[][] =>
  Array.from({ length: pages }, () => Array<number>(128).fill(0));
function put(table: number[][], start: number, words: readonly number[]): void {
  for (const [offset, value] of words.entries()) {
    const i = start + offset;
    const page = table[i >>> 7];
    assert.ok(page !== undefined);
    page[i & 127] = value;
  }
}
function word(table: Words, i: number): number {
  const value = table[i >>> 7]?.[i & 127];
  assert.ok(value !== undefined);
  return value;
}
let linked: Promise<TypedProgram> | undefined;
async function evaluator(name: 'evrun' | 'evstep') {
  linked ??= link('compiler/evalrun.a0', (path) => readFile(path, 'utf8')).then(
    ({ program }) => program,
  );
  const fn = (await linked).byName.get(name);
  assert.ok(fn !== undefined);
  return fn;
}
function tables() {
  const fns = zero(45),
    nodes = zero(132),
    args = zero(512);
  // fn q u32 u32 -> u32; r cadd p0 p1; v at r 0; ret v.
  // Function/body fields and operand pairs are handwritten, independent of the encoder.
  put(fns, 0, [1, 2, 0, 0, 0, 2, 0x10000001]);
  put(nodes, 0, [0, 32, 2, 0, 0, 0, 0, 27, 2, 2, 0, 0]);
  put(args, 0, [2, 0, 2, 1, 1, 0, 3, 0]);
  return { fns, nodes, args };
}
async function execute(
  t: ReturnType<typeof tables>,
  values: readonly number[],
  fuel: number,
  op = 19,
) {
  const input = Array<number>(64).fill(0);
  values.forEach((v, i) => {
    input[i] = v;
  });
  return run(
    await evaluator('evrun'),
    [t.fns, t.nodes, t.args, input, op, 0, 0, values.length, fuel],
    { fuel: 20_000_000 },
  );
}

test('A0 checked evaluation charges one node unit per checked result', async () => {
  const t = tables();
  assert.deepEqual(await execute(t, [0xffffffff, 1], 3), [1, 0]);
  const exhausted = await execute(t, [0xffffffff, 1], 2);
  assert.ok(Array.isArray(exhausted));
  assert.equal(exhausted[0], 2);
});

test('A0 root fold preserves its trip prefix when function zero begins with checked arithmetic', async () => {
  assert.deepEqual(await execute(tables(), [9, 0], 4096, 20), [1, 36]);
});

test('A0 checked tuple uses the final three heap words and refuses a two-word remainder', async () => {
  const t = tables();
  for (const top of [65533, 65534]) {
    const state = zero(512);
    // One active frame at its first node; parameters precede two node-value slots.
    put(state, 1, [10, 1, 8340, top]);
    put(state, 128, [0, 8336, 0, 0, 0, 0, 0, 2]);
    put(state, 8336, [0xffffffff, 1]);
    if (top === 65534) put(state, top, [12345, 67890]);
    const out = run(await evaluator('evstep'), [state, 0, t.fns, t.nodes, t.args], {
      fuel: 2_000_000,
    }) as Words;
    assert.equal(word(out, 1), 9, 'checked node costs one fuel unit');
    if (top === 65533) {
      assert.equal(word(out, 0), 0);
      assert.deepEqual([word(out, top), word(out, top + 1), word(out, top + 2)], [2, 0, 0]);
      assert.equal(word(out, 8338), top, 'node result points at the immutable record');
      assert.equal(word(out, 4), 65536);
    } else {
      assert.equal(word(out, 0), 3);
      assert.deepEqual(
        [word(out, top), word(out, top + 1)],
        [12345, 67890],
        'failed allocation copies no heap words',
      );
    }
  }
});

test('A0 evaluator refuses unknown raw opcodes', async () => {
  for (const op of [0, 38, 0xffffffff]) {
    const t = tables();
    put(t.nodes, 1, [op]);
    const result = await execute(t, [1, 2], 32);
    assert.ok(Array.isArray(result));
    assert.equal(result[0], 4, `unsupported opcode ${op}`);
  }
});
