import type { Case } from '../../../tools/corpus.js';
import { CHECKED_SOURCE, checkedCases } from '../checked-ops-fixtures.js';

// This module is deliberately data/oracle only: importing it does not parse, compile,
// execute, or inspect the emitter. The shared checked fixture supplies all six checked
// operations, direct scalar projections, call-returned records, tuple updates and folds.
export const NATIVE_EXTRA_SOURCE = `fn j_scalar u32 u32 u32 -> u32
sum add p0 p1
delta sub p0 p1
product mul sum delta
q div product p1
r rem product p1
left shl p0 p2
right shr p0 p2
both and sum delta
either or left right
x xor product both
y xor q r
z xor either x
out xor z y
ret out
end
fn j_cmp u32 u32 -> u32
e eq p0 p1
n ne p0 p1
l lt p0 p1
leq le p0 p1
g gt p0 p1
geq ge p0 p1
b0 select e 1 0
b1 select n 2 0
b2 select l 4 0
b3 select leq 8 0
b4 select g 16 0
b5 select geq 32 0
s0 add b0 b1
s1 add b2 b3
s2 add b4 b5
t add s0 s1
out add t s2
ret out
end
fn j_bool bool bool -> bool
a and p0 p1
b or p0 p1
c xor p0 p1
d eq c a
e ne b c
out select d e b
ret out
end
fn j_digest u32x3 -> u32
a get p0 0
b get p0 1
c get p0 2
d mul b 3
e mul c 5
f add a d
out add f e
ret out
end
fn j_arr_id u32x3 -> u32x3
copy mov p0
ret copy
end
fn j_nested u32 u32 bool -> u32
a arr p0 p1 2147483648
alias call j_arr_id a
r rec alias p2
other rec a false
rows arr r other
old get rows 0
oldarr at old 0
changed set alias p1 77
local put r 0 changed
rowsnew set rows 0 local
selected select p2 rowsnew rows
chosen get selected 0
chosenarr at chosen 0
othernew get rowsnew 1
otherarr at othernew 0
h0 call j_digest a
h1 call j_digest chosenarr
h2 call j_digest otherarr
h3 call j_digest oldarr
w0 mul h0 3
w1 mul h1 5
w2 mul h2 7
w3 mul h3 11
s0 add w0 w1
s1 add w2 w3
out add s0 s1
ret out
end
fn j_step (u32x3,u32) u32 u32 u32 -> (u32x3,u32)
a at p0 0
counter at p0 1
value add counter p1
next set a p1 value
n add counter p2
out rec next n
ret out
end
fn j_pred (u32x3,u32) u32 u32 u32 -> bool
out lt p1 p3
ret out
end
fn j_fold u32 u32 u32 -> u32
a arr p1 2147483648 4294967295
s rec a p1
r fold j_step p0 s p2 0
finalarr at r 0
counter at r 1
fresh call j_digest finalarr
old call j_digest a
x xor fresh old
out xor x counter
ret out
end
fn j_loop u32 u32 u32 u32 -> u32
a arr p1 2147483648 4294967295
s rec a p1
r loop j_pred j_step p0 s p2 p3
finalarr at r 0
counter at r 1
fresh call j_digest finalarr
old call j_digest a
x xor fresh old
out xor x counter
ret out
end
fn j_tap u32 io -> (u32,io)
w write p1 p0
out rec p0 w
ret out
end
fn j_io u32 io -> u32
r0 read p1
v0 at r0 0
t0 at r0 1
r1 read t0
v1 at r1 0
t1 at r1 1
r2 read t1
v2 at r2 0
t2 at r2 1
sum cadd v0 v1
value at sum 0
ok at sum 1
tag select ok 1 0
tap call j_tap p0 t2
token at tap 1
w0 write token value
w1 write w0 tag
bytes text "é#\\n"
w2 puts w1 bytes
out xor value v2
ret out
end
fn j_io_step u32 u32 io -> u32
out add p0 p1
w write p2 out
ret out
end
fn j_io_fold u32 u32 io -> u32
out fold j_io_step p0 p1 p2
ret out
end
`;

export const NATIVE_PORT_SOURCE = `${CHECKED_SOURCE}${NATIVE_EXTRA_SOURCE}`;

const MASK = 0xffff_ffffn;
const word = (value: bigint): number => Number(value & MASK);
const xorWords = (a: number, b: number): number => word(BigInt(a) ^ BigInt(b));
const digest = (a: readonly number[]): number =>
  word(BigInt(a[0] as number) + 3n * BigInt(a[1] as number) + 5n * BigInt(a[2] as number));

function scalar(a: number, b: number, distance: number): number {
  const x = BigInt(a);
  const y = BigInt(b);
  const sum = (x + y) & MASK;
  const delta = (x - y) & MASK;
  const product = (sum * delta) & MASK;
  const shift = BigInt(distance % 32);
  const quotient = y === 0n ? MASK : product / y;
  const remainder = y === 0n ? product : product % y;
  return word(
    (((x << shift) & MASK) | (x >> shift)) ^ product ^ (sum & delta) ^ quotient ^ remainder,
  );
}

