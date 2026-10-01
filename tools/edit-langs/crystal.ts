/**
 * Crystal: u32 values are UInt32 with the wrapping operators (&+, &-, &*); records are
 * Tuple(UInt32, UInt32), u32x4 arrays are Array(UInt32). The candidate file is required by
 * a generated driver and both are built with crystal build.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Type, Value } from '../../src/core.js';
import { runTool } from '../../src/toolchain.js';
import {
  arrayElem,
  BUILD_MS,
  failure,
  type LangCase,
  type LangSpec,
  RUN_MS,
  recordFields,
  signature,
  tool,
} from './spec.js';

function literal(v: Value, t: Type | undefined): string {
  if (typeof v === 'number') return `${v}_u32`;
  if (typeof v === 'boolean') return String(v);
  const fields = recordFields(t);
  const items = Array.from(v as ArrayLike<Value>, (x, i) => literal(x, fields[i])).join(', ');
  return fields.length > 0 ? `{${items}}` : `[${items}]`;
}

function render(expr: string, t: Type | undefined): string {
  const fields = recordFields(t);
  if (fields.length > 0)
    return `"[" + ${fields.map((ft, i) => render(`${expr}[${i}]`, ft)).join(' + "," + ')} + "]"`;
  if (arrayElem(t) !== undefined) return `"[" + ${expr}.join(",") + "]"`;
  return `${expr}.to_s`;
}

function driver(tests: readonly LangCase[], typed: Parameters<LangSpec['driver']>[1]): string {
  const body = tests
    .map((t, i) => {
      const { params, result } = signature(typed, t.fn);
      const args = t.args.map((a, k) => literal(a, params[k])).join(', ');
      return `v${i} = ${t.fn}(${args})\nputs "R${i} " + ${render(`v${i}`, result)}`;
    })
    .join('\n');
  return `require "./mod"\n${body}\nputs "DONE"\n`;
}

const B: LangSpec['b'] = {
  'b-fits-inclusive': {
    source: 'def fits(a : UInt32, b : UInt32) : Bool\n  a < b\nend\n',
    reference: 'def fits(a : UInt32, b : UInt32) : Bool\n  a <= b\nend\n',
  },
  'b-sumfrom-eight': {
    source:
      'def sumfrom(x : UInt32) : UInt32\n  s = x\n  5_u32.times do |i|\n    s = s &+ i\n  end\n  s\nend\n',
    reference:
      'def sumfrom(x : UInt32) : UInt32\n  s = x\n  8_u32.times do |i|\n    s = s &+ i\n  end\n  s\nend\n',
  },
  'b-rot8-constant': {
    source: 'def rot8(x : UInt32) : UInt32\n  (x << 8) | (x >> 23)\nend\n',
    reference: 'def rot8(x : UInt32) : UInt32\n  (x << 8) | (x >> 24)\nend\n',
  },
  'b-onlyone-xor': {
    source: 'def onlyone(a : Bool, b : Bool) : Bool\n  a || b\nend\n',
    reference: 'def onlyone(a : Bool, b : Bool) : Bool\n  a != b\nend\n',
  },
  'b-avgfloor-nowrap': {
    source: 'def avgfloor(a : UInt32, b : UInt32) : UInt32\n  (a &+ b) >> 1\nend\n',
    reference: 'def avgfloor(a : UInt32, b : UInt32) : UInt32\n  (a & b) &+ ((a ^ b) >> 1)\nend\n',
  },
  'b-sumsq-array': {
    source:
      'def sumsq(a : Array(UInt32)) : UInt32\n  s = 0_u32\n  4.times do |i|\n    s = s &+ a[i]\n  end\n  s\nend\n',
    reference:
      'def sumsq(a : Array(UInt32)) : UInt32\n  s = 0_u32\n  4.times do |i|\n    s = s &+ a[i] &* a[i]\n  end\n  s\nend\n',
  },
  'b-inrange-inclusive': {
    source: 'def inrange(x : UInt32, lo : UInt32, hi : UInt32) : Bool\n  x > lo && x < hi\nend\n',
    reference:
      'def inrange(x : UInt32, lo : UInt32, hi : UInt32) : Bool\n  x >= lo && x <= hi\nend\n',
  },
  'b-bounds-largest': {
    source:
      'def bounds(a : Array(UInt32)) : Tuple(UInt32, UInt32)\n  lo = 4294967295_u32\n  hi = 0_u32\n  4.times do |i|\n    x = a[i]\n    lo = x if x < lo\n    hi = x if x < hi\n  end\n  {lo, hi}\nend\n',
    reference:
      'def bounds(a : Array(UInt32)) : Tuple(UInt32, UInt32)\n  lo = 4294967295_u32\n  hi = 0_u32\n  4.times do |i|\n    x = a[i]\n    lo = x if x < lo\n    hi = x if x > hi\n  end\n  {lo, hi}\nend\n',
  },
  'b-checksum-poly': {
    source:
      'def checksum(a : Array(UInt32)) : UInt32\n  h = 0_u32\n  4.times do |i|\n    h = h ^ a[i]\n  end\n  h\nend\n',
    reference:
      'def checksum(a : Array(UInt32)) : UInt32\n  h = 7_u32\n  4.times do |i|\n    h = h &* 31_u32 &+ a[i]\n  end\n  h\nend\n',
  },
  'b-norm2-dot': {
    source:
      'def dot(a : Array(UInt32), b : Array(UInt32)) : UInt32\n  s = 0_u32\n  4.times do |i|\n    s = s &+ a[i] &* b[i]\n  end\n  s\nend\n',
    reference:
      'def dot(a : Array(UInt32), b : Array(UInt32)) : UInt32\n  s = 0_u32\n  4.times do |i|\n    s = s &+ a[i] &* b[i]\n  end\n  s\nend\ndef norm2(a : Array(UInt32)) : UInt32\n  dot(a, a)\nend\n',
  },
  'b-pctof-limit': {
    source:
      'def limit(x : UInt32, lo : UInt32, hi : UInt32) : UInt32\n  b = x < lo ? lo : x\n  b > hi ? hi : b\nend\n',
    reference:
      'def limit(x : UInt32, lo : UInt32, hi : UInt32) : UInt32\n  b = x < lo ? lo : x\n  b > hi ? hi : b\nend\ndef pctof(part : UInt32, whole : UInt32) : UInt32\n  n = part &* 100_u32\n  q = whole == 0_u32 ? 4294967295_u32 : n // whole\n  limit(q, 0_u32, 100_u32)\nend\n',
  },
  'b-hamming-popcnt': {
    source:
      'def popcnt(x : UInt32) : UInt32\n  s = 0_u32\n  32.times do |i|\n    s = s &+ ((x >> i) & 1_u32)\n  end\n  s\nend\n',
    reference:
      'def popcnt(x : UInt32) : UInt32\n  s = 0_u32\n  32.times do |i|\n    s = s &+ ((x >> i) & 1_u32)\n  end\n  s\nend\ndef hamming(a : UInt32, b : UInt32) : UInt32\n  popcnt(a ^ b)\nend\n',
  },
};

export const CRYSTAL: LangSpec = {
  semantics:
    'Integers are UInt32 (literals need the _u32 suffix, e.g. 4294967295_u32): plain + - * raise on overflow, so use the wrapping operators &+ &- &* wherever the value may leave 32 bits; comparisons are unsigned, shifts << >> take an Int count and a count of 32 or more gives 0, and integer division is // (division by zero raises, so handle it: it must give 4294967295). u32x4 arrays are Array(UInt32) and records are Tuple(UInt32, UInt32). Functions are top-level def with typed parameters; the file is required by a driver and both are built with crystal build.',
  head: /^def ([a-z_][A-Za-z0-9_]*)\(/,
  file: (body) => body,
  b: B,
  driver,
  compileLabel: 'crystal',
  async buildAndRun(dir, source, drv) {
    const crystal = tool('crystal', 'A0_CRYSTAL', ['/opt/homebrew/bin/crystal']);
    await writeFile(join(dir, 'mod.cr'), source, 'utf8');
    await writeFile(join(dir, 'driver.cr'), drv, 'utf8');
    const bin = join(dir, 'drv');
    const env = { ...process.env, CRYSTAL_CACHE_DIR: join(dir, 'cache') };
    const build = runTool(crystal, ['build', '--no-debug', '-o', bin, join(dir, 'driver.cr')], {
      cwd: dir,
      timeoutMs: BUILD_MS,
      env,
    });
    if (!build.ok) return failure('crystal', build);
    const run = runTool(bin, [], { cwd: dir, timeoutMs: RUN_MS });
    if (!run.ok) return failure('run', run);
    return { stdout: run.stdout };
  },
};
