/** Value and alias regressions for nested native record-state iterations. */
export const INTERMEDIATE_RECORD_CASES = [
  [
    'later scalar at of old p0',
    `fn keep (u32x8,u32) u32 -> (u32x8,u32)
h at p0 0
a set h p1 p1
c at p0 1
s rec a c
ret s
end
fn step (u32x8,u32) u32 u32 -> (u32x8,u32)
h at p0 0
a set h 0 p2
st rec a 1
lim and p2 1
r fold keep lim st
old at p0 1
b at r 0
s rec b old
ret s
end
fn probe u32 u32 -> u32
a arr p0 p1 3 4 5 6 7 8
s rec a 7
count and p1 3
r fold step count s p1
x at r 0
c at r 1
v get x 0
y mul v 31
out add y c
ret out
end
`,
  ],
  [
    'later read of old set-result alias',
    `fn change (u32x8,u32) u32 -> (u32x8,u32)
h at p0 0
a set h 0 99
c at p0 1
s rec a c
ret s
end
fn step (u32x8,u32) u32 u32 -> (u32x8,u32)
h at p0 0
a set h 0 p2
st rec a 1
lim and p2 1
r fold change lim st
old get a 0
b at r 0
s rec b old
ret s
end
fn probe u32 u32 -> u32
a arr p0 p1 3 4 5 6 7 8
s rec a 7
count and p1 3
r fold step count s p1
x at r 0
c at r 1
v get x 0
y mul v 31
out add y c
ret out
end
`,
  ],
  [
    'generic intermediate record with zero or positive inner trips',
    `fn turn (u32x8,u32) u32 u32 -> (u32x8,u32)
h at p0 0
c at p0 1
k add p1 p2
a set h p1 k
n add c 1
s rec a n
ret s
end
fn step (u32x8,u32) u32 u32 -> (u32x8,u32)
h at p0 0
acc at p0 1
a set h p1 p2
st rec a 1
lim and p2 7
r fold turn lim st p1
b at r 0
c at r 1
old add acc 3
n add old c
s rec b n
ret s
end
fn probe u32 u32 -> u32
a arr p0 p1 3 4 5 6 7 8
s rec a 7
trips and p1 3
r fold step trips s p1
x at r 0
c at r 1
v get x 0
y mul v 31
out add y c
ret out
end
`,
  ],
  [
    'old aggregate borrow after intermediate record',
    `fn turn (u32x8,u32) u32 u32 -> (u32x8,u32)
h at p0 0
c at p0 1
k add p1 p2
a set h p1 k
n add c 1
s rec a n
ret s
end
fn step (u32x8,u32) u32 u32 -> (u32x8,u32)
h at p0 0
acc at p0 1
a set h p1 p2
st rec a 1
lim and p2 7
r fold turn lim st p1
b at r 0
c at r 1
old get h 0
prior add old c
n add prior acc
s rec b n
ret s
end
fn probe u32 u32 -> u32
a arr p0 p1 3 4 5 6 7 8
s rec a 7
trips and p1 3
r fold step trips s p1
x at r 0
c at r 1
v get x 0
y mul v 31
out add y c
ret out
end
`,
  ],
  [
    'old parent passed as an extra across intermediate record',
    `fn turn (u32x8,u32) u32 (u32x8,u32) -> (u32x8,u32)
h at p0 0
c at p0 1
old at p2 0
v get old p1
a set h p1 v
n add c v
s rec a n
ret s
end
fn step (u32x8,u32) u32 u32 -> (u32x8,u32)
h at p0 0
acc at p0 1
a set h p1 p2
st rec a 1
lim and p2 7
r fold turn lim st p0
b at r 0
c at r 1
n add acc c
s rec b n
ret s
end
fn probe u32 u32 -> u32
a arr p0 p1 3 4 5 6 7 8
s rec a 7
trips and p1 3
r fold step trips s p1
x at r 0
c at r 1
v get x 0
y mul v 31
out add y c
ret out
end
`,
  ],
  [
    'old field passed as an extra across intermediate record',
    `fn turn (u32x8,u32) u32 u32x8 -> (u32x8,u32)
h at p0 0
c at p0 1
old mov p2
v get old p1
a set h p1 v
n add c v
s rec a n
ret s
end
fn step (u32x8,u32) u32 u32 -> (u32x8,u32)
h at p0 0
acc at p0 1
a set h p1 p2
st rec a 1
lim and p2 7
r fold turn lim st h
b at r 0
c at r 1
n add acc c
s rec b n
ret s
end
fn probe u32 u32 -> u32
a arr p0 p1 3 4 5 6 7 8
s rec a 7
trips and p1 3
r fold step trips s p1
x at r 0
c at r 1
v get x 0
y mul v 31
out add y c
ret out
end
`,
  ],
  [
    'intermediate record swaps physical array fields',
    `fn turn (u32x8,u32x8,u32) u32 u32 -> (u32x8,u32x8,u32)
h at p0 0
k at p0 1
c at p0 2
a set h p1 p2
b set k p1 c
n add c 1
s rec a b n
ret s
end
fn step (u32x8,u32x8,u32) u32 u32 -> (u32x8,u32x8,u32)
h at p0 0
k at p0 1
acc at p0 2
st rec k h 1
lim and p2 7
r fold turn lim st p1
b at r 0
c at r 1
v at r 2
n add acc v
s rec b c n
ret s
end
fn probe u32 u32 -> u32
a arr p0 p1 3 4 5 6 7 8
b arr p1 p0 8 7 6 5 4 3
s rec a b 7
trips and p1 3
r fold step trips s p1
h at r 0
k at r 1
c at r 2
x get h 0
y get k 0
z mul x 31
v mul y 7
u add z v
out add u c
ret out
end
`,
  ],
  [
    'intermediate rebuild retains many earlier scalar reads under register pressure',
    `fn turn (u32x8,u32) u32 u32 -> (u32x8,u32)
h at p0 0
c at p0 1
k add p1 p2
a set h p1 k
n add c 1
s rec a n
ret s
end
fn step (u32x8,u32) u32 u32 -> (u32x8,u32)
h at p0 0
acc at p0 1
v0 get h 0
w0 mul v0 3
x0 add w0 p2
v1 get h 1
w1 mul v1 5
x1 add w1 p2
v2 get h 2
w2 mul v2 7
x2 add w2 p2
v3 get h 3
w3 mul v3 9
x3 add w3 p2
v4 get h 4
w4 mul v4 11
x4 add w4 p2
v5 get h 5
w5 mul v5 13
x5 add w5 p2
v6 get h 6
w6 mul v6 15
x6 add w6 p2
v7 get h 7
w7 mul v7 17
x7 add w7 p2
v8 get h 0
w8 mul v8 19
x8 add w8 p2
v9 get h 1
w9 mul v9 21
x9 add w9 p2
v10 get h 2
w10 mul v10 23
x10 add w10 p2
v11 get h 3
w11 mul v11 25
x11 add w11 p2
v12 get h 4
w12 mul v12 27
x12 add w12 p2
v13 get h 5
w13 mul v13 29
x13 add w13 p2
v14 get h 6
w14 mul v14 31
x14 add w14 p2
v15 get h 7
w15 mul v15 33
x15 add w15 p2
v16 get h 0
w16 mul v16 35
x16 add w16 p2
v17 get h 1
w17 mul v17 37
x17 add w17 p2
v18 get h 2
w18 mul v18 39
x18 add w18 p2
v19 get h 3
w19 mul v19 41
x19 add w19 p2
a set h p1 p2
st rec a 1
lim and p2 7
r fold turn lim st p1
b at r 0
c at r 1
n add acc c
q0 xor n x0
q1 xor q0 x1
q2 xor q1 x2
q3 xor q2 x3
q4 xor q3 x4
q5 xor q4 x5
q6 xor q5 x6
q7 xor q6 x7
q8 xor q7 x8
q9 xor q8 x9
q10 xor q9 x10
q11 xor q10 x11
q12 xor q11 x12
q13 xor q12 x13
q14 xor q13 x14
q15 xor q14 x15
q16 xor q15 x16
q17 xor q16 x17
q18 xor q17 x18
q19 xor q18 x19
s rec b q19
ret s
end
fn probe u32 u32 -> u32
a arr p0 p1 3 4 5 6 7 8
s rec a 7
trips and p1 3
r fold step trips s p1
x at r 0
c at r 1
v get x 0
y mul v 31
out add y c
ret out
end
`,
  ],
  [
    'chained intermediate record swaps physical array fields',
    `fn turn (u32x1025,u32x1025,u32) u32 u32 -> (u32x1025,u32x1025,u32)
h at p0 0
k at p0 1
c at p0 2
a set h p1 p2
b set k p1 c
n add c 1
s rec a b n
ret s
end
fn step (u32x1025,u32x1025,u32) u32 u32 -> (u32x1025,u32x1025,u32)
h at p0 0
k at p0 1
acc at p0 2
a set h 0 p2
st rec a k 1
lim and p2 1
r fold turn lim st p1
b at r 0
c at r 1
v at r 2
st2 rec c b v
r2 fold turn lim st2 p1
x at r2 0
y at r2 1
z at r2 2
n add acc z
s rec x y n
ret s
end
fn probe u32 u32 -> u32
a arr p0 p1 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3
b arr p1 p0 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5 5
s rec a b 7
count and p1 3
r fold step count s p1
h at r 0
k at r 1
c at r 2
x get h 1
y get k 1
z mul x 31
v mul y 7
u add z v
out add u c
ret out
end
`,
  ],
  [
    'prior parent identity call retains snapshot at size 1024',
    `fn copy (u32x1024,u32) -> (u32x1024,u32)
ret p0
end
fn change (u32x1024,u32) u32 -> (u32x1024,u32)
h at p0 0
a set h 0 99
c at p0 1
s rec a c
ret s
end
fn step (u32x1024,u32) u32 u32 -> (u32x1024,u32)
h at p0 0
acc at p0 1
old call copy p0
a set h 0 p2
st rec a 1
r fold change 1 st
q at old 0
v get q 0
b at r 0
n add acc v
s rec b n
ret s
end
fn probe u32 u32 -> u32
a arr p0 p1 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3
s rec a 7
r fold step 1 s p1
h at r 0
c at r 1
v get h 0
w mul v 31
out add w c
ret out
end
`,
  ],
  [
    'prior field identity call retains snapshot at size 1024',
    `fn copy u32x1024 -> u32x1024
ret p0
end
fn change (u32x1024,u32) u32 -> (u32x1024,u32)
h at p0 0
a set h 0 99
c at p0 1
s rec a c
ret s
end
fn step (u32x1024,u32) u32 u32 -> (u32x1024,u32)
h at p0 0
acc at p0 1
old call copy h
a set h 0 p2
st rec a 1
r fold change 1 st
v get old 0
b at r 0
n add acc v
s rec b n
ret s
end
fn probe u32 u32 -> u32
a arr p0 p1 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3
s rec a 7
r fold step 1 s p1
h at r 0
c at r 1
v get h 0
w mul v 31
out add w c
ret out
end
`,
  ],
  [
    'prior parent identity call retains snapshot at size 1025',
    `fn copy (u32x1025,u32) -> (u32x1025,u32)
ret p0
end
fn change (u32x1025,u32) u32 -> (u32x1025,u32)
h at p0 0
a set h 0 99
c at p0 1
s rec a c
ret s
end
fn step (u32x1025,u32) u32 u32 -> (u32x1025,u32)
h at p0 0
acc at p0 1
old call copy p0
a set h 0 p2
st rec a 1
r fold change 1 st
q at old 0
v get q 0
b at r 0
n add acc v
s rec b n
ret s
end
fn probe u32 u32 -> u32
a arr p0 p1 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3
s rec a 7
r fold step 1 s p1
h at r 0
c at r 1
v get h 0
w mul v 31
out add w c
ret out
end
`,
  ],
  [
    'prior field identity call retains snapshot at size 1025',
    `fn copy u32x1025 -> u32x1025
ret p0
end
fn change (u32x1025,u32) u32 -> (u32x1025,u32)
h at p0 0
a set h 0 99
c at p0 1
s rec a c
ret s
end
fn step (u32x1025,u32) u32 u32 -> (u32x1025,u32)
h at p0 0
acc at p0 1
old call copy h
a set h 0 p2
st rec a 1
r fold change 1 st
v get old 0
b at r 0
n add acc v
s rec b n
ret s
end
fn probe u32 u32 -> u32
a arr p0 p1 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3
s rec a 7
r fold step 1 s p1
h at r 0
c at r 1
v get h 0
w mul v 31
out add w c
ret out
end
`,
  ],
  [
    'earlier whole-state identity call',
    `fn identity (u32x8,u32) -> (u32x8,u32)
ret p0
end
fn turn (u32x8,u32) u32 -> (u32x8,u32)
h at p0 0
c at p0 1
a set h 0 99
s rec a c
ret s
end
fn step (u32x8,u32) u32 u32 -> (u32x8,u32)
old call identity p0
h at p0 0
acc at p0 1
a set h 0 p2
st rec a 1
r fold turn 1 st
oldh at old 0
v get oldh 0
b at r 0
n add acc v
s rec b n
ret s
end
fn probe u32 u32 -> u32
a arr p0 p1 3 4 5 6 7 8
s rec a 7
r fold step 1 s p1
h at r 0
c at r 1
v get h 0
w mul v 31
out add w c
ret out
end
`,
  ],
  [
    'earlier projected-field identity call',
    `fn identity u32x8 -> u32x8
ret p0
end
fn turn (u32x8,u32) u32 -> (u32x8,u32)
h at p0 0
c at p0 1
a set h 0 99
s rec a c
ret s
end
fn step (u32x8,u32) u32 u32 -> (u32x8,u32)
h at p0 0
old call identity h
acc at p0 1
a set h 0 p2
st rec a 1
r fold turn 1 st
v get old 0
b at r 0
n add acc v
s rec b n
ret s
end
fn probe u32 u32 -> u32
a arr p0 p1 3 4 5 6 7 8
s rec a 7
r fold step 1 s p1
h at r 0
c at r 1
v get h 0
w mul v 31
out add w c
ret out
end
`,
  ],
  [
    'two intermediate rebuilds with a fresh first initializer',
    `fn identity u32x8 -> u32x8
ret p0
end
fn keep (u32x8,u32) u32 -> (u32x8,u32)
ret p0
end
fn turn (u32x8,u32) u32 -> (u32x8,u32)
h at p0 0
c at p0 1
a set h 0 99
s rec a c
ret s
end
fn step (u32x8,u32) u32 u32 -> (u32x8,u32)
acc at p0 1
z arr p2 p1 3 4 5 6 7 8
st1 rec z 1
r1 fold keep 1 st1
b at r1 0
old call identity b
c set b 1 p1
st2 rec c 2
r2 fold turn 1 st2
v get old 0
d at r2 0
n add acc v
s rec d n
ret s
end
fn probe u32 u32 -> u32
a arr p0 p1 3 4 5 6 7 8
s rec a 7
r fold step 1 s p1
h at r 0
c at r 1
v get h 0
w mul v 31
out add w c
ret out
end
`,
  ],
  [
    'earlier identity call of an in-place set result',
    `fn identity u32x8 -> u32x8
ret p0
end
fn turn (u32x8,u32) u32 -> (u32x8,u32)
h at p0 0
c at p0 1
a set h 0 99
s rec a c
ret s
end
fn step (u32x8,u32) u32 u32 -> (u32x8,u32)
h at p0 0
acc at p0 1
a set h 0 p2
old call identity a
b set a 1 p1
st rec b 1
r fold turn 1 st
v get old 0
k at r 0
n add acc v
s rec k n
ret s
end
fn probe u32 u32 -> u32
a arr p0 p1 3 4 5 6 7 8
s rec a 7
r fold step 1 s p1
h at r 0
c at r 1
v get h 0
w mul v 31
out add w c
ret out
end
`,
  ],
  [
    'earlier rec observation',
    `fn turn (u32x8,u32) u32 -> (u32x8,u32)
h at p0 0
c at p0 1
a set h 0 99
s rec a c
ret s
end
fn step (u32x8,u32) u32 u32 -> (u32x8,u32)
h at p0 0
acc at p0 1
old rec h 3
a set h 0 p2
st rec a 1
r fold turn 1 st
saved at old 0
v get saved 0
b at r 0
n add acc v
s rec b n
ret s
end
fn probe u32 u32 -> u32
a arr p0 p1 3 4 5 6 7 8
s rec a 7
r fold step 1 s p1
h at r 0
c at r 1
v get h 0
w mul v 31
out add w c
ret out
end
`,
  ],
  [
    'earlier arr observation',
    `fn turn (u32x8,u32) u32 -> (u32x8,u32)
h at p0 0
c at p0 1
a set h 0 99
s rec a c
ret s
end
fn step (u32x8,u32) u32 u32 -> (u32x8,u32)
h at p0 0
acc at p0 1
old arr h h
a set h 0 p2
st rec a 1
r fold turn 1 st
saved get old 1
v get saved 0
b at r 0
n add acc v
s rec b n
ret s
end
fn probe u32 u32 -> u32
a arr p0 p1 3 4 5 6 7 8
s rec a 7
r fold step 1 s p1
h at r 0
c at r 1
v get h 0
w mul v 31
out add w c
ret out
end
`,
  ],
  [
    'earlier mov observation',
    `fn turn (u32x8,u32) u32 -> (u32x8,u32)
h at p0 0
c at p0 1
a set h 0 99
s rec a c
ret s
end
fn step (u32x8,u32) u32 u32 -> (u32x8,u32)
h at p0 0
acc at p0 1
old mov h
a set h 0 p2
st rec a 1
r fold turn 1 st
v get old 0
b at r 0
n add acc v
s rec b n
ret s
end
fn probe u32 u32 -> u32
a arr p0 p1 3 4 5 6 7 8
s rec a 7
r fold step 1 s p1
h at r 0
c at r 1
v get h 0
w mul v 31
out add w c
ret out
end
`,
  ],
  [
    'earlier select observation',
    `fn turn (u32x8,u32) u32 -> (u32x8,u32)
h at p0 0
c at p0 1
a set h 0 99
s rec a c
ret s
end
fn step (u32x8,u32) u32 u32 -> (u32x8,u32)
h at p0 0
acc at p0 1
c eq p2 0
old select c h h
a set h 0 p2
st rec a 1
r fold turn 1 st
v get old 0
b at r 0
n add acc v
s rec b n
ret s
end
fn probe u32 u32 -> u32
a arr p0 p1 3 4 5 6 7 8
s rec a 7
r fold step 1 s p1
h at r 0
c at r 1
v get h 0
w mul v 31
out add w c
ret out
end
`,
  ],
  [
    'earlier scalar call observation',
    `fn scalar (u32x8,u32) -> u32
h at p0 0
v get h 0
c at p0 1
n add v c
ret n
end
fn turn (u32x8,u32) u32 -> (u32x8,u32)
h at p0 0
c at p0 1
a set h 0 99
s rec a c
ret s
end
fn step (u32x8,u32) u32 u32 -> (u32x8,u32)
h at p0 0
acc at p0 1
old call scalar p0
a set h 0 p2
st rec a 1
r fold turn 1 st
v mov old
b at r 0
n add acc v
s rec b n
ret s
end
fn probe u32 u32 -> u32
a arr p0 p1 3 4 5 6 7 8
s rec a 7
r fold step 1 s p1
h at r 0
c at r 1
v get h 0
w mul v 31
out add w c
ret out
end
`,
  ],
  [
    'boolean array and scalar boolean survive an intermediate rebuild',
    `fn turn (boolx8,bool,u32) u32 u32 -> (boolx8,bool,u32)
h at p0 0
flag at p0 1
acc at p0 2
bit and p2 1
odd ne bit 0
next xor flag odd
a set h p1 next
n add acc p2
s rec a next n
ret s
end
fn step (boolx8,bool,u32) u32 u32 -> (boolx8,bool,u32)
h at p0 0
flag at p0 1
acc at p0 2
old get h p1
next xor flag old
a set h p1 next
st rec a next 1
lim and p2 7
r fold turn lim st p2
b at r 0
current at r 1
c at r 2
combined xor flag current
n add acc c
s rec b combined n
ret s
end
fn probe u32 u32 -> u32
first ne p0 0
last ne p1 0
a arr first false true false true false true last
s rec a first 7
count and p1 3
r fold step count s p1
h at r 0
flag at r 1
acc at r 2
v get h 0
x select v p0 p1
y select flag 37 11
z add x y
out add z acc
ret out
end
`,
  ],
  [
    'strict dynamic nested fold traps after a valid state update',
    `profile strict
fn turn (u32x8,u32) u32 u32 -> (u32x8,u32)
h at p0 0
c at p0 1
k add p1 p2
a set h p1 k
x get a p2
n add c x
s rec a n
ret s
end
fn step (u32x8,u32) u32 u32 -> (u32x8,u32)
h at p0 0
acc at p0 1
a set h p1 p2
st rec a 1
lim and p2 7
r fold turn lim st p2
b at r 0
c at r 1
old add acc 3
n add old c
s rec b n
ret s
end
fn probe u32 u32 -> u32
a arr p0 p1 3 4 5 6 7 8
s rec a 7
count and p1 3
r fold step count s p1
x at r 0
c at r 1
v get x 0
y mul v 31
out add y c
ret out
end
`,
  ],
  [
    'IO extra excludes an intermediate rebuild and preserves ordered effects',
    `fn turn (u32x8,u32) u32 -> (u32x8,u32)
h at p0 0
c at p0 1
a set h p1 c
n add c 1
s rec a n
ret s
end
fn step (u32x8,u32) u32 io -> (u32x8,u32)
h at p0 0
acc at p0 1
rd read p2
v at rd 0
t at rd 1
a set h p1 v
st rec a 1
lim and v 3
r fold turn lim st
b at r 0
c at r 1
n add acc v
q add n c
out write t q
s rec b q
ret s
end
fn probe u32 io -> u32
a arr p0 1 2 3 4 5 6 7
s rec a 7
r fold step 3 s p1
h at r 0
c at r 1
v get h 0
out add v c
ret out
end
`,
  ],
  [
    'private intermediate record survives scalar pressure across a residual call',
    `fn mix u32 u32 -> u32
m0 xor p0 p1
m1 mul m0 1664527
m2 add m1 1013904257
m3 shr m2 8
m4 add m3 p0
m5 xor m4 p1
m6 mul m5 1664537
m7 add m6 1013904342
m8 shr m7 13
m9 add m8 p0
m10 xor m9 p1
m11 mul m10 1664547
m12 add m11 1013904427
m13 shr m12 18
m14 add m13 p0
m15 xor m14 p1
m16 mul m15 1664557
m17 add m16 1013904512
m18 shr m17 23
m19 add m18 p0
m20 xor m19 p1
m21 mul m20 1664567
m22 add m21 1013904597
m23 shr m22 5
m24 add m23 p0
m25 xor m24 p1
m26 mul m25 1664577
m27 add m26 1013904682
m28 shr m27 10
m29 add m28 p0
m30 xor m29 p1
m31 mul m30 1664587
m32 add m31 1013904767
m33 shr m32 15
m34 add m33 p0
m35 xor m34 p1
m36 mul m35 1664597
m37 add m36 1013904852
m38 shr m37 20
m39 add m38 p0
m40 xor m39 p1
m41 mul m40 1664607
m42 add m41 1013904937
m43 shr m42 25
m44 add m43 p0
m45 xor m44 p1
m46 mul m45 1664617
m47 add m46 1013905022
m48 shr m47 7
m49 add m48 p0
m50 xor m49 p1
m51 mul m50 1664627
m52 add m51 1013905107
m53 shr m52 12
m54 add m53 p0
m55 xor m54 p1
m56 mul m55 1664637
m57 add m56 1013905192
m58 shr m57 17
m59 add m58 p0
m60 xor m59 p1
m61 mul m60 1664647
m62 add m61 1013905277
m63 shr m62 22
m64 add m63 p0
m65 xor m64 p1
m66 mul m65 1664657
m67 add m66 1013905362
m68 shr m67 27
m69 add m68 p0
m70 xor m69 p1
m71 mul m70 1664667
m72 add m71 1013905447
m73 shr m72 9
m74 add m73 p0
m75 xor m74 p1
m76 mul m75 1664677
m77 add m76 1013905532
m78 shr m77 14
m79 add m78 p0
m80 xor m79 p1
m81 mul m80 1664687
m82 add m81 1013905617
m83 shr m82 19
m84 add m83 p0
m85 xor m84 p1
m86 mul m85 1664697
m87 add m86 1013905702
m88 shr m87 24
m89 add m88 p0
m90 xor m89 p1
m91 mul m90 1664707
m92 add m91 1013905787
m93 shr m92 6
m94 add m93 p0
m95 xor m94 p1
m96 mul m95 1664717
m97 add m96 1013905872
m98 shr m97 11
m99 add m98 p0
ret m99
end
fn turn (u32x8,u32) u32 u32 -> (u32x8,u32)
h at p0 0
acc at p0 1
a set h p1 p2
n add acc 1
s rec a n
ret s
end
fn step (u32x8,u32) u32 u32 -> (u32x8,u32)
h at p0 0
acc at p0 1
v0 get h 0
x0 add v0 p2
v1 get h 1
x1 xor v1 p2
v2 get h 2
x2 add v2 p2
v3 get h 3
x3 xor v3 p2
v4 get h 4
x4 add v4 p2
v5 get h 5
x5 xor v5 p2
v6 get h 6
x6 add v6 p2
v7 get h 7
x7 xor v7 p2
a set h p1 p2
st rec a 1
arg add p2 acc
m call mix arg p1
lim and m 7
r fold turn lim st m
b at r 0
c at r 1
n add acc c
q0 xor n x0
q1 xor q0 x1
q2 xor q1 x2
q3 xor q2 x3
q4 xor q3 x4
q5 xor q4 x5
q6 xor q5 x6
q7 xor q6 x7
out add q7 m
s rec b out
ret s
end
fn probe u32 u32 -> u32
a arr p0 p1 3 4 5 6 7 8
s rec a 7
count and p1 3
r fold step count s p1
h at r 0
c at r 1
v get h 0
w mul v 31
out add w c
ret out
end
`,
  ],
] as const;
