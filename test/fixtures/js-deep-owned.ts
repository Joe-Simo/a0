import type { Value } from '../../src/core.js';

export interface JSOwnershipCase {
  readonly name: string;
  readonly source: string;
  readonly entry?: string;
  readonly inputs?: readonly (readonly Value[])[];
  readonly io?: boolean;
  readonly noDeep?: boolean;
  readonly deep?: boolean;
}

export const INPUTS: [number, number][] = [
  [0, 0],
  [7, 13],
  [17, 3],
  [0xffffffff, 1],
  [1, 0xffffffff],
  [0x9e3779b9, 15],
];
const TOP_SINGLE = `fn probe u32 u32 -> u32
a arr p0 p1 3 4 5 6 7 8
s rec a p0
r fold step 17 s p1
h at r 0
c at r 1
x get h 0
y get a 0
z mul x 31
v add z y
w add v c
ret w
end
`;
const TOP_DOUBLE = (
  init = 's rec a b p0',
  iteration = 'r fold step 17 s p1',
) => `fn probe u32 u32 -> u32
a arr p0 p1 3 4 5 6 7 8
b arr p1 p0 8 7 6 5 4 3
${init}
${iteration}
h at r 0
k at r 1
c at r 2
x get h 0
y get k 0
u get a 0
v mul x 31
w mul y 7
z add v w
q add z u
out add q c
ret out
end
`;
const SINGLE_STEP = `fn step (u32x8,u32) u32 u32 -> (u32x8,u32)
h at p0 0
c at p0 1
v get h p1
w add v p2
a set h p1 w
n add c v
s rec a n
ret s
end
`;
const DOUBLE_STEP = `fn step (u32x8,u32x8,u32) u32 u32 -> (u32x8,u32x8,u32)
h at p0 0
old at p0 1
c at p0 2
v get h p1
a set h p1 p2
x get old p1
n add c x
q add n v
s rec a old q
ret s
end
`;
export const CASES: readonly JSOwnershipCase[] = [
  { name: 'disjoint owned field', source: SINGLE_STEP + TOP_SINGLE },
  {
    name: 'shared initializer fields retain distinct values',
    source: DOUBLE_STEP + TOP_DOUBLE('s rec a a p0'),
  },
  {
    name: 'duplicate field projections keep an old view',
    source: `fn step (u32x8,u32) u32 u32 -> (u32x8,u32)
h at p0 0
old at p0 0
c at p0 1
a set h p1 p2
x get old p1
n add c x
s rec a n
ret s
end
${TOP_SINGLE}`,
  },
  {
    name: 'borrowed field escapes in an earlier holder record',
    source: `fn step (u32x8,u32) u32 u32 -> (u32x8,u32)
h at p0 0
holder rec h p2
c at p0 1
a set h p1 p2
old at holder 0
x get old p1
n add c x
s rec a n
ret s
end
${TOP_SINGLE}`,
  },
  {
    name: 'whole parent escapes through an identity call',
    source: `fn identity (u32x8,u32) -> (u32x8,u32)
ret p0
end
fn step (u32x8,u32) u32 u32 -> (u32x8,u32)
old call identity p0
h at p0 0
c at p0 1
a set h p1 p2
k at old 0
x get k p1
n add c x
s rec a n
ret s
end
${TOP_SINGLE}`,
  },
  {
    name: 'state is simultaneously the iteration extra',
    source: `fn step (u32x8,u32) u32 (u32x8,u32) -> (u32x8,u32)
h at p0 0
c at p0 1
a set h p1 p1
old at p2 0
x get old p1
n add c x
s rec a n
ret s
end
fn probe u32 u32 -> u32
a arr p0 p1 3 4 5 6 7 8
s rec a p0
r fold step 17 s s
h at r 0
x get h 0
c at r 1
y get a 0
v add x c
out add v y
ret out
end
`,
  },
  {
    name: 'state is nested inside an iteration extra record',
    source: `fn step (u32x8,u32) u32 ((u32x8,u32),u32) -> (u32x8,u32)
h at p0 0
c at p0 1
a set h p1 p1
old at p2 0
k at old 0
x get k p1
n add c x
s rec a n
ret s
end
fn probe u32 u32 -> u32
a arr p0 p1 3 4 5 6 7 8
s rec a p0
e rec s p1
r fold step 17 s e
h at r 0
x get h 0
c at r 1
y get a 0
v add x c
out add v y
ret out
end
`,
  },
  {
    name: 'borrowed external array returned as next state field',
    source: `fn step (u32x8,u32) u32 u32x8 -> (u32x8,u32)
h at p0 0
c at p0 1
v get h p1
a set h p1 c
x get a p1
n add c v
q add n x
s rec p2 q
ret s
end
fn probe u32 u32 -> u32
a arr p0 p1 3 4 5 6 7 8
b arr p1 p0 8 7 6 5 4 3
s rec a p0
r fold step 17 s b
h at r 0
c at r 1
x get h 0
y get b 0
z add c x
out add z y
ret out
end
`,
  },
  {
    name: 'array fields swap after an update',
    source: `fn step (u32x8,u32x8,u32) u32 u32 -> (u32x8,u32x8,u32)
a at p0 0
b at p0 1
c at p0 2
v get b p1
h set a p1 p2
n add c v
s rec b h n
ret s
end
${TOP_DOUBLE()}`,
  },
  {
    name: 'one updated source is returned in both fields',
    source: `fn step (u32x8,u32x8,u32) u32 u32 -> (u32x8,u32x8,u32)
a at p0 0
b at p0 1
c at p0 2
h set a p1 p2
v get b p1
n add c v
s rec h h n
ret s
end
${TOP_DOUBLE()}`,
  },
  {
    name: 'two updates from one child remain independent',
    source: `fn step (u32x8,u32x8,u32) u32 u32 -> (u32x8,u32x8,u32)
a at p0 0
b at p0 1
c at p0 2
h set a p1 p2
q add p2 1
k set a p1 q
x get h p1
y get k p1
v add x y
n add c v
s rec h k n
ret s
end
${TOP_DOUBLE('s rec a a p0')}`,
  },
  {
    name: 'zero-trip nested result is updated without touching its caller',
    source: `${SINGLE_STEP}fn nested (u32x8,u32) u32 u32 -> (u32x8,u32)
r fold step 0 p0 p2
h at r 0
c at r 1
a set h p1 p2
s rec a c
ret s
end
${TOP_SINGLE.replace('fold step 17', 'fold nested 9')}`,
  },
  {
    name: 'early-exit nested loop preserves shared original fields',
    source: `${DOUBLE_STEP}fn pred (u32x8,u32x8,u32) u32 u32 -> bool
b lt p1 3
ret b
end
fn nested (u32x8,u32x8,u32) u32 u32 -> (u32x8,u32x8,u32)
r loop pred step 17 p0 p2
ret r
end
${TOP_DOUBLE('s rec a a p0', 'r fold nested 9 s p1')}`,
  },
  {
    name: 'nested folds pass state through two ownership boundaries',
    source: `${SINGLE_STEP}fn nested (u32x8,u32) u32 u32 -> (u32x8,u32)
r fold step 17 p0 p2
ret r
end
${TOP_SINGLE.replace('fold step 17', 'fold nested 9')}`,
  },
  {
    name: 'holder built before an inner loop keeps the old borrowed child',
    source: `${SINGLE_STEP}fn nested (u32x8,u32) u32 u32 -> (u32x8,u32)
h at p0 0
holder rec h p2
r fold step 17 p0 p2
old at holder 0
x get old p1
k at r 0
c at r 1
n add c x
s rec k n
ret s
end
${TOP_SINGLE.replace('fold step 17', 'fold nested 9')}`,
  },
  {
    name: 'caller array is preserved when it initializes a record',
    entry: 'probe',
    inputs: INPUTS.map(([a, b]) => [[a, b, 3, 4, 5, 6, 7, 8], b]),
    source: `${SINGLE_STEP}fn probe u32x8 u32 -> u32x8
s rec p0 p1
r fold step 17 s p1
h at r 0
a set h 0 p1
ret a
end
`,
  },
  {
    name: 'caller record can share its array fields',
    entry: 'probe',
    inputs: INPUTS.map(([a, b]) => {
      const v = [a, b, 3, 4, 5, 6, 7, 8];
      return [[v, v, a], b];
    }),
    source: `${DOUBLE_STEP}fn probe (u32x8,u32x8,u32) u32 -> (u32x8,u32x8,u32)
r fold step 17 p0 p1
h at r 0
k at r 1
c at r 2
a set h 0 p1
s rec a k c
ret s
end
`,
  },
];
