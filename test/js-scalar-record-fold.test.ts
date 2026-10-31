import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compile } from '../src/backends.js';
import { makeIo, parseAndValidate, run, type TypedProgram, type Value } from '../src/core.js';
import { KERNELS } from '../tools/exec-bench-kernels.js';

function fnOf(program: TypedProgram, name: string) {
  const fn = program.byName.get(name);
  assert.ok(fn);
  return fn;
}

async function emitted(source: string, optimize: boolean) {
  const program = parseAndValidate(source);
  const text = compile(program, 'js', { optimize }).text;
  const mod = await import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`);
  return { program, text, mod };
}

const putStep = `fn step (u32,u32) u32 -> (u32,u32)
a at p0 0
b at p0 1
x add a p1
y xor b x
r put p0 0 y
old at p0 0
s put r 1 old
ret s
end`;

for (const optimize of [false, true]) {
  test(`scalar-record folding preserves the existing run-length codec O${Number(optimize)}`, async () => {
    const kernel = KERNELS.find((k) => k.name === 'rle4k');
    assert.ok(kernel);
    const { program, mod, text } = await emitted(kernel.a0, optimize);
    assert.match(text, /_state0/);
    const reference = await import(
      `data:text/javascript;base64,${Buffer.from(kernel.js).toString('base64')}`
    );
    for (const args of [
      [0, 0],
      [0, 0xffffffff],
      [1, 7],
      [0xffffffff, 0xffffffff],
      [0x80000000, 17],
      [1234567, 9876543],
    ]) {
      const expected = run(fnOf(program, 'rle4k'), args, { fuel: 5e7 });
      assert.equal(mod.rle4k(...args), expected);
      assert.equal(reference.rle4k(...args), expected);
    }
  });

  test(`scalar-record folds preserve snapshots, parallel updates and zero trips O${Number(optimize)}`, async () => {
    const source = `${putStep}\nfn top (u32,u32) u32 -> (u32,u32)\nr fold step p1 p0\nret r\nend`;
    const { program, mod, text } = await emitted(source, optimize);
    assert.match(text, /_state0/);
    for (const count of [0, 1, 2, 7, 31])
      for (const initial of [
        [0, 1],
        [0xffffffff, 0x80000000],
        [17, 42],
      ]) {
        const copy = [...initial];
        const expected = run(fnOf(program, 'top'), [copy, count]);
        assert.deepEqual(mod.top(initial, count), expected);
        assert.deepEqual(initial, copy);
      }
  });

  test(`scalar-record fold extra aliases observe original state O${Number(optimize)}`, async () => {
    const source = `fn step (u32,u32) u32 (u32,u32) -> (u32,u32)
a at p0 0
b at p2 0
c add a b
n rec c a
ret n
end
fn top (u32,u32) u32 -> (u32,u32)
r fold step p1 p0 p0
ret r
end`;
    const { program, mod } = await emitted(source, optimize);
    for (const count of [0, 1, 3, 8]) {
      const input = [0xffffffff, 17];
      assert.deepEqual(mod.top(input, count), run(fnOf(program, 'top'), [input, count]));
      assert.deepEqual(input, [0xffffffff, 17]);
    }
  });

  test(`scalar-record folding reproduces the existing minmax1k benchmark O${Number(optimize)}`, async () => {
    const kernel = KERNELS.find((k) => k.name === 'minmax1k');
    assert.ok(kernel);
    const { program, mod } = await emitted(kernel.a0, optimize);
    const reference = await import(
      `data:text/javascript;base64,${Buffer.from(kernel.js).toString('base64')}`
    );
    for (const args of [
      [0, 0],
      [1, 7],
      [0xffffffff, 0xffffffff],
      [0x80000000, 17],
      [1234567, 9876543],
    ]) {
      const expected = run(fnOf(program, 'minmax1k'), args, { fuel: 5e6 });
      assert.equal(mod.minmax1k(...args), expected);
      assert.equal(reference.minmax1k(...args), expected);
    }
  });
}

test('scalar-record inlining bounds the whole pure body including record bookkeeping', async () => {
  const source = (computations: number, updates: number) => {
    const rows = ['fn step (u32,u32) u32 -> (u32,u32)', 'old at p0 0'];
    for (let i = 0; i < computations; i++)
      rows.push(`n${i} add ${i === 0 ? 'old' : `n${i - 1}`} p1`);
    for (let i = 0; i < updates; i++) {
      rows.push(`s${i} put ${i === 0 ? 'p0' : `s${i - 1}`} 0 n${computations - 1}`);
      rows.push(`r${i} at s${i} 0`);
    }
    return [
      ...rows,
      `ret s${updates - 1}`,
      'end',
      'fn top (u32,u32) u32 -> (u32,u32)',
      'r fold step p1 p0',
      'ret r',
      'end',
    ].join('\n');
  };
  for (const [computations, updates, inlined] of [
    [16, 4, true],
    [17, 4, true],
    [55, 4, true],
    [56, 4, false],
    [1, 31, true],
    [1, 32, false],
  ] as const) {
    const { program, mod, text } = await emitted(source(computations, updates), false);
    assert.equal(text.includes('_state0'), inlined);
    for (const count of [0, 1, 7]) {
      const initial = [0xffffffff, 42];
      assert.deepEqual(mod.top(initial, count), run(fnOf(program, 'top'), [initial, count]));
      assert.deepEqual(initial, [0xffffffff, 42]);
    }
  }
});

test('scalar-record lowering keeps typed bool array reads and unsigned operations', async () => {
  const source = `fn step (u32,bool) u32 boolx4 -> (u32,bool)
a at p0 0
b get p2 p1
c div a 0
r rec c b
ret r
end
fn top u32 -> (u32,bool)
a arr true false true false
s rec p0 false
r fold step 7 s a
ret r
end`;
  const { program, mod } = await emitted(source, false);
  for (const x of [0, 1, 0xffffffff]) assert.deepEqual(mod.top(x), run(fnOf(program, 'top'), [x]));
});

test('scalar-record lowering keeps caller and callee names distinct', async () => {
  const source = `fn step (u32,u32) u32 u32 -> (u32,u32)
a at p0 0
b add a p2
r rec b p1
ret r
end
fn top u32 -> (u32,u32)
a add p0 1
s rec 0 0
r fold step 3 s a
ret r
end`;
  const { program, mod } = await emitted(source, false);
  assert.deepEqual(mod.top(7), run(fnOf(program, 'top'), [7]));
});

test('strict and effectful fold bodies retain ordinary lowering', async () => {
  const sources = [
    `profile strict\n${putStep}\nfn top (u32,u32) -> (u32,u32)\nr fold step 3 p0\nret r\nend`,
    `fn identity u32 -> u32\nret p0\nend\nfn step (u32,u32) u32 -> (u32,u32)\na at p0 0\nb call identity a\nr rec b p1\nret r\nend\nfn top (u32,u32) -> (u32,u32)\nr fold step 3 p0\nret r\nend`,
  ];
  for (const source of sources) {
    const { program, mod, text } = await emitted(source, false);
    assert.doesNotMatch(text, /_state0/);
    const input: Value[] = [[7, 13]];
    assert.deepEqual(mod.top(input[0]), run(fnOf(program, 'top'), input));
  }
});

test('record folds carrying IO preserve ordered writes through ordinary lowering', async () => {
  const source = `fn step (u32,io) u32 -> (u32,io)
x at p0 0
t at p0 1
n add x 1
w write t n
r rec n w
ret r
end
fn top io -> (u32,io)
s rec 0 p0
r fold step 3 s
ret r
end`;
  const { program, mod, text } = await emitted(source, false);
  assert.doesNotMatch(text, /_state0/);
  const expected = run(fnOf(program, 'top'), [makeIo([])]) as [number, { output: number[] }];
  const actual = mod.top(mod.a0_make_io([]));
  assert.equal(actual[0], expected[0]);
  assert.deepEqual(actual[1].output, expected[1].output);
  assert.deepEqual(actual[1].output, [1, 2, 3]);
});
