/**
 * Held-out task set B for the AI-edit experiment. Independent of the primary
 * TASKS array: same shape, disjoint tasks, ids prefixed `b-`.
 */

import type { Value } from '../src/core.js';

interface AcceptanceCase {
  readonly fn: string;
  readonly args: readonly Value[];
  readonly expected: Value;
}

export interface Task {
  readonly id: string;
  readonly kind: 'targeted-edit' | 'multi-node-edit' | 'comprehension-edit' | 'create';
  /** Function the structured A0 view opens (default: the first function). */
  readonly target?: string;
  readonly instruction: string;
  readonly a0Source: string;
  readonly tsSource: string;
  readonly rustSource: string;
  readonly tests: readonly AcceptanceCase[];
  /** Reference solutions, used only to validate the harness itself. */
  readonly reference: { readonly a0: string; readonly ts: string; readonly rust: string };
}

const MAX = 0xffff_ffff;

export const TASKS_B: readonly Task[] = [
  {
    id: 'b-fits-inclusive',
    kind: 'targeted-edit',
    instruction:
      'fits(a, b) must be true when a is less than or equal to b (unsigned). It currently uses a strict comparison. Change only that comparison.',
    a0Source: 'fn fits u32 u32 -> bool\nret lt p0 p1\nend\n',
    tsSource: 'export function fits(a: number, b: number): boolean {\n  return a < b;\n}\n',
    rustSource: 'pub fn fits(a: u32, b: u32) -> bool {\n    a < b\n}\n',
    tests: [
      { fn: 'fits', args: [3, 3], expected: true },
      { fn: 'fits', args: [4, 3], expected: false },
      { fn: 'fits', args: [0, 0], expected: true },
      { fn: 'fits', args: [MAX, MAX - 1], expected: false },
      { fn: 'fits', args: [2, 9], expected: true },
    ],
    reference: {
      a0: 'fn fits u32 u32 -> bool\nret le p0 p1\nend\n',
      ts: 'export function fits(a: number, b: number): boolean {\n  return a <= b;\n}\n',
      rust: 'pub fn fits(a: u32, b: u32) -> bool {\n    a <= b\n}\n',
    },
  },
  {
    id: 'b-sumfrom-eight',
    kind: 'targeted-edit',
    instruction:
      'sumfrom(x) should return x plus the integers 0 through 7 (eight iterations, wrapping mod 2^32). It currently runs only five iterations. Change only the iteration count.',
    a0Source:
      'fn addi u32 u32 -> u32\na add p0 p1\nret a\nend\nfn sumfrom u32 -> u32\nr fold addi 5 p0\nret r\nend\n',
    tsSource:
      'export function sumfrom(x: number): number {\n  let s = x >>> 0;\n  for (let i = 0; i < 5; i++) {\n    s = (s + i) >>> 0;\n  }\n  return s;\n}\n',
    rustSource:
      'pub fn sumfrom(x: u32) -> u32 {\n    let mut s = x;\n    for i in 0..5u32 {\n        s = s.wrapping_add(i);\n    }\n    s\n}\n',
    tests: [
      { fn: 'sumfrom', args: [0], expected: 28 },
      { fn: 'sumfrom', args: [10], expected: 38 },
      { fn: 'sumfrom', args: [MAX - 5], expected: 22 },
      { fn: 'sumfrom', args: [MAX], expected: 27 },
    ],
    reference: {
      a0: 'fn addi u32 u32 -> u32\na add p0 p1\nret a\nend\nfn sumfrom u32 -> u32\nr fold addi 8 p0\nret r\nend\n',
      ts: 'export function sumfrom(x: number): number {\n  let s = x >>> 0;\n  for (let i = 0; i < 8; i++) {\n    s = (s + i) >>> 0;\n  }\n  return s;\n}\n',
      rust: 'pub fn sumfrom(x: u32) -> u32 {\n    let mut s = x;\n    for i in 0..8u32 {\n        s = s.wrapping_add(i);\n    }\n    s\n}\n',
    },
  },
  {
    id: 'b-rot8-constant',
    kind: 'targeted-edit',
    instruction:
      'rot8 is meant to rotate a 32-bit value left by 8 bits, but one shift constant is wrong. Fix that single constant.',
    a0Source: 'fn rot8 u32 -> u32\na shl p0 8\nb shr p0 23\nc or a b\nret c\nend\n',
    tsSource: 'export function rot8(x: number): number {\n  return ((x << 8) | (x >>> 23)) >>> 0;\n}\n',
    rustSource: 'pub fn rot8(x: u32) -> u32 {\n    (x << 8) | (x >> 23)\n}\n',
    tests: [
      { fn: 'rot8', args: [0x1234_5678], expected: 0x3456_7812 },
      { fn: 'rot8', args: [0x8000_0000], expected: 0x80 },
      { fn: 'rot8', args: [0xff00_0000], expected: 0xff },
      { fn: 'rot8', args: [1], expected: 256 },
      { fn: 'rot8', args: [0], expected: 0 },
    ],
    reference: {
      a0: 'fn rot8 u32 -> u32\na shl p0 8\nb shr p0 24\nc or a b\nret c\nend\n',
      ts: 'export function rot8(x: number): number {\n  return ((x << 8) | (x >>> 24)) >>> 0;\n}\n',
      rust: 'pub fn rot8(x: u32) -> u32 {\n    (x << 8) | (x >> 24)\n}\n',
    },
  },
  {
    id: 'b-onlyone-xor',
    kind: 'targeted-edit',
    instruction:
      'onlyone(a, b) must be true exactly when one of its two inputs is true and the other is false. Currently it is also true when both are true. Change only the operator.',
    a0Source: 'fn onlyone bool bool -> bool\nret or p0 p1\nend\n',
    tsSource: 'export function onlyone(a: boolean, b: boolean): boolean {\n  return a || b;\n}\n',
    rustSource: 'pub fn onlyone(a: bool, b: bool) -> bool {\n    a || b\n}\n',
    tests: [
      { fn: 'onlyone', args: [true, true], expected: false },
      { fn: 'onlyone', args: [true, false], expected: true },
      { fn: 'onlyone', args: [false, true], expected: true },
      { fn: 'onlyone', args: [false, false], expected: false },
    ],
    reference: {
      a0: 'fn onlyone bool bool -> bool\nret xor p0 p1\nend\n',
      ts: 'export function onlyone(a: boolean, b: boolean): boolean {\n  return a !== b;\n}\n',
      rust: 'pub fn onlyone(a: bool, b: bool) -> bool {\n    a ^ b\n}\n',
    },
  },
  {
    id: 'b-avgfloor-nowrap',
    kind: 'multi-node-edit',
    instruction:
      'avgfloor(a, b) must return floor((a + b) / 2) of the true mathematical sum, even when a + b exceeds 32 bits. It currently wraps. Rewrite the body without any intermediate overflow (hint: (a & b) + ((a ^ b) >> 1)).',
    a0Source: 'fn avgfloor u32 u32 -> u32\na add p0 p1\nb shr a 1\nret b\nend\n',
    tsSource:
      'export function avgfloor(a: number, b: number): number {\n  return ((a + b) >>> 0) >>> 1;\n}\n',
    rustSource: 'pub fn avgfloor(a: u32, b: u32) -> u32 {\n    a.wrapping_add(b) >> 1\n}\n',
    tests: [
      { fn: 'avgfloor', args: [MAX, MAX], expected: MAX },
      { fn: 'avgfloor', args: [1, 2], expected: 1 },
      { fn: 'avgfloor', args: [0, 0], expected: 0 },
      { fn: 'avgfloor', args: [MAX, 1], expected: 0x8000_0000 },
      { fn: 'avgfloor', args: [0x8000_0000, 0x8000_0002], expected: 0x8000_0001 },
    ],
    reference: {
      a0: 'fn avgfloor u32 u32 -> u32\na and p0 p1\nb xor p0 p1\nc shr b 1\nd add a c\nret d\nend\n',
      ts: 'export function avgfloor(a: number, b: number): number {\n  return ((a & b) + ((a ^ b) >>> 1)) >>> 0;\n}\n',
      rust: 'pub fn avgfloor(a: u32, b: u32) -> u32 {\n    (a & b) + ((a ^ b) >> 1)\n}\n',
    },
  },
  {
    id: 'b-sumsq-array',
    kind: 'multi-node-edit',
    instruction:
      'sumsq should return the sum of the squares of the four elements (wrapping mod 2^32). It currently sums the elements without squaring them. Make it square each element before accumulating.',
    a0Source:
      'fn addel u32 u32 u32x4 -> u32\na get p2 p1\nb add p0 a\nret b\nend\nfn sumsq u32x4 -> u32\nr fold addel 4 0 p0\nret r\nend\n',
    tsSource:
      'export function sumsq(a: number[]): number {\n  let s = 0;\n  for (let i = 0; i < 4; i++) {\n    s = (s + a[i % 4]!) >>> 0;\n  }\n  return s;\n}\n',
    rustSource:
      'pub fn sumsq(a: [u32; 4]) -> u32 {\n    let mut s: u32 = 0;\n    for i in 0..4 {\n        s = s.wrapping_add(a[i]);\n    }\n    s\n}\n',
    tests: [
      { fn: 'sumsq', args: [[1, 2, 3, 4]], expected: 30 },
      { fn: 'sumsq', args: [[65536, 0, 0, 0]], expected: 0 },
      { fn: 'sumsq', args: [[65535, 0, 0, 0]], expected: 4294836225 },
      { fn: 'sumsq', args: [[0, 0, 0, 0]], expected: 0 },
      { fn: 'sumsq', args: [[MAX, MAX, 0, 0]], expected: 2 },
    ],
    reference: {
      a0: 'fn addel u32 u32 u32x4 -> u32\na get p2 p1\nq mul a a\nb add p0 q\nret b\nend\nfn sumsq u32x4 -> u32\nr fold addel 4 0 p0\nret r\nend\n',
      ts: 'export function sumsq(a: number[]): number {\n  let s = 0;\n  for (let i = 0; i < 4; i++) {\n    const x = a[i % 4]!;\n    s = (s + Math.imul(x, x)) >>> 0;\n  }\n  return s;\n}\n',
      rust: 'pub fn sumsq(a: [u32; 4]) -> u32 {\n    let mut s: u32 = 0;\n    for i in 0..4 {\n        s = s.wrapping_add(a[i].wrapping_mul(a[i]));\n    }\n    s\n}\n',
    },
  },
  {
    id: 'b-inrange-inclusive',
    kind: 'multi-node-edit',
    instruction:
      'inrange(x, lo, hi) must be true when lo <= x <= hi (unsigned), inclusive at both ends. Both comparisons are currently strict; fix both.',
    a0Source:
      'fn inrange u32 u32 u32 -> bool\na gt p0 p1\nb lt p0 p2\nc and a b\nret c\nend\n',
    tsSource:
      'export function inrange(x: number, lo: number, hi: number): boolean {\n  return x > lo && x < hi;\n}\n',
    rustSource: 'pub fn inrange(x: u32, lo: u32, hi: u32) -> bool {\n    x > lo && x < hi\n}\n',
    tests: [
      { fn: 'inrange', args: [5, 5, 5], expected: true },
      { fn: 'inrange', args: [4, 5, 9], expected: false },
      { fn: 'inrange', args: [9, 5, 9], expected: true },
      { fn: 'inrange', args: [10, 5, 9], expected: false },
      { fn: 'inrange', args: [7, 5, 9], expected: true },
      { fn: 'inrange', args: [MAX, 0, MAX], expected: true },
    ],
    reference: {
      a0: 'fn inrange u32 u32 u32 -> bool\na ge p0 p1\nb le p0 p2\nc and a b\nret c\nend\n',
      ts: 'export function inrange(x: number, lo: number, hi: number): boolean {\n  return x >= lo && x <= hi;\n}\n',
      rust: 'pub fn inrange(x: u32, lo: u32, hi: u32) -> bool {\n    x >= lo && x <= hi\n}\n',
    },
  },
  {
    id: 'b-bounds-largest',
    kind: 'comprehension-edit',
    target: 'bounds',
    instruction:
      'bounds takes an array of four u32 and should return the pair (smallest element, largest element). The first field is right but the second field is wrong for most inputs. Make bounds behave as described.',
    a0Source:
      'fn minmax (u32,u32) u32 u32x4 -> (u32,u32)\nlo at p0 0\nhi at p0 1\nx get p2 p1\nc lt x lo\nnlo select c x lo\nd lt x hi\nnhi select d x hi\nr rec nlo nhi\nret r\nend\nfn bounds u32x4 -> (u32,u32)\ns rec 4294967295 0\nr fold minmax 4 s p0\nret r\nend\n',
    tsSource:
      'export function bounds(a: number[]): [number, number] {\n  let lo = 0xffffffff;\n  let hi = 0;\n  for (let i = 0; i < 4; i++) {\n    const x = a[i % 4]!;\n    if (x < lo) lo = x;\n    if (x < hi) hi = x;\n  }\n  return [lo, hi];\n}\n',
    rustSource:
      'pub fn bounds(a: [u32; 4]) -> (u32, u32) {\n    let mut lo = u32::MAX;\n    let mut hi = 0u32;\n    for i in 0..4 {\n        let x = a[i];\n        if x < lo {\n            lo = x;\n        }\n        if x < hi {\n            hi = x;\n        }\n    }\n    (lo, hi)\n}\n',
    tests: [
      { fn: 'bounds', args: [[3, 9, 1, 7]], expected: [1, 9] },
      { fn: 'bounds', args: [[5, 5, 5, 5]], expected: [5, 5] },
      { fn: 'bounds', args: [[MAX, 0, MAX, 2]], expected: [0, MAX] },
      { fn: 'bounds', args: [[8, 6, 4, 2]], expected: [2, 8] },
    ],
    reference: {
      a0: 'fn minmax (u32,u32) u32 u32x4 -> (u32,u32)\nlo at p0 0\nhi at p0 1\nx get p2 p1\nc lt x lo\nnlo select c x lo\nd gt x hi\nnhi select d x hi\nr rec nlo nhi\nret r\nend\nfn bounds u32x4 -> (u32,u32)\ns rec 4294967295 0\nr fold minmax 4 s p0\nret r\nend\n',
      ts: 'export function bounds(a: number[]): [number, number] {\n  let lo = 0xffffffff;\n  let hi = 0;\n  for (let i = 0; i < 4; i++) {\n    const x = a[i % 4]!;\n    if (x < lo) lo = x;\n    if (x > hi) hi = x;\n  }\n  return [lo, hi];\n}\n',
      rust: 'pub fn bounds(a: [u32; 4]) -> (u32, u32) {\n    let mut lo = u32::MAX;\n    let mut hi = 0u32;\n    for i in 0..4 {\n        let x = a[i];\n        if x < lo {\n            lo = x;\n        }\n        if x > hi {\n            hi = x;\n        }\n    }\n    (lo, hi)\n}\n',
    },
  },
  {
    id: 'b-checksum-poly',
    kind: 'comprehension-edit',
    target: 'checksum',
    instruction:
      'checksum takes an array of four u32 and should be a polynomial rolling hash: start with h = 7, then for each element x in index order set h = h * 31 + x (all arithmetic wrapping mod 2^32), and return h. It currently does something else. Make it behave as described.',
    a0Source:
      'fn mixel u32 u32 u32x4 -> u32\na get p2 p1\nb xor p0 a\nret b\nend\nfn checksum u32x4 -> u32\nr fold mixel 4 0 p0\nret r\nend\n',
    tsSource:
      'export function checksum(a: number[]): number {\n  let h = 0;\n  for (let i = 0; i < 4; i++) {\n    h = (h ^ a[i % 4]!) >>> 0;\n  }\n  return h;\n}\n',
    rustSource:
      'pub fn checksum(a: [u32; 4]) -> u32 {\n    let mut h: u32 = 0;\n    for i in 0..4 {\n        h ^= a[i];\n    }\n    h\n}\n',
    tests: [
      { fn: 'checksum', args: [[0, 0, 0, 0]], expected: 6464647 },
      { fn: 'checksum', args: [[1, 2, 3, 4]], expected: 6496457 },
      { fn: 'checksum', args: [[MAX, MAX, MAX, MAX]], expected: 0 },
      { fn: 'checksum', args: [[0, 0, 0, 1]], expected: 0 },
    ],
    reference: {
      a0: 'fn mixel u32 u32 u32x4 -> u32\nm mul p0 31\na get p2 p1\nb add m a\nret b\nend\nfn checksum u32x4 -> u32\nr fold mixel 4 7 p0\nret r\nend\n',
      ts: 'export function checksum(a: number[]): number {\n  let h = 7;\n  for (let i = 0; i < 4; i++) {\n    h = (Math.imul(h, 31) + a[i % 4]!) >>> 0;\n  }\n  return h;\n}\n',
      rust: 'pub fn checksum(a: [u32; 4]) -> u32 {\n    let mut h: u32 = 7;\n    for i in 0..4 {\n        h = h.wrapping_mul(31).wrapping_add(a[i]);\n    }\n    h\n}\n',
    },
  },
  {
    id: 'b-norm2-dot',
    kind: 'create',
    target: 'dot',
    instruction:
      'Add a new function norm2 taking one u32x4 and returning its squared length: the dot product of the array with itself. It must call the existing dot function.',
    a0Source:
      'fn dstep u32 u32 u32x4 u32x4 -> u32\na get p2 p1\nb get p3 p1\nc mul a b\nd add p0 c\nret d\nend\nfn dot u32x4 u32x4 -> u32\nr fold dstep 4 0 p0 p1\nret r\nend\n',
    tsSource:
      'export function dot(a: number[], b: number[]): number {\n  let s = 0;\n  for (let i = 0; i < 4; i++) {\n    s = (s + Math.imul(a[i % 4]!, b[i % 4]!)) >>> 0;\n  }\n  return s;\n}\n',
    rustSource:
      'pub fn dot(a: [u32; 4], b: [u32; 4]) -> u32 {\n    let mut s: u32 = 0;\n    for i in 0..4 {\n        s = s.wrapping_add(a[i].wrapping_mul(b[i]));\n    }\n    s\n}\n',
    tests: [
      { fn: 'norm2', args: [[1, 2, 3, 4]], expected: 30 },
      { fn: 'norm2', args: [[65536, 1, 0, 0]], expected: 1 },
      { fn: 'norm2', args: [[0, 0, 0, 0]], expected: 0 },
      { fn: 'norm2', args: [[3, 0, 0, 4]], expected: 25 },
      { fn: 'dot', args: [[1, 2, 3, 4], [4, 3, 2, 1]], expected: 20 },
    ],
    reference: {
      a0: 'fn dstep u32 u32 u32x4 u32x4 -> u32\na get p2 p1\nb get p3 p1\nc mul a b\nd add p0 c\nret d\nend\nfn dot u32x4 u32x4 -> u32\nr fold dstep 4 0 p0 p1\nret r\nend\nfn norm2 u32x4 -> u32\nr call dot p0 p0\nret r\nend\n',
      ts: 'export function dot(a: number[], b: number[]): number {\n  let s = 0;\n  for (let i = 0; i < 4; i++) {\n    s = (s + Math.imul(a[i % 4]!, b[i % 4]!)) >>> 0;\n  }\n  return s;\n}\nexport function norm2(a: number[]): number {\n  return dot(a, a);\n}\n',
      rust: 'pub fn dot(a: [u32; 4], b: [u32; 4]) -> u32 {\n    let mut s: u32 = 0;\n    for i in 0..4 {\n        s = s.wrapping_add(a[i].wrapping_mul(b[i]));\n    }\n    s\n}\npub fn norm2(a: [u32; 4]) -> u32 {\n    dot(a, a)\n}\n',
    },
  },
  {
    id: 'b-pctof-limit',
    kind: 'create',
    target: 'limit',
    instruction:
      'Add a new function pctof(part, whole): compute (part * 100) / whole using wrapping multiply and A0 division semantics (whole = 0 gives 4294967295), then return that value limited to the range 0..100 by calling the existing limit function.',
    a0Source:
      'fn limit u32 u32 u32 -> u32\na lt p0 p1\nb select a p1 p0\nc gt b p2\nd select c p2 b\nret d\nend\n',
    tsSource:
      'export function limit(x: number, lo: number, hi: number): number {\n  const b = x < lo ? lo : x;\n  return b > hi ? hi : b;\n}\n',
    rustSource:
      'pub fn limit(x: u32, lo: u32, hi: u32) -> u32 {\n    let b = if x < lo { lo } else { x };\n    if b > hi { hi } else { b }\n}\n',
    tests: [
      { fn: 'pctof', args: [1, 4], expected: 25 },
      { fn: 'pctof', args: [5, 0], expected: 100 },
      { fn: 'pctof', args: [0, 0], expected: 100 },
      { fn: 'pctof', args: [3, 2], expected: 100 },
      { fn: 'pctof', args: [42949673, 1], expected: 4 },
      { fn: 'pctof', args: [1, 3], expected: 33 },
    ],
    reference: {
      a0: 'fn limit u32 u32 u32 -> u32\na lt p0 p1\nb select a p1 p0\nc gt b p2\nd select c p2 b\nret d\nend\nfn pctof u32 u32 -> u32\na mul p0 100\nb div a p1\nc call limit b 0 100\nret c\nend\n',
      ts: 'export function limit(x: number, lo: number, hi: number): number {\n  const b = x < lo ? lo : x;\n  return b > hi ? hi : b;\n}\nexport function pctof(part: number, whole: number): number {\n  const n = Math.imul(part, 100) >>> 0;\n  const q = whole === 0 ? 0xffffffff : Math.floor(n / whole);\n  return limit(q, 0, 100);\n}\n',
      rust: 'pub fn limit(x: u32, lo: u32, hi: u32) -> u32 {\n    let b = if x < lo { lo } else { x };\n    if b > hi { hi } else { b }\n}\npub fn pctof(part: u32, whole: u32) -> u32 {\n    let n = part.wrapping_mul(100);\n    let q = if whole == 0 { u32::MAX } else { n / whole };\n    limit(q, 0, 100)\n}\n',
    },
  },
  {
    id: 'b-hamming-popcnt',
    kind: 'create',
    target: 'popcnt',
    instruction:
      'Add a new function hamming(a, b) returning the number of bit positions where a and b differ. It must call the existing popcnt function on a xor b.',
    a0Source:
      'fn pstep u32 u32 u32 -> u32\na shr p2 p1\nb and a 1\nc add p0 b\nret c\nend\nfn popcnt u32 -> u32\nr fold pstep 32 0 p0\nret r\nend\n',
    tsSource:
      'export function popcnt(x: number): number {\n  let s = 0;\n  for (let i = 0; i < 32; i++) {\n    s = (s + ((x >>> i) & 1)) >>> 0;\n  }\n  return s;\n}\n',
    rustSource:
      'pub fn popcnt(x: u32) -> u32 {\n    let mut s: u32 = 0;\n    for i in 0..32u32 {\n        s = s.wrapping_add((x >> i) & 1);\n    }\n    s\n}\n',
    tests: [
      { fn: 'hamming', args: [0, MAX], expected: 32 },
      { fn: 'hamming', args: [5, 5], expected: 0 },
      { fn: 'hamming', args: [1, 2], expected: 2 },
      { fn: 'hamming', args: [MAX, MAX], expected: 0 },
      { fn: 'popcnt', args: [0xf0f0_f0f0], expected: 16 },
    ],
    reference: {
      a0: 'fn pstep u32 u32 u32 -> u32\na shr p2 p1\nb and a 1\nc add p0 b\nret c\nend\nfn popcnt u32 -> u32\nr fold pstep 32 0 p0\nret r\nend\nfn hamming u32 u32 -> u32\nx xor p0 p1\nr call popcnt x\nret r\nend\n',
      ts: 'export function popcnt(x: number): number {\n  let s = 0;\n  for (let i = 0; i < 32; i++) {\n    s = (s + ((x >>> i) & 1)) >>> 0;\n  }\n  return s;\n}\nexport function hamming(a: number, b: number): number {\n  return popcnt((a ^ b) >>> 0);\n}\n',
      rust: 'pub fn popcnt(x: u32) -> u32 {\n    let mut s: u32 = 0;\n    for i in 0..32u32 {\n        s = s.wrapping_add((x >> i) & 1);\n    }\n    s\n}\npub fn hamming(a: u32, b: u32) -> u32 {\n    popcnt(a ^ b)\n}\n',
    },
  },
];
