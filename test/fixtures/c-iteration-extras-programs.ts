export const OWNED_EXTRA_CASES = [
  [
    'owned/ref variants locally update 4096-byte array extras',
    `fn pred (u32x8,u32) u32 u32x1024 -> bool
old get p2 p1
a set p2 p1 p1
v get a p1
n add old v
k and n 3
b le p1 k
ret b
end
fn step (u32x8,u32) u32 u32x1024 -> (u32x8,u32)
h at p0 0
c at p0 1
old get p2 p1
a set p2 p1 c
v get a p1
n add old v
k set h p1 n
s rec k n
ret s
end
fn probe u32 u32 -> u32
a arr p0 p1 3 4 5 6 7 8
e arr p1 p0 ${Array(1022).fill('3').join(' ')}
s rec a p0
r loop pred step 17 s e
h at r 0
c at r 1
x get h 0
y get e 0
z add x c
out add z y
ret out
end
`,
  ],
  [
    'owned/ref variants locally update nested-record extras',
    `fn pred (u32x8,u32) u32 (u32x8,u32) -> bool
h at p2 0
old get h p1
a set h p1 p1
n put p2 0 a
k at n 0
v get k p1
c add old v
d and c 3
b le p1 d
ret b
end
fn step (u32x8,u32) u32 (u32x8,u32) -> (u32x8,u32)
h at p0 0
c at p0 1
x at p2 0
old get x p1
a set x p1 c
t put p2 0 a
k at t 0
v get k p1
n add old v
b set h p1 n
s rec b n
ret s
end
fn probe u32 u32 -> u32
a arr p0 p1 3 4 5 6 7 8
b arr p1 p0 8 7 6 5 4 3
e rec b p1
s rec a p0
r loop pred step 17 s e
h at r 0
c at r 1
old at e 0
x get old 0
y get h 0
z add x y
out add z c
ret out
end
`,
  ],
  [
    'owned/ref variants locally update record extras',
    `fn pred (u32x8,u32) u32 (u32,u32) -> bool
old at p2 0
a put p2 0 p1
v at a 0
n add old v
k and n 3
b le p1 k
ret b
end
fn step (u32x8,u32) u32 (u32,u32) -> (u32x8,u32)
h at p0 0
c at p0 1
old at p2 0
a put p2 0 c
v at a 0
n add old v
b set h p1 n
s rec b n
ret s
end
fn probe u32 u32 -> u32
a arr p0 p1 3 4 5 6 7 8
e rec p1 p0
s rec a p0
r loop pred step 17 s e
h at r 0
c at r 1
x get h 0
y at e 0
z add x c
out add z y
ret out
end
`,
  ],
  [
    'owned/ref variants locally update large array extras',
    `fn pred u32x8 u32 u32x1025 -> bool
old get p2 p1
a set p2 p1 p1
v get a p1
n add old v
k and n 3
b le p1 k
ret b
end
fn step u32x8 u32 u32x1025 -> u32x8
old get p2 p1
a set p2 p1 p1
v get a p1
n add old v
b set p0 p1 n
ret b
end
fn probe u32 u32 -> u32
a arr p0 p1 3 4 5 6 7 8
e arr p1 p0 ${Array(1023).fill('3').join(' ')}
r loop pred step 17 a e
x get r 0
y get e 0
out add x y
ret out
end
`,
  ],
] as const;

export const IO_EXTRA_CASES = [
  [
    'token extra',
    `fn step (u32x8,u32) u32 io -> (u32x8,u32)
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
fn probe u32 io -> u32
a arr p0 1 2 3 4 5 6 7
s rec a 0
r fold step 9 s p1
h at r 0
c at r 1
x get h 0
y get a 0
z add x y
out add z c
ret out
end
`,
  ],
  [
    'IO-containing record extra',
    `fn step (u32x8,u32) u32 (u32x8,io) -> (u32x8,u32)
h at p0 0
c at p0 1
external at p2 0
tok at p2 1
k and p1 7
rd read tok
v at rd 0
t at rd 1
old get external k
local set external k v
q get local k
w add old c
out write t w
z add v q
a set h k z
n add c old
s rec a n
ret s
end
fn probe u32 io -> u32
a arr p0 1 2 3 4 5 6 7
external arr p0 7 6 5 4 3 2 1
e rec external p1
s rec a 0
r fold step 9 s e
h at r 0
c at r 1
x get h 0
y get external 0
z add x y
out add z c
ret out
end
`,
  ],
] as const;

