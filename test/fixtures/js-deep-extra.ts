import { makeIo, type Value } from '../../src/core.js';
import { INPUTS, type JSOwnershipCase } from './js-deep-owned.js';

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
const TOP = `fn probe u32 u32 -> u32
a arr p0 p1 3 4 5 6 7 8
s rec a p0
r fold step 17 s p1
h at r 0
c at r 1
x get h 0
y get a 0
z mul x 31
v add z y
out add v c
ret out
end
`;
const doubleTop = (init: string) => `fn probe u32 u32 -> u32
a arr p0 p1 3 4 5 6 7 8
b arr p1 p0 8 7 6 5 4 3
${init}
s rec a alias p0
r fold step 17 s p1
h at r 0
k at r 1
c at r 2
x get h 0
y get k 0
z mul x 31
v mul y 7
w add z v
q get a 0
u add w q
out add u c
ret out
end
`;
const DOUBLE_STEP = `fn step (u32x8,u32x8,u32) u32 u32 -> (u32x8,u32x8,u32)
h at p0 0
k at p0 1
c at p0 2
a set h p1 p2
x get k p1
n add c x
s rec a k n
ret s
end
`;
const callerInputs: Value[][] = INPUTS.map(([a, b]) => [[a, b, 3, 4, 5, 6, 7, 8], b]);
export const CASES: readonly JSOwnershipCase[] = [
  {
    name: 'bool array and bool scalar field remain exact booleans',
    source: `fn step (boolx8,bool,u32) u32 u32 -> (boolx8,bool,u32)
h at p0 0
flag at p0 1
c at p0 2
bits and p1 p2
b eq bits 0
a set h p1 b
f xor flag b
q select f p2 p1
n add c q
s rec a f n
ret s
end
fn probe u32 u32 -> u32
a arr true false true false true false true false
b eq p0 0
s rec a b p0
r fold step 17 s p1
h at r 0
flag at r 1
c at r 2
x get h 0
y select x 31 7
z select flag 13 3
q add c y
out add q z
ret out
end
`,
  },
  {
    name: 'bool array fields initially share a reference',
    source: `fn step (boolx8,boolx8,bool,u32) u32 u32 -> (boolx8,boolx8,bool,u32)
h at p0 0
old at p0 1
flag at p0 2
c at p0 3
bits and p1 p2
b eq bits 0
a set h p1 b
v get old p1
f xor flag v
q select f p2 p1
n add c q
s rec a old f n
ret s
end
fn probe u32 u32 -> u32
a arr true false true false true false true false
b eq p0 0
s rec a a b p0
r fold step 17 s p1
h at r 0
old at r 1
flag at r 2
c at r 3
x get h 0
y get old 0
z select x 31 7
v select y 13 3
w select flag 23 5
q add c z
u add q v
out add u w
ret out
end
`,
  },
  {
    name: 'borrowed child captured inside earlier ARRAY holder',
    source: `fn step (u32x8,u32) u32 u32 -> (u32x8,u32)
h at p0 0
holder arr h h
c at p0 1
a set h p1 p2
old get holder 1
x get old p1
n add c x
s rec a n
ret s
end
${TOP}`,
  },
  {
    name: 'aggregate-return call keeps a borrow across deep loop initializer',
    source: `${SINGLE_STEP}fn hold u32x8 u32 -> (u32x8,u32)
s rec p0 p1
ret s
end
fn probe u32 u32 -> u32
a arr p0 p1 3 4 5 6 7 8
s rec a p0
h at s 0
holder call hold h p1
r fold step 17 s p1
old at holder 0
x get old 0
k at r 0
y get k 0
c at r 1
z mul x 31
q add z y
out add q c
ret out
end
`,
  },
  {
    name: 'borrowed child captured in ARRAY holder before deep loop initializer',
    source: `${SINGLE_STEP}fn probe u32 u32 -> u32
a arr p0 p1 3 4 5 6 7 8
s rec a p0
h at s 0
holder arr h h
r fold step 17 s p1
old get holder 1
x get old 0
k at r 0
y get k 0
c at r 1
z mul x 31
q add z y
out add q c
ret out
end
`,
  },
  {
    name: 'flat array duplicate produced via mov',
    source: `${DOUBLE_STEP}${doubleTop('alias mov a')}`,
  },
  {
    name: 'flat array duplicate produced via select',
    source: `${DOUBLE_STEP}${doubleTop('cond eq p0 0\nalias select cond a b')}`,
  },
  {
    name: 'body returns unknown external array through identity call',
    noDeep: true,
    source: `fn identity u32x8 -> u32x8
ret p0
end
fn step (u32x8,u32) u32 u32x8 -> (u32x8,u32)
h at p0 0
c at p0 1
w add c p1
a set h p1 w
v get a 0
n add c v
ext call identity p2
s rec ext n
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
q mul y 31
z add c x
out add z q
ret out
end
`,
  },
  {
    name: 'strict bounds trap after earlier valid updates keeps metadata and caller input',
    inputs: callerInputs,
    source: `profile strict
fn step (u32x8,u32) u32 u32 -> (u32x8,u32)
h at p0 0
c at p0 1
k and p1 7
a set h k p2
j add p1 1
v get a j
n add c v
s rec a n
ret s
end
fn nested (u32x8,u32) u32 u32 -> (u32x8,u32)
r fold step 9 p0 p2
ret r
end
fn probe u32x8 u32 -> u32
s rec p0 p1
r fold nested 2 s p1
c at r 1
ret c
end
`,
  },
  {
    name: 'strict division trap after update keeps metadata and caller input',
    inputs: callerInputs,
    source: `profile strict
fn step (u32x8,u32) u32 u32 -> (u32x8,u32)
h at p0 0
c at p0 1
k and p1 7
a set h k p2
v div c p2
n add v p1
s rec a n
ret s
end
fn probe u32x8 u32 -> u32
s rec p0 p1
r fold step 9 s p1
c at r 1
ret c
end
`,
  },
  {
    name: 'io-containing state preserves read/write ordering',
    inputs: INPUTS.map(([a, b]) => [a, makeIo([b, a, 11, 22, 33, 44, 55, 66, 77])]),
    io: true,
    source: `fn step (u32x8,io,u32) u32 u32 -> (u32x8,io,u32)
h at p0 0
tok at p0 1
c at p0 2
rd read tok
v at rd 0
t at rd 1
old get h p1
a set h p1 v
q add old c
w write t q
n add c v
s rec a w n
ret s
end
fn probe u32 io -> u32
a arr p0 1 2 3 4 5 6 7
s rec a p1 p0
r fold step 9 s p0
h at r 0
c at r 2
v get h 0
out add v c
ret out
end
`,
  },
];

const IO_EXTRA_BODY = `fn step (u32x8,u32) u32 io -> (u32x8,u32)
h at p0 0
c at p0 1
k and p1 7
r read p2
v at r 0
t at r 1
old get h k
a set h k v
w add old c
out write t w
n add c v
s rec a n
ret s
end
fn probe u32x8 io -> u32
s rec p0 0
r fold step 9 s p1
h at r 0
c at r 1
x get h 0
y get p0 0
z add x y
out add z c
ret out
end
`;
export const IO_EXTRA_CASES: readonly JSOwnershipCase[] = [false, true].map((strict) => ({
  name: `deep state with IO extra ${strict ? 'strict' : 'canonical'}`,
  source: (strict ? 'profile strict\n' : '') + IO_EXTRA_BODY,
  deep: true,
  inputs: [0, 1, 2, 8, 9, 17].map((length, i) => [
    [i === 0 ? 0 : 0xffffffff, i, 3, 4, 5, 6, 7, 8],
    makeIo(Array.from({ length }, (_, j) => ((j + 1) * 0x9e3779b9 + i) >>> 0)),
  ]),
}));