function nested(a: number, index: number, takeChanged: boolean): number {
  const original = [a, index, 0x8000_0000];
  const changed = [...original];
  changed[index % 3] = 77;
  // Three retained aliases have weights 3, 7 and 11; only the selected branch
  // can observe the independently changed array (weight 5).
  return word(
    21n * BigInt(digest(original)) + 5n * BigInt(digest(takeChanged ? changed : original)),
  );
}

function iteration(count: number, seed: number, increment: number): number {
  const initial = [seed, 0x8000_0000, 0xffff_ffff];
  const cells = [...initial];
  let counter = BigInt(seed);
  for (let i = 0; i < count; i++) {
    cells[i % 3] = word(counter + BigInt(i));
    counter = (counter + BigInt(increment)) & MASK;
  }
  return word(BigInt(digest(cells)) ^ BigInt(digest(initial)) ^ counter);
}

export function nativeExtraCases(): Case[] {
  const cases: Case[] = [];
  const edges = [0, 1, 2, 3, 7, 0x7fff_ffff, 0x8000_0000, 0xffff_fffe, 0xffff_ffff];
  const distances = [0, 1, 31, 32, 33, 63, 0xffff_ffff];
  for (const a of edges)
    for (const b of edges) {
      for (const d of distances)
        cases.push({ functionName: 'j_scalar', args: [a, b, d], expected: scalar(a, b, d) });
      // Exactly one of these three unsigned relations holds. This truth table
      // supplies all six comparison bits without reproducing Java comparisons.
      cases.push({
        functionName: 'j_cmp',
        args: [a, b],
        expected: a === b ? 1 + 8 + 32 : a < b ? 2 + 4 + 8 : 2 + 16 + 32,
      });
    }

  // Explicit truth table for the boolean expression, rather than using its ops.
  for (const [a, b, expected] of [
    [false, false, false],
    [false, true, true],
    [true, false, true],
    [true, true, true],
  ] as const)
    cases.push({ functionName: 'j_bool', args: [a, b], expected });

  for (const a of [0, 1, 0x8000_0000, 0xffff_ffff])
    for (const index of [0, 1, 2, 3, 7, 0x8000_0000, 0xffff_ffff])
      for (const changed of [false, true])
        cases.push({
          functionName: 'j_nested',
          args: [a, index, changed],
          expected: nested(a, index, changed),
        });

  for (const count of [0, 1, 2, 3, 7, 9, 11])
    for (const seed of [0, 7, 0xffff_ffff])
      for (const increment of [0, 1, 0x8000_0000, 0xffff_ffff]) {
        cases.push({
          functionName: 'j_fold',
          args: [count, seed, increment],
          expected: iteration(count, seed, increment),
        });
        for (const limit of [0, 1, 4, 9, 0xffff_ffff])
          cases.push({
            functionName: 'j_loop',
            args: [count, seed, increment, limit],
            expected: iteration(Math.min(count, limit), seed, increment),
          });
      }

  const streams = [
    [],
    [0],
    [0xffff_ffff],
    [0xffff_ffff, 1],
    [0x8000_0000, 0x8000_0000, 7],
    [3, 4, 5, 6],
  ];
  for (const tag of [0, 0x8000_0000, 0xffff_ffff])
    for (const input of streams) {
      const total = BigInt(input[0] ?? 0) + BigInt(input[1] ?? 0);
      const value = word(total);
      cases.push({
        functionName: 'j_io',
        args: [tag],
        input,
        expected: xorWords(value, input[2] ?? 0),
        expectedOutput: [tag, value, total <= MASK ? 1 : 0, 4, 0xc3, 0xa9, 0x23, 0x0a],
      });
    }

  for (const count of [0, 1, 2, 9, 17])
    for (const seed of [0, 0xffff_ffff]) {
      const expectedOutput = Array.from({ length: count }, (_, i) =>
        word(BigInt(seed) + (BigInt(i) * BigInt(i + 1)) / 2n),
      );
      cases.push({
        functionName: 'j_io_fold',
        args: [count, seed],
        input: [],
        expected: word(BigInt(seed) + (BigInt(count) * BigInt(count - 1)) / 2n),
        expectedOutput,
      });
    }
  return cases;
}

export function nativePortCases(): Case[] {
  return [...checkedCases(), ...nativeExtraCases()];
}

export const NATIVE_PORT_PURE_SOURCE =
  CHECKED_SOURCE + NATIVE_EXTRA_SOURCE.slice(0, NATIVE_EXTRA_SOURCE.indexOf('fn j_tap '));

export function nativePortPureCases(): Case[] {
  return nativePortCases().filter(
    (item) => item.input === undefined && item.expectedOutput === undefined,
  );
}
