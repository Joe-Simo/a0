/**
 * The exec-bench kernel set: each kernel in A0 with its hand-written C, JavaScript and Rust
 * baselines (identical u32 wrapping semantics), plus the C and Rust drivers that wrap a kernel
 * in the common xorshift32 input loop and print one "ns-per-call checksum" line. Shared by
 * tools/exec-bench.ts and tools/lang-axes.ts so both measure the same programs.
 */

import { ITER, type KernelName } from './exec-bench-languages.js';

export interface Kernel {
  readonly name: KernelName;
  readonly arity: number;
  readonly a0: string;
  readonly c: string;
  readonly js: string;
  /** Hand-written Rust with identical wrapping semantics (compiled with rustc -O). */
  readonly rust: string;
  /**
   * Token axis only (tools/lang-axes.ts, tools/dense-tokens.ts): the A0 text to count when the
   * timed `a0` source is deliberately not the plain program every competitor writes (noop keeps
   * redundant identity ops so exec-bench checks the optimizer adds no work). Never timed.
   */
  readonly a0TokenSource?: string;
  /** Divides the iteration counts for kernels whose single call does much more work. */
  readonly iterScale?: number;
  /** Reason the direct arm64 backend is not timed on this kernel (reported as blocked). */
  readonly noArm64?: string;
}

const zeros = (n: number): string => Array.from({ length: n }, () => '0').join(' ');
const ZEROS_4096 = zeros(4096);
/** a[i] = i * x + y */
const FILLA =
  'fn filla u32x1024 u32 u32 u32 -> u32x1024\nv mul p1 p2\nw add v p3\nn set p0 p1 w\nret n\nend';
/** b[i] = (i ^ y) * x */
const FILLB =
  'fn fillb u32x1024 u32 u32 u32 -> u32x1024\nv xor p1 p3\nw mul v p2\nn set p0 p1 w\nret n\nend';
/** a[i] = ((i * x + y) ^ ((i * x + y) >> 15)) * 2654435761 */
const hashFill = (name: string, len: number): string =>
  `fn ${name} u32x${len} u32 u32 u32 -> u32x${len}\nv mul p1 p2\nw add v p3\nx shr w 15\ny xor w x\nm mul y 2654435761\nn set p0 p1 m\nret n\nend`;

/** 4x4 u32 matrix product repeated 8 times: A = A * B, fully unrolled per step. */
function mat4Source(): string {
  const lines = ['fn mulstep u32x16 u32 u32x16 -> u32x16'];
  for (let k = 0; k < 16; k += 1) lines.push(`a${k} get p0 ${k}`, `b${k} get p2 ${k}`);
  const cs: string[] = [];
  for (let r = 0; r < 4; r += 1)
    for (let c = 0; c < 4; c += 1) {
      const terms: string[] = [];
      for (let k = 0; k < 4; k += 1) {
        lines.push(`m${r}${c}${k} mul a${r * 4 + k} b${k * 4 + c}`);
        terms.push(`m${r}${c}${k}`);
      }
      lines.push(
        `s${r}${c}a add ${terms[0]} ${terms[1]}`,
        `s${r}${c}b add s${r}${c}a ${terms[2]}`,
        `c${r}${c} add s${r}${c}b ${terms[3]}`,
      );
      cs.push(`c${r}${c}`);
    }
  lines.push(`n arr ${cs.join(' ')}`, 'ret n', 'end');
  const top = ['fn mat4 u32 u32 -> u32'];
  const as: string[] = [];
  const bs: string[] = [];
  for (let k = 0; k < 16; k += 1) {
    top.push(
      `ea${k} mul p0 ${k + 1}`,
      `fa${k} shr p1 ${k}`,
      `ga${k} xor ea${k} fa${k}`,
      `eb${k} mul p1 ${k + 3}`,
      `fb${k} shr p0 ${k}`,
      `gb${k} add eb${k} fb${k}`,
    );
    as.push(`ga${k}`);
    bs.push(`gb${k}`);
  }
  top.push(
    `a arr ${as.join(' ')}`,
    `b arr ${bs.join(' ')}`,
    'r fold mulstep 8 a b',
    'q and p0 15',
    'x get r q',
    't0 get r 0',
    't5 get r 5',
    't10 get r 10',
    't15 get r 15',
    'u add t0 t5',
    'v add u t10',
    'w add v t15',
    'y add w x',
    'ret y',
    'end',
  );
  return `${lines.join('\n')}\n${top.join('\n')}`;
}

const C_HASH_FILL = (n: number): string =>
  `for (uint32_t i = 0; i < ${n}; i++) { uint32_t w = i * x + y; a[i] = (w ^ (w >> 15)) * 2654435761u; }`;
const JS_HASH_FILL = (n: number): string =>
  `for (let i = 0; i < ${n}; i++) { const w = (Math.imul(i, x) + y) >>> 0; a[i] = Math.imul(w ^ (w >>> 15), 2654435761) >>> 0; }`;
const RUST_HASH_FILL = (n: number): string =>
  `for i in 0..${n}u32 { let w = i.wrapping_mul(x).wrapping_add(y); a[i as usize] = (w ^ (w >> 15)).wrapping_mul(2654435761); }`;

/** The reflected CRC-32 (IEEE 802.3, polynomial 0xEDB88320) byte table. */
const CRC_TABLE: readonly number[] = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
  return c >>> 0;
});
const CRC_LIST = CRC_TABLE.join(', ');

/** One CRC-32 table step per byte of the word `v` (A0 lines; the state enters as p0). */
function crcWordLines(): string[] {
  const lines = ['v get p2 p1'];
  let s = 'p0';
  for (let b = 0; b < 4; b += 1) {
    const byte = b === 0 ? 'v' : `w${b}`;
    if (b > 0) lines.push(`w${b} shr v ${b * 8}`);
    lines.push(
      `x${b} xor ${s} ${byte}`,
      `i${b} and x${b} 255`,
      `t${b} get p3 i${b}`,
      `h${b} shr ${s} 8`,
      `c${b} xor t${b} h${b}`,
    );
    s = `c${b}`;
  }
  lines.push(`ret ${s}`);
  return lines;
}

