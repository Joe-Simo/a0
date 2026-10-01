/**
 * Dart: u32 values are ints (64-bit on the VM) masked with & 0xFFFFFFFF after every operation
 * that can leave the range; records and u32x4 arrays are List<int>. Checked with dart analyze,
 * run with dart run.
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

const M = '0xFFFFFFFF';

function literal(v: Value, t: Type | undefined): string {
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return String(v);
  const fields = recordFields(t);
  return `<int>[${Array.from(v as ArrayLike<Value>, (x, i) => literal(x, fields[i])).join(', ')}]`;
}

function driver(tests: readonly LangCase[], typed: Parameters<LangSpec['driver']>[1]): string {
  const body = tests
    .map((t, i) => {
      const { params } = signature(typed, t.fn);
      const args = t.args.map((a, k) => literal(a, params[k])).join(', ');
      return `  print('R${i} ' + fmt(${t.fn}(${args})));`;
    })
    .join('\n');
  return `import 'lib.dart';\n\nString fmt(Object? v) {\n  if (v is List) return '[' + v.map(fmt).join(',') + ']';\n  return v.toString();\n}\n\nvoid main() {\n${body}\n  print('DONE');\n}\n`;
}

const B: LangSpec['b'] = {
  'b-fits-inclusive': {
    source: 'bool fits(int a, int b) {\n  return a < b;\n}\n',
    reference: 'bool fits(int a, int b) {\n  return a <= b;\n}\n',
  },
  'b-sumfrom-eight': {
    source: `int sumfrom(int x) {\n  var s = x;\n  for (var i = 0; i < 5; i++) {\n    s = (s + i) & ${M};\n  }\n  return s;\n}\n`,
    reference: `int sumfrom(int x) {\n  var s = x;\n  for (var i = 0; i < 8; i++) {\n    s = (s + i) & ${M};\n  }\n  return s;\n}\n`,
  },
  'b-rot8-constant': {
    source: `int rot8(int x) {\n  return ((x << 8) | (x >> 23)) & ${M};\n}\n`,
    reference: `int rot8(int x) {\n  return ((x << 8) | (x >> 24)) & ${M};\n}\n`,
  },
  'b-onlyone-xor': {
    source: 'bool onlyone(bool a, bool b) {\n  return a || b;\n}\n',
    reference: 'bool onlyone(bool a, bool b) {\n  return a != b;\n}\n',
  },
  'b-avgfloor-nowrap': {
    source: `int avgfloor(int a, int b) {\n  return ((a + b) & ${M}) >> 1;\n}\n`,
    reference: 'int avgfloor(int a, int b) {\n  return (a & b) + ((a ^ b) >> 1);\n}\n',
  },
  'b-sumsq-array': {
    source: `int sumsq(List<int> a) {\n  var s = 0;\n  for (var i = 0; i < 4; i++) {\n    s = (s + a[i]) & ${M};\n  }\n  return s;\n}\n`,
    reference: `int sumsq(List<int> a) {\n  var s = 0;\n  for (var i = 0; i < 4; i++) {\n    s = (s + a[i] * a[i]) & ${M};\n  }\n  return s;\n}\n`,
  },
  'b-inrange-inclusive': {
    source: 'bool inrange(int x, int lo, int hi) {\n  return x > lo && x < hi;\n}\n',
    reference: 'bool inrange(int x, int lo, int hi) {\n  return x >= lo && x <= hi;\n}\n',
  },
  'b-bounds-largest': {
    source: `List<int> bounds(List<int> a) {\n  var lo = ${M};\n  var hi = 0;\n  for (var i = 0; i < 4; i++) {\n    final x = a[i];\n    if (x < lo) lo = x;\n    if (x < hi) hi = x;\n  }\n  return [lo, hi];\n}\n`,
    reference: `List<int> bounds(List<int> a) {\n  var lo = ${M};\n  var hi = 0;\n  for (var i = 0; i < 4; i++) {\n    final x = a[i];\n    if (x < lo) lo = x;\n    if (x > hi) hi = x;\n  }\n  return [lo, hi];\n}\n`,
  },
  'b-checksum-poly': {
    source:
      'int checksum(List<int> a) {\n  var h = 0;\n  for (var i = 0; i < 4; i++) {\n    h = h ^ a[i];\n  }\n  return h;\n}\n',
    reference: `int checksum(List<int> a) {\n  var h = 7;\n  for (var i = 0; i < 4; i++) {\n    h = (h * 31 + a[i]) & ${M};\n  }\n  return h;\n}\n`,
  },
  'b-norm2-dot': {
    source: `int dot(List<int> a, List<int> b) {\n  var s = 0;\n  for (var i = 0; i < 4; i++) {\n    s = (s + a[i] * b[i]) & ${M};\n  }\n  return s;\n}\n`,
    reference: `int dot(List<int> a, List<int> b) {\n  var s = 0;\n  for (var i = 0; i < 4; i++) {\n    s = (s + a[i] * b[i]) & ${M};\n  }\n  return s;\n}\nint norm2(List<int> a) {\n  return dot(a, a);\n}\n`,
  },
  'b-pctof-limit': {
    source:
      'int limit(int x, int lo, int hi) {\n  final b = x < lo ? lo : x;\n  return b > hi ? hi : b;\n}\n',
    reference: `int limit(int x, int lo, int hi) {\n  final b = x < lo ? lo : x;\n  return b > hi ? hi : b;\n}\nint pctof(int part, int whole) {\n  final n = (part * 100) & ${M};\n  final q = whole == 0 ? ${M} : n ~/ whole;\n  return limit(q, 0, 100);\n}\n`,
  },
  'b-hamming-popcnt': {
    source:
      'int popcnt(int x) {\n  var s = 0;\n  for (var i = 0; i < 32; i++) {\n    s += (x >> i) & 1;\n  }\n  return s;\n}\n',
    reference:
      'int popcnt(int x) {\n  var s = 0;\n  for (var i = 0; i < 32; i++) {\n    s += (x >> i) & 1;\n  }\n  return s;\n}\nint hamming(int a, int b) {\n  return popcnt(a ^ b);\n}\n',
  },
};

export const DART: LangSpec = {
  semantics:
    'Integers are Dart ints (64-bit on the VM) holding unsigned 32-bit values: mask with & 0xFFFFFFFF after every +, -, *, << that can leave the range; shift counts are masked to 5 bits where needed. Division by zero gives 4294967295; remainder by zero gives the dividend. u32x4 arrays are List<int> and records are List<int> pairs. Functions are top-level in library lib.dart (no imports needed); it is checked with dart analyze and imported by a driver run with dart run.',
  head: /^(?:int|bool|List<int>) ([a-z_][A-Za-z0-9_]*)\(/,
  file: (body) => body,
  b: B,
  driver,
  compileLabel: 'dart',
  async buildAndRun(dir, source, drv) {
    const dart = tool('dart', 'A0_DART', ['/opt/homebrew/bin/dart']);
    await writeFile(join(dir, 'lib.dart'), source, 'utf8');
    await writeFile(join(dir, 'driver.dart'), drv, 'utf8');
    const env = { ...process.env, HOME: dir, DART_SUPPRESS_ANALYTICS: 'true' };
    const check = runTool(dart, ['analyze', join(dir, 'lib.dart')], {
      cwd: dir,
      timeoutMs: BUILD_MS,
      env,
    });
    if (!check.ok) return failure('dart', check);
    const run = runTool(dart, ['run', join(dir, 'driver.dart')], {
      cwd: dir,
      timeoutMs: RUN_MS,
      env,
    });
    if (!run.ok) return failure('run', run);
    return { stdout: run.stdout };
  },
};
