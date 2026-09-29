/**
 * Gate A harness: the controlled 2x2 AI-edit experiment.
 *
 *   representation: A0 | TypeScript        x    protocol: conventional | structured
 *
 * Each cell gives the model the same task, the same acceptance tests, and an
 * equally capable edit protocol; whole-task accounting records setup (language
 * instructions + protocol instructions), view, output, tool calls, validation
 * failures, repairs, wall time, and provider-reported usage. Unknown reasoning
 * usage is recorded as null, never zero.
 *
 * Modes:
 *   default (dry run): builds every prompt, validates the reference solutions
 *     against the acceptance tests locally, and records local tokenizer counts.
 *     No model is called. Writes results/ai-edit-experiment.json with status
 *     "unrun".
 *   live: requires A0_ALLOW_PAID_MODEL_CALLS=1 AND Anthropic credentials. Calls
 *     claude-opus-5-5 (override with A0_EXPERIMENT_MODEL) for N trials per cell.
 *     Never runs implicitly.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import Anthropic from '@anthropic-ai/sdk';
import { getEncoding } from 'js-tiktoken';
import { formatProgram, parseAndValidate, run, type TypedFunc, type Value } from '../src/core.js';
import { EditSession } from '../src/edit.js';
import { runTool, withTempDir } from '../src/toolchain.js';

type Representation = 'a0' | 'ts' | 'rust';
type Protocol = 'conventional' | 'structured';

interface AcceptanceCase {
  readonly fn: string;
  readonly args: readonly Value[];
  readonly expected: Value;
}

interface Task {
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

// --- Held-out style tasks (small; the harness, not the task set, is the deliverable) ---

const TASKS: readonly Task[] = [
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

// --- Instructions (counted as setup cost; identical across trials) ------------

const PROTOCOL_CONVENTIONAL =
  'Reply with the complete updated source file and nothing else, inside one ```code block.';
const PROTOCOL_STRUCTURED_A0 =
  'You are shown a view whose first line is an edit handle. With a function handle (e0), reply with that line followed only by edit lines: `id op ...` replaces an instruction or inserts a new one before ret, `id op ... @ other` inserts after instruction other, `-id` deletes, `ret x` changes the result; the view may end with `fn ... end` signature lines of callable functions. With a program handle (g0) whose view lists function signatures, reply with that line followed by whole `fn ... end` blocks to add or replace functions and `-fn name` to remove one. Nothing else, inside one ```code block.';
const PROTOCOL_STRUCTURED_TS =
  'You are shown a view whose first line is an edit handle (e.g. e0) and whose remaining lines are numbered. Reply with that handle line followed only by edit lines: `<number> <new text>` replaces a line, `+<number> <new text>` inserts a new line after it (use +0 for the top), `-<number>` deletes a line; a number may be given once. Nothing else, inside one ```code block.';
const RUST_SEMANTICS =
  'Integers are u32 with wrapping arithmetic (use wrapping_add/wrapping_sub/wrapping_mul; shifts are masked to 5 bits); comparisons are unsigned. The file must compile with rustc, edition 2021.';
const PROTOCOL_STRUCTURED_RUST = PROTOCOL_STRUCTURED_TS;
const TS_SEMANTICS =
  'Numbers are unsigned 32-bit integers: every arithmetic result must be normalized with >>> 0, use Math.imul for multiplication, and comparisons are unsigned.';

// --- Views and edit application -----------------------------------------------

function numbered(text: string): string {
  return text
    .trimEnd()
    .split('\n')
    .map((l, i) => `${i + 1} ${l}`)
    .join('\n');
}

function extractBlock(reply: string): string {
  const m = /```[a-z0-9]*\n([\s\S]*?)```/.exec(reply);
  return `${(m ? (m[1] ?? '') : reply).trimEnd()}\n`;
}

interface AppliedEdit {
  readonly source: string;
  readonly error?: string;
}

function applyA0(
  rep: Representation,
  protocol: Protocol,
  source: string,
  reply: string,
  session?: EditSession,
): AppliedEdit {
  void rep;
  const body = extractBlock(reply);
  if (protocol === 'conventional') {
    try {
      parseAndValidate(body);
      return { source: body };
    } catch (e) {
      return { source, error: e instanceof Error ? e.message : String(e) };
    }
  }
  if (session === undefined) return { source, error: 'no session' };
  try {
    const next = session.apply(body);
    return { source: formatProgram(next) };
  } catch (e) {
    return { source, error: e instanceof Error ? e.message : String(e) };
  }
}

function applyTs(protocol: Protocol, source: string, reply: string, handle: string): AppliedEdit {
  const body = extractBlock(reply);
  if (protocol === 'conventional') return { source: body };
  const lines = body.trimEnd().split('\n');
  if (lines[0] !== handle)
    return { source, error: `expected handle ${handle}, got '${lines[0] ?? ''}'` };
  const out: (string | null)[] = source.trimEnd().split('\n');
  const inserts = new Map<number, string[]>();
  const seen = new Set<number>();
  for (const l of lines.slice(1)) {
    const m = /^([+-]?)(\d+) ?(.*)$/.exec(l);
    if (!m) return { source, error: `bad edit line: ${l}` };
    const n = Number(m[2]);
    const mode = m[1] ?? '';
    if (mode === '+') {
      if (n < 0 || n > out.length) return { source, error: `bad insert position ${n}` };
      inserts.set(n, [...(inserts.get(n) ?? []), m[3] ?? '']);
      continue;
    }
    if (seen.has(n) || n < 1 || n > out.length)
      return { source, error: `bad or duplicate line number ${n}` };
    seen.add(n);
    out[n - 1] = mode === '-' ? null : (m[3] ?? '');
  }
  const result: string[] = [...(inserts.get(0) ?? [])];
  out.forEach((line, i) => {
    if (line !== null) result.push(line);
    result.push(...(inserts.get(i + 1) ?? []));
  });
  return { source: `${result.join('\n')}\n` };
}

// --- Acceptance -----------------------------------------------------------------

function fmt(v: Value): string {
  return typeof v === 'boolean' ? String(v) : String(v);
}

async function acceptA0(source: string, tests: readonly AcceptanceCase[]): Promise<string[]> {
  const failures: string[] = [];
  let program: ReturnType<typeof parseAndValidate>;
  try {
    program = parseAndValidate(source);
  } catch (e) {
    return [`invalid A0: ${e instanceof Error ? e.message : String(e)}`];
  }
  for (const t of tests) {
    const fn = program.byName.get(t.fn) as TypedFunc | undefined;
    if (fn === undefined) {
      failures.push(`missing function ${t.fn}`);
      continue;
    }
    try {
      const got = run(fn, t.args);
      if (got !== t.expected)
        failures.push(
          `${t.fn}(${t.args.map(fmt).join(',')}) = ${fmt(got)}, expected ${fmt(t.expected)}`,
        );
    } catch (e) {
      failures.push(`${t.fn}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return failures;
}

function rustLiteral(v: Value): string {
  if (typeof v === 'number') return `${v}u32`;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return `(${v.map(rustLiteral).join(', ')})`;
  return '0u32';
}

async function acceptRust(source: string, tests: readonly AcceptanceCase[]): Promise<string[]> {
  // Single file: the candidate source plus a generated main that checks every case.
  const checks = tests.map(
    (t, i) =>
      `    { let got = ${t.fn}(${t.args.map(rustLiteral).join(', ')}); if got != ${rustLiteral(t.expected)} { println!("FAIL ${i} {}", got); } }`,
  );
  const main = `\n#[allow(dead_code)]\nfn main() {\n${checks.join('\n')}\n    println!("DONE");\n}\n`;
  return withTempDir(async (dir) => {
    const file = join(dir, 'candidate.rs');
    await writeFile(file, `${source}${main}`, 'utf8');
    const rustc = `${process.env.HOME ?? ''}/.cargo/bin/rustc`;
    const build = runTool(
      rustc,
      ['--edition', '2021', '-O', '-A', 'warnings', '-o', join(dir, 'candidate'), file],
      { cwd: dir, timeoutMs: 300_000 },
    );
    if (!build.ok) return [`rustc: ${build.stderr.slice(0, 500)}`];
    const run = runTool(join(dir, 'candidate'), [], { cwd: dir, timeoutMs: 60_000 });
    if (!run.ok) return [`run: ${run.stderr.slice(0, 300)}`];
    const failures = run.stdout
      .split('\n')
      .filter((l) => l.startsWith('FAIL'))
      .map((l) => {
        const [, idx, got] = l.split(' ');
        const t = tests[Number(idx)];
        return t === undefined
          ? l
          : `${t.fn}(${t.args.map(fmt).join(',')}) = ${got}, expected ${fmt(t.expected)}`;
      });
    if (!run.stdout.includes('DONE')) failures.push('program did not finish');
    return failures;
  });
}

async function acceptTs(source: string, tests: readonly AcceptanceCase[]): Promise<string[]> {
  // Type-check with tsc, then execute the checked JS in a separate Node process.
  return withTempDir(async (dir) => {
    const file = join(dir, 'mod.ts');
    await writeFile(file, source, 'utf8');
    const tsc = join(process.cwd(), 'node_modules', '.bin', 'tsc');
    // Self-contained project: no ambient @types, only the ES library.
    await writeFile(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: 'es2022',
          module: 'es2022',
          moduleResolution: 'bundler',
          lib: ['es2022'],
          types: [],
          typeRoots: [],
          outDir: dir,
        },
        files: ['mod.ts'],
      }),
      'utf8',
    );
    const check = runTool(tsc, ['-p', join(dir, 'tsconfig.json')], { cwd: dir });
    if (!check.ok) return [`tsc: ${check.stdout.slice(0, 500)}`];
    const js = await readFile(join(dir, 'mod.js'), 'utf8');
    const mod = (await import(
      `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
    )) as Record<string, (...a: Value[]) => Value>;
    const failures: string[] = [];
    for (const t of tests) {
      const f = mod[t.fn];
      if (typeof f !== 'function') {
        failures.push(`missing export ${t.fn}`);
        continue;
      }
      try {
        const got = f(...t.args);
        if (got !== t.expected)
          failures.push(
            `${t.fn}(${t.args.map(fmt).join(',')}) = ${fmt(got)}, expected ${fmt(t.expected)}`,
          );
      } catch (e) {
        failures.push(`${t.fn}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return failures;
  });
}

// --- Cells ------------------------------------------------------------------------

interface Cell {
  readonly representation: Representation;
  readonly protocol: Protocol;
  /** Language primer: what the model must know about the language (bucket 1). */
  readonly languagePrimer: string;
  /** Workflow primer: the edit protocol instructions (bucket 2). */
  readonly workflowPrimer: string;
  readonly system: string;
  readonly view: string;
}