/** sieve4k: sieve of Eratosthenes below n = 2048 + (x & 2047), then a count of the primes. */
const SIEVE_A0 = [
  'fn mark u32x4096 u32 u32 u32 -> u32x4096',
  'm mul p1 p3',
  'j add p2 m',
  'n set p0 j 1',
  'ret n',
  'end',
  'fn sstep u32x4096 u32 u32 -> u32x4096',
  'c get p0 p1',
  'q mul p1 p1',
  'prime eq c 0',
  'big ge p1 2',
  'fits lt q p2',
  'r1 and prime big',
  'r2 and r1 fits',
  'd sub p2 q',
  'e add d p1',
  'f sub e 1',
  'g div f p1',
  'cnt select r2 g 0',
  'r fold mark cnt p0 q p1',
  'ret r',
  'end',
  'fn cstep u32 u32 u32x4096 -> u32',
  'v get p2 p1',
  'z eq v 0',
  'big ge p1 2',
  'b and z big',
  'one select b 1 0',
  'k add p0 one',
  'ret k',
  'end',
  'fn sieve4k u32 u32 -> u32',
  'n0 and p0 2047',
  'n add n0 2048',
  `z arr ${zeros(4096)}`,
  's fold sstep 64 z n',
  'k fold cstep n 0 s',
  'm mul k 65599',
  'w and p1 255',
  't add m w',
  'q and p1 4095',
  'c get s q',
  'r add t c',
  'ret r',
  'end',
].join('\n');

/** isort256: insertion sort of 256 hashed words (A0 sinks each new element by adjacent swaps). */
const ISORT_A0 = `${hashFill('fillh256', 256)}
fn swp u32x256 u32 u32 -> u32x256
j sub p2 p1
i1 sub j 1
u get p0 i1
v get p0 j
b set p0 j u
c set b i1 v
ret c
end
fn swpok u32x256 u32 u32 -> bool
j sub p2 p1
i1 sub j 1
u get p0 i1
v get p0 j
g gt u v
ret g
end
fn ins u32x256 u32 -> u32x256
r loop swpok swp p1 p0 p1
ret r
end
fn isort256 u32 u32 -> u32
z arr ${zeros(256)}
a fold fillh256 256 z p0 p1
s fold ins 256 a
q and p1 255
r get s q
w and p0 255
t get s w
m mul t 3
o add r m
ret o
end`;

/** bsearch1k: 512 lower-bound searches of hashed keys in a sorted 1024-word table. */
const BSEARCH_A0 = `fn fillsorted u32x1024 u32 u32 -> u32x1024
m mul p1 p2
h shr m 26
b shl p1 6
v add b h
n set p0 p1 v
ret n
end
fn bsok (u32,u32) u32 u32x1024 u32 -> bool
lo at p0 0
hi at p0 1
c lt lo hi
ret c
end
fn bsstep (u32,u32) u32 u32x1024 u32 -> (u32,u32)
lo at p0 0
hi at p0 1
s add lo hi
m shr s 1
v get p2 m
c lt v p3
m1 add m 1
nlo select c m1 lo
nhi select c hi m
r put p0 0 nlo
r2 put r 1 nhi
ret r2
end
fn qstep u32 u32 u32x1024 u32 -> u32
m mul p1 2654435761
x xor m p3
k shr x 16
st rec 0 1024
r loop bsok bsstep 11 st p2 k
lo at r 0
s add p0 lo
ret s
end
fn bsearch1k u32 u32 -> u32
z arr ${zeros(1024)}
a fold fillsorted 1024 z p0
s fold qstep 512 0 a p1
ret s
end`;
const C_SORTED_FILL = 'for (uint32_t i = 0; i < 1024; i++) a[i] = (i << 6) + ((i * x) >> 26);';

/** rle4k: run-length encode 4096 symbols (runs capped at 255), FNV-hashing each (symbol, length) pair. */
const RLE_A0 = `fn rlefill u32x4096 u32 u32 u32 -> u32x4096
s shr p1 2
m mul s p2
x xor m p3
v shr x 30
n set p0 p1 v
ret n
end
fn rlestep (u32,u32,u32,u32) u32 u32x4096 -> (u32,u32,u32,u32)
v get p2 p1
pr at p0 0
ln at p0 1
h at p0 2
rn at p0 3
e eq v pr
s lt ln 255
c and e s
l1 add ln 1
sh shl pr 8
o or sh ln
hx xor h o
hm mul hx 16777619
r1 add rn 1
npr select c pr v
nln select c l1 1
nh select c h hm
nrn select c rn r1
q0 put p0 0 npr
q1 put q0 1 nln
q2 put q1 2 nh
q3 put q2 3 nrn
ret q3
end
fn rle4k u32 u32 -> u32
z arr ${zeros(4096)}
a fold rlefill 4096 z p0 p1
f get a 0
st rec f 0 2166136261 0
r fold rlestep 4096 st a
pr at r 0
ln at r 1
h at r 2
rn at r 3
sh shl pr 8
o or sh ln
hx xor h o
hm mul hx 16777619
t add hm rn
ret t
end`;

