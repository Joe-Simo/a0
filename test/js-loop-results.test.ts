import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compile } from '../src/backends.js';
import { parseAndValidate, run } from '../src/core.js';

const INPUTS = [
  [0, 0],
  [7, 13],
  [17, 3],
  [0xffffffff, 1],
  [1, 0xffffffff],
  [0x9e3779b9, 15],
];
const STEP = `fn step u32x8 u32 u32 -> u32x8
v get p0 p1
w add v p2
n set p0 p1 w
ret n
end
fn pred u32x8 u32 u32 -> bool
b lt p1 3
ret b
end
`;
const GO = `fn go u32 u32 -> u32
a arr p0 p1 3 4 5 6 7 8
b fold nested 9 a p1
x get a 0
y get b 0
r add x y
ret r
end
`;
const arrayProgram = (iteration: string): string =>
  `${STEP}fn nested u32x8 u32 u32 -> u32x8\nn ${iteration}\nret n\nend\n${GO}`;
const FLAT = arrayProgram('fold step 17 p0 p2');
const CASES = [
  ['fold result', FLAT],
  ['zero-trip result', arrayProgram('fold step 0 p0 p2')],
  ['early-exit loop result', arrayProgram('loop pred step 17 p0 p2')],
  [
    'essential extra-argument snapshot',
    `fn take u32x8 u32 u32x8 -> u32x8
ret p2
end
fn nested u32x8 u32 u32x8 -> u32x8
v add p1 99
a set p0 p1 v
n fold take 1 a p2
ret n
end
fn go u32 u32 -> u32
a arr p0 p1 3 4 5 6 7 8
b fold nested 9 a a
x get a 0
y get b 0
r add x y
ret r
end
`,
  ],
  [
    'shared fields in a nested record',
    `fn step (u32x8,u32x8,u32) u32 u32 -> (u32x8,u32x8,u32)
h at p0 0
old at p0 1
c at p0 2
v get h p1
a set h p1 p2
n add c v
s rec a old n
ret s
end
fn nested (u32x8,u32x8,u32) u32 u32 -> (u32x8,u32x8,u32)
n fold step 17 p0 p2
ret n
end
fn go u32 u32 -> u32
a arr p0 p1 3 4 5 6 7 8
s rec a a p0
r fold nested 9 s p1
h at r 0
old at r 1
c at r 2
x get a 0
y get h 0
z get old 0
u add x y
v add u z
w add v c
ret w
end
`,
  ],
] as const;

for (const [name, source] of CASES)
  test(`JS owned iteration return: ${name}`, async () => {
    const p = parseAndValidate(source);
    const fn = p.byName.get('go');
    assert.ok(fn);
    for (const optimize of [false, true]) {
      const text = compile(p, 'js', { optimize }).text;
      const mod = (await import(
        `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`
      )) as { go: (a: number, b: number) => number };
      for (const args of INPUTS)
        assert.equal(
          mod.go(args[0] as number, args[1] as number),
          run(fn, args),
          `${name}; ${args}; optimize=${optimize}`,
        );
    }
  });

test('JS owned loop results keep only the necessary caller snapshot', async () => {
  const p = parseAndValidate(FLAT);
  const text = compile(p, 'js', { optimize: false }).text;
  const mod = (await import(
    `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`
  )) as { go: (a: number, b: number) => number };
  const descriptor = Object.getOwnPropertyDescriptor(Uint32Array.prototype, 'slice');
  const original = Uint32Array.prototype.slice;
  let copies = 0;
  Object.defineProperty(Uint32Array.prototype, 'slice', {
    configurable: true,
    writable: true,
    value: function (this: Uint32Array, ...args: [number?, number?]) {
      copies++;
      return Reflect.apply(original, this, args);
    },
  });
  try {
    mod.go(7, 13);
  } finally {
    if (descriptor === undefined) Reflect.deleteProperty(Uint32Array.prototype, 'slice');
    else Object.defineProperty(Uint32Array.prototype, 'slice', descriptor);
  }
  assert.equal(
    copies,
    1,
    'protect the original caller array once; iteration returns are already private',
  );
});

test('JS updates through iteration results preserve caller arrays, including zero trips', async () => {
  for (const count of [0, 17]) {
    const p = parseAndValidate(
      STEP +
        `fn nested u32x8 u32 u32 -> u32x8\nn fold step ${count} p0 p2\nret n\nend\nfn go u32x8 u32 -> u32x8\nr fold nested 2 p0 p1\nn set r 0 p1\nret n\nend\n`,
    );
    const fn = p.byName.get('go');
    assert.ok(fn);
    for (const optimize of [false, true]) {
      const text = compile(p, 'js', { optimize }).text;
      const mod = (await import(
        `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`
      )) as { go: (a: Uint32Array, b: number) => Uint32Array };
      const input = Uint32Array.of(7, 13, 3, 4, 5, 6, 7, 8);
      const before = [...input];
      const output = mod.go(input, 17);
      assert.deepEqual([...output], run(fn, [before, 17]));
      output[0] = 123;
      assert.deepEqual([...input], before);
    }
  }
});
