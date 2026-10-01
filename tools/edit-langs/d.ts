/**
 * D (LDC): u32 values are uint (wrapping arithmetic, unsigned compares; shifts of a uint stay
 * uint); u32x4 arrays are const(uint)[], records are uint[2] static arrays. The candidate is
 * module `mod`, compiled separately with ldc2 -c, then linked with the generated driver.
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
  if (typeof v === 'number') return `${v}u`;
  if (typeof v === 'boolean') return String(v);
  return `[${Array.from(v as ArrayLike<Value>, literal).join(', ')}]`;
}

function render(expr: string, t: Type | undefined): string {
  if (t === 'bool') return `(${expr} ? "true" : "false")`;
  if (recordFields(t).length === 2)
    return `"[" ~ to!string(${expr}[0]) ~ "," ~ to!string(${expr}[1]) ~ "]"`;
  return `to!string(${expr})`;
}

function driver(tests: readonly LangCase[], typed: Parameters<LangSpec['driver']>[1]): string {
  const body = tests
    .map((t, i) => {
      const { result } = signature(typed, t.fn);
      const args = t.args.map(literal).join(', ');
      return `  writeln("R${i} " ~ ${render(`${t.fn}(${args})`, result)});`;
    })
    .join('\n');
  return `import mod;\nimport std.conv : to;\nimport std.stdio : writeln;\nvoid main() {\n${body}\n  writeln("DONE");\n}\n`;
}

const B: LangSpec['b'] = {
  'b-fits-inclusive': {
    source: 'bool fits(uint a, uint b) {\n    return a < b;\n}\n',
    reference: 'bool fits(uint a, uint b) {\n    return a <= b;\n}\n',
  },
  'b-sumfrom-eight': {
    source:
      'uint sumfrom(uint x) {\n    uint s = x;\n    foreach (uint i; 0 .. 5) {\n        s += i;\n    }\n    return s;\n}\n',
    reference:
      'uint sumfrom(uint x) {\n    uint s = x;\n    foreach (uint i; 0 .. 8) {\n        s += i;\n    }\n    return s;\n}\n',
  },
  'b-rot8-constant': {
    source: 'uint rot8(uint x) {\n    return (x << 8) | (x >> 23);\n}\n',
    reference: 'uint rot8(uint x) {\n    return (x << 8) | (x >> 24);\n}\n',
  },
  'b-onlyone-xor': {
    source: 'bool onlyone(bool a, bool b) {\n    return a || b;\n}\n',
    reference: 'bool onlyone(bool a, bool b) {\n    return a != b;\n}\n',
  },
  'b-avgfloor-nowrap': {
    source: 'uint avgfloor(uint a, uint b) {\n    return (a + b) >> 1;\n}\n',
    reference: 'uint avgfloor(uint a, uint b) {\n    return (a & b) + ((a ^ b) >> 1);\n}\n',
  },
  'b-sumsq-array': {
    source:
      'uint sumsq(const(uint)[] a) {\n    uint s = 0;\n    foreach (i; 0 .. 4) {\n        s += a[i];\n    }\n    return s;\n}\n',
    reference:
      'uint sumsq(const(uint)[] a) {\n    uint s = 0;\n    foreach (i; 0 .. 4) {\n        s += a[i] * a[i];\n    }\n    return s;\n}\n',
  },
  'b-inrange-inclusive': {
    source: 'bool inrange(uint x, uint lo, uint hi) {\n    return x > lo && x < hi;\n}\n',
    reference: 'bool inrange(uint x, uint lo, uint hi) {\n    return x >= lo && x <= hi;\n}\n',
  },
  'b-bounds-largest': {
    source:
      'uint[2] bounds(const(uint)[] a) {\n    uint lo = 4294967295u;\n    uint hi = 0;\n    foreach (i; 0 .. 4) {\n        uint x = a[i];\n        if (x < lo) lo = x;\n        if (x < hi) hi = x;\n    }\n    return [lo, hi];\n}\n',
    reference:
      'uint[2] bounds(const(uint)[] a) {\n    uint lo = 4294967295u;\n    uint hi = 0;\n    foreach (i; 0 .. 4) {\n        uint x = a[i];\n        if (x < lo) lo = x;\n        if (x > hi) hi = x;\n    }\n    return [lo, hi];\n}\n',
  },
  'b-checksum-poly': {
    source:
      'uint checksum(const(uint)[] a) {\n    uint h = 0;\n    foreach (i; 0 .. 4) {\n        h ^= a[i];\n    }\n    return h;\n}\n',
    reference:
      'uint checksum(const(uint)[] a) {\n    uint h = 7;\n    foreach (i; 0 .. 4) {\n        h = h * 31 + a[i];\n    }\n    return h;\n}\n',
  },
  'b-norm2-dot': {
    source:
      'uint dot(const(uint)[] a, const(uint)[] b) {\n    uint s = 0;\n    foreach (i; 0 .. 4) {\n        s += a[i] * b[i];\n    }\n    return s;\n}\n',
    reference:
      'uint dot(const(uint)[] a, const(uint)[] b) {\n    uint s = 0;\n    foreach (i; 0 .. 4) {\n        s += a[i] * b[i];\n    }\n    return s;\n}\nuint norm2(const(uint)[] a) {\n    return dot(a, a);\n}\n',
  },
  'b-pctof-limit': {
    source:
      'uint limit(uint x, uint lo, uint hi) {\n    uint b = x < lo ? lo : x;\n    return b > hi ? hi : b;\n}\n',
    reference:
      'uint limit(uint x, uint lo, uint hi) {\n    uint b = x < lo ? lo : x;\n    return b > hi ? hi : b;\n}\nuint pctof(uint part, uint whole) {\n    uint n = part * 100;\n    uint q = whole == 0 ? 4294967295u : n / whole;\n    return limit(q, 0, 100);\n}\n',
  },
  'b-hamming-popcnt': {
    source:
      'uint popcnt(uint x) {\n    uint s = 0;\n    foreach (uint i; 0 .. 32) {\n        s += (x >> i) & 1;\n    }\n    return s;\n}\n',
    reference:
      'uint popcnt(uint x) {\n    uint s = 0;\n    foreach (uint i; 0 .. 32) {\n        s += (x >> i) & 1;\n    }\n    return s;\n}\nuint hamming(uint a, uint b) {\n    return popcnt(a ^ b);\n}\n',
  },
};

export const D: LangSpec = {
  semantics:
    'Integers are uint (unsigned 32-bit; literals above 2147483647 need the u suffix, e.g. 4294967295u): +, -, * wrap modulo 2^32, comparisons are unsigned, shift counts below 32 keep the type uint. Division by zero must be handled explicitly (4294967295; remainder by zero gives the dividend). u32x4 arrays are const(uint)[] and records are uint[2]. The file is module mod (functions at top level), compiled with ldc2 -c and linked with a driver that imports it.',
  head: /^[A-Za-z0-9_()[\]]+ ([a-z_][A-Za-z0-9_]*)\(/,
  file: (body) => `module mod;\n${body}`,
  b: B,
  driver,
  compileLabel: 'ldc2',
  async buildAndRun(dir, source, drv) {
    const ldc2 = tool('ldc2', 'A0_LDC2', ['/opt/homebrew/bin/ldc2']);
    await writeFile(join(dir, 'mod.d'), source, 'utf8');
    await writeFile(join(dir, 'driver.d'), drv, 'utf8');
    const obj = join(dir, 'mod.o');
    const build = runTool(ldc2, ['-O0', '-w', '-c', `-of=${obj}`, join(dir, 'mod.d')], {
      cwd: dir,
      timeoutMs: BUILD_MS,
    });
    if (!build.ok) return failure('ldc2', build);
    const exe = join(dir, 'main');
    const link = runTool(ldc2, ['-O0', `-I${dir}`, `-of=${exe}`, join(dir, 'driver.d'), obj], {
      cwd: dir,
      timeoutMs: BUILD_MS,
    });
    if (!link.ok) return failure('ldc2', link);
    const run = runTool(exe, [], { cwd: dir, timeoutMs: RUN_MS });
    if (!run.ok) return failure('run', run);
    return { stdout: run.stdout };
  },
};