async function buildCell(
  task: Task,
  representation: Representation,
  protocol: Protocol,
  guide: string,
): Promise<{ cell: Cell; session?: EditSession; handle: string }> {
  const handle = 'e0';
  if (representation === 'a0') {
    const protocolText =
      protocol === 'conventional' ? PROTOCOL_CONVENTIONAL : PROTOCOL_STRUCTURED_A0;
    const system = `${guide}\n\n${protocolText}`;
    const primers = { languagePrimer: guide, workflowPrimer: protocolText };
    if (protocol === 'structured') {
      // Two handles per view: e0 edits the target function, g1 edits the program (add,
      // replace, or remove whole functions, e.g. for signature changes). The reply's first
      // line selects which one is used.
      const session = new EditSession(parseAndValidate(task.a0Source));
      const fnName = task.target ?? parseAndValidate(task.a0Source).functions[0]?.name ?? '';
      const fnView = session.open(fnName, { scope: 'deps' }).text;
      const progView = session.openProgram().text;
      const view = `${fnView}\n${progView}`;
      return { cell: { representation, protocol, ...primers, system, view }, session, handle };
    }
    return { cell: { representation, protocol, ...primers, system, view: task.a0Source }, handle };
  }
  const src = representation === 'rust' ? task.rustSource : task.tsSource;
  const semantics = representation === 'rust' ? RUST_SEMANTICS : TS_SEMANTICS;
  const structured = representation === 'rust' ? PROTOCOL_STRUCTURED_RUST : PROTOCOL_STRUCTURED_TS;
  const protocolText = protocol === 'conventional' ? PROTOCOL_CONVENTIONAL : structured;
  const system = `${semantics}\n\n${protocolText}`;
  const view = protocol === 'conventional' ? src : `${handle}\n${numbered(src)}`;
  return {
    cell: {
      representation,
      protocol,
      languagePrimer: semantics,
      workflowPrimer: protocolText,
      system,
      view,
    },
    handle,
  };
}

