/**
 * Held-out task set F for the AI-edit experiment. Independent of the primary
 * TASKS array and of sets B and D: same shape, disjoint tasks, ids prefixed `f-`.
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

export const TASKS_F: readonly Task[] = [
  {
    id: 'f-min4-seed',
    kind: 'comprehension-edit',
    target: 'min4',
    instruction:
      'min4 takes an array of four u32 and should return its smallest element, but it always returns zero. Make it behave as described.',
    a0Source:
      'fn minel u32 u32 u32x4 -> u32\na get p2 p1\nc lt a p0\nr select c a p0\nret r\nend\nfn min4 u32x4 -> u32\nr fold minel 4 0 p0\nret r\nend\n',
    tsSource:
      'export function min4(a: number[]): number {\n  let s = 0;\n  for (let i = 0; i < 4; i++) {\n    const v = a[i % 4]!;\n    s = v < s ? v : s;\n  }\n  return s;\n}\n',
    rustSource:
      'pub fn min4(a: [u32; 4]) -> u32 {\n    let mut s: u32 = 0;\n    for i in 0..4 {\n        if a[i] < s {\n            s = a[i];\n        }\n    }\n    s\n}\n',
    tests: [
      { fn: 'min4', args: [[3, 1, 2, 4]], expected: 1 },
      { fn: 'min4', args: [[5, 5, 5, 5]], expected: 5 },
      { fn: 'min4', args: [[MAX, MAX, MAX, MAX]], expected: MAX },
      { fn: 'min4', args: [[9, 8, 7, 6]], expected: 6 },
      { fn: 'min4', args: [[0, 4, 4, 4]], expected: 0 },
      { fn: 'min4', args: [[100, 200, 50, 75]], expected: 50 },
    ],
    reference: {
      a0: 'fn minel u32 u32 u32x4 -> u32\na get p2 p1\nc lt a p0\nr select c a p0\nret r\nend\nfn min4 u32x4 -> u32\nr fold minel 4 4294967295 p0\nret r\nend\n',
      ts: 'export function min4(a: number[]): number {\n  let s = 4294967295;\n  for (let i = 0; i < 4; i++) {\n    const v = a[i % 4]!;\n    s = v < s ? v : s;\n  }\n  return s;\n}\n',
      rust: 'pub fn min4(a: [u32; 4]) -> u32 {\n    let mut s: u32 = u32::MAX;\n    for i in 0..4 {\n        if a[i] < s {\n            s = a[i];\n        }\n    }\n    s\n}\n',
    },
  },
  {
    id: 'f-third-index',
    kind: 'targeted-edit',
    instruction:
      'third(a) should return the third element of a four-element array (counting from one), but it currently returns the second. Change only the index.',
    a0Source: 'fn third u32x4 -> u32\nr get p0 1\nret r\nend\n',
    tsSource: 'export function third(a: number[]): number {\n  return a[1]!;\n}\n',
    rustSource: 'pub fn third(a: [u32; 4]) -> u32 {\n    a[1]\n}\n',
    tests: [
      { fn: 'third', args: [[1, 2, 3, 4]], expected: 3 },
      { fn: 'third', args: [[10, 20, 30, 40]], expected: 30 },
      { fn: 'third', args: [[0, 0, 7, 0]], expected: 7 },
      { fn: 'third', args: [[MAX, 5, 6, 7]], expected: 6 },
      { fn: 'third', args: [[9, 9, 9, 9]], expected: 9 },
    ],
    reference: {
      a0: 'fn third u32x4 -> u32\nr get p0 2\nret r\nend\n',
      ts: 'export function third(a: number[]): number {\n  return a[2]!;\n}\n',
      rust: 'pub fn third(a: [u32; 4]) -> u32 {\n    a[2]\n}\n',
    },
  },
  {
    id: 'f-advance-wrap',
    kind: 'multi-node-edit',
    instruction:
      'advance(i, n) should return i plus 1 (wrapping mod 2^32), except that it must return 0 when that incremented value equals n. Add the missing wrap-around.',
    a0Source: 'fn advance u32 u32 -> u32\na add p0 1\nret a\nend\n',
    tsSource:
      'export function advance(i: number, n: number): number {\n  return (i + 1) >>> 0;\n}\n',
    rustSource: 'pub fn advance(i: u32, _n: u32) -> u32 {\n    i.wrapping_add(1)\n}\n',
    tests: [
      { fn: 'advance', args: [0, 4], expected: 1 },
      { fn: 'advance', args: [2, 4], expected: 3 },
      { fn: 'advance', args: [3, 4], expected: 0 },
      { fn: 'advance', args: [7, 8], expected: 0 },
      { fn: 'advance', args: [5, 10], expected: 6 },
      { fn: 'advance', args: [9, 10], expected: 0 },
    ],
    reference: {
      a0: 'fn advance u32 u32 -> u32\na add p0 1\nc eq a p1\nr select c 0 a\nret r\nend\n',
      ts: 'export function advance(i: number, n: number): number {\n  const a = (i + 1) >>> 0;\n  return a === n ? 0 : a;\n}\n',
      rust: 'pub fn advance(i: u32, n: u32) -> u32 {\n    let a = i.wrapping_add(1);\n    if a == n { 0 } else { a }\n}\n',
    },
  },
  {
    id: 'f-bump-cap',
    kind: 'multi-node-edit',
    instruction:
      'bump(x) returns x plus 10 (wrapping mod 2^32). Limit the result to the range 0 through 100 by replacing any result above 100 with 100.',
    a0Source: 'fn bump u32 -> u32\na add p0 10\nret a\nend\n',
    tsSource: 'export function bump(x: number): number {\n  return (x + 10) >>> 0;\n}\n',
    rustSource: 'pub fn bump(x: u32) -> u32 {\n    x.wrapping_add(10)\n}\n',
    tests: [
      { fn: 'bump', args: [0], expected: 10 },
      { fn: 'bump', args: [50], expected: 60 },
      { fn: 'bump', args: [90], expected: 100 },
      { fn: 'bump', args: [95], expected: 100 },
      { fn: 'bump', args: [200], expected: 100 },
      { fn: 'bump', args: [MAX], expected: 9 },
    ],
    reference: {
      a0: 'fn bump u32 -> u32\na add p0 10\nc gt a 100\nr select c 100 a\nret r\nend\n',
      ts: 'export function bump(x: number): number {\n  const a = (x + 10) >>> 0;\n  return a > 100 ? 100 : a;\n}\n',
      rust: 'pub fn bump(x: u32) -> u32 {\n    let a = x.wrapping_add(10);\n    if a > 100 { 100 } else { a }\n}\n',
    },
  },
  {
    id: 'f-divrem-pair',
    kind: 'multi-node-edit',
    instruction:
      'divrem(a, b) currently returns only the quotient of a divided by b. Make it return a pair whose first field is the quotient and whose second field is the remainder.',
    a0Source: 'fn divrem u32 u32 -> u32\nq div p0 p1\nret q\nend\n',
    tsSource:
      'export function divrem(a: number, b: number): number {\n  return b === 0 ? 4294967295 : Math.floor(a / b);\n}\n',
    rustSource:
      'pub fn divrem(a: u32, b: u32) -> u32 {\n    if b == 0 { u32::MAX } else { a / b }\n}\n',
    tests: [
      { fn: 'divrem', args: [17, 5], expected: [3, 2] },
      { fn: 'divrem', args: [10, 2], expected: [5, 0] },
      { fn: 'divrem', args: [3, 7], expected: [0, 3] },
      { fn: 'divrem', args: [7, 0], expected: [MAX, 7] },
      { fn: 'divrem', args: [MAX, 10], expected: [429496729, 5] },
      { fn: 'divrem', args: [0, 0], expected: [MAX, 0] },
    ],
    reference: {
      a0: 'fn divrem u32 u32 -> (u32,u32)\nq div p0 p1\nr rem p0 p1\np rec q r\nret p\nend\n',
      ts: 'export function divrem(a: number, b: number): [number, number] {\n  const q = b === 0 ? 4294967295 : Math.floor(a / b);\n  const r = b === 0 ? a : a % b;\n  return [q, r];\n}\n',
      rust: 'pub fn divrem(a: u32, b: u32) -> (u32, u32) {\n    let q = if b == 0 { u32::MAX } else { a / b };\n    let r = if b == 0 { a } else { a % b };\n    (q, r)\n}\n',
    },
  },
  {
    id: 'f-remaining-order',
    kind: 'targeted-edit',
    instruction:
      'remaining(used, total) should return total minus used (wrapping mod 2^32), but it currently computes used minus total. Reverse the subtraction.',
    a0Source: 'fn remaining u32 u32 -> u32\na sub p0 p1\nret a\nend\n',
    tsSource:
      'export function remaining(used: number, total: number): number {\n  return (used - total) >>> 0;\n}\n',
    rustSource:
      'pub fn remaining(used: u32, total: u32) -> u32 {\n    used.wrapping_sub(total)\n}\n',
    tests: [
      { fn: 'remaining', args: [3, 10], expected: 7 },
      { fn: 'remaining', args: [10, 3], expected: 4294967289 },
      { fn: 'remaining', args: [0, 0], expected: 0 },
      { fn: 'remaining', args: [5, 5], expected: 0 },
      { fn: 'remaining', args: [1, 0], expected: MAX },
      { fn: 'remaining', args: [100, MAX], expected: 4294967195 },
    ],
    reference: {
      a0: 'fn remaining u32 u32 -> u32\na sub p1 p0\nret a\nend\n',
      ts: 'export function remaining(used: number, total: number): number {\n  return (total - used) >>> 0;\n}\n',
      rust: 'pub fn remaining(used: u32, total: u32) -> u32 {\n    total.wrapping_sub(used)\n}\n',
    },
  },
  {
    id: 'f-sumlow-bound',
    kind: 'targeted-edit',
    target: 'sumlow',
    instruction:
      'sumlow(x) should return x plus the sum of those loop indices from 0 through 7 that are below 6 (that is 0+1+2+3+4+5, wrapping mod 2^32). It currently only includes indices below 4. Change that bound.',
    a0Source:
      'fn addlow u32 u32 -> u32\nc lt p1 4\nv select c p1 0\nr add p0 v\nret r\nend\nfn sumlow u32 -> u32\nr fold addlow 8 p0\nret r\nend\n',
    tsSource:
      'export function sumlow(x: number): number {\n  let s = x >>> 0;\n  for (let i = 0; i < 8; i++) {\n    if (i < 4) {\n      s = (s + i) >>> 0;\n    }\n  }\n  return s;\n}\n',
    rustSource:
      'pub fn sumlow(x: u32) -> u32 {\n    let mut s = x;\n    for i in 0..8u32 {\n        if i < 4 {\n            s = s.wrapping_add(i);\n        }\n    }\n    s\n}\n',
    tests: [
      { fn: 'sumlow', args: [0], expected: 15 },
      { fn: 'sumlow', args: [1], expected: 16 },
      { fn: 'sumlow', args: [10], expected: 25 },
      { fn: 'sumlow', args: [100], expected: 115 },
      { fn: 'sumlow', args: [MAX], expected: 14 },
    ],
    reference: {
      a0: 'fn addlow u32 u32 -> u32\nc lt p1 6\nv select c p1 0\nr add p0 v\nret r\nend\nfn sumlow u32 -> u32\nr fold addlow 8 p0\nret r\nend\n',
      ts: 'export function sumlow(x: number): number {\n  let s = x >>> 0;\n  for (let i = 0; i < 8; i++) {\n    if (i < 6) {\n      s = (s + i) >>> 0;\n    }\n  }\n  return s;\n}\n',
      rust: 'pub fn sumlow(x: u32) -> u32 {\n    let mut s = x;\n    for i in 0..8u32 {\n        if i < 6 {\n            s = s.wrapping_add(i);\n        }\n    }\n    s\n}\n',
    },
  },
  {
    id: 'f-setlow-or',
    kind: 'targeted-edit',
    instruction:
      'setlow(x) should force the low 4 bits of x to one and leave all other bits unchanged. It currently uses a bitwise exclusive or, which flips them instead. Replace that operation with a bitwise or.',
    a0Source: 'fn setlow u32 -> u32\na xor p0 15\nret a\nend\n',
    tsSource: 'export function setlow(x: number): number {\n  return (x ^ 15) >>> 0;\n}\n',
    rustSource: 'pub fn setlow(x: u32) -> u32 {\n    x ^ 15\n}\n',
    tests: [
      { fn: 'setlow', args: [0], expected: 15 },
      { fn: 'setlow', args: [15], expected: 15 },
      { fn: 'setlow', args: [16], expected: 31 },
      { fn: 'setlow', args: [305419896], expected: 305419903 },
      { fn: 'setlow', args: [255], expected: 255 },
      { fn: 'setlow', args: [MAX], expected: MAX },
    ],
    reference: {
      a0: 'fn setlow u32 -> u32\na or p0 15\nret a\nend\n',
      ts: 'export function setlow(x: number): number {\n  return (x | 15) >>> 0;\n}\n',
      rust: 'pub fn setlow(x: u32) -> u32 {\n    x | 15\n}\n',
    },
  },
  {
    id: 'f-sumsq-helper',
    kind: 'multi-node-edit',
    target: 'sumsq',
    instruction:
      'sumsq(a, b) should return a squared plus b squared (wrapping mod 2^32), but it currently adds b unsquared. Add a helper function sq(x) returning x times x, and use it for both squares.',
    a0Source: 'fn sumsq u32 u32 -> u32\na mul p0 p0\nc add a p1\nret c\nend\n',
    tsSource:
      'export function sumsq(a: number, b: number): number {\n  return (Math.imul(a, a) + b) >>> 0;\n}\n',
    rustSource: 'pub fn sumsq(a: u32, b: u32) -> u32 {\n    a.wrapping_mul(a).wrapping_add(b)\n}\n',
    tests: [
      { fn: 'sumsq', args: [3, 4], expected: 25 },
      { fn: 'sumsq', args: [1, 1], expected: 2 },
      { fn: 'sumsq', args: [65535, 1], expected: 4294836226 },
      { fn: 'sumsq', args: [MAX, MAX], expected: 2 },
      { fn: 'sumsq', args: [5, 0], expected: 25 },
      { fn: 'sq', args: [7], expected: 49 },
    ],
    reference: {
      a0: 'fn sq u32 -> u32\na mul p0 p0\nret a\nend\nfn sumsq u32 u32 -> u32\na call sq p0\nb call sq p1\nc add a b\nret c\nend\n',
      ts: 'export function sq(x: number): number {\n  return Math.imul(x, x) >>> 0;\n}\nexport function sumsq(a: number, b: number): number {\n  return (sq(a) + sq(b)) >>> 0;\n}\n',
      rust: 'pub fn sq(x: u32) -> u32 {\n    x.wrapping_mul(x)\n}\npub fn sumsq(a: u32, b: u32) -> u32 {\n    sq(a).wrapping_add(sq(b))\n}\n',
    },
  },
  {
    id: 'f-countabove-gt',
    kind: 'comprehension-edit',
    target: 'countabove',
    instruction:
      'countabove(a, t) should count how many of the four elements of a are strictly greater than t. It currently also counts elements equal to t. Fix it.',
    a0Source:
      'fn cnt u32 u32 u32x4 u32 -> u32\na get p2 p1\nc ge a p3\nd select c 1 0\nr add p0 d\nret r\nend\nfn countabove u32x4 u32 -> u32\nr fold cnt 4 0 p0 p1\nret r\nend\n',
    tsSource:
      'export function countabove(a: number[], t: number): number {\n  let n = 0;\n  for (let i = 0; i < 4; i++) {\n    if (a[i % 4]! >= t) {\n      n = (n + 1) >>> 0;\n    }\n  }\n  return n;\n}\n',
    rustSource:
      'pub fn countabove(a: [u32; 4], t: u32) -> u32 {\n    let mut n: u32 = 0;\n    for i in 0..4 {\n        if a[i] >= t {\n            n += 1;\n        }\n    }\n    n\n}\n',
    tests: [
      { fn: 'countabove', args: [[1, 5, 9, 3], 4], expected: 2 },
      { fn: 'countabove', args: [[5, 5, 5, 5], 5], expected: 0 },
      { fn: 'countabove', args: [[1, 2, 3, 4], 0], expected: 4 },
      { fn: 'countabove', args: [[0, 0, 0, 0], MAX], expected: 0 },
      { fn: 'countabove', args: [[MAX, MAX, 1, 2], 4294967294], expected: 2 },
      { fn: 'countabove', args: [[7, 8, 9, 10], 8], expected: 2 },
    ],
    reference: {
      a0: 'fn cnt u32 u32 u32x4 u32 -> u32\na get p2 p1\nc gt a p3\nd select c 1 0\nr add p0 d\nret r\nend\nfn countabove u32x4 u32 -> u32\nr fold cnt 4 0 p0 p1\nret r\nend\n',
      ts: 'export function countabove(a: number[], t: number): number {\n  let n = 0;\n  for (let i = 0; i < 4; i++) {\n    if (a[i % 4]! > t) {\n      n = (n + 1) >>> 0;\n    }\n  }\n  return n;\n}\n',
      rust: 'pub fn countabove(a: [u32; 4], t: u32) -> u32 {\n    let mut n: u32 = 0;\n    for i in 0..4 {\n        if a[i] > t {\n            n += 1;\n        }\n    }\n    n\n}\n',
    },
  },
  {
    id: 'f-avg4-floor',
    kind: 'comprehension-edit',
    target: 'avg4',
    instruction:
      'avg4 takes an array of four u32 and should return the average of its elements using floor division: the sum (wrapping mod 2^32) divided by 4. It currently returns the sum itself. Make it behave as described.',
    a0Source:
      'fn addel u32 u32 u32x4 -> u32\na get p2 p1\nb add p0 a\nret b\nend\nfn avg4 u32x4 -> u32\ns fold addel 4 0 p0\nret s\nend\n',
    tsSource:
      'export function avg4(a: number[]): number {\n  let s = 0;\n  for (let i = 0; i < 4; i++) {\n    s = (s + a[i % 4]!) >>> 0;\n  }\n  return s;\n}\n',
    rustSource:
      'pub fn avg4(a: [u32; 4]) -> u32 {\n    let mut s: u32 = 0;\n    for i in 0..4 {\n        s = s.wrapping_add(a[i]);\n    }\n    s\n}\n',
    tests: [
      { fn: 'avg4', args: [[4, 8, 12, 16]], expected: 10 },
      { fn: 'avg4', args: [[1, 2, 3, 3]], expected: 2 },
      { fn: 'avg4', args: [[0, 0, 0, 0]], expected: 0 },
      { fn: 'avg4', args: [[MAX, MAX, MAX, MAX]], expected: 1073741823 },
      { fn: 'avg4', args: [[1, 0, 0, 0]], expected: 0 },
      { fn: 'avg4', args: [[10, 10, 10, 11]], expected: 10 },
    ],
    reference: {
      a0: 'fn addel u32 u32 u32x4 -> u32\na get p2 p1\nb add p0 a\nret b\nend\nfn avg4 u32x4 -> u32\ns fold addel 4 0 p0\nr div s 4\nret r\nend\n',
      ts: 'export function avg4(a: number[]): number {\n  let s = 0;\n  for (let i = 0; i < 4; i++) {\n    s = (s + a[i % 4]!) >>> 0;\n  }\n  return Math.floor(s / 4);\n}\n',
      rust: 'pub fn avg4(a: [u32; 4]) -> u32 {\n    let mut s: u32 = 0;\n    for i in 0..4 {\n        s = s.wrapping_add(a[i]);\n    }\n    s / 4\n}\n',
    },
  },
  {
    id: 'f-addover-bool',
    kind: 'multi-node-edit',
    instruction:
      'addover(a, b) currently returns the wrapped sum of a and b. Change it to return a bool that is true exactly when adding a and b overflows 32 bits, that is when the true sum is at least 2^32.',
    a0Source: 'fn addover u32 u32 -> u32\ns add p0 p1\nret s\nend\n',
    tsSource:
      'export function addover(a: number, b: number): number {\n  return (a + b) >>> 0;\n}\n',
    rustSource: 'pub fn addover(a: u32, b: u32) -> u32 {\n    a.wrapping_add(b)\n}\n',
    tests: [
      { fn: 'addover', args: [1, 2], expected: false },
      { fn: 'addover', args: [MAX, 1], expected: true },
      { fn: 'addover', args: [MAX, 0], expected: false },
      { fn: 'addover', args: [2147483648, 2147483648], expected: true },
      { fn: 'addover', args: [4000000000, 294967295], expected: false },
      { fn: 'addover', args: [4000000000, 294967296], expected: true },
    ],
    reference: {
      a0: 'fn addover u32 u32 -> bool\ns add p0 p1\nc lt s p0\nret c\nend\n',
      ts: 'export function addover(a: number, b: number): boolean {\n  const s = (a + b) >>> 0;\n  return s < a;\n}\n',
      rust: 'pub fn addover(a: u32, b: u32) -> bool {\n    let s = a.wrapping_add(b);\n    s < a\n}\n',
    },
  },
  {
    id: 'f-highbyte-shr',
    kind: 'targeted-edit',
    instruction:
      'highbyte(x) should return the top 8 bits of x as a number from 0 to 255, but it currently shifts in the wrong direction. Fix the shift.',
    a0Source: 'fn highbyte u32 -> u32\na shl p0 24\nret a\nend\n',
    tsSource: 'export function highbyte(x: number): number {\n  return (x << 24) >>> 0;\n}\n',
    rustSource: 'pub fn highbyte(x: u32) -> u32 {\n    x << 24\n}\n',
    tests: [
      { fn: 'highbyte', args: [0], expected: 0 },
      { fn: 'highbyte', args: [4278190080], expected: 255 },
      { fn: 'highbyte', args: [305419896], expected: 18 },
      { fn: 'highbyte', args: [255], expected: 0 },
      { fn: 'highbyte', args: [MAX], expected: 255 },
      { fn: 'highbyte', args: [16777216], expected: 1 },
    ],
    reference: {
      a0: 'fn highbyte u32 -> u32\na shr p0 24\nret a\nend\n',
      ts: 'export function highbyte(x: number): number {\n  return x >>> 24;\n}\n',
      rust: 'pub fn highbyte(x: u32) -> u32 {\n    x >> 24\n}\n',
    },
  },
];
