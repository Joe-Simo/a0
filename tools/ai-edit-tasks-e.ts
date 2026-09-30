/**
 * Held-out task set E for the AI-edit experiment. Independent of the primary
 * TASKS array and of sets B and D: same shape, disjoint tasks, ids prefixed `e-`.
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

export const TASKS_E: readonly Task[] = [
  {
    id: 'e-fold-count-fix',
    kind: 'targeted-edit',
    target: 'sumto',
    instruction:
      'sumto(x) should return x plus each of the integers 0 through 4 (five iterations, wrapping mod 2^32). It currently stops one iteration early. Change only the iteration count.',
    a0Source:
      'fn addi u32 u32 -> u32\na add p0 p1\nret a\nend\nfn sumto u32 -> u32\nr fold addi 4 p0\nret r\nend\n',
    tsSource:
      'export function sumto(x: number): number {\n  let s = x >>> 0;\n  for (let i = 0; i < 4; i++) {\n    s = (s + i) >>> 0;\n  }\n  return s;\n}\n',
    rustSource:
      'pub fn sumto(x: u32) -> u32 {\n    let mut s = x;\n    for i in 0..4u32 {\n        s = s.wrapping_add(i);\n    }\n    s\n}\n',
    tests: [
      { fn: 'sumto', args: [0], expected: 10 },
      { fn: 'sumto', args: [5], expected: 15 },
      { fn: 'sumto', args: [100], expected: 110 },
      { fn: 'sumto', args: [MAX], expected: 9 },
      { fn: 'sumto', args: [MAX - 9], expected: 0 },
    ],
    reference: {
      a0: 'fn addi u32 u32 -> u32\na add p0 p1\nret a\nend\nfn sumto u32 -> u32\nr fold addi 5 p0\nret r\nend\n',
      ts: 'export function sumto(x: number): number {\n  let s = x >>> 0;\n  for (let i = 0; i < 5; i++) {\n    s = (s + i) >>> 0;\n  }\n  return s;\n}\n',
      rust: 'pub fn sumto(x: u32) -> u32 {\n    let mut s = x;\n    for i in 0..5u32 {\n        s = s.wrapping_add(i);\n    }\n    s\n}\n',
    },
  },
  {
    id: 'e-swap-fields',
    kind: 'targeted-edit',
    instruction:
      'split(a, b) returns a pair holding a + b and a - b (wrapping mod 2^32) in that order. Swap the two fields so the difference comes first and the sum second.',
    a0Source: 'fn split u32 u32 -> (u32,u32)\ns add p0 p1\nd sub p0 p1\nr rec s d\nret r\nend\n',
    tsSource:
      'export function split(a: number, b: number): [number, number] {\n  const s = (a + b) >>> 0;\n  const d = (a - b) >>> 0;\n  return [s, d];\n}\n',
    rustSource:
      'pub fn split(a: u32, b: u32) -> (u32, u32) {\n    let s = a.wrapping_add(b);\n    let d = a.wrapping_sub(b);\n    (s, d)\n}\n',
    tests: [
      { fn: 'split', args: [7, 3], expected: [4, 10] },
      { fn: 'split', args: [3, 7], expected: [4294967292, 10] },
      { fn: 'split', args: [0, 0], expected: [0, 0] },
      { fn: 'split', args: [MAX, 1], expected: [4294967294, 0] },
      { fn: 'split', args: [5, 5], expected: [0, 10] },
    ],
    reference: {
      a0: 'fn split u32 u32 -> (u32,u32)\ns add p0 p1\nd sub p0 p1\nr rec d s\nret r\nend\n',
      ts: 'export function split(a: number, b: number): [number, number] {\n  const s = (a + b) >>> 0;\n  const d = (a - b) >>> 0;\n  return [d, s];\n}\n',
      rust: 'pub fn split(a: u32, b: u32) -> (u32, u32) {\n    let s = a.wrapping_add(b);\n    let d = a.wrapping_sub(b);\n    (d, s)\n}\n',
    },
  },
  {
    id: 'e-guard-zero-div',
    kind: 'multi-node-edit',
    instruction:
      'quot(a, b) returns a divided by b. Add a guard so that when b is zero it returns 0 instead of the default division-by-zero result.',
    a0Source: 'fn quot u32 u32 -> u32\nq div p0 p1\nret q\nend\n',
    tsSource:
      'export function quot(a: number, b: number): number {\n  return b === 0 ? 4294967295 : Math.floor(a / b);\n}\n',
    rustSource:
      'pub fn quot(a: u32, b: u32) -> u32 {\n    if b == 0 { u32::MAX } else { a / b }\n}\n',
    tests: [
      { fn: 'quot', args: [10, 2], expected: 5 },
      { fn: 'quot', args: [10, 0], expected: 0 },
      { fn: 'quot', args: [0, 0], expected: 0 },
      { fn: 'quot', args: [MAX, 1], expected: MAX },
      { fn: 'quot', args: [7, 3], expected: 2 },
      { fn: 'quot', args: [MAX, 0], expected: 0 },
    ],
    reference: {
      a0: 'fn quot u32 u32 -> u32\nz eq p1 0\nq div p0 p1\nr select z 0 q\nret r\nend\n',
      ts: 'export function quot(a: number, b: number): number {\n  return b === 0 ? 0 : Math.floor(a / b);\n}\n',
      rust: 'pub fn quot(a: u32, b: u32) -> u32 {\n    if b == 0 { 0 } else { a / b }\n}\n',
    },
  },
  {
    id: 'e-helper-sq-twice',
    kind: 'create',
    target: 'sumsq',
    instruction:
      'Add a helper sq(x) returning x times x (wrapping mod 2^32), and rewrite sumsq(a, b) to call sq twice, once for each argument, instead of multiplying inline.',
    a0Source: 'fn sumsq u32 u32 -> u32\nx mul p0 p0\ny mul p1 p1\ns add x y\nret s\nend\n',
    tsSource:
      'export function sumsq(a: number, b: number): number {\n  return (Math.imul(a, a) + Math.imul(b, b)) >>> 0;\n}\n',
    rustSource:
      'pub fn sumsq(a: u32, b: u32) -> u32 {\n    a.wrapping_mul(a).wrapping_add(b.wrapping_mul(b))\n}\n',
    tests: [
      { fn: 'sumsq', args: [3, 4], expected: 25 },
      { fn: 'sumsq', args: [0, 0], expected: 0 },
      { fn: 'sumsq', args: [65536, 0], expected: 0 },
      { fn: 'sumsq', args: [MAX, MAX], expected: 2 },
      { fn: 'sumsq', args: [1, 2], expected: 5 },
      { fn: 'sq', args: [6], expected: 36 },
    ],
    reference: {
      a0: 'fn sq u32 -> u32\na mul p0 p0\nret a\nend\nfn sumsq u32 u32 -> u32\nx call sq p0\ny call sq p1\ns add x y\nret s\nend\n',
      ts: 'export function sq(x: number): number {\n  return Math.imul(x, x) >>> 0;\n}\nexport function sumsq(a: number, b: number): number {\n  return (sq(a) + sq(b)) >>> 0;\n}\n',
      rust: 'pub fn sq(x: u32) -> u32 {\n    x.wrapping_mul(x)\n}\npub fn sumsq(a: u32, b: u32) -> u32 {\n    sq(a).wrapping_add(sq(b))\n}\n',
    },
  },
  {
    id: 'e-mask-widen',
    kind: 'targeted-edit',
    instruction:
      'lowbits(x) currently keeps only the low 4 bits of x. Change the mask so it keeps the low 12 bits instead.',
    a0Source: 'fn lowbits u32 -> u32\na and p0 15\nret a\nend\n',
    tsSource: 'export function lowbits(x: number): number {\n  return (x & 15) >>> 0;\n}\n',
    rustSource: 'pub fn lowbits(x: u32) -> u32 {\n    x & 15\n}\n',
    tests: [
      { fn: 'lowbits', args: [0], expected: 0 },
      { fn: 'lowbits', args: [4095], expected: 4095 },
      { fn: 'lowbits', args: [4096], expected: 0 },
      { fn: 'lowbits', args: [305419896], expected: 1656 },
      { fn: 'lowbits', args: [MAX], expected: 4095 },
    ],
    reference: {
      a0: 'fn lowbits u32 -> u32\na and p0 4095\nret a\nend\n',
      ts: 'export function lowbits(x: number): number {\n  return (x & 4095) >>> 0;\n}\n',
      rust: 'pub fn lowbits(x: u32) -> u32 {\n    x & 4095\n}\n',
    },
  },
  {
    id: 'e-cmp-direction',
    kind: 'targeted-edit',
    instruction:
      'above(a, b) should return true exactly when the unsigned value a is strictly greater than b, but it currently tests a less than or equal to b. Change only the comparison.',
    a0Source: 'fn above u32 u32 -> bool\nc le p0 p1\nret c\nend\n',
    tsSource: 'export function above(a: number, b: number): boolean {\n  return a <= b;\n}\n',
    rustSource: 'pub fn above(a: u32, b: u32) -> bool {\n    a <= b\n}\n',
    tests: [
      { fn: 'above', args: [3, 9], expected: false },
      { fn: 'above', args: [9, 3], expected: true },
      { fn: 'above', args: [5, 5], expected: false },
      { fn: 'above', args: [0, MAX], expected: false },
      { fn: 'above', args: [MAX, 0], expected: true },
    ],
    reference: {
      a0: 'fn above u32 u32 -> bool\nc gt p0 p1\nret c\nend\n',
      ts: 'export function above(a: number, b: number): boolean {\n  return a > b;\n}\n',
      rust: 'pub fn above(a: u32, b: u32) -> bool {\n    a > b\n}\n',
    },
  },
  {
    id: 'e-sum-range',
    kind: 'targeted-edit',
    target: 'sum3',
    instruction:
      'sum3(a) takes an array of four u32 and currently adds the elements at indices 0, 1 and 2 (wrapping mod 2^32). Make it add the elements at indices 1, 2 and 3 instead.',
    a0Source:
      'fn stepadd u32 u32 u32x4 -> u32\nv get p2 p1\nr add p0 v\nret r\nend\nfn sum3 u32x4 -> u32\nr fold stepadd 3 0 p0\nret r\nend\n',
    tsSource:
      'export function sum3(a: number[]): number {\n  let s = 0;\n  for (let i = 0; i < 3; i++) {\n    s = (s + a[i]!) >>> 0;\n  }\n  return s;\n}\n',
    rustSource:
      'pub fn sum3(a: [u32; 4]) -> u32 {\n    let mut s: u32 = 0;\n    for i in 0..3 {\n        s = s.wrapping_add(a[i]);\n    }\n    s\n}\n',
    tests: [
      { fn: 'sum3', args: [[1, 2, 3, 4]], expected: 9 },
      { fn: 'sum3', args: [[0, 0, 0, 0]], expected: 0 },
      { fn: 'sum3', args: [[9, 1, 1, 1]], expected: 3 },
      { fn: 'sum3', args: [[5, MAX, 1, MAX]], expected: MAX },
      { fn: 'sum3', args: [[1, 2, 3, MAX]], expected: 4 },
      { fn: 'sum3', args: [[7, 0, 0, 0]], expected: 0 },
    ],
    reference: {
      a0: 'fn stepadd u32 u32 u32x4 -> u32\nj add p1 1\nv get p2 j\nr add p0 v\nret r\nend\nfn sum3 u32x4 -> u32\nr fold stepadd 3 0 p0\nret r\nend\n',
      ts: 'export function sum3(a: number[]): number {\n  let s = 0;\n  for (let i = 0; i < 3; i++) {\n    s = (s + a[i + 1]!) >>> 0;\n  }\n  return s;\n}\n',
      rust: 'pub fn sum3(a: [u32; 4]) -> u32 {\n    let mut s: u32 = 0;\n    for i in 0..3 {\n        s = s.wrapping_add(a[i + 1]);\n    }\n    s\n}\n',
    },
  },
  {
    id: 'e-popcount-fold',
    kind: 'multi-node-edit',
    target: 'popcnt',
    instruction:
      'popcnt(x) should return the number of set bits in the 32-bit value x, but it currently returns only the lowest bit. Make it count all 32 bits by folding over the bit positions.',
    a0Source: 'fn popcnt u32 -> u32\na and p0 1\nret a\nend\n',
    tsSource: 'export function popcnt(x: number): number {\n  return (x & 1) >>> 0;\n}\n',
    rustSource: 'pub fn popcnt(x: u32) -> u32 {\n    x & 1\n}\n',
    tests: [
      { fn: 'popcnt', args: [0], expected: 0 },
      { fn: 'popcnt', args: [1], expected: 1 },
      { fn: 'popcnt', args: [255], expected: 8 },
      { fn: 'popcnt', args: [MAX], expected: 32 },
      { fn: 'popcnt', args: [2147483648], expected: 1 },
      { fn: 'popcnt', args: [4042322160], expected: 16 },
    ],
    reference: {
      a0: 'fn bitstep u32 u32 u32 -> u32\na shr p2 p1\nb and a 1\nc add p0 b\nret c\nend\nfn popcnt u32 -> u32\nr fold bitstep 32 0 p0\nret r\nend\n',
      ts: 'export function popcnt(x: number): number {\n  let s = 0;\n  for (let i = 0; i < 32; i++) {\n    s = (s + ((x >>> i) & 1)) >>> 0;\n  }\n  return s;\n}\n',
      rust: 'pub fn popcnt(x: u32) -> u32 {\n    let mut s: u32 = 0;\n    for i in 0..32u32 {\n        s = s.wrapping_add((x >> i) & 1);\n    }\n    s\n}\n',
    },
  },
  {
    id: 'e-max3-helper',
    kind: 'multi-node-edit',
    target: 'max3',
    instruction:
      'max3(a, b, c) should return the largest of three unsigned values by using the existing max2 helper, but it currently ignores c. Fix it.',
    a0Source:
      'fn max2 u32 u32 -> u32\nc gt p0 p1\nr select c p0 p1\nret r\nend\nfn max3 u32 u32 u32 -> u32\nx call max2 p0 p1\nret x\nend\n',
    tsSource:
      'export function max2(a: number, b: number): number {\n  return a > b ? a : b;\n}\nexport function max3(a: number, b: number, c: number): number {\n  return max2(a, b);\n}\n',
    rustSource:
      'pub fn max2(a: u32, b: u32) -> u32 {\n    if a > b { a } else { b }\n}\npub fn max3(a: u32, b: u32, c: u32) -> u32 {\n    max2(a, b)\n}\n',
    tests: [
      { fn: 'max3', args: [1, 2, 3], expected: 3 },
      { fn: 'max3', args: [3, 2, 1], expected: 3 },
      { fn: 'max3', args: [2, 9, 4], expected: 9 },
      { fn: 'max3', args: [0, 0, 0], expected: 0 },
      { fn: 'max3', args: [MAX, 5, 7], expected: MAX },
      { fn: 'max3', args: [1, MAX, MAX - 1], expected: MAX },
    ],
    reference: {
      a0: 'fn max2 u32 u32 -> u32\nc gt p0 p1\nr select c p0 p1\nret r\nend\nfn max3 u32 u32 u32 -> u32\nx call max2 p0 p1\ny call max2 x p2\nret y\nend\n',
      ts: 'export function max2(a: number, b: number): number {\n  return a > b ? a : b;\n}\nexport function max3(a: number, b: number, c: number): number {\n  return max2(max2(a, b), c);\n}\n',
      rust: 'pub fn max2(a: u32, b: u32) -> u32 {\n    if a > b { a } else { b }\n}\npub fn max3(a: u32, b: u32, c: u32) -> u32 {\n    max2(max2(a, b), c)\n}\n',
    },
  },
  {
    id: 'e-hash-const',
    kind: 'targeted-edit',
    instruction:
      'hash2(a, b) computes a times 31 plus b (wrapping mod 2^32). Change the multiplier constant from 31 to 33.',
    a0Source: 'fn hash2 u32 u32 -> u32\nm mul p0 31\nh add m p1\nret h\nend\n',
    tsSource:
      'export function hash2(a: number, b: number): number {\n  return (Math.imul(a, 31) + b) >>> 0;\n}\n',
    rustSource:
      'pub fn hash2(a: u32, b: u32) -> u32 {\n    a.wrapping_mul(31).wrapping_add(b)\n}\n',
    tests: [
      { fn: 'hash2', args: [1, 2], expected: 35 },
      { fn: 'hash2', args: [0, 5], expected: 5 },
      { fn: 'hash2', args: [10, 0], expected: 330 },
      { fn: 'hash2', args: [MAX, 0], expected: 4294967263 },
      { fn: 'hash2', args: [65536, 65536], expected: 2228224 },
      { fn: 'hash2', args: [1000000, 1], expected: 33000001 },
    ],
    reference: {
      a0: 'fn hash2 u32 u32 -> u32\nm mul p0 33\nh add m p1\nret h\nend\n',
      ts: 'export function hash2(a: number, b: number): number {\n  return (Math.imul(a, 33) + b) >>> 0;\n}\n',
      rust: 'pub fn hash2(a: u32, b: u32) -> u32 {\n    a.wrapping_mul(33).wrapping_add(b)\n}\n',
    },
  },
  {
    id: 'e-thread-param',
    kind: 'multi-node-edit',
    target: 'apply',
    instruction:
      'addk currently adds the fixed constant 5. Give addk a second parameter k that it adds instead, and give apply a second parameter k that it passes to both of its addk calls.',
    a0Source:
      'fn addk u32 -> u32\na add p0 5\nret a\nend\nfn apply u32 -> u32\na call addk p0\nb call addk a\nret b\nend\n',
    tsSource:
      'export function addk(x: number): number {\n  return (x + 5) >>> 0;\n}\nexport function apply(x: number): number {\n  return addk(addk(x));\n}\n',
    rustSource:
      'pub fn addk(x: u32) -> u32 {\n    x.wrapping_add(5)\n}\npub fn apply(x: u32) -> u32 {\n    addk(addk(x))\n}\n',
    tests: [
      { fn: 'apply', args: [1, 2], expected: 5 },
      { fn: 'apply', args: [0, 0], expected: 0 },
      { fn: 'apply', args: [MAX, 1], expected: 1 },
      { fn: 'apply', args: [10, 100], expected: 210 },
      { fn: 'apply', args: [5, MAX], expected: 3 },
      { fn: 'addk', args: [3, 4], expected: 7 },
    ],
    reference: {
      a0: 'fn addk u32 u32 -> u32\na add p0 p1\nret a\nend\nfn apply u32 u32 -> u32\na call addk p0 p1\nb call addk a p1\nret b\nend\n',
      ts: 'export function addk(x: number, k: number): number {\n  return (x + k) >>> 0;\n}\nexport function apply(x: number, k: number): number {\n  return addk(addk(x, k), k);\n}\n',
      rust: 'pub fn addk(x: u32, k: u32) -> u32 {\n    x.wrapping_add(k)\n}\npub fn apply(x: u32, k: u32) -> u32 {\n    addk(addk(x, k), k)\n}\n',
    },
  },
];
