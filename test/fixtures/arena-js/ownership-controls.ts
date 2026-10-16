import assert from 'node:assert/strict';

// Handwritten alias controls with independent models and fixed pre-candidate
// snapshot expectations from the reference compiler at optimize:false.
// The model uses immutable JS value copies and BigInt modular arithmetic;
// it neither compiles nor invokes A0. Observe target allocations outside it.
const U = (x: number | bigint): number => Number(BigInt.asUintN(32, BigInt(x)));
const add = (a: number, b: number): number => U(BigInt(a) + BigInt(b));
const mul = (a: number, b: number): number => U(BigInt(a) * BigInt(b));
const score = (old: number, now: number, counter = 3): number =>
  add(add(mul(old, 31), now), counter);
export const INPUTS = [
  [0, 0],
  [7, 13],
  [0xffffffff, 1],
  [0xffffffff, 0xffffffff],
  [0x9e3779b9, 17],
];

const STEP = `fn step (u32x2,u32) u32 u32 -> (u32x2,u32)
h at p0 0
c at p0 1
v get h 0
w add v p2
a set h 0 w
d add c 1
s rec a d
ret s
end
`;
const PEEK = `fn peek u32x2 -> u32
v get p0 0
ret v
end
`;
const HOLD = `fn hold u32x2 -> (u32x2,u32)
s rec p0 0
ret s
end
`;
const ROOT = `a arr p0 p1
s rec a 0
`;
const RESULT = `result_array at r 0
c at r 1
y get result_array 0
weighted mul x 31
combined add weighted y
out add combined c
ret out`;
const probe = (body: string) => `fn probe u32 u32 -> u32\n${body}\nend\n`;
const changed = (a: number, b: number) => add(a, mul(b, 3));