const REPEATED = `fn pred u32x8 u32 u32x8 u32x8 -> bool
old get p3 p1
left set p2 p1 p1
v get left p1
right set p3 p1 1
w get right p1
x add old v
y add x w
k and y 3
b le p1 k
ret b
end
fn step u32x8 u32 u32x8 u32x8 -> u32x8
old get p3 p1
left set p2 p1 p1
v get left p1
right set p3 p1 1
w get right p1
n add v w
q add n old
a set p0 p1 q
ret a
end
fn probe u32 u32 -> u32
a arr p0 p1 3 4 5 6 7 8
r loop pred step COUNT a a a
x get r 0
y get a 0
z get r 7
w add x y
out add w z
ret out
end
`;

/** Share one body/predicate; zero trips and repeated aliases remain distinct observations. */
export function repeatedExtrasProgram(): string {
  const header = 'fn probe u32 u32 -> u32';
  const split = REPEATED.indexOf(header);
  const helpers = REPEATED.slice(0, split);
  const top = REPEATED.slice(split + header.length);
  return (
    helpers +
    [0, 17].map((n) => `fn probe${n} u32 u32 -> u32${top.replace('COUNT', String(n))}`).join('')
  );
}

export const STRICT_EXTRA_CASES = [
  [
    'ref bounds after local extra update',
    `profile strict
fn pred u32x8 u32 u32x8 -> bool
k and p1 7
a set p2 k p1
v get a p1
b eq v p1
ret b
end
fn step u32x8 u32 u32x8 -> u32x8
k and p1 7
v get p2 k
a set p0 k v
ret a
end
fn probe u32 u32 -> u32
a arr p0 p1 3 4 5 6 7 8
r loop pred step 9 a a
v get r 0
ret v
end
`,
  ],
  [
    'owned divzero after state update',
    `profile strict
fn step (u32x8,u32) u32 u32x8 u32 -> (u32x8,u32)
h at p0 0
c at p0 1
k and p1 7
v get p2 k
a set h k v
q div c p3
n add q v
s rec a n
ret s
end
fn probe u32 u32 -> u32
a arr p0 p1 3 4 5 6 7 8
s rec a p0
r fold step 3 s a p1
c at r 1
ret c
end
`,
  ],
] as const;

const PARALLEL_BODY = `fn step u32x128 u32 u32x128 u32x128 -> u32x128
old get p2 p1
v add old p1
other get p3 p1
w add old v
x add w other
a set p0 p1 x
ret a
end
`;

export function parallelExtrasProgram(count: 0 | 128 | 'n'): string {
  return (
    PARALLEL_BODY +
    `fn probe u32 u32 -> u32
a arr p0 p1 ${Array(126).fill('3').join(' ')}
n and p1 127
r fold step ${count} a a a
x get r 0
y get a 0
w get r 127
z add x y
out add z w
ret out
end
`
  );
}

/** Returning an extra must copy its value into state before later updates to that state. */
export const RETURN_EXTRA_CASES = [
  ['direct extra', 'u32x8', 'ret p2', 'e arr p1 p0 3 4 5 6 7 8', 'e'],
  ['moved extra', 'u32x8', 'x mov p2\nret x', 'e arr p1 p0 3 4 5 6 7 8', 'e'],
  ['selected extra', 'u32x8', 'b eq p1 0\nx select b p2 p0\nret x', 'e arr p1 p0 3 4 5 6 7 8', 'e'],
  [
    'borrowed record field',
    '(u32x8,u32)',
    'x at p2 0\nret x',
    'e arr p1 p0 3 4 5 6 7 8\nx rec e p0',
    'x',
  ],
].map(
  ([name, type, body, create, extra]) =>
    [
      name,
      `fn take u32x8 u32 ${type} -> u32x8
${body}
end
fn change u32x8 u32 -> u32x8
r set p0 p1 p1
ret r
end
fn probe u32 u32 -> u32
a arr p0 p1 8 7 6 5 4 3
${create}
n and p1 3
r fold take n a ${extra}
z fold change 3 r
v get z 0
old get e 0
initial get a 0
t add v old
out add t initial
ret out
end
`,
    ] as const,
);

/** No later initializer use masks the identical-state/extra snapshot requirement. */
export const SNAPSHOT_EXTRA = `fn step u32x8 u32 u32x8 -> u32x8
a set p0 p1 99
old get p2 p1
current get a 0
v add old current
b set a 0 v
ret b
end
fn probe u32 u32 -> u32
a arr p0 p1 3 4 5 6 7 8
n and p1 7
r fold step n a a
v get r 0
ret v
end
`;
