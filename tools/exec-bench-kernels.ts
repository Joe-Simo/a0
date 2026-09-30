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

const ZEROS_4096 = Array.from({ length: 4096 }, () => '0').join(' ');

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
    noArm64:
      'src/arm64.ts copies the 16 KiB state into and out of every trip (no in-place path yet)',
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
];
