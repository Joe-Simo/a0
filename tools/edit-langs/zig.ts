/**
 * Zig: u32 values are u32 with wrapping operators (+% -% *%); shift counts are truncated
 * to u5; records are tuple structs and u32x4 arrays are [4]u32. The candidate is lib.zig,
 * imported by the driver main.zig, built with zig build-exe (Debug, so plain overflow traps).
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Type, Value } from '../../src/core.js';
import { runTool } from '../../src/toolchain.js';
import type { FillerFunction } from '../ai-edit-tasks-c.js';
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

const M = '0xFFFFFFFF';
const U5 = (e: string): string => `@as(u5, @truncate(${e}))`;

function literal(v: Value): string {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return `.{ ${Array.from(v as ArrayLike<Value>, literal).join(', ')} }`;
}

/** Format specifiers and arguments printing `expr` of type `t` canonically. */
function render(expr: string, t: Type | undefined): { fmt: string; args: string[] } {
  if (t === 'bool') return { fmt: '{}', args: [expr] };
  const fields = recordFields(t);
  if (fields.length > 0) {
    const parts = fields.map((ft, i) => render(`${expr}[${i}]`, ft));
    return { fmt: `[${parts.map((p) => p.fmt).join(',')}]`, args: parts.flatMap((p) => p.args) };
  }
  return { fmt: '{d}', args: [expr] };
}

function driver(tests: readonly LangCase[], typed: Parameters<LangSpec['driver']>[1]): string {
  const body = tests
    .map((t, i) => {
      const { result } = signature(typed, t.fn);
      const args = t.args.map((a) => literal(a)).join(', ');
      const r = render(`v${i}`, result);
      return `    const v${i} = lib.${t.fn}(${args});\n    try o.print("R${i} ${r.fmt}\\n", .{ ${r.args.join(', ')} });`;
    })
    .join('\n');
  return `const std = @import("std");\nconst lib = @import("lib.zig");\n\npub fn main(init: std.process.Init) !void {\n    var buf: [4096]u8 = undefined;\n    var w = std.Io.File.stdout().writer(init.io, &buf);\n    const o = &w.interface;\n${body}\n    try o.print("DONE\\n", .{});\n    try o.flush();\n}\n`;
}

