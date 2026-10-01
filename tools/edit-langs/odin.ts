/**
 * Odin: u32 values are u32 (arithmetic wraps, shifts by 32 or more give 0, comparisons are
 * unsigned); u32x4 arrays are [4]u32 and records are multi-value returns (u32, u32). The
 * candidate is lib.odin and the driver main.odin, two files of one package built together
 * with odin build.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Type, Value } from '../../src/core.js';
import { runTool } from '../../src/toolchain.js';
import {
  BUILD_MS,
  failure,
  type LangCase,
  type LangSpec,
  RUN_MS,
  recordFields,
  signature,
  tool,
} from './spec.js';

function literal(v: Value): string {
  if (typeof v === 'number') return `u32(${v})`;
  if (typeof v === 'boolean') return String(v);
  return `[4]u32{${Array.from(v as ArrayLike<Value>, literal).join(', ')}}`;
}

function driver(tests: readonly LangCase[], typed: Parameters<LangSpec['driver']>[1]): string {
  const body = tests
    .map((t, i) => {
      const { result } = signature(typed, t.fn);
      const args = t.args.map(literal).join(', ');
      const fields = recordFields(result as Type | undefined);
      if (fields.length > 0) {
        const names = fields.map((_, k) => `v${i}_${k}`);
        return `  ${names.join(', ')} := ${t.fn}(${args})\n  fmt.printfln("R${i} [${fields.map(() => '%d').join(',')}]", ${names.join(', ')})`;
      }
      const f = result === 'bool' ? '%v' : '%d';
      return `  v${i} := ${t.fn}(${args})\n  fmt.printfln("R${i} ${f}", v${i})`;
    })
    .join('\n');
  return `package main\n\nimport "core:fmt"\n\nmain :: proc() {\n${body}\n  fmt.println("DONE")\n}\n`;
}

const B: LangSpec['b'] = {
  'b-fits-inclusive': {
    source: 'fits :: proc(a, b: u32) -> bool {\n  return a < b\n}\n',
    reference: 'fits :: proc(a, b: u32) -> bool {\n  return a <= b\n}\n',
  },
  'b-sumfrom-eight': {
    source:
      'sumfrom :: proc(x: u32) -> u32 {\n  s := x\n  for i in u32(0) ..< 5 {\n    s = s + i\n  }\n  return s\n}\n',
    reference:
      'sumfrom :: proc(x: u32) -> u32 {\n  s := x\n  for i in u32(0) ..< 8 {\n    s = s + i\n  }\n  return s\n}\n',
  },
  'b-rot8-constant': {
    source: 'rot8 :: proc(x: u32) -> u32 {\n  return (x << 8) | (x >> 23)\n}\n',
    reference: 'rot8 :: proc(x: u32) -> u32 {\n  return (x << 8) | (x >> 24)\n}\n',
  },
  'b-onlyone-xor': {
    source: 'onlyone :: proc(a, b: bool) -> bool {\n  return a || b\n}\n',
    reference: 'onlyone :: proc(a, b: bool) -> bool {\n  return a != b\n}\n',
  },
  'b-avgfloor-nowrap': {
    source: 'avgfloor :: proc(a, b: u32) -> u32 {\n  return (a + b) >> 1\n}\n',
    reference: 'avgfloor :: proc(a, b: u32) -> u32 {\n  return (a & b) + ((a ~ b) >> 1)\n}\n',
  },
  'b-sumsq-array': {
    source:
      'sumsq :: proc(a: [4]u32) -> u32 {\n  s: u32 = 0\n  for i in 0 ..< 4 {\n    s = s + a[i % 4]\n  }\n  return s\n}\n',
    reference:
      'sumsq :: proc(a: [4]u32) -> u32 {\n  s: u32 = 0\n  for i in 0 ..< 4 {\n    x := a[i % 4]\n    s = s + x * x\n  }\n  return s\n}\n',
  },
  'b-inrange-inclusive': {
    source: 'inrange :: proc(x, lo, hi: u32) -> bool {\n  return x > lo && x < hi\n}\n',
    reference: 'inrange :: proc(x, lo, hi: u32) -> bool {\n  return x >= lo && x <= hi\n}\n',
  },
  'b-bounds-largest': {
    source:
      'bounds :: proc(a: [4]u32) -> (u32, u32) {\n  lo: u32 = 0xffffffff\n  hi: u32 = 0\n  for i in 0 ..< 4 {\n    x := a[i % 4]\n    if x < lo { lo = x }\n    if x < hi { hi = x }\n  }\n  return lo, hi\n}\n',
    reference:
      'bounds :: proc(a: [4]u32) -> (u32, u32) {\n  lo: u32 = 0xffffffff\n  hi: u32 = 0\n  for i in 0 ..< 4 {\n    x := a[i % 4]\n    if x < lo { lo = x }\n    if x > hi { hi = x }\n  }\n  return lo, hi\n}\n',
  },
  'b-checksum-poly': {
    source:
      'checksum :: proc(a: [4]u32) -> u32 {\n  h: u32 = 0\n  for i in 0 ..< 4 {\n    h = h ~ a[i % 4]\n  }\n  return h\n}\n',
    reference:
      'checksum :: proc(a: [4]u32) -> u32 {\n  h: u32 = 7\n  for i in 0 ..< 4 {\n    h = h * 31 + a[i % 4]\n  }\n  return h\n}\n',
  },
  'b-norm2-dot': {
    source:
      'dot :: proc(a, b: [4]u32) -> u32 {\n  s: u32 = 0\n  for i in 0 ..< 4 {\n    s = s + a[i % 4] * b[i % 4]\n  }\n  return s\n}\n',
    reference:
      'dot :: proc(a, b: [4]u32) -> u32 {\n  s: u32 = 0\n  for i in 0 ..< 4 {\n    s = s + a[i % 4] * b[i % 4]\n  }\n  return s\n}\nnorm2 :: proc(a: [4]u32) -> u32 {\n  return dot(a, a)\n}\n',
  },
  'b-pctof-limit': {
    source:
      'limit :: proc(x, lo, hi: u32) -> u32 {\n  b := lo if x < lo else x\n  return hi if b > hi else b\n}\n',
    reference:
      'limit :: proc(x, lo, hi: u32) -> u32 {\n  b := lo if x < lo else x\n  return hi if b > hi else b\n}\npctof :: proc(part, whole: u32) -> u32 {\n  n := part * 100\n  q: u32 = 0xffffffff if whole == 0 else n / whole\n  return limit(q, 0, 100)\n}\n',
  },
  'b-hamming-popcnt': {
    source:
      'popcnt :: proc(x: u32) -> u32 {\n  s: u32 = 0\n  for i in u32(0) ..< 32 {\n    s = s + ((x >> i) & 1)\n  }\n  return s\n}\n',
    reference:
      'popcnt :: proc(x: u32) -> u32 {\n  s: u32 = 0\n  for i in u32(0) ..< 32 {\n    s = s + ((x >> i) & 1)\n  }\n  return s\n}\nhamming :: proc(a, b: u32) -> u32 {\n  return popcnt(a ~ b)\n}\n',
  },
};

export const ODIN: LangSpec = {
  semantics:
    'Integers are u32: + - * wrap modulo 2^32, shifts by 32 or more give 0 (mask counts with & 31 where the task says so), comparisons are unsigned, xor is ~ and bool xor is !=. Records are multi-value returns such as -> (u32, u32); u32x4 is [4]u32. Division by zero gives 4294967295; remainder by zero gives the dividend. The file is lib.odin (package main, no main proc, no imports) and must build with odin build together with a driver main.odin.',
  head: /^([a-z_][A-Za-z0-9_]*) :: proc\(/,
  file: (body) => `package main\n\n${body}`,
  b: B,
  driver,
  compileLabel: 'odin',
  async buildAndRun(dir, source, drv) {
    const odin = tool('odin', 'A0_ODIN', ['/opt/homebrew/bin/odin']);
    await writeFile(join(dir, 'lib.odin'), source, 'utf8');
    await writeFile(join(dir, 'main.odin'), drv, 'utf8');
    const exe = join(dir, 'prog');
    const build = runTool(odin, ['build', dir, '-o:none', `-out:${exe}`], {
      cwd: dir,
      timeoutMs: BUILD_MS,
    });
    if (!build.ok) return failure('odin', build);
    const run = runTool(exe, [], { cwd: dir, timeoutMs: RUN_MS });
    if (!run.ok) return failure('run', run);
    return { stdout: run.stdout };
  },
};