export const KERNELS: readonly Kernel[] = [
  {
    name: 'affine',
    arity: 3,
    a0: 'fn affine u32 u32 u32 -> u32\na mul p0 p1\nb add a p2\nret b\nend',
    c: 'static inline uint32_t hw_affine(uint32_t x, uint32_t s, uint32_t o) { return x * s + o; }',
    js: 'export function affine(x, s, o) { return (Math.imul(x, s) + o) >>> 0; }',
    rust: '#[inline] fn hw_affine(x: u32, s: u32, o: u32) -> u32 { x.wrapping_mul(s).wrapping_add(o) }',
  },
  {
    name: 'rotl',
    arity: 2,
    a0: 'fn rotl u32 u32 -> u32\nl shl p0 p1\nn sub 32 p1\nr shr p0 n\no or l r\nret o\nend',
    c: 'static inline uint32_t hw_rotl(uint32_t x, uint32_t n) { return (x << (n & 31)) | (x >> ((32 - n) & 31)); }',
    js: 'export function rotl(x, n) { return ((x << (n & 31)) | (x >>> ((32 - n) & 31))) >>> 0; }',
    rust: '#[inline] fn hw_rotl(x: u32, n: u32) -> u32 { (x << (n & 31)) | (x >> ((32u32.wrapping_sub(n)) & 31)) }',
  },
  {
    name: 'clamp',
    arity: 3,
    a0: 'fn clamp u32 u32 u32 -> u32\nc lt p2 p0\nr select c p2 p0\nd lt r p1\ns select d p1 r\nret s\nend',
    c: 'static inline uint32_t hw_clamp(uint32_t x, uint32_t lo, uint32_t hi) { uint32_t t = hi < x ? hi : x; return t < lo ? lo : t; }',
    js: 'export function clamp(x, lo, hi) { const t = hi < x ? hi : x; return t < lo ? lo : t; }',
    rust: '#[inline] fn hw_clamp(x: u32, lo: u32, hi: u32) -> u32 { let t = if hi < x { hi } else { x }; if t < lo { lo } else { t } }',
  },
  {
    name: 'mix', // longer dependency chain: a hash-like mixer
    arity: 2,
    a0: 'fn mix u32 u32 -> u32\na xor p0 p1\nb shl a 13\nc shr a 19\nd or b c\ne mul d 2654435761\nf add e p0\ng shr f 16\nh xor f g\nret h\nend',
    c: 'static inline uint32_t hw_mix(uint32_t x, uint32_t y) { uint32_t a = x ^ y; uint32_t d = (a << 13) | (a >> 19); uint32_t f = d * 2654435761u + x; return f ^ (f >> 16); }',
    js: 'export function mix(x, y) { const a = (x ^ y) >>> 0; const d = ((a << 13) | (a >>> 19)) >>> 0; const f = (Math.imul(d, 2654435761) + x) >>> 0; return (f ^ (f >>> 16)) >>> 0; }',
    rust: '#[inline] fn hw_mix(x: u32, y: u32) -> u32 { let a = x ^ y; let d = (a << 13) | (a >> 19); let f = d.wrapping_mul(2654435761).wrapping_add(x); f ^ (f >> 16) }',
  },
  {
    name: 'ident', // tiny function: call overhead only
    arity: 1,
    a0: 'fn ident u32 -> u32\nret p0\nend',
    c: 'static inline uint32_t hw_ident(uint32_t x) { return x; }',
    js: 'export function ident(x) { return x; }',
    rust: '#[inline] fn hw_ident(x: u32) -> u32 { x }',
  },
  {
    name: 'noop', // already-optimal computation: the optimizer must not add work
    arity: 1,
    a0: 'fn noop u32 -> u32\na add p0 0\nb mul a 1\nc xor b 0\nret c\nend',
    // the identity every competitor writes; docs/history/2026-10-09-noop-token-identity-declaration.md
    a0TokenSource: 'fn noop u32 -> u32\nret p0\nend',
    c: 'static inline uint32_t hw_noop(uint32_t x) { return x; }',
    js: 'export function noop(x) { return x; }',
    rust: '#[inline] fn hw_noop(x: u32) -> u32 { x }',
  },
  {
    name: 'chain3', // boundary-dominated: three nested calls of tiny functions
    arity: 2,
    a0: 'fn inc1 u32 -> u32\na add p0 1\nret a\nend\nfn dbl u32 -> u32\na add p0 p0\nret a\nend\nfn chain3 u32 u32 -> u32\na call inc1 p0\nb call dbl a\nc call inc1 b\nd add c p1\nret d\nend',
    c: 'static inline uint32_t hw_inc1(uint32_t x) { return x + 1; }\nstatic inline uint32_t hw_dbl(uint32_t x) { return x + x; }\nstatic inline uint32_t hw_chain3(uint32_t x, uint32_t y) { return hw_inc1(hw_dbl(hw_inc1(x))) + y; }',
    js: 'function inc1(x) { return (x + 1) >>> 0; }\nfunction dbl(x) { return (x + x) >>> 0; }\nexport function chain3(x, y) { return (inc1(dbl(inc1(x))) + y) >>> 0; }',
    rust: '#[inline] fn inc1(x: u32) -> u32 { x.wrapping_add(1) }\n#[inline] fn dbl(x: u32) -> u32 { x.wrapping_add(x) }\n#[inline] fn hw_chain3(x: u32, y: u32) -> u32 { inc1(dbl(inc1(x))).wrapping_add(y) }',
  },
  {
    name: 'branchy', // data-dependent selects
    arity: 2,
    a0: 'fn branchy u32 u32 -> u32\nc1 lt p0 p1\nc2 eq p0 p1\nd sub p0 p1\ne sub p1 p0\nm select c1 e d\nz select c2 0 m\nb and z 1\nc3 eq b 1\nr select c3 z p0\nret r\nend',
    c: 'static inline uint32_t hw_branchy(uint32_t x, uint32_t y) { uint32_t m = x < y ? y - x : x - y; uint32_t z = x == y ? 0u : m; return (z & 1u) == 1u ? z : x; }',
    js: 'export function branchy(x, y) { const m = x < y ? (y - x) >>> 0 : (x - y) >>> 0; const z = x === y ? 0 : m; return (z & 1) === 1 ? z : x; }',
    rust: '#[inline] fn hw_branchy(x: u32, y: u32) -> u32 { let m = if x < y { y.wrapping_sub(x) } else { x.wrapping_sub(y) }; let z = if x == y { 0 } else { m }; if (z & 1) == 1 { z } else { x } }',
  },
  {
    name: 'arrfill', // memory: build an 8-element array by successive value-semantics updates
    arity: 2,
    a0: 'fn put8 u32x8 u32 u32 -> u32x8\nv add p1 p2\nn set p0 p1 v\nret n\nend\nfn arrfill u32 u32 -> u32\nz arr 0 0 0 0 0 0 0 0\na fold put8 8 z p0\nx get a p1\ny get a 3\ns add x y\nret s\nend',
    c: 'static inline uint32_t hw_arrfill(uint32_t x, uint32_t y) { uint32_t a[8]; for (uint32_t i = 0; i < 8; i++) a[i] = i + x; return a[y % 8u] + a[3]; }',
    js: 'export function arrfill(x, y) { const a = new Uint32Array(8); for (let i = 0; i < 8; i++) a[i] = (i + x) >>> 0; return (a[y % 8] + a[3]) >>> 0; }',
    rust: '#[inline] fn hw_arrfill(x: u32, y: u32) -> u32 { let mut a = [0u32; 8]; for i in 0..8u32 { a[i as usize] = i.wrapping_add(x); } a[(y % 8) as usize].wrapping_add(a[3]) }',
  },
  {
    name: 'arrfill4k', // memory: 4096 value-semantics updates of a 16 KiB array (in-place C/JS path)
    arity: 2,
    iterScale: 128,
    a0: `fn put4k u32x4096 u32 u32 -> u32x4096\nv add p1 p2\nn set p0 p1 v\nret n\nend\nfn arrfill4k u32 u32 -> u32\nz arr ${ZEROS_4096}\na fold put4k 4096 z p0\nx get a p1\ny get a 4095\ns add x y\nret s\nend`,
    c: 'static inline uint32_t hw_arrfill4k(uint32_t x, uint32_t y) { uint32_t a[4096]; for (uint32_t i = 0; i < 4096; i++) a[i] = i + x; return a[y % 4096u] + a[4095]; }',
    js: 'export function arrfill4k(x, y) { const a = new Uint32Array(4096); for (let i = 0; i < 4096; i++) a[i] = (i + x) >>> 0; return (a[y & 4095] + a[4095]) >>> 0; }',
    rust: '#[inline] fn hw_arrfill4k(x: u32, y: u32) -> u32 { let mut a = [0u32; 4096]; for i in 0..4096u32 { a[i as usize] = i.wrapping_add(x); } a[(y % 4096) as usize].wrapping_add(a[4095]) }',
  },
  {
    name: 'loop64', // iteration: 64 dependent steps through a body call
    arity: 2,
    a0: 'fn mixstep u32 u32 u32 -> u32\na xor p0 p2\nb mul a 2654435761\nc shr b 15\nd xor b c\ne add d p1\nret e\nend\nfn loop64 u32 u32 -> u32\nr fold mixstep 64 p0 p1\nret r\nend',
    c: 'static inline uint32_t hw_loop64(uint32_t s, uint32_t k) { for (uint32_t i = 0; i < 64; i++) { uint32_t b = (s ^ k) * 2654435761u; s = (b ^ (b >> 15)) + i; } return s; }',
    js: 'export function loop64(s, k) { for (let i = 0; i < 64; i++) { const b = Math.imul((s ^ k) >>> 0, 2654435761) >>> 0; s = ((b ^ (b >>> 15)) + i) >>> 0; } return s; }',
    rust: '#[inline] fn hw_loop64(s0: u32, k: u32) -> u32 { let mut s = s0; for i in 0..64u32 { let b = (s ^ k).wrapping_mul(2654435761); s = (b ^ (b >> 15)).wrapping_add(i); } s }',
  },
  {
    name: 'dot1k', // two 1024-element fills, then a multiply-accumulate reduce
    arity: 2,
    iterScale: 64,
    a0: `${FILLA}\n${FILLB}\nfn dotstep u32 u32 u32x1024 u32x1024 -> u32\ne get p2 p1\nf get p3 p1\ng mul e f\nh add p0 g\nret h\nend\nfn dot1k u32 u32 -> u32\nz arr ${zeros(1024)}\na fold filla 1024 z p0 p1\nz2 arr ${zeros(1024)}\nb fold fillb 1024 z2 p0 p1\nd fold dotstep 1024 0 a b\nret d\nend`,
    c: 'static inline uint32_t hw_dot1k(uint32_t x, uint32_t y) { uint32_t a[1024], b[1024]; for (uint32_t i = 0; i < 1024; i++) { a[i] = i * x + y; b[i] = (i ^ y) * x; } uint32_t s = 0; for (uint32_t i = 0; i < 1024; i++) s += a[i] * b[i]; return s; }',
    js: 'export function dot1k(x, y) { const a = new Uint32Array(1024), b = new Uint32Array(1024); for (let i = 0; i < 1024; i++) { a[i] = (Math.imul(i, x) + y) >>> 0; b[i] = Math.imul(i ^ y, x) >>> 0; } let s = 0; for (let i = 0; i < 1024; i++) s = (s + Math.imul(a[i], b[i])) >>> 0; return s; }',
    rust: '#[inline] fn hw_dot1k(x: u32, y: u32) -> u32 { let mut a = [0u32; 1024]; let mut b = [0u32; 1024]; for i in 0..1024u32 { a[i as usize] = i.wrapping_mul(x).wrapping_add(y); b[i as usize] = (i ^ y).wrapping_mul(x); } let mut s = 0u32; for i in 0..1024 { s = s.wrapping_add(a[i].wrapping_mul(b[i])); } s }',
  },
  {
    name: 'prefix1k', // in-place prefix sum: each step reads the element written by the previous one
    arity: 2,
    iterScale: 64,
    a0: `${FILLA}\nfn pfx u32x1024 u32 -> u32x1024\nc eq p1 0\nj sub p1 1\nt get p0 j\nu select c 0 t\ns get p0 p1\nv add u s\nn set p0 p1 v\nret n\nend\nfn prefix1k u32 u32 -> u32\nz arr ${zeros(1024)}\na fold filla 1024 z p0 p1\nb fold pfx 1024 a\nq and p1 1023\nr get b q\nw get b 1023\ns add r w\nret s\nend`,
    c: 'static inline uint32_t hw_prefix1k(uint32_t x, uint32_t y) { uint32_t a[1024]; for (uint32_t i = 0; i < 1024; i++) a[i] = i * x + y; for (uint32_t i = 1; i < 1024; i++) a[i] += a[i - 1]; return a[y & 1023u] + a[1023]; }',
    js: 'export function prefix1k(x, y) { const a = new Uint32Array(1024); for (let i = 0; i < 1024; i++) a[i] = (Math.imul(i, x) + y) >>> 0; for (let i = 1; i < 1024; i++) a[i] = (a[i] + a[i - 1]) >>> 0; return (a[y & 1023] + a[1023]) >>> 0; }',
    rust: '#[inline] fn hw_prefix1k(x: u32, y: u32) -> u32 { let mut a = [0u32; 1024]; for i in 0..1024u32 { a[i as usize] = i.wrapping_mul(x).wrapping_add(y); } for i in 1..1024 { a[i] = a[i].wrapping_add(a[i - 1]); } a[(y & 1023) as usize].wrapping_add(a[1023]) }',
  },
  {
    name: 'hist256', // data-dependent indexing: 4096 hashed words into 256 buckets
    arity: 2,
    iterScale: 256,
    a0: `${hashFill('fillh4k', 4096)}\nfn hstep u32x256 u32 u32x4096 -> u32x256\nv get p2 p1\nk shr v 24\nh get p0 k\nh1 add h 1\nn set p0 k h1\nret n\nend\nfn hist256 u32 u32 -> u32\nz arr ${ZEROS_4096}\na fold fillh4k 4096 z p0 p1\nhz arr ${zeros(256)}\nh fold hstep 4096 hz a\nq and p1 255\nr get h q\nw and p0 255\nr2 get h w\ns mul r 65599\nt add s r2\nret t\nend`,
    c: `static inline uint32_t hw_hist256(uint32_t x, uint32_t y) { uint32_t a[4096]; ${C_HASH_FILL(4096)} uint32_t h[256] = {0}; for (uint32_t i = 0; i < 4096; i++) h[a[i] >> 24]++; return h[y & 255u] * 65599u + h[x & 255u]; }`,
    js: `export function hist256(x, y) { const a = new Uint32Array(4096); ${JS_HASH_FILL(4096)} const h = new Uint32Array(256); for (let i = 0; i < 4096; i++) h[a[i] >>> 24]++; return (Math.imul(h[y & 255], 65599) + h[x & 255]) >>> 0; }`,
    rust: `#[inline] fn hw_hist256(x: u32, y: u32) -> u32 { let mut a = [0u32; 4096]; ${RUST_HASH_FILL(4096)} let mut h = [0u32; 256]; for i in 0..4096 { h[(a[i] >> 24) as usize] += 1; } h[(y & 255) as usize].wrapping_mul(65599).wrapping_add(h[(x & 255) as usize]) }`,
  },
  {
    name: 'mat4', // 4x4 matrix product repeated 8 times: 16-element arrays, many independent multiplies
    arity: 2,
    iterScale: 16,
    a0: mat4Source(),
    c: 'static inline uint32_t hw_mat4(uint32_t x, uint32_t y) { uint32_t a[16], b[16]; for (uint32_t k = 0; k < 16; k++) { a[k] = (x * (k + 1)) ^ (y >> k); b[k] = (y * (k + 3)) + (x >> k); } for (int n = 0; n < 8; n++) { uint32_t c[16]; for (int r = 0; r < 4; r++) for (int j = 0; j < 4; j++) { uint32_t s = 0; for (int k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + j]; c[r * 4 + j] = s; } for (int i = 0; i < 16; i++) a[i] = c[i]; } return a[0] + a[5] + a[10] + a[15] + a[x & 15u]; }',
    js: 'export function mat4(x, y) { const a = new Uint32Array(16), b = new Uint32Array(16), c = new Uint32Array(16); for (let k = 0; k < 16; k++) { a[k] = (Math.imul(x, k + 1) ^ (y >>> k)) >>> 0; b[k] = (Math.imul(y, k + 3) + (x >>> k)) >>> 0; } for (let n = 0; n < 8; n++) { for (let r = 0; r < 4; r++) for (let j = 0; j < 4; j++) { let s = 0; for (let k = 0; k < 4; k++) s = (s + Math.imul(a[r * 4 + k], b[k * 4 + j])) >>> 0; c[r * 4 + j] = s; } a.set(c); } return (a[0] + a[5] + a[10] + a[15] + a[x & 15]) >>> 0; }',
    rust: '#[inline] fn hw_mat4(x: u32, y: u32) -> u32 { let mut a = [0u32; 16]; let mut b = [0u32; 16]; for k in 0..16u32 { a[k as usize] = x.wrapping_mul(k + 1) ^ (y >> k); b[k as usize] = y.wrapping_mul(k + 3).wrapping_add(x >> k); } for _ in 0..8 { let mut c = [0u32; 16]; for r in 0..4 { for j in 0..4 { let mut s = 0u32; for k in 0..4 { s = s.wrapping_add(a[r * 4 + k].wrapping_mul(b[k * 4 + j])); } c[r * 4 + j] = s; } } a = c; } a[0].wrapping_add(a[5]).wrapping_add(a[10]).wrapping_add(a[15]).wrapping_add(a[(x & 15) as usize]) }',
  },
  {
    name: 'fnv4k', // FNV-1a over the bytes of 4096 hashed words: a long serial dependency chain
    arity: 2,
    iterScale: 1024,
    a0: `${hashFill('fillh4k', 4096)}\nfn fnvstep u32 u32 u32x4096 -> u32\nv get p2 p1\nb0 and v 255\ns0 xor p0 b0\nm0 mul s0 16777619\nb1 shr v 8\nc1 and b1 255\ns1 xor m0 c1\nm1 mul s1 16777619\nb2 shr v 16\nc2 and b2 255\ns2 xor m1 c2\nm2 mul s2 16777619\nb3 shr v 24\ns3 xor m2 b3\nm3 mul s3 16777619\nret m3\nend\nfn fnv4k u32 u32 -> u32\nz arr ${ZEROS_4096}\na fold fillh4k 4096 z p0 p1\nh fold fnvstep 4096 2166136261 a\nret h\nend`,
    c: `static inline uint32_t hw_fnv4k(uint32_t x, uint32_t y) { uint32_t a[4096]; ${C_HASH_FILL(4096)} uint32_t s = 2166136261u; for (uint32_t i = 0; i < 4096; i++) { uint32_t v = a[i]; s = (s ^ (v & 255u)) * 16777619u; s = (s ^ ((v >> 8) & 255u)) * 16777619u; s = (s ^ ((v >> 16) & 255u)) * 16777619u; s = (s ^ (v >> 24)) * 16777619u; } return s; }`,
    js: `export function fnv4k(x, y) { const a = new Uint32Array(4096); ${JS_HASH_FILL(4096)} let s = 2166136261; for (let i = 0; i < 4096; i++) { const v = a[i]; s = Math.imul(s ^ (v & 255), 16777619) >>> 0; s = Math.imul(s ^ ((v >>> 8) & 255), 16777619) >>> 0; s = Math.imul(s ^ ((v >>> 16) & 255), 16777619) >>> 0; s = Math.imul(s ^ (v >>> 24), 16777619) >>> 0; } return s; }`,
    rust: `#[inline] fn hw_fnv4k(x: u32, y: u32) -> u32 { let mut a = [0u32; 4096]; ${RUST_HASH_FILL(4096)} let mut s = 2166136261u32; for i in 0..4096 { let v = a[i]; s = (s ^ (v & 255)).wrapping_mul(16777619); s = (s ^ ((v >> 8) & 255)).wrapping_mul(16777619); s = (s ^ ((v >> 16) & 255)).wrapping_mul(16777619); s = (s ^ (v >> 24)).wrapping_mul(16777619); } s }`,
  },
  {
    name: 'xs4k', // xorshift32 stream of 4096 words (each element depends on the previous), xor-reduced
    arity: 2,
    iterScale: 512,
    a0: `fn xsfill u32x4096 u32 u32 -> u32x4096\nc eq p1 0\nj sub p1 1\nt get p0 j\ns select c p2 t\na shl s 13\nb xor s a\nc2 shr b 17\nd xor b c2\ne shl d 5\nf xor d e\nn set p0 p1 f\nret n\nend\nfn xorstep u32 u32 u32x4096 -> u32\nv get p2 p1\nw xor p0 v\nret w\nend\nfn xs4k u32 u32 -> u32\nz arr ${ZEROS_4096}\na fold xsfill 4096 z p0\nr fold xorstep 4096 p1 a\nret r\nend`,
    c: 'static inline uint32_t hw_xs4k(uint32_t x, uint32_t y) { uint32_t a[4096]; uint32_t s = x; for (uint32_t i = 0; i < 4096; i++) { s ^= s << 13; s ^= s >> 17; s ^= s << 5; a[i] = s; } uint32_t r = y; for (uint32_t i = 0; i < 4096; i++) r ^= a[i]; return r; }',
    js: 'export function xs4k(x, y) { const a = new Uint32Array(4096); let s = x; for (let i = 0; i < 4096; i++) { s = (s ^ (s << 13)) >>> 0; s = (s ^ (s >>> 17)) >>> 0; s = (s ^ (s << 5)) >>> 0; a[i] = s; } let r = y; for (let i = 0; i < 4096; i++) r = (r ^ a[i]) >>> 0; return r; }',
    rust: '#[inline] fn hw_xs4k(x: u32, y: u32) -> u32 { let mut a = [0u32; 4096]; let mut s = x; for i in 0..4096 { s ^= s << 13; s ^= s >> 17; s ^= s << 5; a[i] = s; } let mut r = y; for i in 0..4096 { r ^= a[i]; } r }',
  },
  {
    name: 'minmax1k', // record state: running (lo, hi) pair over 1024 hashed words
    arity: 2,
    iterScale: 64,
    a0: `${hashFill('fillh1k', 1024)}\nfn mmstep (u32,u32) u32 u32x1024 -> (u32,u32)\nv get p2 p1\nlo at p0 0\nhi at p0 1\nc lt v lo\nnlo select c v lo\nd gt v hi\nnhi select d v hi\nr put p0 0 nlo\nr2 put r 1 nhi\nret r2\nend\nfn minmax1k u32 u32 -> u32\nz arr ${zeros(1024)}\na fold fillh1k 1024 z p0 p1\ni rec 4294967295 0\nm fold mmstep 1024 i a\nlo at m 0\nhi at m 1\ns sub hi lo\nret s\nend`,
    c: `static inline uint32_t hw_minmax1k(uint32_t x, uint32_t y) { uint32_t a[1024]; ${C_HASH_FILL(1024)} uint32_t lo = 0xffffffffu, hi = 0; for (uint32_t i = 0; i < 1024; i++) { uint32_t v = a[i]; lo = v < lo ? v : lo; hi = v > hi ? v : hi; } return hi - lo; }`,
    js: `export function minmax1k(x, y) { const a = new Uint32Array(1024); ${JS_HASH_FILL(1024)} let lo = 0xffffffff, hi = 0; for (let i = 0; i < 1024; i++) { const v = a[i]; lo = v < lo ? v : lo; hi = v > hi ? v : hi; } return (hi - lo) >>> 0; }`,
    rust: `#[inline] fn hw_minmax1k(x: u32, y: u32) -> u32 { let mut a = [0u32; 1024]; ${RUST_HASH_FILL(1024)} let mut lo = u32::MAX; let mut hi = 0u32; for i in 0..1024 { let v = a[i]; lo = if v < lo { v } else { lo }; hi = if v > hi { v } else { hi }; } hi.wrapping_sub(lo) }`,
  },
  {
    name: 'filter2', // two passes of a 2-tap averaging filter (wrapping neighbour reads) over 1024 hashed words
    arity: 2,
    iterScale: 64,
    a0: `${hashFill('fillh1k', 1024)}\nfn smooth u32x1024 u32 u32x1024 -> u32x1024\nj add p1 1\nu get p2 p1\nv get p2 j\nw add u v\ns shr w 1\nn set p0 p1 s\nret n\nend\nfn filter2 u32 u32 -> u32\nz arr ${zeros(1024)}\na fold fillh1k 1024 z p0 p1\nz2 arr ${zeros(1024)}\nb fold smooth 1024 z2 a\nz3 arr ${zeros(1024)}\nc fold smooth 1024 z3 b\nq and p1 1023\nr get c q\nw get c 1023\ns add r w\nret s\nend`,
    c: `static inline uint32_t hw_filter2(uint32_t x, uint32_t y) { uint32_t a[1024], b[1024], c[1024]; ${C_HASH_FILL(1024)} for (uint32_t i = 0; i < 1024; i++) b[i] = (a[i] + a[(i + 1) & 1023u]) >> 1; for (uint32_t i = 0; i < 1024; i++) c[i] = (b[i] + b[(i + 1) & 1023u]) >> 1; return c[y & 1023u] + c[1023]; }`,
    js: `export function filter2(x, y) { const a = new Uint32Array(1024), b = new Uint32Array(1024), c = new Uint32Array(1024); ${JS_HASH_FILL(1024)} for (let i = 0; i < 1024; i++) b[i] = (a[i] + a[(i + 1) & 1023]) >>> 1; for (let i = 0; i < 1024; i++) c[i] = (b[i] + b[(i + 1) & 1023]) >>> 1; return (c[y & 1023] + c[1023]) >>> 0; }`,
    rust: `#[inline] fn hw_filter2(x: u32, y: u32) -> u32 { let mut a = [0u32; 1024]; let mut b = [0u32; 1024]; let mut c = [0u32; 1024]; ${RUST_HASH_FILL(1024)} for i in 0..1024 { b[i] = a[i].wrapping_add(a[(i + 1) & 1023]) >> 1; } for i in 0..1024 { c[i] = b[i].wrapping_add(b[(i + 1) & 1023]) >> 1; } c[(y & 1023) as usize].wrapping_add(c[1023]) }`,
  },
  {
    name: 'sieve4k', // sieve of Eratosthenes below 2048..4095: strided stores with a data-dependent trip count
    arity: 2,
    iterScale: 512,
    a0: SIEVE_A0,
    c: 'static inline uint32_t hw_sieve4k(uint32_t x, uint32_t y) { uint32_t c[4096] = {0}; uint32_t n = 2048u + (x & 2047u); for (uint32_t p = 2; p < 64; p++) { if (c[p]) continue; for (uint32_t j = p * p; j < n; j += p) c[j] = 1; } uint32_t k = 0; for (uint32_t i = 2; i < n; i++) k += c[i] == 0; return k * 65599u + (y & 255u) + c[y & 4095u]; }',
    js: 'export function sieve4k(x, y) { const c = new Uint32Array(4096); const n = 2048 + (x & 2047); for (let p = 2; p < 64; p++) { if (c[p]) continue; for (let j = p * p; j < n; j += p) c[j] = 1; } let k = 0; for (let i = 2; i < n; i++) k += c[i] === 0 ? 1 : 0; return (Math.imul(k, 65599) + (y & 255) + c[y & 4095]) >>> 0; }',
    rust: '#[inline] fn hw_sieve4k(x: u32, y: u32) -> u32 { let mut c = [0u32; 4096]; let n = 2048 + (x & 2047); for p in 2..64u32 { if c[p as usize] != 0 { continue; } let mut j = p * p; while j < n { c[j as usize] = 1; j += p; } } let mut k = 0u32; for i in 2..n { if c[i as usize] == 0 { k += 1; } } k.wrapping_mul(65599).wrapping_add(y & 255).wrapping_add(c[(y & 4095) as usize]) }',
  },
  {
    name: 'isort256', // insertion sort of 256 hashed words: data-dependent inner loop with early exit
    arity: 2,
    iterScale: 2048,
    a0: ISORT_A0,
    c: `static inline uint32_t hw_isort256(uint32_t x, uint32_t y) { uint32_t a[256]; ${C_HASH_FILL(256)} for (uint32_t i = 1; i < 256; i++) { uint32_t v = a[i]; uint32_t j = i; while (j > 0 && a[j - 1] > v) { a[j] = a[j - 1]; j--; } a[j] = v; } return a[y & 255u] + a[x & 255u] * 3u; }`,
    js: `export function isort256(x, y) { const a = new Uint32Array(256); ${JS_HASH_FILL(256)} for (let i = 1; i < 256; i++) { const v = a[i]; let j = i; while (j > 0 && a[j - 1] > v) { a[j] = a[j - 1]; j--; } a[j] = v; } return (a[y & 255] + Math.imul(a[x & 255], 3)) >>> 0; }`,
    rust: `#[inline] fn hw_isort256(x: u32, y: u32) -> u32 { let mut a = [0u32; 256]; ${RUST_HASH_FILL(256)} for i in 1..256 { let v = a[i]; let mut j = i; while j > 0 && a[j - 1] > v { a[j] = a[j - 1]; j -= 1; } a[j] = v; } a[(y & 255) as usize].wrapping_add(a[(x & 255) as usize].wrapping_mul(3)) }`,
  },
  {
    name: 'crc4k', // table-driven CRC-32 over the 4096 bytes of 1024 hashed words: a 256-entry lookup per byte
    arity: 2,
    iterScale: 1024,
    a0: `${hashFill('fillh1k', 1024)}\nfn crcstep u32 u32 u32x1024 u32x256 -> u32\n${crcWordLines().join('\n')}\nend\nfn crc4k u32 u32 -> u32\nz arr ${zeros(1024)}\na fold fillh1k 1024 z p0 p1\nt arr ${CRC_TABLE.join(' ')}\nc fold crcstep 1024 4294967295 a t\nr xor c 4294967295\nret r\nend`,
    c: `static const uint32_t crc_t[256] = {${CRC_LIST}};\nstatic inline uint32_t hw_crc4k(uint32_t x, uint32_t y) { uint32_t a[1024]; ${C_HASH_FILL(1024)} uint32_t c = 0xffffffffu; for (uint32_t i = 0; i < 1024; i++) { uint32_t v = a[i]; for (uint32_t b = 0; b < 32; b += 8) c = crc_t[(c ^ (v >> b)) & 255u] ^ (c >> 8); } return c ^ 0xffffffffu; }`,
    js: `const crcT = new Uint32Array([${CRC_LIST}]);\nexport function crc4k(x, y) { const a = new Uint32Array(1024); ${JS_HASH_FILL(1024)} let c = 0xffffffff; for (let i = 0; i < 1024; i++) { const v = a[i]; for (let b = 0; b < 32; b += 8) c = (crcT[(c ^ (v >>> b)) & 255] ^ (c >>> 8)) >>> 0; } return (c ^ 0xffffffff) >>> 0; }`,
    rust: `static CRC_T: [u32; 256] = [${CRC_LIST}];\n#[inline] fn hw_crc4k(x: u32, y: u32) -> u32 { let mut a = [0u32; 1024]; ${RUST_HASH_FILL(1024)} let mut c = 0xffffffffu32; for i in 0..1024 { let v = a[i]; for b in [0u32, 8, 16, 24] { c = CRC_T[((c ^ (v >> b)) & 255) as usize] ^ (c >> 8); } } c ^ 0xffffffff }`,
  },
  {
    name: 'bsearch1k', // 512 lower-bound binary searches in a sorted 1024-word table
    arity: 2,
    iterScale: 256,
    a0: BSEARCH_A0,
    c: `static inline uint32_t hw_bsearch1k(uint32_t x, uint32_t y) { uint32_t a[1024]; ${C_SORTED_FILL} uint32_t s = 0; for (uint32_t q = 0; q < 512; q++) { uint32_t k = ((q * 2654435761u) ^ y) >> 16; uint32_t lo = 0, hi = 1024; while (lo < hi) { uint32_t m = (lo + hi) >> 1; if (a[m] < k) lo = m + 1; else hi = m; } s += lo; } return s; }`,
    js: 'export function bsearch1k(x, y) { const a = new Uint32Array(1024); for (let i = 0; i < 1024; i++) a[i] = ((i << 6) + (Math.imul(i, x) >>> 26)) >>> 0; let s = 0; for (let q = 0; q < 512; q++) { const k = ((Math.imul(q, 2654435761) ^ y) >>> 16); let lo = 0, hi = 1024; while (lo < hi) { const m = (lo + hi) >>> 1; if (a[m] < k) lo = m + 1; else hi = m; } s = (s + lo) >>> 0; } return s; }',
    rust: '#[inline] fn hw_bsearch1k(x: u32, y: u32) -> u32 { let mut a = [0u32; 1024]; for i in 0..1024u32 { a[i as usize] = (i << 6).wrapping_add(i.wrapping_mul(x) >> 26); } let mut s = 0u32; for q in 0..512u32 { let k = (q.wrapping_mul(2654435761) ^ y) >> 16; let (mut lo, mut hi) = (0u32, 1024u32); while lo < hi { let m = (lo + hi) >> 1; if a[m as usize] < k { lo = m + 1; } else { hi = m; } } s = s.wrapping_add(lo); } s }',
  },
  {
    name: 'rle4k', // run-length codec state machine over 4096 two-bit symbols, hashing each emitted run
    arity: 2,
    iterScale: 1024,
    a0: RLE_A0,
    c: 'static inline uint32_t hw_rle4k(uint32_t x, uint32_t y) { uint32_t a[4096]; for (uint32_t i = 0; i < 4096; i++) a[i] = (((i >> 2) * x) ^ y) >> 30; uint32_t prev = a[0], len = 1, h = 2166136261u, runs = 0; for (uint32_t i = 1; i < 4096; i++) { uint32_t v = a[i]; if (v == prev && len < 255u) len++; else { h = (h ^ ((prev << 8) | len)) * 16777619u; runs++; prev = v; len = 1; } } h = (h ^ ((prev << 8) | len)) * 16777619u; return h + runs; }',
    js: 'export function rle4k(x, y) { const a = new Uint32Array(4096); for (let i = 0; i < 4096; i++) a[i] = ((Math.imul(i >>> 2, x) ^ y) >>> 30); let prev = a[0], len = 1, h = 2166136261, runs = 0; for (let i = 1; i < 4096; i++) { const v = a[i]; if (v === prev && len < 255) len++; else { h = Math.imul(h ^ ((prev << 8) | len), 16777619) >>> 0; runs++; prev = v; len = 1; } } h = Math.imul(h ^ ((prev << 8) | len), 16777619) >>> 0; return (h + runs) >>> 0; }',
    rust: '#[inline] fn hw_rle4k(x: u32, y: u32) -> u32 { let mut a = [0u32; 4096]; for i in 0..4096u32 { a[i as usize] = ((i >> 2).wrapping_mul(x) ^ y) >> 30; } let (mut prev, mut len, mut h, mut runs) = (a[0], 1u32, 2166136261u32, 0u32); for i in 1..4096 { let v = a[i]; if v == prev && len < 255 { len += 1; } else { h = (h ^ ((prev << 8) | len)).wrapping_mul(16777619); runs += 1; prev = v; len = 1; } } h = (h ^ ((prev << 8) | len)).wrapping_mul(16777619); h.wrapping_add(runs) }',
  },
];

