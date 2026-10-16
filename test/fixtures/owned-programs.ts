// Independent observations of old fields, aliases and rebuilt records.
const top = `fn probe u32 u32 -> u32
a arr p0 p1 3 4 5 6 7 8
s rec a p0
r fold step 17 s p1
h at r 0
x get h 0
y at r 1
z get a 0
v add x y
w add v z
ret w
end
`;
const cases: [string, string][] = [
  [
    'owned field',
    `fn step (u32x8,u32) u32 u32 -> (u32x8,u32)
h at p0 0
c at p0 1
v get h p1
w add v p2
a set h p1 w
n add c v
s rec a n
ret s
end
${top}`,
  ],
  [
    'same field read twice',
    `fn step (u32x8,u32) u32 u32 -> (u32x8,u32)
h at p0 0
old at p0 0
c at p0 1
a set h p1 p2
v get old 0
n add c v
s rec a n
ret s
end
${top}`,
  ],
  [
    'whole parent call alias',
    `fn copy (u32x8,u32) -> (u32x8,u32)
ret p0
end
fn step (u32x8,u32) u32 u32 -> (u32x8,u32)
old call copy p0
h at p0 0
c at p0 1
a set h p1 p2
q at old 0
v get q 0
n add c v
s rec a n
ret s
end
${top}`,
  ],
  [
    'borrowed nested field read after update',
    `fn step ((u32x8,u32),u32) u32 u32 -> ((u32x8,u32),u32)
h at p0 0
old at h 0
c at p0 1
z arr p2 p2 p2 p2 p2 p2 p2 p2
a put h 0 z
v get old 0
n add c v
s rec a n
ret s
end
fn probe u32 u32 -> u32
a arr p0 p1 3 4 5 6 7 8
h rec a p0
s rec h p1
r fold step 17 s p0
f at r 0
b at f 0
x get b 0
y at r 1
z get a 0
v add x y
w add v z
ret w
end
`,
  ],
];
for (const swap of [true, false])
  cases.push([
    swap ? 'swap array fields' : 'repeat one source into two fields',
    `fn step (u32x8,u32x8,u32) u32 u32 -> (u32x8,u32x8,u32)
a at p0 0
b at p0 1
c at p0 2
v get b 0
n add c v
${swap ? 's rec b a n' : 'h set a p1 p2\ns rec h h n'}
ret s
end
fn probe u32 u32 -> u32
a arr p0 p1 3 4 5 6 7 8
b arr p1 p0 8 7 6 5 4 3
s rec a b 0
r fold step 17 s p0
x at r 0
y at r 1
c at r 2
u get x 0
v get y 0
w mul u 31
z add w v
out add z c
ret out
end
`,
  ]);

export const RECORD_CASES = cases;
export const PREDICATE_BODIES = [
  'a lt p0 p2\nret a',
  'a ne p0 p3\nret a',
  'a le p2 p0\nret a',
  'a eq 4294967295 p2\nret a',
  'a lt p0 p2\nb ne p1 p3\nc and a b\nret c',
  'a lt p0 p2\nb ne p1 p3\nc or a b\nret c',
  'a lt p0 p2\nb ne p1 p3\nc xor a b\nret c',
  'a lt p0 p2\nb and a a\nret b',
  'a lt p0 p2\nb ne p1 p3\nc and a b\nd or a b\nret c',
  'a lt p0 p2\nb ne p1 p3\nc or a b\nd le p0 p3\ne and c d\nret e',
  'a and p2 8\nb eq a 8\nret b',
  'a and p2 8\nb eq a 0\nret b',
  'a lt p0 p2\nb and a true\nret b',
  'a div p2 p0\nb ge p1 1\nc ne a 0\nd and b c\nret d',
];
