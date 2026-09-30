/**
 * Held-out task set D for the AI-edit experiment. Independent of the primary
 * TASKS array and of set B: same shape, disjoint tasks, ids prefixed `d-`.
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

export const TASKS_D: readonly Task[] = [
  {
    id: 'd-scale-constant',
    kind: 'targeted-edit',
    instruction:
      'scale(x) should return x times 3 plus 1 (wrapping mod 2^32). It currently adds 2 instead of 1. Fix that single constant.',
    a0Source: 'fn scale u32 -> u32\na mul p0 3\nb add a 2\nret b\nend\n',
    tsSource:
      'export function scale(x: number): number {\n  return (Math.imul(x, 3) + 2) >>> 0;\n}\n',
    rustSource: 'pub fn scale(x: u32) -> u32 {\n    x.wrapping_mul(3).wrapping_add(2)\n}\n',
    tests: [
      { fn: 'scale', args: [0], expected: 1 },
      { fn: 'scale', args: [5], expected: 16 },
      { fn: 'scale', args: [10], expected: 31 },
      { fn: 'scale', args: [MAX], expected: 4294967294 },
      { fn: 'scale', args: [1431655765], expected: 0 },
    ],
    reference: {
      a0: 'fn scale u32 -> u32\na mul p0 3\nb add a 1\nret b\nend\n',
      ts: 'export function scale(x: number): number {\n  return (Math.imul(x, 3) + 1) >>> 0;\n}\n',
      rust: 'pub fn scale(x: u32) -> u32 {\n    x.wrapping_mul(3).wrapping_add(1)\n}\n',
    },
  },
  {
    id: 'd-offset-param',
    kind: 'targeted-edit',
    instruction:
      'offset(x) currently adds the fixed constant 10 to x. Change it to take a second parameter k and return x plus k (wrapping mod 2^32).',
    a0Source: 'fn offset u32 -> u32\na add p0 10\nret a\nend\n',
    tsSource: 'export function offset(x: number): number {\n  return (x + 10) >>> 0;\n}\n',
    rustSource: 'pub fn offset(x: u32) -> u32 {\n    x.wrapping_add(10)\n}\n',
    tests: [
      { fn: 'offset', args: [5, 3], expected: 8 },
      { fn: 'offset', args: [MAX, 1], expected: 0 },
      { fn: 'offset', args: [0, 0], expected: 0 },
      { fn: 'offset', args: [100, MAX], expected: 99 },
      { fn: 'offset', args: [7, 10], expected: 17 },
    ],
    reference: {
      a0: 'fn offset u32 u32 -> u32\na add p0 p1\nret a\nend\n',
      ts: 'export function offset(x: number, k: number): number {\n  return (x + k) >>> 0;\n}\n',
      rust: 'pub fn offset(x: u32, k: u32) -> u32 {\n    x.wrapping_add(k)\n}\n',
    },
  },
  {
    id: 'd-cube-sq',
    kind: 'create',
    target: 'sq',
    instruction:
      'Add a new function cube(x) returning x times x times x (wrapping mod 2^32). It must call the existing sq function.',
    a0Source: 'fn sq u32 -> u32\na mul p0 p0\nret a\nend\n',
    tsSource: 'export function sq(x: number): number {\n  return Math.imul(x, x) >>> 0;\n}\n',
    rustSource: 'pub fn sq(x: u32) -> u32 {\n    x.wrapping_mul(x)\n}\n',
    tests: [
      { fn: 'cube', args: [3], expected: 27 },
      { fn: 'cube', args: [0], expected: 0 },
      { fn: 'cube', args: [2], expected: 8 },
      { fn: 'cube', args: [65536], expected: 0 },
      { fn: 'cube', args: [MAX], expected: MAX },
      { fn: 'sq', args: [5], expected: 25 },
    ],
    reference: {
      a0: 'fn sq u32 -> u32\na mul p0 p0\nret a\nend\nfn cube u32 -> u32\na call sq p0\nb mul a p0\nret b\nend\n',
      ts: 'export function sq(x: number): number {\n  return Math.imul(x, x) >>> 0;\n}\nexport function cube(x: number): number {\n  return Math.imul(sq(x), x) >>> 0;\n}\n',
      rust: 'pub fn sq(x: u32) -> u32 {\n    x.wrapping_mul(x)\n}\npub fn cube(x: u32) -> u32 {\n    sq(x).wrapping_mul(x)\n}\n',
    },
  },
  {
    id: 'd-total-six',
    kind: 'targeted-edit',
    instruction:
      'total(x) should return x plus twice each of the integers 0 through 5 (six iterations, wrapping mod 2^32). It currently runs only four iterations. Change only the iteration count.',
    a0Source:
      'fn addtwice u32 u32 -> u32\na shl p1 1\nb add p0 a\nret b\nend\nfn total u32 -> u32\nr fold addtwice 4 p0\nret r\nend\n',
    tsSource:
      'export function total(x: number): number {\n  let s = x >>> 0;\n  for (let i = 0; i < 4; i++) {\n    s = (s + (i << 1)) >>> 0;\n  }\n  return s;\n}\n',
    rustSource:
      'pub fn total(x: u32) -> u32 {\n    let mut s = x;\n    for i in 0..4u32 {\n        s = s.wrapping_add(i << 1);\n    }\n    s\n}\n',
    tests: [
      { fn: 'total', args: [0], expected: 30 },
      { fn: 'total', args: [1], expected: 31 },
      { fn: 'total', args: [100], expected: 130 },
      { fn: 'total', args: [MAX], expected: 29 },
      { fn: 'total', args: [MAX - 10], expected: 19 },
    ],
    reference: {
      a0: 'fn addtwice u32 u32 -> u32\na shl p1 1\nb add p0 a\nret b\nend\nfn total u32 -> u32\nr fold addtwice 6 p0\nret r\nend\n',
      ts: 'export function total(x: number): number {\n  let s = x >>> 0;\n  for (let i = 0; i < 6; i++) {\n    s = (s + (i << 1)) >>> 0;\n  }\n  return s;\n}\n',
      rust: 'pub fn total(x: u32) -> u32 {\n    let mut s = x;\n    for i in 0..6u32 {\n        s = s.wrapping_add(i << 1);\n    }\n    s\n}\n',
    },
  },
  {
    id: 'd-stats-second-field',
    kind: 'targeted-edit',
    instruction:
      'stats(a, b) returns a pair whose first field is a + b and whose second field should be a - b (both wrapping mod 2^32). The second field currently holds b - a. Fix the second field.',
    a0Source: 'fn stats u32 u32 -> (u32,u32)\ns add p0 p1\nd sub p1 p0\nr rec s d\nret r\nend\n',
    tsSource:
      'export function stats(a: number, b: number): [number, number] {\n  const s = (a + b) >>> 0;\n  const d = (b - a) >>> 0;\n  return [s, d];\n}\n',
    rustSource:
      'pub fn stats(a: u32, b: u32) -> (u32, u32) {\n    let s = a.wrapping_add(b);\n    let d = b.wrapping_sub(a);\n    (s, d)\n}\n',
    tests: [
      { fn: 'stats', args: [7, 3], expected: [10, 4] },
      { fn: 'stats', args: [3, 7], expected: [10, 4294967292] },
      { fn: 'stats', args: [0, 0], expected: [0, 0] },
      { fn: 'stats', args: [MAX, 1], expected: [0, 4294967294] },
      { fn: 'stats', args: [MAX, MAX], expected: [4294967294, 0] },
    ],
    reference: {
      a0: 'fn stats u32 u32 -> (u32,u32)\ns add p0 p1\nd sub p0 p1\nr rec s d\nret r\nend\n',
      ts: 'export function stats(a: number, b: number): [number, number] {\n  const s = (a + b) >>> 0;\n  const d = (a - b) >>> 0;\n  return [s, d];\n}\n',
      rust: 'pub fn stats(a: u32, b: u32) -> (u32, u32) {\n    let s = a.wrapping_add(b);\n    let d = a.wrapping_sub(b);\n    (s, d)\n}\n',
    },
  },
  {
    id: 'd-maxof-comparison',
    kind: 'targeted-edit',
    instruction:
      'maxof(a, b) must return the larger of its two unsigned inputs, but it currently returns the smaller one. Change only the comparison.',
    a0Source: 'fn maxof u32 u32 -> u32\nc lt p0 p1\nr select c p0 p1\nret r\nend\n',
    tsSource: 'export function maxof(a: number, b: number): number {\n  return a < b ? a : b;\n}\n',
    rustSource: 'pub fn maxof(a: u32, b: u32) -> u32 {\n    if a < b { a } else { b }\n}\n',
    tests: [
      { fn: 'maxof', args: [3, 9], expected: 9 },
      { fn: 'maxof', args: [9, 3], expected: 9 },
      { fn: 'maxof', args: [5, 5], expected: 5 },
      { fn: 'maxof', args: [0, MAX], expected: MAX },
      { fn: 'maxof', args: [MAX, 0], expected: MAX },
    ],
    reference: {
      a0: 'fn maxof u32 u32 -> u32\nc gt p0 p1\nr select c p0 p1\nret r\nend\n',
      ts: 'export function maxof(a: number, b: number): number {\n  return a > b ? a : b;\n}\n',
      rust: 'pub fn maxof(a: u32, b: u32) -> u32 {\n    if a > b { a } else { b }\n}\n',
    },
  },
  {
    id: 'd-isdiv-bool',
    kind: 'multi-node-edit',
    instruction:
      'isdiv(a, b) currently returns the remainder of a divided by b. Change it to return a bool that is true exactly when that remainder is zero (with b = 0 the remainder is a, so the result is true only when a is 0).',
    a0Source: 'fn isdiv u32 u32 -> u32\nr rem p0 p1\nret r\nend\n',
    tsSource:
      'export function isdiv(a: number, b: number): number {\n  return b === 0 ? a : a % b;\n}\n',
    rustSource: 'pub fn isdiv(a: u32, b: u32) -> u32 {\n    if b == 0 { a } else { a % b }\n}\n',
    tests: [
      { fn: 'isdiv', args: [10, 5], expected: true },
      { fn: 'isdiv', args: [10, 3], expected: false },
      { fn: 'isdiv', args: [0, 0], expected: true },
      { fn: 'isdiv', args: [7, 0], expected: false },
      { fn: 'isdiv', args: [0, 7], expected: true },
      { fn: 'isdiv', args: [MAX, MAX], expected: true },
    ],
    reference: {
      a0: 'fn isdiv u32 u32 -> bool\nr rem p0 p1\nz eq r 0\nret z\nend\n',
      ts: 'export function isdiv(a: number, b: number): boolean {\n  const r = b === 0 ? a : a % b;\n  return r === 0;\n}\n',
      rust: 'pub fn isdiv(a: u32, b: u32) -> bool {\n    let r = if b == 0 { a } else { a % b };\n    r == 0\n}\n',
    },
  },
  {
    id: 'd-rename-twice',
    kind: 'multi-node-edit',
    target: 'twice',
    instruction:
      'Rename the function twice to dbl everywhere, including the calls made by quad. Behavior must not change.',
    a0Source:
      'fn twice u32 -> u32\na add p0 p0\nret a\nend\nfn quad u32 -> u32\na call twice p0\nb call twice a\nret b\nend\n',
    tsSource:
      'export function twice(x: number): number {\n  return (x + x) >>> 0;\n}\nexport function quad(x: number): number {\n  return twice(twice(x));\n}\n',
    rustSource:
      'pub fn twice(x: u32) -> u32 {\n    x.wrapping_add(x)\n}\npub fn quad(x: u32) -> u32 {\n    twice(twice(x))\n}\n',
    tests: [
      { fn: 'dbl', args: [5], expected: 10 },
      { fn: 'dbl', args: [MAX], expected: 4294967294 },
      { fn: 'quad', args: [3], expected: 12 },
      { fn: 'quad', args: [0x4000_0000], expected: 0 },
      { fn: 'quad', args: [MAX], expected: 4294967292 },
    ],
    reference: {
      a0: 'fn dbl u32 -> u32\na add p0 p0\nret a\nend\nfn quad u32 -> u32\na call dbl p0\nb call dbl a\nret b\nend\n',
      ts: 'export function dbl(x: number): number {\n  return (x + x) >>> 0;\n}\nexport function quad(x: number): number {\n  return dbl(dbl(x));\n}\n',
      rust: 'pub fn dbl(x: u32) -> u32 {\n    x.wrapping_add(x)\n}\npub fn quad(x: u32) -> u32 {\n    dbl(dbl(x))\n}\n',
    },
  },
  {
    id: 'd-lowflip-xor',
    kind: 'targeted-edit',
    instruction:
      'lowflip(x) should return x with its low 8 bits inverted and all other bits unchanged. It currently masks with a bitwise and, which keeps only the low byte. Replace that operation.',
    a0Source: 'fn lowflip u32 -> u32\na and p0 255\nret a\nend\n',
    tsSource: 'export function lowflip(x: number): number {\n  return (x & 255) >>> 0;\n}\n',
    rustSource: 'pub fn lowflip(x: u32) -> u32 {\n    x & 255\n}\n',
    tests: [
      { fn: 'lowflip', args: [0], expected: 255 },
      { fn: 'lowflip', args: [255], expected: 0 },
      { fn: 'lowflip', args: [0x1234_5678], expected: 305419911 },
      { fn: 'lowflip', args: [256], expected: 511 },
      { fn: 'lowflip', args: [MAX], expected: 4294967040 },
    ],
    reference: {
      a0: 'fn lowflip u32 -> u32\na xor p0 255\nret a\nend\n',
      ts: 'export function lowflip(x: number): number {\n  return (x ^ 255) >>> 0;\n}\n',
      rust: 'pub fn lowflip(x: u32) -> u32 {\n    x ^ 255\n}\n',
    },
  },
  {
    id: 'd-absdiff-wrap',
    kind: 'multi-node-edit',
    instruction:
      'absdiff(a, b) must return the absolute difference between two unsigned values. It currently returns a - b, which wraps around when a is smaller than b. Fix it.',
    a0Source: 'fn absdiff u32 u32 -> u32\na sub p0 p1\nret a\nend\n',
    tsSource:
      'export function absdiff(a: number, b: number): number {\n  return (a - b) >>> 0;\n}\n',
    rustSource: 'pub fn absdiff(a: u32, b: u32) -> u32 {\n    a.wrapping_sub(b)\n}\n',
    tests: [
      { fn: 'absdiff', args: [9, 4], expected: 5 },
      { fn: 'absdiff', args: [4, 9], expected: 5 },
      { fn: 'absdiff', args: [7, 7], expected: 0 },
      { fn: 'absdiff', args: [0, MAX], expected: MAX },
      { fn: 'absdiff', args: [MAX, 0], expected: MAX },
    ],
    reference: {
      a0: 'fn absdiff u32 u32 -> u32\nc lt p0 p1\nx sub p0 p1\ny sub p1 p0\nr select c y x\nret r\nend\n',
      ts: 'export function absdiff(a: number, b: number): number {\n  return a < b ? b - a : a - b;\n}\n',
      rust: 'pub fn absdiff(a: u32, b: u32) -> u32 {\n    if a < b { b - a } else { a - b }\n}\n',
    },
  },
  {
    id: 'd-setmid-index',
    kind: 'targeted-edit',
    instruction:
      'setmid(a, v) should return the array with v stored at index 2 and every other element unchanged. It currently stores v at index 1. Change only the index.',
    a0Source: 'fn setmid u32x4 u32 -> u32x4\nr set p0 1 p1\nret r\nend\n',
    tsSource:
      'export function setmid(a: number[], v: number): number[] {\n  const r = a.slice();\n  r[1] = v;\n  return r;\n}\n',
    rustSource:
      'pub fn setmid(a: [u32; 4], v: u32) -> [u32; 4] {\n    let mut r = a;\n    r[1] = v;\n    r\n}\n',
    tests: [
      { fn: 'setmid', args: [[1, 2, 3, 4], 9], expected: [1, 2, 9, 4] },
      { fn: 'setmid', args: [[0, 0, 0, 0], MAX], expected: [0, 0, MAX, 0] },
      { fn: 'setmid', args: [[5, 5, 5, 5], 5], expected: [5, 5, 5, 5] },
      { fn: 'setmid', args: [[1, 2, 3, 4], 0], expected: [1, 2, 0, 4] },
      { fn: 'setmid', args: [[MAX, MAX, MAX, MAX], 7], expected: [MAX, MAX, 7, MAX] },
    ],
    reference: {
      a0: 'fn setmid u32x4 u32 -> u32x4\nr set p0 2 p1\nret r\nend\n',
      ts: 'export function setmid(a: number[], v: number): number[] {\n  const r = a.slice();\n  r[2] = v;\n  return r;\n}\n',
      rust: 'pub fn setmid(a: [u32; 4], v: u32) -> [u32; 4] {\n    let mut r = a;\n    r[2] = v;\n    r\n}\n',
    },
  },
  {
    id: 'd-calc-inc-first',
    kind: 'multi-node-edit',
    target: 'calc',
    instruction:
      'Add a new function inc(x) returning x plus 1 (wrapping mod 2^32), and change calc(x) so that it doubles the incremented value, that is shl1(inc(x)), instead of just doubling x.',
    a0Source:
      'fn shl1 u32 -> u32\na shl p0 1\nret a\nend\nfn calc u32 -> u32\nr call shl1 p0\nret r\nend\n',
    tsSource:
      'export function shl1(x: number): number {\n  return (x << 1) >>> 0;\n}\nexport function calc(x: number): number {\n  return shl1(x);\n}\n',
    rustSource:
      'pub fn shl1(x: u32) -> u32 {\n    x << 1\n}\npub fn calc(x: u32) -> u32 {\n    shl1(x)\n}\n',
    tests: [
      { fn: 'calc', args: [0], expected: 2 },
      { fn: 'calc', args: [4], expected: 10 },
      { fn: 'calc', args: [MAX], expected: 0 },
      { fn: 'calc', args: [0x7fff_ffff], expected: 0 },
      { fn: 'calc', args: [0x7fff_fffe], expected: 4294967294 },
      { fn: 'inc', args: [9], expected: 10 },
    ],
    reference: {
      a0: 'fn shl1 u32 -> u32\na shl p0 1\nret a\nend\nfn inc u32 -> u32\na add p0 1\nret a\nend\nfn calc u32 -> u32\na call inc p0\nb call shl1 a\nret b\nend\n',
      ts: 'export function shl1(x: number): number {\n  return (x << 1) >>> 0;\n}\nexport function inc(x: number): number {\n  return (x + 1) >>> 0;\n}\nexport function calc(x: number): number {\n  return shl1(inc(x));\n}\n',
      rust: 'pub fn shl1(x: u32) -> u32 {\n    x << 1\n}\npub fn inc(x: u32) -> u32 {\n    x.wrapping_add(1)\n}\npub fn calc(x: u32) -> u32 {\n    shl1(inc(x))\n}\n',
    },
  },
  {
    id: 'd-prod4-seed',
    kind: 'comprehension-edit',
    target: 'prod4',
    instruction:
      'prod4 takes an array of four u32 and should return the product of its four elements (wrapping mod 2^32), but it always returns zero. Make it behave as described.',
    a0Source:
      'fn mulel u32 u32 u32x4 -> u32\na get p2 p1\nb mul p0 a\nret b\nend\nfn prod4 u32x4 -> u32\nr fold mulel 4 0 p0\nret r\nend\n',
    tsSource:
      'export function prod4(a: number[]): number {\n  let s = 0;\n  for (let i = 0; i < 4; i++) {\n    s = Math.imul(s, a[i % 4]!) >>> 0;\n  }\n  return s;\n}\n',
    rustSource:
      'pub fn prod4(a: [u32; 4]) -> u32 {\n    let mut s: u32 = 0;\n    for i in 0..4 {\n        s = s.wrapping_mul(a[i]);\n    }\n    s\n}\n',
    tests: [
      { fn: 'prod4', args: [[1, 2, 3, 4]], expected: 24 },
      { fn: 'prod4', args: [[65536, 65536, 1, 1]], expected: 0 },
      { fn: 'prod4', args: [[MAX, MAX, 1, 1]], expected: 1 },
      { fn: 'prod4', args: [[5, 0, 5, 5]], expected: 0 },
      { fn: 'prod4', args: [[7, 1, 1, 1]], expected: 7 },
      { fn: 'prod4', args: [[MAX, 2, 1, 1]], expected: 4294967294 },
    ],
    reference: {
      a0: 'fn mulel u32 u32 u32x4 -> u32\na get p2 p1\nb mul p0 a\nret b\nend\nfn prod4 u32x4 -> u32\nr fold mulel 4 1 p0\nret r\nend\n',
      ts: 'export function prod4(a: number[]): number {\n  let s = 1;\n  for (let i = 0; i < 4; i++) {\n    s = Math.imul(s, a[i % 4]!) >>> 0;\n  }\n  return s;\n}\n',
      rust: 'pub fn prod4(a: [u32; 4]) -> u32 {\n    let mut s: u32 = 1;\n    for i in 0..4 {\n        s = s.wrapping_mul(a[i]);\n    }\n    s\n}\n',
    },
  },
];