/**
 * Failure taxonomy per attempt (after MultiPL-E's status classes, extended for edit
 * protocols): `protocol` = the reply did not follow the edit protocol (bad handle, bad
 * line reference, stale revision); `compile` = the resulting program does not parse or
 * type-check (A0 validator, tsc, rustc); `missing` = a function the tests need is absent;
 * `runtime` = a test raised or the program did not finish; `wrong-output` = a test
 * returned a different value; `no-reply` = no model output for this attempt.
 */
type AttemptStatus =
  | 'ok'
  | 'protocol'
  | 'compile'
  | 'missing'
  | 'runtime'
  | 'wrong-output'
  | 'no-reply';

interface Attempt {
  readonly status: AttemptStatus;
  readonly failures: readonly string[];
  readonly outputTokensLocal: Record<string, number>;
}

function classify(
  applied: AppliedEdit,
  protocol: Protocol,
  failures: readonly string[],
): AttemptStatus {
  if (applied.error !== undefined) return protocol === 'structured' ? 'protocol' : 'compile';
  if (failures.length === 0) return 'ok';
  const f = failures[0] ?? '';
  if (/^(invalid A0:|tsc:|rustc:)/.test(f)) return 'compile';
  if (failures.some((x) => x.startsWith('missing '))) return 'missing';
  if (failures.some((x) => /=.*, expected /.test(x))) return 'wrong-output';
  return 'runtime';
}