const B: LangSpec['b'] = {
  'b-fits-inclusive': {
    source: 'pub fn fits(a: u32, b: u32) bool {\n    return a < b;\n}\n',
    reference: 'pub fn fits(a: u32, b: u32) bool {\n    return a <= b;\n}\n',
  },
  'b-sumfrom-eight': {
    source:
      'pub fn sumfrom(x: u32) u32 {\n    var s: u32 = x;\n    var i: u32 = 0;\n    while (i < 5) : (i += 1) {\n        s +%= i;\n    }\n    return s;\n}\n',
    reference:
      'pub fn sumfrom(x: u32) u32 {\n    var s: u32 = x;\n    var i: u32 = 0;\n    while (i < 8) : (i += 1) {\n        s +%= i;\n    }\n    return s;\n}\n',
  },
  'b-rot8-constant': {
    source: 'pub fn rot8(x: u32) u32 {\n    return (x << 8) | (x >> 23);\n}\n',
    reference: 'pub fn rot8(x: u32) u32 {\n    return (x << 8) | (x >> 24);\n}\n',
  },
  'b-onlyone-xor': {
    source: 'pub fn onlyone(a: bool, b: bool) bool {\n    return a or b;\n}\n',
    reference: 'pub fn onlyone(a: bool, b: bool) bool {\n    return a != b;\n}\n',
  },
  'b-avgfloor-nowrap': {
    source: 'pub fn avgfloor(a: u32, b: u32) u32 {\n    return (a +% b) >> 1;\n}\n',
    reference: 'pub fn avgfloor(a: u32, b: u32) u32 {\n    return (a & b) +% ((a ^ b) >> 1);\n}\n',
  },
  'b-sumsq-array': {
    source:
      'pub fn sumsq(a: [4]u32) u32 {\n    var s: u32 = 0;\n    for (a) |x| {\n        s +%= x;\n    }\n    return s;\n}\n',
    reference:
      'pub fn sumsq(a: [4]u32) u32 {\n    var s: u32 = 0;\n    for (a) |x| {\n        s +%= x *% x;\n    }\n    return s;\n}\n',
  },
  'b-inrange-inclusive': {
    source: 'pub fn inrange(x: u32, lo: u32, hi: u32) bool {\n    return x > lo and x < hi;\n}\n',
    reference:
      'pub fn inrange(x: u32, lo: u32, hi: u32) bool {\n    return x >= lo and x <= hi;\n}\n',
  },
  'b-bounds-largest': {
    source: `pub fn bounds(a: [4]u32) struct { u32, u32 } {\n    var lo: u32 = ${M};\n    var hi: u32 = 0;\n    for (a) |x| {\n        if (x < lo) lo = x;\n        if (x < hi) hi = x;\n    }\n    return .{ lo, hi };\n}\n`,
    reference: `pub fn bounds(a: [4]u32) struct { u32, u32 } {\n    var lo: u32 = ${M};\n    var hi: u32 = 0;\n    for (a) |x| {\n        if (x < lo) lo = x;\n        if (x > hi) hi = x;\n    }\n    return .{ lo, hi };\n}\n`,
  },
  'b-checksum-poly': {
    source:
      'pub fn checksum(a: [4]u32) u32 {\n    var h: u32 = 0;\n    for (a) |x| {\n        h ^= x;\n    }\n    return h;\n}\n',
    reference:
      'pub fn checksum(a: [4]u32) u32 {\n    var h: u32 = 7;\n    for (a) |x| {\n        h = h *% 31 +% x;\n    }\n    return h;\n}\n',
  },
  'b-norm2-dot': {
    source:
      'pub fn dot(a: [4]u32, b: [4]u32) u32 {\n    var s: u32 = 0;\n    for (a, b) |x, y| {\n        s +%= x *% y;\n    }\n    return s;\n}\n',
    reference:
      'pub fn dot(a: [4]u32, b: [4]u32) u32 {\n    var s: u32 = 0;\n    for (a, b) |x, y| {\n        s +%= x *% y;\n    }\n    return s;\n}\npub fn norm2(a: [4]u32) u32 {\n    return dot(a, a);\n}\n',
  },
  'b-pctof-limit': {
    source:
      'pub fn limit(x: u32, lo: u32, hi: u32) u32 {\n    const b = if (x < lo) lo else x;\n    return if (b > hi) hi else b;\n}\n',
    reference: `pub fn limit(x: u32, lo: u32, hi: u32) u32 {\n    const b = if (x < lo) lo else x;\n    return if (b > hi) hi else b;\n}\npub fn pctof(part: u32, whole: u32) u32 {\n    const n = part *% 100;\n    const q = if (whole == 0) ${M} else n / whole;\n    return limit(q, 0, 100);\n}\n`,
  },
  'b-hamming-popcnt': {
    source:
      'pub fn popcnt(x: u32) u32 {\n    var s: u32 = 0;\n    var i: u32 = 0;\n    while (i < 32) : (i += 1) {\n        s +%= (x >> @as(u5, @truncate(i))) & 1;\n    }\n    return s;\n}\n',
    reference:
      'pub fn popcnt(x: u32) u32 {\n    var s: u32 = 0;\n    var i: u32 = 0;\n    while (i < 32) : (i += 1) {\n        s +%= (x >> @as(u5, @truncate(i))) & 1;\n    }\n    return s;\n}\npub fn hamming(a: u32, b: u32) u32 {\n    return popcnt(a ^ b);\n}\n',
  },
};