export function cDriver(callExpr: (i: number) => string, arity: number): string {
  const args = (base: string) => Array.from({ length: arity }, (_, i) => `${base}${i}`).join(', ');
  return `#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
static uint32_t rng(uint32_t *s) { uint32_t x = *s; x ^= x << 13; x ^= x >> 17; x ^= x << 5; return *s = x; }
int main(int argc, char **argv) {
  long iters = argc > 1 ? atol(argv[1]) : ${ITER};
  uint32_t s = 0x9e3779b9u, acc = 0;
  struct timespec t0, t1;
  clock_gettime(CLOCK_MONOTONIC, &t0);
  for (long i = 0; i < iters; i++) {
    ${Array.from({ length: arity }, (_, i) => `uint32_t a${i} = rng(&s);`).join(' ')}
    acc ^= ${callExpr(0).replace('ARGS', args('a'))};
  }
  clock_gettime(CLOCK_MONOTONIC, &t1);
  double ns = ((t1.tv_sec - t0.tv_sec) * 1e9 + (t1.tv_nsec - t0.tv_nsec)) / (double)iters;
  printf("%.4f %u\\n", ns, acc);
  return 0;
}
`;
}

/**
 * A0 source of a whole-program driver around `kernel`: `a0drive(n)` folds the kernel over `n`
 * iterations with the same xorshift32 inputs and xor-accumulated results as `cDriver` (a record
 * state of the generator and the checksum), so the direct arm64 backend sees the loop and the call
 * together, as every other language's own driver does. Append it to `kernel.a0`.
 */