interface Trial {
  readonly task: string;
  readonly kind: Task['kind'];
  readonly representation: Representation;
  readonly protocol: Protocol;
  readonly trial: number;
  readonly setupTokensLocal: Record<string, number>;
  readonly viewTokensLocal: Record<string, number>;
  /**
   * Whole-task token buckets (o200k, local counts), never merged: language primer and
   * workflow primer are charged once per model call (they travel in the system prompt);
   * tool context is the task text, the view, and every repair message; output is every
   * model reply.
   */
  readonly tokenBucketsLocal: {
    readonly languagePrimer: number;
    readonly workflowPrimer: number;
    readonly toolContext: number;
    readonly output: number;
    readonly total: number;
  } | null;
  readonly outputTokensLocal: Record<string, number> | null;
  readonly providerUsage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  } | null;
  readonly reasoningTokens: null;
  readonly modelCalls: number;
  readonly validationFailures: number;
  /** Accepted on the first reply, before any repair message. */
  readonly acceptedOneShot: boolean | null;
  /** Accepted within maxRepairs repair rounds. */
  readonly accepted: boolean | null;
  readonly attempts: readonly Attempt[];
  readonly failures: readonly string[];
  readonly wallMs: number | null;
}

interface ReplyResult {
  readonly reply: string;
  readonly usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/** Runs one trial: up to 1 + maxRepairs replies from `ask`, each applied and accepted. */
async function runTrial(
  task: Task,
  representation: Representation,
  protocol: Protocol,
  cell: Cell,
  session: EditSession | undefined,
  handle: string,
  maxRepairs: number,
  count: (text: string) => Record<string, number>,
  ask: (messages: Anthropic.MessageParam[]) => Promise<ReplyResult | undefined>,
): Promise<
  Omit<
    Trial,
    | 'task'
    | 'kind'
    | 'representation'
    | 'protocol'
    | 'trial'
    | 'setupTokensLocal'
    | 'viewTokensLocal'
    | 'reasoningTokens'
  >
> {
  const start = performance.now();
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: `${task.instruction}\n\n${cell.view}` },
  ];
  let source =
    representation === 'a0'
      ? task.a0Source
      : representation === 'rust'
        ? task.rustSource
        : task.tsSource;
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let sawUsage = false;
  let calls = 0;
  let toolContext = count(`${task.instruction}\n\n${cell.view}`).o200k_base ?? 0;
  const attempts: Attempt[] = [];
  let failures: string[] = [];
  let accepted = false;
  let outputText = '';
  for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
    const res = await ask(messages);
    if (res === undefined) {
      attempts.push({ status: 'no-reply', failures: ['no reply'], outputTokensLocal: count('') });
      failures = ['no reply'];
      break;
    }
    calls += 1;
    if (res.usage !== undefined) {
      sawUsage = true;
      usage.input += res.usage.input;
      usage.output += res.usage.output;
      usage.cacheRead += res.usage.cacheRead;
      usage.cacheWrite += res.usage.cacheWrite;
    }
    outputText += res.reply;
    const applied =
      representation === 'a0'
        ? applyA0(representation, protocol, source, res.reply, session)
        : applyTs(protocol, source, res.reply, handle);
    failures =
      applied.error !== undefined
        ? [applied.error]
        : representation === 'a0'
          ? await acceptA0(applied.source, task.tests)
          : representation === 'rust'
            ? await acceptRust(applied.source, task.tests)
            : await acceptTs(applied.source, task.tests);
    attempts.push({
      status: classify(applied, protocol, failures),
      failures,
      outputTokensLocal: count(res.reply),
    });
    if (failures.length === 0) {
      accepted = true;
      source = applied.source;
      break;
    }
    messages.push({ role: 'assistant', content: res.reply });
    const nextView =
      protocol === 'structured' &&
      representation === 'a0' &&
      session !== undefined &&
      applied.error === undefined
        ? session.open(parseAndValidate(applied.source).functions[0]?.name ?? '').text
        : undefined;
    const repair = `Rejected:\n${failures.join('\n')}\n${nextView !== undefined ? `\nCurrent view:\n${nextView}` : ''}\nTry again.`;
    toolContext += count(repair).o200k_base ?? 0;
    messages.push({ role: 'user', content: repair });
  }
  const languagePrimer = (count(cell.languagePrimer).o200k_base ?? 0) * calls;
  const workflowPrimer = (count(cell.workflowPrimer).o200k_base ?? 0) * calls;
  const output = count(outputText).o200k_base ?? 0;
  return {
    tokenBucketsLocal: {
      languagePrimer,
      workflowPrimer,
      toolContext,
      output,
      total: languagePrimer + workflowPrimer + toolContext + output,
    },
    outputTokensLocal: count(outputText),
    providerUsage: sawUsage ? usage : null,
    modelCalls: calls,
    validationFailures: attempts.filter((a) => a.status !== 'ok').length,
    acceptedOneShot: attempts[0]?.status === 'ok',
    accepted,
    attempts,
    failures,
    wallMs: performance.now() - start,
  };
}

