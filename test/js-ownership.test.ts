import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compile } from '../src/backends.js';
import { parseAndValidate, run, type TypedFunc } from '../src/core.js';

const HELPERS = `fn peek u32x8 u32 -> u32
v get p0 p1
ret v
end
fn nonzero u32x8 u32 -> bool
v get p0 p1
b ne v 0
ret b
end
fn sum u32 u32 u32x8 -> u32
v get p2 p1
s add p0 v
ret s
end
fn more u32 u32 u32x8 -> bool
v get p2 p1
b le p0 v
ret b
end
fn copy u32x8 -> u32x8
ret p0
end
fn copyrec (u32,u32) -> (u32,u32)
ret p0
end
fn step u32x8 u32 u32x8 -> u32x8
i add p1 7
v get p2 i
w add v 1
n set p0 p1 w
ret n
end
`;

const ARRAY = 'a arr p0 p1 3 4 5 6 7 8\n';
const UPDATE = 'b set a p1 p0\nx get b p1\nr add v x\nret r';
const CASES = [
  ['scalar call', `${ARRAY}v call peek a p1\n${UPDATE}`, 0],
  ['boolean call', `${ARRAY}q call nonzero a p1\nv select q p0 p1\n${UPDATE}`, 0],
  ['scalar fold', `${ARRAY}v fold sum 16 0 a\n${UPDATE}`, 0],
  ['scalar loop', `${ARRAY}v loop more sum 16 0 a\n${UPDATE}`, 0],
  [
    'array call retains an alias',
    `${ARRAY}old call copy a\nb set a 0 p1\nx get old 0\ny get b 0\nr add x y\nret r`,
    1,
  ],
  [
    'record call retains an alias',
    'a rec p0 p1\nold call copyrec a\nb put a 0 p1\nx at old 0\ny at b 0\nr add x y\nret r',
    1,
  ],
  [
    'old storage read after update',
    `${ARRAY}v call peek a 0\nb set a 0 p1\nx get a 0\ny get b 0\ns add v x\nr add s y\nret r`,
    1,
  ],
  [
    'state also passed as an extra',
    `${ARRAY}b fold step 9 a a\nx get b 0\ny get b 1\nr add x y\nret r`,
    1,
  ],
] as const;

/** Observe actual aggregate snapshots during one compiled call, restoring both prototypes. */
function snapshots(fn: () => number): { value: number; copies: number } {
  let copies = 0;
  const saved = [Array.prototype, Uint32Array.prototype].map((prototype) => {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'slice');
    const original = prototype.slice;
    Object.defineProperty(prototype, 'slice', {
      configurable: true,
      writable: true,
      value: function (this: unknown, ...args: unknown[]) {
        copies += 1;
        return Reflect.apply(original, this, args);
      },
    });
    return { prototype, descriptor };
  });
  try {
    return { value: fn(), copies };
  } finally {
    for (const { prototype, descriptor } of saved) {
      if (descriptor === undefined) Reflect.deleteProperty(prototype, 'slice');
      else Object.defineProperty(prototype, 'slice', descriptor);
    }
  }
}

for (const [name, body, copies] of CASES) {
  test(`JavaScript ownership: ${name}`, async () => {
    const program = parseAndValidate(`${HELPERS}fn go u32 u32 -> u32\n${body}\nend\n`);
    const fn = program.byName.get('go') as TypedFunc;
    for (const optimize of [false, true]) {
      const source = compile(program, 'js', { optimize }).text;
      const mod = (await import(
        `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
      )) as { go: (x: number, y: number) => number };
      for (const args of [
        [0, 0],
        [7, 13],
        [17, 3],
        [0xffffffff, 1],
        [1, 0xffffffff],
        [0x9e3779b9, 15],
      ] as const)
        assert.equal(mod.go(args[0], args[1]), run(fn, [...args]), `${args}; optimize=${optimize}`);
      if (!optimize) {
        const measured = snapshots(() => mod.go(7, 13));
        assert.equal(measured.value, run(fn, [7, 13]));
        assert.equal(measured.copies, copies, name);
      }
    }
  });
}