const FILLER = `pub fn affine(x: u32, scale: u32, offset: u32) u32 {
    return x *% scale +% offset;
}
pub fn clamp(x: u32, hi: u32) u32 {
    return if (hi < x) hi else x;
}
pub fn rotl(x: u32, n: u32) u32 {
    return (x << ${U5('n')}) | (x << ${U5('32 -% n')});
}
pub fn sq(x: u32) u32 {
    return x *% x;
}
pub fn quad(x: u32) u32 {
    return sq(x);
}
pub fn absdiff(a: u32, b: u32) u32 {
    return a -% b;
}
pub fn combine4(a: u32, b: u32, c: u32, d: u32) u32 {
    return a +% b +% c +% d;
}
pub fn min2(a: u32, b: u32) u32 {
    return if (b < a) b else a;
}
pub fn sumto(n: u32) u32 {
    var s: u32 = 0;
    var i: u32 = 0;
    while (i < n) : (i += 1) {
        s +%= i;
    }
    return s;
}
pub fn countup(lim: u32, cap: u32) u32 {
    var s: u32 = 0;
    var k: u32 = 0;
    while (k < cap) : (k += 1) {
        if (!(s < lim)) break;
        s +%= 1;
    }
    return s;
}
pub fn pick(r: struct { u32, bool }) u32 {
    return r[0];
}
pub fn byte1(x: u32) u32 {
    return (x >> 8) & 0xFF;
}
pub fn sadd(a: u32, b: u32) u32 {
    return a +% b;
}
pub fn is_even(x: u32) bool {
    return (x & 1) == 0;
}
pub fn addi(acc: u32, i: u32) u32 {
    return acc +% i;
}
pub fn inc(s: u32, i: u32, lim: u32) u32 {
    _ = i;
    _ = lim;
    return s +% 1;
}
pub fn below(s: u32, i: u32, lim: u32) bool {
    _ = i;
    return s < lim;
}
pub fn addel(acc: u32, i: u32, a: [4]u32) u32 {
    return acc +% a[i % 4];
}
pub fn minmax(acc: struct { u32, u32 }, i: u32, a: [4]u32) struct { u32, u32 } {
    const lo = acc[0];
    const hi = acc[1];
    const x = a[i % 4];
    const nlo = if (x < lo) x else lo;
    const nhi = if (x < hi) x else hi;
    return .{ nlo, nhi };
}
pub fn mixel(acc: u32, i: u32, a: [4]u32) u32 {
    return acc ^ a[i % 4];
}
pub fn dstep(acc: u32, i: u32, a: [4]u32, b: [4]u32) u32 {
    return acc +% a[i % 4] *% b[i % 4];
}
pub fn pstep(acc: u32, i: u32, x: u32) u32 {
    return acc +% ((x >> ${U5('i')}) & 1);
}
pub fn nb(grid: [32]u32, r: u32, c: u32) u32 {
    const row = grid[r % 32];
    return (row >> ${U5('c')}) & 1;
}
pub fn count(grid: [32]u32, r: u32, c: u32) u32 {
    const ru = r -% 1;
    const rd = r +% 1;
    const cl = c -% 1;
    const cr = c +% 1;
    var s = nb(grid, ru, cl);
    s +%= nb(grid, ru, c);
    s +%= nb(grid, ru, cr);
    s +%= nb(grid, r, cl);
    s +%= nb(grid, r, cr);
    s +%= nb(grid, rd, cl);
    s +%= nb(grid, rd, c);
    s +%= nb(grid, rd, cr);
    return s;
}
pub fn bitstep(acc: u32, i: u32, x: u32) u32 {
    return acc +% ((x >> ${U5('i')}) & 1);
}
pub fn popcount(x: u32) u32 {
    var n: u32 = 0;
    var i: u32 = 0;
    while (i < 32) : (i += 1) {
        n = bitstep(n, i, x);
    }
    return n;
}
pub fn rowpop(acc: u32, i: u32, grid: [32]u32) u32 {
    return acc +% popcount(grid[i % 32]);
}
pub fn population(grid: [32]u32) u32 {
    var n: u32 = 0;
    var i: u32 = 0;
    while (i < 32) : (i += 1) {
        n = rowpop(n, i, grid);
    }
    return n;
}
`;

function fillerText(f: FillerFunction): string {
  const s = f.spec;
  const fn = (params: string, e: string): string =>
    `pub fn ${f.name}(${params}) u32 {\n    return ${e};\n}\n`;
  switch (s.template) {
    case 'lin':
      return fn('x: u32', `x *% ${s.m} +% ${s.c}`);
    case 'xs':
      return fn('x: u32', `x ^ (x >> ${s.s})`);
    case 'cap':
      return fn('x: u32', `if (x < ${s.c}) x else ${s.c}`);
    case 'pair':
      return fn('a: u32, b: u32', `(a +% b) ^ ${s.c}`);
    case 'sum':
      return fn('x: u32', `${s.g}(x) +% ${s.h}(x)`);
    case 'mixin':
      return fn('a: u32, b: u32', `${s.g}(a) ^ b`);
  }
}

export const ZIG: LangSpec = {
  semantics:
    'Integers are u32: use the wrapping operators +% -% *% for arithmetic (plain + - * trap on overflow), shift by a runtime count through @as(u5, @truncate(n)) so counts are masked to 5 bits; comparisons are unsigned. Records are tuple structs such as struct { u32, u32 } indexed r[0], r[1]; u32x4 is [4]u32. Every parameter must be used or discarded with _ = name;, and no parameter or local may shadow a function name. Division by zero gives 4294967295; remainder by zero gives the dividend. The file is lib.zig; functions are pub fn and it must build with zig build-exe (Zig 0.16).',
  head: /^pub fn ([a-z_][A-Za-z0-9_]*)\(/,
  file: (body) => body,
  b: B,
  filler: FILLER,
  fillerText,
  driver,
  compileLabel: 'zig',
  async buildAndRun(dir, source, drv) {
    const zig = tool('zig', 'A0_ZIG', ['/opt/homebrew/bin/zig']);
    await writeFile(join(dir, 'lib.zig'), source, 'utf8');
    await writeFile(join(dir, 'main.zig'), drv, 'utf8');
    const exe = join(dir, 'main');
    const build = runTool(
      zig,
      [
        'build-exe',
        'main.zig',
        '-ODebug',
        '--cache-dir',
        join(dir, 'zig-cache'),
        `-femit-bin=${exe}`,
      ],
      { cwd: dir, timeoutMs: BUILD_MS },
    );
    if (!build.ok) return failure('zig', build);
    const run = runTool(exe, [], { cwd: dir, timeoutMs: RUN_MS });
    if (!run.ok) return failure('run', run);
    return { stdout: run.stdout };
  },
};