async function main(): Promise<void> {
  const live = process.env.A0_ALLOW_PAID_MODEL_CALLS === '1';
  const model = process.env.A0_EXPERIMENT_MODEL ?? 'claude-opus-5-5';
  const trialsPerCell = Number(process.env.A0_EXPERIMENT_TRIALS ?? '3');
  const maxRepairs = 2;
  const guide = await readFile('MODEL_GUIDE.txt', 'utf8');
  const encoders = {
    o200k_base: getEncoding('o200k_base'),
    cl100k_base: getEncoding('cl100k_base'),
  } as const;
  const count = (text: string): Record<string, number> =>
    Object.fromEntries(Object.entries(encoders).map(([k, e]) => [k, e.encode(text).length]));

  // Harness self-check: reference solutions must pass acceptance in every cell.
  const selfCheck: Record<string, string[]> = {};
  for (const task of TASKS) {
    selfCheck[`${task.id}/a0`] = await acceptA0(task.reference.a0, task.tests);
    selfCheck[`${task.id}/ts`] = await acceptTs(task.reference.ts, task.tests);
    selfCheck[`${task.id}/a0-original-must-fail`] =
      (await acceptA0(task.a0Source, task.tests)).length > 0 ? [] : ['original already passes'];
    selfCheck[`${task.id}/ts-original-must-fail`] =
      (await acceptTs(task.tsSource, task.tests)).length > 0 ? [] : ['original already passes'];
    selfCheck[`${task.id}/rust`] = await acceptRust(task.reference.rust, task.tests);
    selfCheck[`${task.id}/rust-original-must-fail`] =
      (await acceptRust(task.rustSource, task.tests)).length > 0 ? [] : ['original already passes'];
  }
  const selfCheckOk = Object.values(selfCheck).every((f) => f.length === 0);

  const client = live ? new Anthropic() : undefined;
  // Scripted replies (e.g. an in-session model answering from a prompt dump): a JSON map
  // "task/representation/protocol" -> reply[] consumed one per attempt. Token counts of
  // replies are local (js-tiktoken); provider usage is null.
  const repliesPath = process.env.A0_EXPERIMENT_REPLIES;
  const scripted: Record<string, string[]> | undefined =
    repliesPath === undefined
      ? undefined
      : (JSON.parse(await readFile(repliesPath, 'utf8')) as Record<string, string[]>);
  const dumpPath = process.env.A0_EXPERIMENT_DUMP;
  const dump: Record<string, { system: string; user: string }> = {};
  const trials: Trial[] = [];
  for (const task of TASKS) {
    for (const representation of ['a0', 'ts', 'rust'] as const) {
      for (const protocol of ['conventional', 'structured'] as const) {
        for (let t = 0; t < (live ? trialsPerCell : 1); t += 1) {
          const { cell, session, handle } = await buildCell(task, representation, protocol, guide);
          const base = {
            task: task.id,
            kind: task.kind,
            representation,
            protocol,
            trial: t,
            setupTokensLocal: count(cell.system),
            viewTokensLocal: count(cell.view),
            reasoningTokens: null,
          } as const;
          const cellKey = `${task.id}/${representation}/${protocol}`;
          dump[cellKey] = { system: cell.system, user: `${task.instruction}\n\n${cell.view}` };
          if (scripted !== undefined) {
            const answers = [...(scripted[cellKey] ?? [])];
            const result = await runTrial(
              task,
              representation,
              protocol,
              cell,
              session,
              handle,
              maxRepairs,
              count,
              async () => {
                const reply = answers.shift();
                return reply === undefined ? undefined : { reply };
              },
            );
            trials.push({ ...base, ...result });
            continue;
          }
          if (client === undefined) {
            trials.push({
              ...base,
              tokenBucketsLocal: null,
              outputTokensLocal: null,
              providerUsage: null,
              modelCalls: 0,
              validationFailures: 0,
              acceptedOneShot: null,
              accepted: null,
              attempts: [],
              failures: [],
              wallMs: null,
            });
            continue;
          }
          const result = await runTrial(
            task,
            representation,
            protocol,
            cell,
            session,
            handle,
            maxRepairs,
            count,
            async (messages) => {
              const res = await client.messages.create({
                model,
                max_tokens: 4096,
                system: [{ type: 'text', text: cell.system, cache_control: { type: 'ephemeral' } }],
                messages,
              });
              return {
                reply: res.content
                  .filter((b): b is Anthropic.TextBlock => b.type === 'text')
                  .map((b) => b.text)
                  .join('\n'),
                usage: {
                  input: res.usage.input_tokens,
                  output: res.usage.output_tokens,
                  cacheRead: res.usage.cache_read_input_tokens ?? 0,
                  cacheWrite: res.usage.cache_creation_input_tokens ?? 0,
                },
              };
            },
          );
          trials.push({ ...base, ...result });
        }
      }
    }
  }

  if (dumpPath !== undefined)
    await writeFile(dumpPath, `${JSON.stringify(dump, null, 2)}\n`, 'utf8');
  const report = {
    generatedAt: new Date().toISOString(),
    status: live
      ? 'run'
      : scripted !== undefined
        ? `run with scripted replies from ${repliesPath} (subject: ${process.env.A0_EXPERIMENT_SUBJECT ?? 'unspecified'})`
        : 'unrun (paid model calls not authorized: set A0_ALLOW_PAID_MODEL_CALLS=1 with Anthropic credentials)',
    model: live ? model : null,
    tokenizerNote:
      'setup/view/output token counts are local js-tiktoken counts (OpenAI encodings), not the vendor tokenizer; providerUsage carries the billed counts when live.',
    design: {
      cells: [
        'a0/conventional',
        'a0/structured',
        'ts/conventional',
        'ts/structured',
        'rust/conventional',
        'rust/structured',
      ],
      heldConstant: [
        'model',
        'task text',
        'acceptance tests',
        'max repairs',
        'max_tokens',
        'system prompt caching',
      ],
      setupCounted:
        'A0 cells carry MODEL_GUIDE.txt as language instructions; TS and Rust cells carry a u32 semantics note; all carry their protocol instructions. Rust acceptance compiles with rustc -O and runs generated checks.',
      unknowns: 'Hidden reasoning tokens are not reported by the API and are recorded as null.',
    },
    tasks: TASKS.map((t) => ({ id: t.id, kind: t.kind, tests: t.tests.length })),
    harnessSelfCheck: { ok: selfCheckOk, details: selfCheck },
    trials,
  };
  await mkdir('results', { recursive: true });
  await writeFile(
    join('results', 'ai-edit-experiment.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  process.stdout.write(`status: ${report.status}\nself-check: ${selfCheckOk ? 'ok' : 'FAILED'}\n`);
  for (const tr of trials) {
    process.stdout.write(
      `${tr.task.padEnd(12)} ${tr.representation}/${tr.protocol.padEnd(12)} setup o200k=${tr.setupTokensLocal.o200k_base} view o200k=${tr.viewTokensLocal.o200k_base}${tr.accepted === null ? '' : ` one-shot=${tr.acceptedOneShot} accepted=${tr.accepted} calls=${tr.modelCalls} total=${tr.tokenBucketsLocal?.total} status=${tr.attempts.map((a) => a.status).join(',')}`}\n`,
    );
  }
  if (!selfCheckOk) process.exit(1);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
