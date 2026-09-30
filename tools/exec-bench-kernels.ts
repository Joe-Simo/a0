/** The exec-bench kernels: A0 source and hand-written C, JavaScript, and Rust with identical semantics. */

import type { KernelName } from './exec-bench-languages.js';

export interface Kernel {
  readonly name: KernelName;
  readonly arity: number;
  readonly a0: string;
  readonly c: string;
  readonly js: string;
  /** Hand-written Rust with identical wrapping semantics (compiled with rustc -O). */
  readonly rust: string;
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
];
