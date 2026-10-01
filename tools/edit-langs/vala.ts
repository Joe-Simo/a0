/**
 * Vala (valac, C backend): u32 values are uint32 (unsigned C arithmetic wraps mod 2^32,
 * comparisons are unsigned); u32x4 arrays are uint32[] and records are two-element uint32[]
 * (a record result is an array [lo, hi]). The candidate is lib.vala (namespace Lib of
 * functions), compiled by one valac invocation together with the generated driver.vala.
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
  if (typeof v === 'number') return `${v}U`;
  if (typeof v === 'boolean') return String(v);
  return `new uint32[] {${Array.from(v as ArrayLike<Value>, literal).join(', ')}}`;
}

function render(expr: string, t: Type | undefined): string {
  if (t === 'bool') return `(${expr} ? "true" : "false")`;
  if (recordFields(t).length === 2) return `join(${expr})`;
  return `(${expr}).to_string()`;
}

function driver(tests: readonly LangCase[], typed: Parameters<LangSpec['driver']>[1]): string {
  const body = tests
    .map((t, i) => {
      const { result } = signature(typed, t.fn);
      const args = t.args.map(literal).join(', ');
      return `    stdout.printf("R${i} %s\\n", ${render(`Lib.${t.fn}(${args})`, result)});`;
    })
    .join('\n');
  return `string join(uint32[] a) {
    string s = "[";
    for (int i = 0; i < a.length; i++) {
        if (i > 0) s += ",";
        s += a[i].to_string();
    }
    return s + "]";
}
int main() {
${body}
    stdout.printf("DONE\\n");
    return 0;
}
`;
}

const B: LangSpec['b'] = {
  'b-fits-inclusive': {
    source: 'bool fits(uint32 a, uint32 b) {\n    return a < b;\n}\n',
    reference: 'bool fits(uint32 a, uint32 b) {\n    return a <= b;\n}\n',
  },
  'b-sumfrom-eight': {
    source:
      'uint32 sumfrom(uint32 x) {\n    uint32 s = x;\n    for (uint32 i = 0; i < 5; i++) {\n        s += i;\n    }\n    return s;\n}\n',
    reference:
      'uint32 sumfrom(uint32 x) {\n    uint32 s = x;\n    for (uint32 i = 0; i < 8; i++) {\n        s += i;\n    }\n    return s;\n}\n',
  },
  'b-rot8-constant': {
    source: 'uint32 rot8(uint32 x) {\n    return (x << 8) | (x >> 23);\n}\n',
    reference: 'uint32 rot8(uint32 x) {\n    return (x << 8) | (x >> 24);\n}\n',
  },
  'b-onlyone-xor': {
    source: 'bool onlyone(bool a, bool b) {\n    return a || b;\n}\n',
    reference: 'bool onlyone(bool a, bool b) {\n    return a != b;\n}\n',
  },
  'b-avgfloor-nowrap': {
    source: 'uint32 avgfloor(uint32 a, uint32 b) {\n    return (a + b) >> 1;\n}\n',
    reference: 'uint32 avgfloor(uint32 a, uint32 b) {\n    return (a & b) + ((a ^ b) >> 1);\n}\n',
  },
  'b-sumsq-array': {
    source:
      'uint32 sumsq(uint32[] a) {\n    uint32 s = 0;\n    for (int i = 0; i < 4; i++) {\n        s += a[i % 4];\n    }\n    return s;\n}\n',
    reference:
      'uint32 sumsq(uint32[] a) {\n    uint32 s = 0;\n    for (int i = 0; i < 4; i++) {\n        uint32 x = a[i % 4];\n        s += x * x;\n    }\n    return s;\n}\n',
  },
  'b-inrange-inclusive': {
    source: 'bool inrange(uint32 x, uint32 lo, uint32 hi) {\n    return x > lo && x < hi;\n}\n',
    reference:
      'bool inrange(uint32 x, uint32 lo, uint32 hi) {\n    return x >= lo && x <= hi;\n}\n',
  },
  'b-bounds-largest': {
    source:
      'uint32[] bounds(uint32[] a) {\n    uint32 lo = 4294967295U;\n    uint32 hi = 0;\n    for (int i = 0; i < 4; i++) {\n        uint32 x = a[i % 4];\n        if (x < lo) lo = x;\n        if (x < hi) hi = x;\n    }\n    uint32[] r = {lo, hi};\n    return r;\n}\n',
    reference:
      'uint32[] bounds(uint32[] a) {\n    uint32 lo = 4294967295U;\n    uint32 hi = 0;\n    for (int i = 0; i < 4; i++) {\n        uint32 x = a[i % 4];\n        if (x < lo) lo = x;\n        if (x > hi) hi = x;\n    }\n    uint32[] r = {lo, hi};\n    return r;\n}\n',
  },
  'b-checksum-poly': {
    source:
      'uint32 checksum(uint32[] a) {\n    uint32 h = 0;\n    for (int i = 0; i < 4; i++) {\n        h ^= a[i % 4];\n    }\n    return h;\n}\n',
    reference:
      'uint32 checksum(uint32[] a) {\n    uint32 h = 7;\n    for (int i = 0; i < 4; i++) {\n        h = h * 31 + a[i % 4];\n    }\n    return h;\n}\n',
  },
  'b-norm2-dot': {
    source:
      'uint32 dot(uint32[] a, uint32[] b) {\n    uint32 s = 0;\n    for (int i = 0; i < 4; i++) {\n        s += a[i % 4] * b[i % 4];\n    }\n    return s;\n}\n',
    reference:
      'uint32 dot(uint32[] a, uint32[] b) {\n    uint32 s = 0;\n    for (int i = 0; i < 4; i++) {\n        s += a[i % 4] * b[i % 4];\n    }\n    return s;\n}\nuint32 norm2(uint32[] a) {\n    return dot(a, a);\n}\n',
  },
  'b-pctof-limit': {
    source:
      'uint32 limit(uint32 x, uint32 lo, uint32 hi) {\n    uint32 b = x < lo ? lo : x;\n    return b > hi ? hi : b;\n}\n',
    reference:
      'uint32 limit(uint32 x, uint32 lo, uint32 hi) {\n    uint32 b = x < lo ? lo : x;\n    return b > hi ? hi : b;\n}\nuint32 pctof(uint32 part, uint32 whole) {\n    uint32 n = part * 100;\n    uint32 q = whole == 0 ? 4294967295U : n / whole;\n    return limit(q, 0, 100);\n}\n',
  },
  'b-hamming-popcnt': {
    source:
      'uint32 popcnt(uint32 x) {\n    uint32 s = 0;\n    for (uint32 i = 0; i < 32; i++) {\n        s += (x >> i) & 1;\n    }\n    return s;\n}\n',
    reference:
      'uint32 popcnt(uint32 x) {\n    uint32 s = 0;\n    for (uint32 i = 0; i < 32; i++) {\n        s += (x >> i) & 1;\n    }\n    return s;\n}\nuint32 hamming(uint32 a, uint32 b) {\n    return popcnt(a ^ b);\n}\n',
  },
};

export const VALA: LangSpec = {
  semantics:
    'Integers are uint32 (unsigned 32-bit; literals above 2147483647 need the U suffix, e.g. 4294967295U): +, -, * wrap modulo 2^32, comparisons are unsigned, shift counts stay below 32. Division by zero must be handled explicitly (4294967295; remainder by zero gives the dividend). u32x4 arrays are uint32[] and records are two-element uint32[]. The file is lib.vala with the functions inside namespace Lib, built with valac lib.vala driver.vala (callers use Lib.name).',
  head: /^[A-Za-z0-9_[\]]+ ([a-z_][A-Za-z0-9_]*)\(/,
  file: (body) => `namespace Lib {\n${body}}\n`,
  b: B,
  driver,
  compileLabel: 'valac',
  async buildAndRun(dir, source, drv) {
    const valac = tool('valac', 'A0_VALAC', ['/opt/homebrew/bin/valac']);
    await writeFile(join(dir, 'lib.vala'), source, 'utf8');
    await writeFile(join(dir, 'driver.vala'), drv, 'utf8');
    const exe = join(dir, 'prog');
    const build = runTool(
      valac,
      ['-X', '-O0', '-X', '-w', '-o', exe, join(dir, 'lib.vala'), join(dir, 'driver.vala')],
      { cwd: dir, timeoutMs: BUILD_MS },
    );
    if (!build.ok) return failure('valac', build);
    const run = runTool(exe, [], { cwd: dir, timeoutMs: RUN_MS });
    if (!run.ok) return failure('run', run);
    return { stdout: run.stdout };
  },
};