export function a0DriverSource(kernel: Kernel): string {
  const lines = ['s0 at p0 0', 'acc at p0 1'];
  let prev = 's0';
  const args: string[] = [];
  for (let i = 0; i < kernel.arity; i += 1) {
    lines.push(
      `x${i}a shl ${prev} 13`,
      `x${i}b xor ${prev} x${i}a`,
      `x${i}c shr x${i}b 17`,
      `x${i}d xor x${i}b x${i}c`,
      `x${i}e shl x${i}d 5`,
      `x${i}f xor x${i}d x${i}e`,
    );
    args.push(`x${i}f`);
    prev = `x${i}f`;
  }
  lines.push(
    `r call ${kernel.name} ${args.join(' ')}`,
    'acc2 xor acc r',
    `o1 put p0 0 ${prev}`,
    'o2 put o1 1 acc2',
    'ret o2',
  );
  return `fn a0drive_step (u32,u32) u32 -> (u32,u32)\n${lines.join('\n')}\nend\nfn a0drive u32 -> u32\nst rec 2654435769 0\nres fold a0drive_step p0 st\nout at res 1\nret out\nend`;
}

/** The C main that times `a0_a0drive(iters)` and prints "ns-per-call checksum" like `cDriver`. */
export const A0_DRIVER_MAIN = `#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
extern uint32_t a0_a0drive(uint32_t);
int main(int argc, char **argv) {
  long iters = argc > 1 ? atol(argv[1]) : 1000000;
  struct timespec t0, t1;
  clock_gettime(CLOCK_MONOTONIC, &t0);
  uint32_t r = a0_a0drive((uint32_t)iters);
  clock_gettime(CLOCK_MONOTONIC, &t1);
  double ns = ((t1.tv_sec - t0.tv_sec) * 1e9 + (t1.tv_nsec - t0.tv_nsec)) / (double)iters;
  printf("%.4f %u\\n", ns, r);
  return 0;
}
`;

export function rustDriver(kernel: Kernel): string {
  const args = Array.from({ length: kernel.arity }, (_, i) => `a${i}`).join(', ');
  return `${kernel.rust}
fn rng(s: &mut u32) -> u32 { let mut x = *s; x ^= x << 13; x ^= x >> 17; x ^= x << 5; *s = x; x }
fn main() {
  let iters: u64 = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(${ITER});
  let mut s: u32 = 0x9e3779b9; let mut acc: u32 = 0;
  let t0 = std::time::Instant::now();
  for _ in 0..iters {
    ${Array.from({ length: kernel.arity }, (_, i) => `let a${i} = rng(&mut s);`).join(' ')}
    acc ^= hw_${kernel.name}(${args});
  }
  let ns = t0.elapsed().as_nanos() as f64 / iters as f64;
  println!("{:.4} {}", ns, acc);
}
`;
}

/** The A0 text the token axis counts for a kernel (its timed source unless a token-only text is set). */
export const a0TokenText = (k: Kernel): string => k.a0TokenSource ?? k.a0;
