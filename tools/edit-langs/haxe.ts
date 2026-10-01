/**
 * Haxe: u32 values are 32-bit signed Int bit patterns (wrapping + and *, >>> logical shift,
 * unsigned compares through ult/udiv); records and u32x4 arrays are Array<Int>. Type-checked
 * with haxe --no-output, run with the eval interpreter (haxe --run).
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

const HEADER = `class Lib {
  public static inline function ult(a:Int, b:Int):Bool { return (a ^ 0x80000000) < (b ^ 0x80000000); }
  public static function udiv(a:Int, b:Int):Int {
    if (b < 0) return ult(a, b) ? 0 : 1;
    if (a >= 0) return Std.int(a / b);
    var q = Std.int((a >>> 1) / b) << 1;
    var r = a - q * b;
    return ult(r, b) ? q : q + 1;
  }
`;

function literal(v: Value, t: Type | undefined): string {
  if (typeof v === 'number') return `0x${v.toString(16)}`;
  if (typeof v === 'boolean') return String(v);
  const fields = recordFields(t);
  return `[${Array.from(v as ArrayLike<Value>, (x, i) => literal(x, fields[i])).join(', ')}]`;
}

function render(expr: string, t: Type | undefined): string {
  if (t === 'bool') return `Std.string(${expr})`;
  const fields = recordFields(t);
  if (fields.length > 0)
    return `"[" + ${fields.map((ft, i) => render(`${expr}[${i}]`, ft)).join(' + "," + ')} + "]"`;
  return `u(${expr})`;
}

function driver(tests: readonly LangCase[], typed: Parameters<LangSpec['driver']>[1]): string {
  const body = tests
    .map((t, i) => {
      const { params, result } = signature(typed, t.fn);
      const args = t.args.map((a, k) => literal(a, params[k])).join(', ');
      return `    Sys.println("R${i} " + ${render(`Lib.${t.fn}(${args})`, result)});`;
    })
    .join('\n');
  return `class Main {
  static function u(x:Int):String { return x < 0 ? Std.string(x + 4294967296.0) : Std.string(x); }
  static function main() {
${body}
    Sys.println("DONE");
  }
}
`;
}

const B: LangSpec['b'] = {
  'b-fits-inclusive': {
    source: 'public static function fits(a:Int, b:Int):Bool {\n  return ult(a, b);\n}\n',
    reference: 'public static function fits(a:Int, b:Int):Bool {\n  return !ult(b, a);\n}\n',
  },
  'b-sumfrom-eight': {
    source:
      'public static function sumfrom(x:Int):Int {\n  var s = x;\n  for (i in 0...5) {\n    s += i;\n  }\n  return s;\n}\n',
    reference:
      'public static function sumfrom(x:Int):Int {\n  var s = x;\n  for (i in 0...8) {\n    s += i;\n  }\n  return s;\n}\n',
  },
  'b-rot8-constant': {
    source: 'public static function rot8(x:Int):Int {\n  return (x << 8) | (x >>> 23);\n}\n',
    reference: 'public static function rot8(x:Int):Int {\n  return (x << 8) | (x >>> 24);\n}\n',
  },
  'b-onlyone-xor': {
    source: 'public static function onlyone(a:Bool, b:Bool):Bool {\n  return a || b;\n}\n',
    reference: 'public static function onlyone(a:Bool, b:Bool):Bool {\n  return a != b;\n}\n',
  },
  'b-avgfloor-nowrap': {
    source: 'public static function avgfloor(a:Int, b:Int):Int {\n  return (a + b) >>> 1;\n}\n',
    reference:
      'public static function avgfloor(a:Int, b:Int):Int {\n  return (a & b) + ((a ^ b) >>> 1);\n}\n',
  },
  'b-sumsq-array': {
    source:
      'public static function sumsq(a:Array<Int>):Int {\n  var s = 0;\n  for (i in 0...4) {\n    s += a[i];\n  }\n  return s;\n}\n',
    reference:
      'public static function sumsq(a:Array<Int>):Int {\n  var s = 0;\n  for (i in 0...4) {\n    s += a[i] * a[i];\n  }\n  return s;\n}\n',
  },
  'b-inrange-inclusive': {
    source:
      'public static function inrange(x:Int, lo:Int, hi:Int):Bool {\n  return ult(lo, x) && ult(x, hi);\n}\n',
    reference:
      'public static function inrange(x:Int, lo:Int, hi:Int):Bool {\n  return !ult(x, lo) && !ult(hi, x);\n}\n',
  },
  'b-bounds-largest': {
    source:
      'public static function bounds(a:Array<Int>):Array<Int> {\n  var lo = 0xFFFFFFFF;\n  var hi = 0;\n  for (i in 0...4) {\n    var x = a[i];\n    if (ult(x, lo)) lo = x;\n    if (ult(x, hi)) hi = x;\n  }\n  return [lo, hi];\n}\n',
    reference:
      'public static function bounds(a:Array<Int>):Array<Int> {\n  var lo = 0xFFFFFFFF;\n  var hi = 0;\n  for (i in 0...4) {\n    var x = a[i];\n    if (ult(x, lo)) lo = x;\n    if (ult(hi, x)) hi = x;\n  }\n  return [lo, hi];\n}\n',
  },
  'b-checksum-poly': {
    source:
      'public static function checksum(a:Array<Int>):Int {\n  var h = 0;\n  for (i in 0...4) {\n    h ^= a[i];\n  }\n  return h;\n}\n',
    reference:
      'public static function checksum(a:Array<Int>):Int {\n  var h = 7;\n  for (i in 0...4) {\n    h = h * 31 + a[i];\n  }\n  return h;\n}\n',
  },
  'b-norm2-dot': {
    source:
      'public static function dot(a:Array<Int>, b:Array<Int>):Int {\n  var s = 0;\n  for (i in 0...4) {\n    s += a[i] * b[i];\n  }\n  return s;\n}\n',
    reference:
      'public static function dot(a:Array<Int>, b:Array<Int>):Int {\n  var s = 0;\n  for (i in 0...4) {\n    s += a[i] * b[i];\n  }\n  return s;\n}\npublic static function norm2(a:Array<Int>):Int {\n  return dot(a, a);\n}\n',
  },
  'b-pctof-limit': {
    source:
      'public static function limit(x:Int, lo:Int, hi:Int):Int {\n  var b = ult(x, lo) ? lo : x;\n  return ult(hi, b) ? hi : b;\n}\n',
    reference:
      'public static function limit(x:Int, lo:Int, hi:Int):Int {\n  var b = ult(x, lo) ? lo : x;\n  return ult(hi, b) ? hi : b;\n}\npublic static function pctof(part:Int, whole:Int):Int {\n  var n = part * 100;\n  var q = whole == 0 ? 0xFFFFFFFF : udiv(n, whole);\n  return limit(q, 0, 100);\n}\n',
  },
  'b-hamming-popcnt': {
    source:
      'public static function popcnt(x:Int):Int {\n  var s = 0;\n  for (i in 0...32) {\n    s += (x >>> i) & 1;\n  }\n  return s;\n}\n',
    reference:
      'public static function popcnt(x:Int):Int {\n  var s = 0;\n  for (i in 0...32) {\n    s += (x >>> i) & 1;\n  }\n  return s;\n}\npublic static function hamming(a:Int, b:Int):Int {\n  return popcnt(a ^ b);\n}\n',
  },
};

export const HAXE: LangSpec = {
  semantics:
    "Integers are Int, a 32-bit two's-complement bit pattern standing for the u32 value (write 4294967295 as 0xFFFFFFFF): + and * wrap modulo 2^32, use >>> for the logical right shift and mask shift counts to 5 bits (& 31). Int comparison is signed, so use the provided helpers ult(a, b) (unsigned a < b) and udiv(a, b) (unsigned division); other comparisons follow from ult. Division by zero gives 4294967295; remainder by zero gives the dividend. u32x4 arrays and records are Array<Int>. The functions are static methods of class Lib (file Lib.hx) that also holds ult and udiv; the file is type-checked and run by haxe with the eval interpreter.",
  head: /^public static function ([a-z_][A-Za-z0-9_]*)\(/,
  file: (body) => `${HEADER}${body}}\n`,
  b: B,
  driver,
  compileLabel: 'haxe',
  async buildAndRun(dir, source, drv) {
    const haxe = tool('haxe', 'A0_HAXE', ['/opt/homebrew/bin/haxe']);
    await writeFile(join(dir, 'Lib.hx'), source, 'utf8');
    await writeFile(join(dir, 'Main.hx'), drv, 'utf8');
    const check = runTool(haxe, ['-cp', dir, 'Lib', '--no-output'], {
      cwd: dir,
      timeoutMs: BUILD_MS,
    });
    if (!check.ok) return failure('haxe', check);
    const run = runTool(haxe, ['-cp', dir, '--run', 'Main'], { cwd: dir, timeoutMs: RUN_MS });
    if (!run.ok) return failure('run', run);
    return { stdout: run.stdout };
  },
};