interface AliasControl {
  readonly name: string;
  readonly source: string;
  readonly slices: number;
  readonly expected: (args: readonly number[]) => unknown;
  readonly facts: string;
  readonly inputs?: readonly (readonly number[])[];
}
function pair(args: readonly number[]): [number, number] {
  const a = args[0],
    b = args[1];
  assert.notEqual(a, undefined);
  assert.notEqual(b, undefined);
  return [a as number, b as number];
}
export const CONTROLS: readonly AliasControl[] = [
  {
    name: 'earlier scalar call of a borrowed field permits transfer',
    source:
      PEEK +
      STEP +
      probe(
        ROOT +
          `h at s 0
x call peek h
r fold step 3 s p1
` +
          RESULT,
      ),
    slices: 0,
    expected: (args) => {
      const [a, b] = pair(args);
      return score(a, changed(a, b));
    },
    facts: 'descLast < fold; no escape. Scalar call is exempt even though it reads an aggregate.',
  },
  {
    name: 'earlier record holder keeps an escaped borrow',
    source:
      STEP +
      probe(
        ROOT +
          `h at s 0
holder rec h 0
r fold step 3 s p1
old at holder 0
x get old 0
` +
          RESULT,
      ),
    slices: 1,
    expected: (args) => {
      const [a, b] = pair(args);
      return score(a, changed(a, b));
    },
    facts:
      'h direct last is before fold, but firstEscape(holder) < fold; clone initial array field.',
  },
  {
    name: 'earlier array holder with repeated elements keeps an escaped borrow',
    source:
      STEP +
      probe(
        ROOT +
          `h at s 0
holder arr h h
r fold step 3 s p1
old get holder 1
x get old 0
` +
          RESULT,
      ),
    slices: 1,
    expected: (args) => {
      const [a, b] = pair(args);
      return score(a, changed(a, b));
    },
    facts: 'Repeated holder operands must both be scanned; aggregate arr is an escape.',
  },
  {
    name: 'mov and duplicate select arms forward an aggregate-call escape',
    source:
      HOLD +
      STEP +
      probe(
        ROOT +
          `h at s 0
m mov h
q eq p0 0
alias select q m m
holder call hold alias
r fold step 3 s p1
old at holder 0
x get old 0
` +
          RESULT,
      ),
    slices: 1,
    expected: (args) => {
      const [a, b] = pair(args);
      return score(a, changed(a, b));
    },
    facts: 'Backward min escape must traverse select and mov. Duplicate DAG edges are idempotent.',
  },
  {
    name: 'current borrowed extra prevents transfer despite last-use equality',
    source:
      `fn step (u32x2,u32) u32 u32x2 -> (u32x2,u32)
h at p0 0
c at p0 1
v get h 0
old get p2 0
w add v old
a set h 0 w
d add c 1
s rec a d
ret s
end
` +
      probe(
        ROOT +
          `h at s 0
r fold step 3 s h
result_array at r 0
c at r 1
x get result_array 0
out add x c
ret out`,
      ),
    slices: 1,
    expected: (args) => {
      const [a] = pair(args);
      return add(mul(a, 4), 3);
    },
    facts: 'descLast == site rejects consume; mutableHere alone excludes the current node.',
  },
  {
    name: 'returned select borrow sets descendant last to the return ordinal',
    source:
      STEP +
      probe(
        ROOT +
          `h at s 0
m mov h
q eq p0 0
alias select q m m
r fold step 3 s p1
ret alias`,
      ).replace('fn probe u32 u32 -> u32', 'fn probe u32 u32 -> u32x2'),
    slices: 1,
    expected: (args) => {
      const [a, b] = pair(args);
      return [a, b];
    },
    facts: 'No earlier escape is necessary: return=n+1 propagates through select/mov to root.',
  },
  {
    name: 'same root used as initializer and extra needs duplicate guard',
    source:
      `fn step (u32x2,u32) u32 (u32x2,u32) -> (u32x2,u32)
h at p0 0
c at p0 1
old at p2 0
v get h 0
x get old 0
w add v x
a set h 0 w
d add c 1
s rec a d
ret s
end
` +
      probe(
        ROOT +
          `r fold step 3 s s
result_array at r 0
c at r 1
x get result_array 0
out add x c
ret out`,
      ),
    slices: 1,
    expected: (args) => {
      const [a] = pair(args);
      return add(mul(a, 4), 3);
    },
    facts: 'Root lastUseCount=2 at fold; firstBad==site alone cannot reject this.',
  },
  {
    name: 'duplicate arrays in final record reject deep callback proof',
    source:
      `fn step (u32x2,u32x2,u32) u32 u32 -> (u32x2,u32x2,u32)
h at p0 0
old at p0 1
c at p0 2
v get h 0
w add v p2
a set h 0 w
x get old 0
d add c x
s rec a a d
ret s
end
` +
      probe(`a arr p0 p1
b arr p1 p0
s rec a b 0
r fold step 3 s p1
h at r 0
c at r 2
x get h 0
out add x c
ret out`),
    slices: 3,
    expected: (args) => {
      const [a, b] = pair(args);
      return add(mul(a, 3), mul(b, 7));
    },
    facts:
      'Both final-rec array operands are current uses; duplicate guard prevents deep invariant violation.',
  },
  {
    name: 'duplicate field projections reject exclusive child mutation',
    source:
      `fn step (u32x2,u32) u32 u32 -> (u32x2,u32)
h at p0 0
old at p0 0
c at p0 1
v get h 0
w add v p2
a set h 0 w
x get old 0
d add c x
s rec a d
ret s
end
` +
      probe(
        ROOT +
          `r fold step 3 s p1
h at r 0
c at r 1
x get h 0
out add x c
ret out`,
      ),
    slices: 3,
    expected: (args) => {
      const [a, b] = pair(args);
      return add(mul(a, 4), mul(b, 6));
    },
    facts:
      'Two at(parent,0) definitions must make uniqueProjection=false, even if each has one use.',
  },
  {
    name: 'deep final record reuses storage while preserving parallel swap values',
    source:
      `fn step (u32x2,u32x2,u32) u32 u32 -> (u32x2,u32x2,u32)
h at p0 0
old at p0 1
c at p0 2
v get h 0
w add v p2
a set h 0 w
x get old 0
d add c x
s rec old a d
ret s
end
` +
      probe(`a arr p0 p1
b arr p1 p0
s rec a b 0
r fold step 3 s p1
h at r 0
k at r 1
c at r 2
x get h 0
y get k 0
q mul x 31
v add q y
out add v c
ret out`),
    slices: 0,
    expected: (args) => {
      const [a, b] = pair(args);
      let left: [number, number] = [a, b],
        right: [number, number] = [b, a],
        c = 0;
      for (let trip = 0; trip < 3; trip++) {
        const updated: [number, number] = [add(left[0], b), left[1]];
        c = add(c, right[0]);
        [left, right] = [right, updated];
      }
      return score(left[0], right[0], c);
    },
    facts:
      'Mode deep only: final rec may overwrite p0 fields after all source values have SSA temporaries.',
  },
  {
    name: 'earlier mov is a bad direct use despite dead direct source',
    source: probe(`a arr p0 p1
alias mov a
b set a 0 p1
x get alias 0
y get b 0
q mul x 31
out add q y
ret out`),
    slices: 1,
    expected: (args) => {
      const [a, b] = pair(args);
      return add(mul(a, 31), b);
    },
    facts:
      'firstBad(mov)<set blocks mutableHere. firstEscape(mov) is exempt; the facts have different meanings.',
  },
  {
    name: 'same operand return blocks a dead update',
    source: probe(`a arr p0 p1
b set a 0 p1
ret a`).replace('fn probe u32 u32 -> u32', 'fn probe u32 u32 -> u32x2'),
    slices: 1,
    expected: (args) => {
      const [a, b] = pair(args);
      return [a, b];
    },
    facts: 'Return ordinal n+1 blocks in-place set even though the set result itself is dead.',
  },
  {
    name: 'zero-node zero-param function has no p0 fact row',
    source: 'fn probe -> u32\nret 7\nend\n',
    inputs: [[]],
    slices: 0,
    expected: () => 7,
    facts:
      'finish_fn must not inspect a nonexistent parameter fact when the entire facts vector is empty.',
  },
  {
    name: 'zero-param record constructor uses only node and literal operand types',
    source:
      STEP +
      `fn probe -> u32
a arr 1 2
s rec a 0
r fold step 3 s 13
h at r 0
c at r 1
x get h 0
out add x c
ret out
end
`,
    inputs: [[]],
    slices: 0,
    expected: () => 43,
    facts:
      'Canonical ctx pads the empty parameter vector with harmless type0; source still needs no semantic p0 read.',
  },
];
