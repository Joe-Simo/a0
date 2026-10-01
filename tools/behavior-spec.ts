/**
 * The behavior table, written once: small A0 programs and the argument rows to run them on.
 * No expected value appears here. `bun run behavior -- --regen` runs every row through the
 * reference interpreter and the independent BigInt oracle (tools/corpus.ts), refuses to write a
 * row where the two disagree, and writes the agreed values inline into tools/behavior-table.ts.
 * tools/behavior.ts then fans the table out across every backend.
 */

import type { Value } from '../src/core.js';

/** One row of the generated table (tools/behavior-table.ts): arguments and the agreed result. */
export interface BehaviorRow {
  readonly fn: string;
  readonly args: readonly Value[];
  readonly input?: readonly number[];
  readonly expected: Value;
  /** A strict-profile row that traps: the exact trap line; `expected` is then 0 and unused. */
  readonly trap?: string;
  /** Expected io output words for a function with a trailing io parameter. */
  readonly output?: readonly number[];
}

export interface BehaviorRowSpec {
  readonly args: readonly Value[];
  /** Input words for a function with a trailing io parameter. */
  readonly input?: readonly number[];
}

export interface BehaviorCallSpec {
  readonly fn: string;
  readonly rows: readonly BehaviorRowSpec[];
}

export interface BehaviorProgramSpec {
  readonly name: string;
  /** Which behavior the program pins down. */
  readonly about: string;
  /** The program uses an io token: backends that refuse io must list a skip with a reason. */
  readonly io: boolean;
  /** `strict`: the source starts with `profile strict` and the program runs on the strict group of the table. */
  readonly profile?: 'strict';
  /** The program uses the checked ops (cadd .. cget), which only some targets implement. */
  readonly checkedOps?: true;
  readonly source: string;
  readonly calls: readonly BehaviorCallSpec[];
}

const B = [0, 1, 31, 32, 0x8000_0000, 0xffff_ffff];
const WORDS = [0, 1, 7, 0x7fff_ffff, 0x8000_0000, 0xffff_ffff, 123_456_789];

const rowsOf = (...lists: readonly (readonly Value[])[]): BehaviorRowSpec[] =>
  lists
    .reduce<Value[][]>((acc, list) => acc.flatMap((p) => list.map((v) => [...p, v])), [[]])
    .map((args) => ({ args }));

const one = (vals: readonly Value[]): BehaviorRowSpec[] => vals.map((v) => ({ args: [v] }));
const BOOLS: readonly Value[] = [false, true];

const EDGES = [0, 1, 2, 0x7fff_ffff, 0x8000_0000, 0xffff_ffff];
const CHECKED_BINARY = ['cadd', 'csub', 'cmul', 'cdiv', 'crem'] as const;

/** The six checked ops as scalar functions: `<p>_<op>_v` (the value) and `<p>_<op>_ok` (the flag). */
const checkedSource = (head: string, p: string): string =>
  `${head}${[...CHECKED_BINARY]
    .map(
      (op) => `fn ${p}_${op}_v u32 u32 -> u32
r ${op} p0 p1
v at r 0
ret v
end
fn ${p}_${op}_ok u32 u32 -> bool
r ${op} p0 p1
v at r 1
ret v
end
`,
    )
    .join('')}fn ${p}_cget_v u32 -> u32
a arr 5 6 7 8
r cget a p0
v at r 0
ret v
end
fn ${p}_cget_ok u32 -> bool
a arr 5 6 7 8
r cget a p0
v at r 1
ret v
end
`;

const checkedCalls = (p: string): BehaviorCallSpec[] => [
  ...CHECKED_BINARY.flatMap((op) => [
    { fn: `${p}_${op}_v`, rows: rowsOf(EDGES, EDGES) },
    { fn: `${p}_${op}_ok`, rows: rowsOf(EDGES, EDGES) },
  ]),
  { fn: `${p}_cget_v`, rows: one([0, 1, 3, 4, 0x8000_0000, 0xffff_ffff]) },
  { fn: `${p}_cget_ok`, rows: one([0, 1, 3, 4, 0x8000_0000, 0xffff_ffff]) },
];

