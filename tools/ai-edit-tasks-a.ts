/** Task set A for the AI-edit experiment: the original 13 tasks, written by the harness author. */

import type { Task } from './ai-edit-tasks-b.js';

export const TASKS_A: readonly Task[] = [
  {
    id: 'affine-sign',
    kind: 'targeted-edit',
    instruction: 'Change affine so it subtracts the offset instead of adding it.',
    a0Source: 'fn affine u32 u32 u32 -> u32\na mul p0 p1\nb add a p2\nret b\nend\n',
    tsSource:
      'export function affine(x: number, scale: number, offset: number): number {\n  return (Math.imul(x, scale) + offset) >>> 0;\n}\n',
    rustSource:
      'pub fn affine(x: u32, scale: u32, offset: u32) -> u32 {\n    x.wrapping_mul(scale).wrapping_add(offset)\n}\n',
    tests: [
      { fn: 'affine', args: [10, 3, 7], expected: 23 },
      { fn: 'affine', args: [0, 0, 1], expected: 0xffff_ffff },
      { fn: 'affine', args: [0xffff_ffff, 2, 0], expected: 0xffff_fffe },
    ],
    reference: {
      a0: 'fn affine u32 u32 u32 -> u32\na mul p0 p1\nb sub a p2\nret b\nend\n',
      ts: 'export function affine(x: number, scale: number, offset: number): number {\n  return (Math.imul(x, scale) - offset) >>> 0;\n}\n',
      rust: 'pub fn affine(x: u32, scale: u32, offset: u32) -> u32 {\n    x.wrapping_mul(scale).wrapping_sub(offset)\n}\n',
    },
  },
  {
    id: 'clamp-both',
    kind: 'multi-node-edit',
    instruction:
      'clamp currently returns min(x, hi). Make it return x clamped into [lo, hi] where the new second parameter is lo and the third is hi (unsigned comparison). Keep the function name.',
    a0Source: 'fn clamp u32 u32 -> u32\nc lt p1 p0\nr select c p1 p0\nret r\nend\n',
    tsSource:
      'export function clamp(x: number, hi: number): number {\n  return hi < x ? hi : x;\n}\n',
    rustSource: 'pub fn clamp(x: u32, hi: u32) -> u32 {\n    if hi < x { hi } else { x }\n}\n',
    tests: [
      { fn: 'clamp', args: [5, 1, 10], expected: 5 },
      { fn: 'clamp', args: [0, 1, 10], expected: 1 },
      { fn: 'clamp', args: [0xffff_ffff, 1, 10], expected: 10 },
      { fn: 'clamp', args: [0x8000_0000, 0x7fff_ffff, 0x8000_0001], expected: 0x8000_0000 },
    ],
    reference: {
      a0: 'fn clamp u32 u32 u32 -> u32\nc lt p2 p0\nr select c p2 p0\nd lt r p1\ns select d p1 r\nret s\nend\n',
      ts: 'export function clamp(x: number, lo: number, hi: number): number {\n  const t = hi < x ? hi : x;\n  return t < lo ? lo : t;\n}\n',
      rust: 'pub fn clamp(x: u32, lo: u32, hi: u32) -> u32 {\n    let t = if hi < x { hi } else { x };\n    if t < lo { lo } else { t }\n}\n',
    },
  },
  {
    id: 'rotl-fix',
    kind: 'comprehension-edit',
    instruction:
      'rotl is meant to rotate x left by n bits (n in 0..31) but currently computes something else. Fix it without changing the signature.',
    a0Source:
      'fn rotl u32 u32 -> u32\nl shl p0 p1\nn sub 32 p1\nr shl p0 n\no or l r\nret o\nend\n',
    tsSource:
      'export function rotl(x: number, n: number): number {\n  return ((x << n) | (x << (32 - n))) >>> 0;\n}\n',
    rustSource:
      'pub fn rotl(x: u32, n: u32) -> u32 {\n    (x << (n & 31)) | (x << ((32u32.wrapping_sub(n)) & 31))\n}\n',
    tests: [
      { fn: 'rotl', args: [0x8000_0000, 1], expected: 1 },
      { fn: 'rotl', args: [1, 31], expected: 0x8000_0000 },
      { fn: 'rotl', args: [0x1234_5678, 8], expected: 0x3456_7812 },
      { fn: 'rotl', args: [0xdead_beef, 0], expected: 0xdead_beef },
    ],
    reference: {
      a0: 'fn rotl u32 u32 -> u32\nl shl p0 p1\nn sub 32 p1\nr shr p0 n\no or l r\nret o\nend\n',
      ts: 'export function rotl(x: number, n: number): number {\n  return ((x << n) | (x >>> ((32 - n) & 31))) >>> 0;\n}\n',
      rust: 'pub fn rotl(x: u32, n: u32) -> u32 {\n    (x << (n & 31)) | (x >> ((32u32.wrapping_sub(n)) & 31))\n}\n',
    },
  },
  {
    id: 'add-cube',
    kind: 'create',
    instruction:
      'Add a new function cube(x) that returns x*x*x mod 2^32, reusing sq. Keep sq unchanged.',
    a0Source: 'fn sq u32 -> u32\na mul p0 p0\nret a\nend\n',
    tsSource: 'export function sq(x: number): number {\n  return Math.imul(x, x) >>> 0;\n}\n',
    rustSource: 'pub fn sq(x: u32) -> u32 {\n    x.wrapping_mul(x)\n}\n',
    tests: [
      { fn: 'cube', args: [3], expected: 27 },
      { fn: 'cube', args: [0x1_0000], expected: 0 },
      { fn: 'cube', args: [0xffff_ffff], expected: 0xffff_ffff },
      { fn: 'sq', args: [5], expected: 25 },
    ],
    reference: {
      a0: 'fn sq u32 -> u32\na mul p0 p0\nret a\nend\n\nfn cube u32 -> u32\ns call sq p0\nc mul s p0\nret c\nend\n',
      ts: 'export function sq(x: number): number {\n  return Math.imul(x, x) >>> 0;\n}\nexport function cube(x: number): number {\n  return Math.imul(sq(x), x) >>> 0;\n}\n',
      rust: 'pub fn sq(x: u32) -> u32 {\n    x.wrapping_mul(x)\n}\npub fn cube(x: u32) -> u32 {\n    sq(x).wrapping_mul(x)\n}\n',
    },
  },
  {
    id: 'absdiff',
    kind: 'comprehension-edit',
    instruction:
      'absdiff should return the absolute difference |a - b| for unsigned inputs; it currently returns a - b.',
    a0Source: 'fn absdiff u32 u32 -> u32\nd sub p0 p1\nret d\nend\n',
    tsSource:
      'export function absdiff(a: number, b: number): number {\n  return (a - b) >>> 0;\n}\n',
    rustSource: 'pub fn absdiff(a: u32, b: u32) -> u32 {\n    a.wrapping_sub(b)\n}\n',
    tests: [
      { fn: 'absdiff', args: [7, 3], expected: 4 },
      { fn: 'absdiff', args: [3, 7], expected: 4 },
      { fn: 'absdiff', args: [0, 0xffff_ffff], expected: 0xffff_ffff },
      { fn: 'absdiff', args: [5, 5], expected: 0 },
    ],
    reference: {
      a0: 'fn absdiff u32 u32 -> u32\nd sub p0 p1\ne sub p1 p0\nc lt p0 p1\nr select c e d\nret r\nend\n',
      ts: 'export function absdiff(a: number, b: number): number {\n  return a < b ? (b - a) >>> 0 : (a - b) >>> 0;\n}\n',
      rust: 'pub fn absdiff(a: u32, b: u32) -> u32 {\n    if a < b { b.wrapping_sub(a) } else { a.wrapping_sub(b) }\n}\n',
    },
  },
  {
    id: 'xor4',
    kind: 'multi-node-edit',
    instruction:
      'combine4 currently adds its four inputs. Change it to xor them instead (all four).',
    a0Source:
      'fn combine4 u32 u32 u32 u32 -> u32\na add p0 p1\nb add a p2\nc add b p3\nret c\nend\n',
    tsSource:
      'export function combine4(a: number, b: number, c: number, d: number): number {\n  return (((a + b) >>> 0) + c + d) >>> 0;\n}\n',
    rustSource:
      'pub fn combine4(a: u32, b: u32, c: u32, d: u32) -> u32 {\n    a.wrapping_add(b).wrapping_add(c).wrapping_add(d)\n}\n',
    tests: [
      { fn: 'combine4', args: [1, 2, 4, 8], expected: 15 },
      { fn: 'combine4', args: [5, 5, 5, 5], expected: 0 },
      { fn: 'combine4', args: [0xffff_ffff, 1, 0, 0], expected: 0xffff_fffe },
    ],
    reference: {
      a0: 'fn combine4 u32 u32 u32 u32 -> u32\na xor p0 p1\nb xor a p2\nc xor b p3\nret c\nend\n',
      ts: 'export function combine4(a: number, b: number, c: number, d: number): number {\n  return (a ^ b ^ c ^ d) >>> 0;\n}\n',
      rust: 'pub fn combine4(a: u32, b: u32, c: u32, d: u32) -> u32 {\n    a ^ b ^ c ^ d\n}\n',
    },
  },
  {
    id: 'min3',
    kind: 'multi-node-edit',
    instruction:
      'min2 returns the smaller of two unsigned values. Rename it to min3 and make it return the smallest of three (add a third parameter).',
    a0Source: 'fn min2 u32 u32 -> u32\nc lt p1 p0\nr select c p1 p0\nret r\nend\n',
    tsSource: 'export function min2(a: number, b: number): number {\n  return b < a ? b : a;\n}\n',
    rustSource: 'pub fn min2(a: u32, b: u32) -> u32 {\n    if b < a { b } else { a }\n}\n',
    tests: [
      { fn: 'min3', args: [3, 2, 1], expected: 1 },
      { fn: 'min3', args: [1, 2, 3], expected: 1 },
      { fn: 'min3', args: [0x8000_0000, 0x7fff_ffff, 0xffff_ffff], expected: 0x7fff_ffff },
      { fn: 'min3', args: [4, 4, 4], expected: 4 },
    ],
    reference: {
      a0: 'fn min3 u32 u32 u32 -> u32\nc lt p1 p0\nr select c p1 p0\nd lt p2 r\ns select d p2 r\nret s\nend\n',
      ts: 'export function min3(a: number, b: number, c: number): number {\n  const m = b < a ? b : a;\n  return c < m ? c : m;\n}\n',
      rust: 'pub fn min3(a: u32, b: u32, c: u32) -> u32 {\n    let m = if b < a { b } else { a };\n    if c < m { c } else { m }\n}\n',
    },
  },
  {
    id: 'sq-twice',
    kind: 'multi-node-edit',
    target: 'quad',
    instruction:
      'quad should apply sq twice (x^4 mod 2^32); it currently applies it once. Only change quad.',
    a0Source:
      'fn sq u32 -> u32\na mul p0 p0\nret a\nend\n\nfn quad u32 -> u32\nx call sq p0\nret x\nend\n',
    tsSource:
      'export function sq(x: number): number {\n  return Math.imul(x, x) >>> 0;\n}\nexport function quad(x: number): number {\n  return sq(x);\n}\n',
    rustSource:
      'pub fn sq(x: u32) -> u32 {\n    x.wrapping_mul(x)\n}\npub fn quad(x: u32) -> u32 {\n    sq(x)\n}\n',
    tests: [
      { fn: 'quad', args: [3], expected: 81 },
      { fn: 'quad', args: [0x1_0000], expected: 0 },
      { fn: 'quad', args: [0xffff_ffff], expected: 1 },
      { fn: 'sq', args: [7], expected: 49 },
    ],
    reference: {
      a0: 'fn sq u32 -> u32\na mul p0 p0\nret a\nend\n\nfn quad u32 -> u32\nx call sq p0\ny call sq x\nret y\nend\n',
      ts: 'export function sq(x: number): number {\n  return Math.imul(x, x) >>> 0;\n}\nexport function quad(x: number): number {\n  return sq(sq(x));\n}\n',
      rust: 'pub fn sq(x: u32) -> u32 {\n    x.wrapping_mul(x)\n}\npub fn quad(x: u32) -> u32 {\n    sq(sq(x))\n}\n',
    },
  },
  {
    id: 'sum-squares',
    kind: 'targeted-edit',
    instruction:
      'sumto(n) currently returns 0+1+...+(n-1). Make it return the sum of squares 0^2+1^2+...+(n-1)^2 (mod 2^32).',
    a0Source:
      'fn addi u32 u32 -> u32\ns add p0 p1\nret s\nend\n\nfn sumto u32 -> u32\nr fold addi p0 0\nret r\nend\n',
    tsSource:
      'export function sumto(n: number): number {\n  let s = 0;\n  for (let i = 0; i < n; i++) s = (s + i) >>> 0;\n  return s;\n}\n',
    rustSource:
      'pub fn sumto(n: u32) -> u32 {\n    let mut s: u32 = 0;\n    for i in 0..n { s = s.wrapping_add(i); }\n    s\n}\n',
    tests: [
      { fn: 'sumto', args: [0], expected: 0 },
      { fn: 'sumto', args: [4], expected: 14 },
      { fn: 'sumto', args: [10], expected: 285 },
      {
        fn: 'sumto',
        args: [70000],
        expected: Array.from({ length: 70000 }, (_, i) => Math.imul(i, i) >>> 0).reduce(
          (a, b) => (a + b) >>> 0,
          0,
        ),
      },
    ],
    reference: {
      a0: 'fn addi u32 u32 -> u32\nq mul p1 p1\ns add p0 q\nret s\nend\n\nfn sumto u32 -> u32\nr fold addi p0 0\nret r\nend\n',
      ts: 'export function sumto(n: number): number {\n  let s = 0;\n  for (let i = 0; i < n; i++) s = (s + Math.imul(i, i)) >>> 0;\n  return s;\n}\n',
      rust: 'pub fn sumto(n: u32) -> u32 {\n    let mut s: u32 = 0;\n    for i in 0..n { s = s.wrapping_add(i.wrapping_mul(i)); }\n    s\n}\n',
    },
  },
  {
    id: 'loop-inclusive',
    kind: 'targeted-edit',
    target: 'below',
    instruction:
      'countup(limit, cap) increments a counter while it is strictly below limit, at most cap times. Change it to continue while the counter is less than or equal to limit.',
    a0Source:
      'fn inc u32 u32 u32 -> u32\ns add p0 1\nret s\nend\n\nfn below u32 u32 u32 -> bool\nc lt p0 p2\nret c\nend\n\nfn countup u32 u32 -> u32\nr loop below inc p1 0 p0\nret r\nend\n',
    tsSource:
      'export function countup(limit: number, cap: number): number {\n  let s = 0;\n  for (let i = 0; i < cap; i++) {\n    if (!(s < limit)) break;\n    s = (s + 1) >>> 0;\n  }\n  return s;\n}\n',
    rustSource:
      'pub fn countup(limit: u32, cap: u32) -> u32 {\n    let mut s: u32 = 0;\n    for _ in 0..cap {\n        if !(s < limit) { break; }\n        s = s.wrapping_add(1);\n    }\n    s\n}\n',
    tests: [
      { fn: 'countup', args: [3, 100], expected: 4 },
      { fn: 'countup', args: [0, 100], expected: 1 },
      { fn: 'countup', args: [10, 5], expected: 5 },
      { fn: 'countup', args: [0xffff_ffff, 3], expected: 3 },
    ],
    reference: {
      a0: 'fn inc u32 u32 u32 -> u32\ns add p0 1\nret s\nend\n\nfn below u32 u32 u32 -> bool\nc lt p2 p0\nn select c false true\nret n\nend\n\nfn countup u32 u32 -> u32\nr loop below inc p1 0 p0\nret r\nend\n',
      ts: 'export function countup(limit: number, cap: number): number {\n  let s = 0;\n  for (let i = 0; i < cap; i++) {\n    if (!(s <= limit)) break;\n    s = (s + 1) >>> 0;\n  }\n  return s;\n}\n',
      rust: 'pub fn countup(limit: u32, cap: u32) -> u32 {\n    let mut s: u32 = 0;\n    for _ in 0..cap {\n        if !(s <= limit) { break; }\n        s = s.wrapping_add(1);\n    }\n    s\n}\n',
    },
  },
  {
    id: 'record-flag',
    kind: 'comprehension-edit',
    instruction:
      'pick takes a (u32,bool) record and returns its number. Change it so that when the flag is true it returns the number plus one (mod 2^32).',
    a0Source: 'fn pick (u32,bool) -> u32\nv at p0 0\nret v\nend\n',
    tsSource: 'export function pick(r: readonly [number, boolean]): number {\n  return r[0];\n}\n',
    rustSource: 'pub fn pick(r: (u32, bool)) -> u32 {\n    r.0\n}\n',
    tests: [
      { fn: 'pick', args: [[5, false]], expected: 5 },
      { fn: 'pick', args: [[5, true]], expected: 6 },
      { fn: 'pick', args: [[0xffff_ffff, true]], expected: 0 },
    ],
    reference: {
      a0: 'fn pick (u32,bool) -> u32\nv at p0 0\nf at p0 1\nw add v 1\nr select f w v\nret r\nend\n',
      ts: 'export function pick(r: readonly [number, boolean]): number {\n  return r[1] ? (r[0] + 1) >>> 0 : r[0];\n}\n',
      rust: 'pub fn pick(r: (u32, bool)) -> u32 {\n    if r.1 { r.0.wrapping_add(1) } else { r.0 }\n}\n',
    },
  },
  {
    id: 'byte-select',
    kind: 'targeted-edit',
    instruction:
      'byte1 extracts bits 8..15 of its input. Change it to extract bits 16..23 instead.',
    a0Source: 'fn byte1 u32 -> u32\ns shr p0 8\nm and s 255\nret m\nend\n',
    tsSource: 'export function byte1(x: number): number {\n  return (x >>> 8) & 0xff;\n}\n',
    rustSource: 'pub fn byte1(x: u32) -> u32 {\n    (x >> 8) & 0xff\n}\n',
    tests: [
      { fn: 'byte1', args: [0x1234_5678], expected: 0x34 },
      { fn: 'byte1', args: [0xff00_0000], expected: 0 },
      { fn: 'byte1', args: [0x00ab_0000], expected: 0xab },
    ],
    reference: {
      a0: 'fn byte1 u32 -> u32\ns shr p0 16\nm and s 255\nret m\nend\n',
      ts: 'export function byte1(x: number): number {\n  return (x >>> 16) & 0xff;\n}\n',
      rust: 'pub fn byte1(x: u32) -> u32 {\n    (x >> 16) & 0xff\n}\n',
    },
  },
  {
    id: 'saturating-add',
    kind: 'comprehension-edit',
    instruction:
      'sadd adds two unsigned 32-bit values with wraparound. Make it saturate at 4294967295 instead of wrapping.',
    a0Source: 'fn sadd u32 u32 -> u32\ns add p0 p1\nret s\nend\n',
    tsSource: 'export function sadd(a: number, b: number): number {\n  return (a + b) >>> 0;\n}\n',
    rustSource: 'pub fn sadd(a: u32, b: u32) -> u32 {\n    a.wrapping_add(b)\n}\n',
    tests: [
      { fn: 'sadd', args: [1, 2], expected: 3 },
      { fn: 'sadd', args: [0xffff_ffff, 1], expected: 0xffff_ffff },
      { fn: 'sadd', args: [0x8000_0000, 0x8000_0000], expected: 0xffff_ffff },
      { fn: 'sadd', args: [0xffff_fffe, 1], expected: 0xffff_ffff },
    ],
    reference: {
      a0: 'fn sadd u32 u32 -> u32\ns add p0 p1\nc lt s p0\nr select c 4294967295 s\nret r\nend\n',
      ts: 'export function sadd(a: number, b: number): number {\n  const s = (a + b) >>> 0;\n  return s < a ? 0xffffffff : s;\n}\n',
      rust: 'pub fn sadd(a: u32, b: u32) -> u32 {\n    a.saturating_add(b)\n}\n',
    },
  },
];
