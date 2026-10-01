/**
 * Nim: u32 values are uint32 (unsigned arithmetic wraps without overflow checks, unsigned
 * compares); u32x4 arrays are openArray[uint32], records are tuples. The candidate is lib.nim,
 * checked on its own and then built with the generated driver using nim c.
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

function literal(v: Value, t: Type | undefined): string {
  if (typeof v === 'number') return `${v}'u32`;
  if (typeof v === 'boolean') return String(v);
  const fields = recordFields(t);
  const items = Array.from(v as ArrayLike<Value>, (x, i) => literal(x, fields[i])).join(', ');
  return fields.length > 0 ? `(${items})` : `[${items}]`;
}

function render(expr: string, t: Type | undefined): string {
  const fields = recordFields(t);
  if (fields.length === 2)
    return `"[" & ${render(`${expr}[0]`, fields[0])} & "," & ${render(`${expr}[1]`, fields[1])} & "]"`;
  return `$(${expr})`;
}

function driver(tests: readonly LangCase[], typed: Parameters<LangSpec['driver']>[1]): string {
  const body = tests
    .map((t, i) => {
      const { params, result } = signature(typed, t.fn);
      const args = t.args.map((a, k) => literal(a, params[k])).join(', ');
      return `let v${i} = ${t.fn}(${args})\necho "R${i} " & ${render(`v${i}`, result)}`;
    })
    .join('\n');
  return `import lib\n${body}\necho "DONE"\n`;
}

const loop4 = (step: string): string => `  for i in 0 ..< 4:\n    ${step}\n`;

const B: LangSpec['b'] = {
  'b-fits-inclusive': {
    source: 'proc fits*(a, b: uint32): bool =\n  a < b\n',
    reference: 'proc fits*(a, b: uint32): bool =\n  a <= b\n',
  },
  'b-sumfrom-eight': {
    source:
      'proc sumfrom*(x: uint32): uint32 =\n  var s = x\n  for i in 0 ..< 5:\n    s += uint32(i)\n  s\n',
    reference:
      'proc sumfrom*(x: uint32): uint32 =\n  var s = x\n  for i in 0 ..< 8:\n    s += uint32(i)\n  s\n',
  },
  'b-rot8-constant': {
    source: 'proc rot8*(x: uint32): uint32 =\n  (x shl 8) or (x shr 23)\n',
    reference: 'proc rot8*(x: uint32): uint32 =\n  (x shl 8) or (x shr 24)\n',
  },
  'b-onlyone-xor': {
    source: 'proc onlyone*(a, b: bool): bool =\n  a or b\n',
    reference: 'proc onlyone*(a, b: bool): bool =\n  a != b\n',
  },
  'b-avgfloor-nowrap': {
    source: 'proc avgfloor*(a, b: uint32): uint32 =\n  (a + b) shr 1\n',
    reference: 'proc avgfloor*(a, b: uint32): uint32 =\n  (a and b) + ((a xor b) shr 1)\n',
  },
  'b-sumsq-array': {
    source: `proc sumsq*(a: openArray[uint32]): uint32 =\n  var s = 0'u32\n${loop4('s += a[i]')}  s\n`,
    reference: `proc sumsq*(a: openArray[uint32]): uint32 =\n  var s = 0'u32\n${loop4('s += a[i] * a[i]')}  s\n`,
  },
  'b-inrange-inclusive': {
    source: 'proc inrange*(x, lo, hi: uint32): bool =\n  x > lo and x < hi\n',
    reference: 'proc inrange*(x, lo, hi: uint32): bool =\n  x >= lo and x <= hi\n',
  },
  'b-bounds-largest': {
    source:
      "proc bounds*(a: openArray[uint32]): (uint32, uint32) =\n  var lo = 4294967295'u32\n  var hi = 0'u32\n  for i in 0 ..< 4:\n    let x = a[i]\n    if x < lo: lo = x\n    if x < hi: hi = x\n  (lo, hi)\n",
    reference:
      "proc bounds*(a: openArray[uint32]): (uint32, uint32) =\n  var lo = 4294967295'u32\n  var hi = 0'u32\n  for i in 0 ..< 4:\n    let x = a[i]\n    if x < lo: lo = x\n    if x > hi: hi = x\n  (lo, hi)\n",
  },
  'b-checksum-poly': {
    source: `proc checksum*(a: openArray[uint32]): uint32 =\n  var h = 0'u32\n${loop4('h = h xor a[i]')}  h\n`,
    reference: `proc checksum*(a: openArray[uint32]): uint32 =\n  var h = 7'u32\n${loop4("h = h * 31'u32 + a[i]")}  h\n`,
  },
  'b-norm2-dot': {
    source: `proc dot*(a, b: openArray[uint32]): uint32 =\n  var s = 0'u32\n${loop4('s += a[i] * b[i]')}  s\n`,
    reference: `proc dot*(a, b: openArray[uint32]): uint32 =\n  var s = 0'u32\n${loop4('s += a[i] * b[i]')}  s\nproc norm2*(a: openArray[uint32]): uint32 =\n  dot(a, a)\n`,
  },
  'b-pctof-limit': {
    source:
      'proc limit*(x, lo, hi: uint32): uint32 =\n  let b = if x < lo: lo else: x\n  if b > hi: hi else: b\n',
    reference:
      "proc limit*(x, lo, hi: uint32): uint32 =\n  let b = if x < lo: lo else: x\n  if b > hi: hi else: b\nproc pctof*(part, whole: uint32): uint32 =\n  let n = part * 100'u32\n  let q = if whole == 0'u32: 4294967295'u32 else: n div whole\n  limit(q, 0'u32, 100'u32)\n",
  },
  'b-hamming-popcnt': {
    source:
      "proc popcnt*(x: uint32): uint32 =\n  var s = 0'u32\n  for i in 0 ..< 32:\n    s += (x shr i) and 1'u32\n  s\n",
    reference:
      "proc popcnt*(x: uint32): uint32 =\n  var s = 0'u32\n  for i in 0 ..< 32:\n    s += (x shr i) and 1'u32\n  s\nproc hamming*(a, b: uint32): uint32 =\n  popcnt(a xor b)\n",
  },
};

export const NIM: LangSpec = {
  semantics:
    "Integers are uint32 (wrapping arithmetic, unsigned comparisons, literals like 7'u32); mask shift counts to 5 bits (and 31); records are tuples (uint32, uint32) and u32x4 values are openArray[uint32]. Division by zero must be handled explicitly (4294967295; remainder by zero gives the dividend). Exported procs end in * and the file is lib.nim, imported by the driver (nim c driver.nim).",
  head: /^proc ([a-z_][A-Za-z0-9_]*)\*?[([]/,
  file: (body) => body,
  b: B,
  driver,
  compileLabel: 'nim',
  async buildAndRun(dir, source, drv) {
    const nim = tool('nim', 'A0_NIM', ['/opt/homebrew/bin/nim']);
    await writeFile(join(dir, 'lib.nim'), source, 'utf8');
    await writeFile(join(dir, 'driver.nim'), drv, 'utf8');
    const flags = [
      '--hints:off',
      '--warnings:off',
      '--verbosity:0',
      `--nimcache:${join(dir, 'nimcache')}`,
    ];
    const check = runTool(nim, ['check', ...flags, 'lib.nim'], { cwd: dir, timeoutMs: BUILD_MS });
    if (!check.ok) return failure('nim', check);
    const build = runTool(
      nim,
      ['c', '-d:release', '--opt:speed', ...flags, `-o:${join(dir, 'prog')}`, 'driver.nim'],
      { cwd: dir, timeoutMs: BUILD_MS },
    );
    if (!build.ok) return failure('nim', build);
    const run = runTool(join(dir, 'prog'), [], { cwd: dir, timeoutMs: RUN_MS });
    if (!run.ok) return failure('run', run);
    return { stdout: run.stdout };
  },
};