const IDX = [0, 1, 2, 3, 4, 0x7fff_ffff, 0xffff_ffff];

export const BEHAVIOR_SPEC: readonly BehaviorProgramSpec[] = [
  {
    name: 'arith',
    about: 'u32 arithmetic wraps mod 2^32; div and rem are total; shifts use the low five bits',
    io: false,
    source: `fn add_wrap u32 u32 -> u32
r add p0 p1
ret r
end
fn sub_wrap u32 u32 -> u32
r sub p0 p1
ret r
end
fn mul_wrap u32 u32 -> u32
r mul p0 p1
ret r
end
fn div_total u32 u32 -> u32
r div p0 p1
ret r
end
fn rem_total u32 u32 -> u32
r rem p0 p1
ret r
end
fn shl_mask u32 u32 -> u32
r shl p0 p1
ret r
end
fn shr_mask u32 u32 -> u32
r shr p0 p1
ret r
end
fn rotl u32 u32 -> u32
l shl p0 p1
n sub 32 p1
r shr p0 n
o or l r
ret o
end
fn mix u32 u32 u32 -> u32
a xor p0 p1
b and a p2
c or b p0
d mul c 2654435761
e shr d 13
f xor d e
ret f
end
`,
    calls: [
      { fn: 'add_wrap', rows: rowsOf(WORDS, WORDS) },
      { fn: 'sub_wrap', rows: rowsOf(WORDS, WORDS) },
      { fn: 'mul_wrap', rows: rowsOf(WORDS, WORDS) },
      { fn: 'div_total', rows: rowsOf(WORDS, WORDS) },
      { fn: 'rem_total', rows: rowsOf(WORDS, WORDS) },
      { fn: 'shl_mask', rows: rowsOf(WORDS, B) },
      { fn: 'shr_mask', rows: rowsOf(WORDS, B) },
      { fn: 'rotl', rows: rowsOf(WORDS, B) },
      {
        fn: 'mix',
        rows: rowsOf([0, 0xffff_ffff, 123_456_789], [1, 0x8000_0000, 7], [0, 0xffff_ffff]),
      },
    ],
  },
  {
    name: 'logic',
    about: 'bool logic, comparisons (unsigned), select computes both arms',
    io: false,
    source: `fn xor_bool bool bool -> bool
r xor p0 p1
ret r
end
fn and_bool bool bool -> bool
r and p0 p1
ret r
end
fn or_bool bool bool -> bool
r or p0 p1
ret r
end
fn eq_bool bool bool -> bool
r eq p0 p1
ret r
end
fn ne_bool bool bool -> bool
r ne p0 p1
ret r
end
fn sel u32 u32 bool -> u32
r select p2 p0 p1
ret r
end
fn cmp_bits u32 u32 -> u32
a lt p0 p1
b le p0 p1
c gt p0 p1
d ge p0 p1
e eq p0 p1
f ne p0 p1
a1 select a 1 0
b1 select b 2 0
c1 select c 4 0
d1 select d 8 0
e1 select e 16 0
f1 select f 32 0
s1 or a1 b1
s2 or s1 c1
s3 or s2 d1
s4 or s3 e1
s5 or s4 f1
ret s5
end
fn both_arms u32 u32 bool -> u32
q div p0 p1
r rem p0 p1
s select p2 q r
ret s
end
`,
    calls: [
      { fn: 'xor_bool', rows: rowsOf(BOOLS, BOOLS) },
      { fn: 'and_bool', rows: rowsOf(BOOLS, BOOLS) },
      { fn: 'or_bool', rows: rowsOf(BOOLS, BOOLS) },
      { fn: 'eq_bool', rows: rowsOf(BOOLS, BOOLS) },
      { fn: 'ne_bool', rows: rowsOf(BOOLS, BOOLS) },
      { fn: 'sel', rows: rowsOf([0, 0xffff_ffff, 7], [1, 0x8000_0000], BOOLS) },
      { fn: 'cmp_bits', rows: rowsOf(WORDS, WORDS) },
      { fn: 'both_arms', rows: rowsOf([0, 9, 0xffff_ffff], [0, 3], BOOLS) },
    ],
  },
  {
    name: 'array',
    about: 'array values: get reduces the index modulo the length, set returns a copy',
    io: false,
    source: `fn arr_get u32 u32 -> u32
a arr p0 7 p1 9
r get a p1
ret r
end
fn arr_set_copy u32 u32 -> u32
a arr 1 2 3 4
b set a p0 p1
x get a p0
y get b p0
z mul x 1000
w add z y
ret w
end
fn arr_chain u32 u32 -> u32
a arr 10 20 30
b set a p0 p1
c set b p1 p0
d get c 0
e get c 1
f get c 2
g mul d 10000
h mul e 100
i add g h
j add i f
ret j
end
`,
    calls: [
      {
        fn: 'arr_get',
        rows: rowsOf([0, 5, 0xffff_ffff], [0, 1, 2, 3, 4, 0xffff_fffe, 0xffff_ffff]),
      },
      { fn: 'arr_set_copy', rows: rowsOf([0, 1, 2, 3, 4, 0xffff_ffff], [0, 99, 0xffff_ffff]) },
      { fn: 'arr_chain', rows: rowsOf([0, 1, 2, 5], [0, 1, 2, 7]) },
    ],
  },
  {
    name: 'record',
    about: 'records: rec, at, put (a copy), records inside arrays and arrays inside records',
    io: false,
    source: `fn rec_put u32 bool -> u32
r rec p0 p1
s put r 0 7
a at r 0
b at s 0
c at s 1
d select c b a
ret d
end
fn rec_in_arr u32 u32 -> u32
a rec p0 true
b rec p1 false
c arr a b
d get c p0
e at d 0
ret e
end
fn arr_in_rec u32 u32 -> u32
a arr p0 p1 3
r rec a p1
s at r 0
t get s p1
ret t
end
`,
    calls: [
      { fn: 'rec_put', rows: rowsOf([0, 5, 0xffff_ffff], BOOLS) },
      { fn: 'rec_in_arr', rows: rowsOf([0, 1, 9], [4, 0xffff_ffff]) },
      { fn: 'arr_in_rec', rows: rowsOf([0, 1, 9], [0, 1, 2, 5]) },
    ],
  },
  {
    name: 'iterate',
    about: 'fold and loop: zero trips, extras, early stop by predicate, aggregate state, nesting',
    io: false,
    source: `fn sum_body u32 u32 -> u32
a add p0 p1
ret a
end
fn sum_to u32 -> u32
r fold sum_body p0 0
ret r
end
fn scale_body u32 u32 u32 -> u32
a mul p1 p2
b add p0 a
ret b
end
fn fold_extra u32 u32 -> u32
r fold scale_body p0 5 p1
ret r
end
fn dbl u32 u32 u32 -> u32
a add p0 p0
ret a
end
fn below u32 u32 u32 -> bool
a lt p0 p2
ret a
end
fn grow u32 u32 -> u32
r loop below dbl p0 1 p1
ret r
end
fn fill u32x4 u32 -> u32x4
a mul p1 p1
b set p0 p1 a
ret b
end
fn fill_sum u32 -> u32
z arr 0 0 0 0
f fold fill p0 z
a get f 0
b get f 1
c get f 2
d get f 3
s add a b
t add c d
u add s t
ret u
end
fn inner_add u32 u32 -> u32
a add p0 p1
ret a
end
fn outer_step u32 u32 u32 -> u32
r fold inner_add p2 p0
ret r
end
fn nested u32 u32 -> u32
a fold outer_step p0 0 p1
ret a
end
`,
    calls: [
      { fn: 'sum_to', rows: one([0, 1, 2, 10, 100, 70_000]) },
      { fn: 'fold_extra', rows: rowsOf([0, 1, 5, 40], [0, 3, 0xffff_ffff]) },
      { fn: 'grow', rows: rowsOf([0, 1, 5, 31, 40], [0, 1, 100, 0x8000_0000, 0xffff_ffff]) },
      { fn: 'fill_sum', rows: one([0, 1, 2, 4, 9]) },
      { fn: 'nested', rows: rowsOf([0, 1, 3, 6], [0, 1, 4, 9]) },
    ],
  },
  {
    name: 'calls',
    about: 'call chains and the call/ID shorthand, callee results feeding callers',
    io: false,
    source: `fn sq u32 -> u32
r mul p0 p0
ret r
end
fn hyp u32 u32 -> u32
a call sq p0
b sq p1
c add a b
ret c
end
fn chain u32 -> u32
a call hyp p0 3
b call hyp a p0
ret b
end
fn pick bool u32 -> u32
a call sq p1
b call hyp p1 1
c select p0 a b
ret c
end
`,
    calls: [
      { fn: 'hyp', rows: rowsOf(WORDS, WORDS) },
      { fn: 'chain', rows: one(WORDS) },
      { fn: 'pick', rows: rowsOf(BOOLS, WORDS) },
    ],
  },
  {
    name: 'bigret',
    about:
      'a u32 literal of 2^28 or more as the ret operand (the IR ret word packs 28 bits; larger literals are a kind-5 operand), alone and through callers',
    io: false,
    source: `fn lit27 -> u32
ret 268435455
end
fn lit28 -> u32
ret 268435456
end
fn lit31 -> u32
ret 2147483648
end
fn lit32 -> u32
ret 4294967295
end
fn via u32 -> u32
a call lit31
b add a p0
ret b
end
fn pass u32 -> u32
a call lit28
b call lit32
c add a b
d add c p0
ret d
end
`,
    calls: [
      { fn: 'lit27', rows: [{ args: [] }] },
      { fn: 'lit28', rows: [{ args: [] }] },
      { fn: 'lit31', rows: [{ args: [] }] },
      { fn: 'lit32', rows: [{ args: [] }] },
      { fn: 'via', rows: one(WORDS) },
      { fn: 'pass', rows: one(WORDS) },
    ],
  },
  {
    name: 'text',
    about: 'text literals are arrays of UTF-8 bytes with escapes',
    io: false,
    source: `fn text_sum -> u32
s text "A0\\n"
a get s 0
b get s 1
c get s 2
d add a b
e add d c
ret e
end
fn text_at u32 -> u32
s text "hello, \\"w\\" \\t#"
a get s p0
ret a
end
`,
    calls: [
      { fn: 'text_sum', rows: [{ args: [] }] },
      { fn: 'text_at', rows: one([0, 1, 7, 8, 9, 11, 12, 100]) },
    ],
  },
  {
    name: 'io',
    about:
      'io tokens order effects: read (0 when exhausted), write, puts, folds that thread the stream',
    io: true,
    source: `fn io_sum io -> u32
a read p0
av at a 0
ta at a 1
b read ta
bv at b 0
tb at b 1
s add av bv
w write tb s
ret s
end
fn io_scale u32 io -> u32
a read p1
v at a 0
t at a 1
m mul v p0
w write t m
ret m
end
fn io_puts u32 io -> u32
a arr p0 7 3
w puts p1 a
ret p0
end
fn acc (u32,io) u32 -> (u32,io)
t at p0 1
s at p0 0
r read t
v at r 0
t2 at r 1
n add s v
o rec n t2
ret o
end
fn io_total u32 io -> u32
z rec 0 p1
f fold acc p0 z
s at f 0
ret s
end
`,
    calls: [
      {
        fn: 'io_sum',
        rows: [[], [5], [5, 7], [0xffff_ffff, 1, 99], [3, 4, 5]].map((input) => ({
          args: [],
          input,
        })),
      },
      {
        fn: 'io_scale',
        rows: [
          { args: [3], input: [] },
          { args: [3], input: [14, 15] },
          { args: [0xffff_ffff], input: [2] },
        ],
      },
      {
        fn: 'io_puts',
        rows: [
          { args: [0], input: [] },
          { args: [8], input: [1] },
        ],
      },
      {
        fn: 'io_total',
        rows: [
          { args: [0], input: [1, 2, 3] },
          { args: [3], input: [1, 2, 3, 4] },
          { args: [5], input: [10, 20] },
          { args: [4], input: [0xffff_ffff, 1, 2, 3] },
        ],
      },
    ],
  },
  {
    name: 'checked',
    about:
      'the total checked ops return (value, ok): cadd/csub/cmul flag overflow, cdiv/crem a zero divisor, cget an index at or past the length',
    io: false,
    checkedOps: true,
    source: checkedSource('', 'c'),
    calls: checkedCalls('c'),
  },
  {
    name: 'strict_checked',
    about: 'the checked ops give the same values under profile strict, and never trap',
    io: false,
    profile: 'strict',
    checkedOps: true,
    source: checkedSource('profile strict\n', 'sc'),
    calls: checkedCalls('sc'),
  },
  {
    name: 'strict_index',
    about:
      'profile strict: get/set at or past the length trap bounds (a dead get too, and a get in the untaken select arm), an index proved in range does not',
    io: false,
    profile: 'strict',
    source: `profile strict
fn s_get u32 -> u32
a arr 10 20 30
r get a p0
ret r
end
fn s_set_sum u32 -> u32
a arr 10 20 30
b set a p0 99
x get b 0
y get b 1
z get b 2
t add x y
u add t z
ret u
end
fn s_mask u32 -> u32
a arr 10 20 30 40
m and p0 3
r get a m
ret r
end
fn s_mod u32 -> u32
a arr 10 20 30
m rem p0 3
r get a m
ret r
end
fn s_dead_get u32 -> u32
a arr 1 2 3
b get a p0
ret 7
end
fn s_select_arms u32 -> u32
a arr 1 2
b get a p0
c select true 7 b
ret c
end
`,
    calls: [
      { fn: 's_get', rows: one(IDX) },
      { fn: 's_set_sum', rows: one(IDX) },
      { fn: 's_mask', rows: one(IDX) },
      { fn: 's_mod', rows: one(IDX) },
      { fn: 's_dead_get', rows: one(IDX) },
      { fn: 's_select_arms', rows: one(IDX) },
    ],
  },
  {
    name: 'strict_div',
    about:
      'profile strict: div/rem by zero trap divzero (a dead div too); a divisor proved nonzero does not; the first trap in node order wins',
    io: false,
    profile: 'strict',
    source: `profile strict
fn s_div u32 u32 -> u32
r div p0 p1
ret r
end
fn s_rem u32 u32 -> u32
r rem p0 p1
ret r
end
fn s_div8 u32 -> u32
r div p0 8
ret r
end
fn s_rem7 u32 -> u32
r rem p0 7
ret r
end
fn s_or1 u32 u32 -> u32
d or p1 1
r div p0 d
ret r
end
fn s_dead_div u32 -> u32
a div 1 p0
ret 5
end
fn s_order u32 u32 -> u32
d div 1 p0
a arr 1 2
g get a p1
r add d g
ret r
end
`,
    calls: [
      { fn: 's_div', rows: rowsOf(WORDS, [0, 1, 7, 0xffff_ffff]) },
      { fn: 's_rem', rows: rowsOf(WORDS, [0, 1, 7, 0xffff_ffff]) },
      { fn: 's_div8', rows: one(WORDS) },
      { fn: 's_rem7', rows: one(WORDS) },
      { fn: 's_or1', rows: rowsOf([0, 5, 0xffff_ffff], [0, 1, 0xffff_ffff]) },
      { fn: 's_dead_div', rows: one([0, 1, 0xffff_ffff]) },
      { fn: 's_order', rows: rowsOf([0, 1, 2], [0, 1, 2, 5]) },
    ],
  },
  {
    name: 'strict_wrap',
    about: 'profile strict: add, sub, mul and the shifts still wrap and mask; they never trap',
    io: false,
    profile: 'strict',
    source: `profile strict
fn s_add u32 u32 -> u32
r add p0 p1
ret r
end
fn s_sub u32 u32 -> u32
r sub p0 p1
ret r
end
fn s_mul u32 u32 -> u32
r mul p0 p1
ret r
end
fn s_shl u32 u32 -> u32
r shl p0 p1
ret r
end
fn s_shr u32 u32 -> u32
r shr p0 p1
ret r
end
`,
    calls: [
      { fn: 's_add', rows: rowsOf(WORDS, WORDS) },
      { fn: 's_sub', rows: rowsOf(WORDS, WORDS) },
      { fn: 's_mul', rows: rowsOf(WORDS, WORDS) },
      { fn: 's_shl', rows: rowsOf(WORDS, B) },
      { fn: 's_shr', rows: rowsOf(WORDS, B) },
    ],
  },
  {
    name: 'strict_iterate',
    about:
      'profile strict: a trap in a fold or loop body names the node, the trip and the call chain; an aggregate-state fold updated in place traps before it writes',
    io: false,
    profile: 'strict',
    source: `profile strict
fn s_step u32 u32 -> u32
a arr 1 2 3
b get a p1
c add p0 b
ret c
end
fn s_top u32 -> u32
r fold s_step p0 0
ret r
end
fn s_outer u32 -> u32
a call s_top p0
b add a 1
ret b
end
fn s_lbody u32 u32 -> u32
a arr 5 6 7
g get a p1
s add p0 g
ret s
end
fn s_lpred u32 u32 -> bool
c lt p0 100
ret c
end
fn s_loop u32 -> u32
r loop s_lpred s_lbody p0 0
ret r
end
fn s_fill u32x4 u32 -> u32x4
a mul p1 p1
b set p0 p1 a
ret b
end
fn s_fill_sum u32 -> u32
z arr 0 0 0 0
f fold s_fill p0 z
a get f 0
b get f 1
c get f 2
d get f 3
s add a b
t add c d
u add s t
ret u
end
`,
    calls: [
      { fn: 's_top', rows: one([0, 1, 3, 4, 9]) },
      { fn: 's_outer', rows: one([0, 3, 4]) },
      { fn: 's_loop', rows: one([0, 3, 4, 9]) },
      { fn: 's_fill_sum', rows: one([0, 1, 4, 5]) },
    ],
  },
  {
    name: 'strict_io',
    about:
      'profile strict: a read after the last input word traps input (inside a fold too); within the input it reads as usual',
    io: true,
    profile: 'strict',
    source: `profile strict
fn s_io_scale u32 io -> u32
a read p1
v at a 0
t at a 1
m mul v p0
w write t m
ret m
end
fn s_acc (u32,io) u32 -> (u32,io)
t at p0 1
s at p0 0
r read t
v at r 0
t2 at r 1
n add s v
o rec n t2
ret o
end
fn s_io_total u32 io -> u32
z rec 0 p1
f fold s_acc p0 z
s at f 0
ret s
end
`,
    calls: [
      {
        fn: 's_io_scale',
        rows: [
          { args: [3], input: [] },
          { args: [3], input: [14, 15] },
          { args: [0xffff_ffff], input: [2] },
        ],
      },
      {
        fn: 's_io_total',
        rows: [
          { args: [0], input: [] },
          { args: [3], input: [1, 2, 3, 4] },
          { args: [3], input: [1, 2] },
          { args: [2], input: [] },
        ],
      },
    ],
  },
];
