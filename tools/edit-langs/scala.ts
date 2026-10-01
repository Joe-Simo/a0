/**
 * Scala 3: u32 values are Long holding 0..4294967295, masked with `& M` after every operation
 * that can leave the range; u32x4 arrays are Array[Long], records are (Long, Long) tuples.
 * Built with scala-cli into an assembly jar (candidate and driver as separate files), run
 * with java -jar.
 */

import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Type, Value } from '../../src/core.js';
import { findJava, runTool } from '../../src/toolchain.js';
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
  if (typeof v === 'number') return `${v}L`;
  if (typeof v === 'boolean') return String(v);
  const fields = recordFields(t);
  const items = Array.from(v as ArrayLike<Value>, (x, i) => literal(x, fields[i])).join(', ');
  return fields.length > 0 ? `(${items})` : `Array[Long](${items})`;
}

function render(expr: string, t: Type | undefined): string {
  const fields = recordFields(t);
  if (fields.length === 2)
    return `"[" + ${render(`${expr}._1`, fields[0])} + "," + ${render(`${expr}._2`, fields[1])} + "]"`;
  return `${expr}.toString`;
}

function driver(tests: readonly LangCase[], typed: Parameters<LangSpec['driver']>[1]): string {
  const body = tests
    .map((t, i) => {
      const { params, result } = signature(typed, t.fn);
      const args = t.args.map((a, k) => literal(a, params[k])).join(', ');
      return `  val v${i} = ${t.fn}(${args})\n  println("R${i} " + ${render(`v${i}`, result)})`;
    })
    .join('\n');
  return `@main def driver(): Unit =\n${body}\n  println("DONE")\n`;
}

const B: LangSpec['b'] = {
  'b-fits-inclusive': {
    source: 'def fits(a: Long, b: Long): Boolean = {\n  a < b\n}\n',
    reference: 'def fits(a: Long, b: Long): Boolean = {\n  a <= b\n}\n',
  },
  'b-sumfrom-eight': {
    source:
      'def sumfrom(x: Long): Long = {\n  var s = x\n  for (i <- 0 until 5) {\n    s = (s + i) & M\n  }\n  s\n}\n',
    reference:
      'def sumfrom(x: Long): Long = {\n  var s = x\n  for (i <- 0 until 8) {\n    s = (s + i) & M\n  }\n  s\n}\n',
  },
  'b-rot8-constant': {
    source: 'def rot8(x: Long): Long = {\n  ((x << 8) | (x >>> 23)) & M\n}\n',
    reference: 'def rot8(x: Long): Long = {\n  ((x << 8) | (x >>> 24)) & M\n}\n',
  },
  'b-onlyone-xor': {
    source: 'def onlyone(a: Boolean, b: Boolean): Boolean = {\n  a || b\n}\n',
    reference: 'def onlyone(a: Boolean, b: Boolean): Boolean = {\n  a != b\n}\n',
  },
  'b-avgfloor-nowrap': {
    source: 'def avgfloor(a: Long, b: Long): Long = {\n  ((a + b) & M) >>> 1\n}\n',
    reference: 'def avgfloor(a: Long, b: Long): Long = {\n  ((a & b) + ((a ^ b) >>> 1)) & M\n}\n',
  },
  'b-sumsq-array': {
    source:
      'def sumsq(a: Array[Long]): Long = {\n  var s = 0L\n  for (i <- 0 until 4) {\n    s = (s + a(i % 4)) & M\n  }\n  s\n}\n',
    reference:
      'def sumsq(a: Array[Long]): Long = {\n  var s = 0L\n  for (i <- 0 until 4) {\n    val x = a(i % 4)\n    s = (s + x * x) & M\n  }\n  s\n}\n',
  },
  'b-inrange-inclusive': {
    source: 'def inrange(x: Long, lo: Long, hi: Long): Boolean = {\n  x > lo && x < hi\n}\n',
    reference: 'def inrange(x: Long, lo: Long, hi: Long): Boolean = {\n  x >= lo && x <= hi\n}\n',
  },
  'b-bounds-largest': {
    source:
      'def bounds(a: Array[Long]): (Long, Long) = {\n  var lo = 0xFFFFFFFFL\n  var hi = 0L\n  for (i <- 0 until 4) {\n    val x = a(i % 4)\n    if (x < lo) lo = x\n    if (x < hi) hi = x\n  }\n  (lo, hi)\n}\n',
    reference:
      'def bounds(a: Array[Long]): (Long, Long) = {\n  var lo = 0xFFFFFFFFL\n  var hi = 0L\n  for (i <- 0 until 4) {\n    val x = a(i % 4)\n    if (x < lo) lo = x\n    if (x > hi) hi = x\n  }\n  (lo, hi)\n}\n',
  },
  'b-checksum-poly': {
    source:
      'def checksum(a: Array[Long]): Long = {\n  var h = 0L\n  for (i <- 0 until 4) {\n    h = (h ^ a(i % 4)) & M\n  }\n  h\n}\n',
    reference:
      'def checksum(a: Array[Long]): Long = {\n  var h = 7L\n  for (i <- 0 until 4) {\n    h = (h * 31 + a(i % 4)) & M\n  }\n  h\n}\n',
  },
  'b-norm2-dot': {
    source:
      'def dot(a: Array[Long], b: Array[Long]): Long = {\n  var s = 0L\n  for (i <- 0 until 4) {\n    s = (s + a(i % 4) * b(i % 4)) & M\n  }\n  s\n}\n',
    reference:
      'def dot(a: Array[Long], b: Array[Long]): Long = {\n  var s = 0L\n  for (i <- 0 until 4) {\n    s = (s + a(i % 4) * b(i % 4)) & M\n  }\n  s\n}\ndef norm2(a: Array[Long]): Long = {\n  dot(a, a)\n}\n',
  },
  'b-pctof-limit': {
    source:
      'def limit(x: Long, lo: Long, hi: Long): Long = {\n  val b = if (x < lo) lo else x\n  if (b > hi) hi else b\n}\n',
    reference:
      'def limit(x: Long, lo: Long, hi: Long): Long = {\n  val b = if (x < lo) lo else x\n  if (b > hi) hi else b\n}\ndef pctof(part: Long, whole: Long): Long = {\n  val n = (part * 100) & M\n  val q = if (whole == 0) 0xFFFFFFFFL else n / whole\n  limit(q, 0L, 100L)\n}\n',
  },
  'b-hamming-popcnt': {
    source:
      'def popcnt(x: Long): Long = {\n  var s = 0L\n  for (i <- 0 until 32) {\n    s = (s + ((x >>> i) & 1)) & M\n  }\n  s\n}\n',
    reference:
      'def popcnt(x: Long): Long = {\n  var s = 0L\n  for (i <- 0 until 32) {\n    s = (s + ((x >>> i) & 1)) & M\n  }\n  s\n}\ndef hamming(a: Long, b: Long): Long = {\n  popcnt((a ^ b) & M)\n}\n',
  },
};

/** JAVA_HOME for scala-cli, which would otherwise pick the macOS java stub. */
function javaHome(java: string): string {
  const home = dirname(dirname(java));
  const brewHome = join(home, 'libexec', 'openjdk.jdk', 'Contents', 'Home');
  return existsSync(brewHome) ? brewHome : home;
}

export const SCALA: LangSpec = {
  semantics:
    'Integers are Long values holding an unsigned 32-bit number (0..4294967295, literals need the L suffix); mask with `& M` (M = 0xFFFFFFFFL, already defined) after every +, -, *, <<, ~ that can leave the range, and use >>> for right shifts, so arithmetic wraps modulo 2^32 and comparisons are unsigned. Division by zero gives 4294967295; remainder by zero gives the dividend. u32x4 arrays are Array[Long] and records are (Long, Long) tuples. Functions are top-level defs with no package; the file is compiled together with a driver by scala-cli into a jar and run with java -jar.',
  head: /^def ([a-z_][A-Za-z0-9_]*)\(/,
  file: (body) => `val M: Long = 0xFFFFFFFFL\n\n${body}`,
  b: B,
  driver,
  compileLabel: 'scala',
  async buildAndRun(dir, source, drv) {
    const cli = tool('scala-cli', 'A0_SCALA_CLI', ['/opt/homebrew/bin/scala-cli']);
    const java = findJava().path;
    if (java === undefined) return { error: 'scala: java not found (set A0_JAVA)' };
    await writeFile(join(dir, 'lib.scala'), source, 'utf8');
    await writeFile(join(dir, 'driver.scala'), drv, 'utf8');
    const jar = join(dir, 'out.jar');
    const env = { ...process.env, JAVA_HOME: javaHome(java) };
    const build = runTool(
      cli,
      [
        '--power',
        'package',
        join(dir, 'lib.scala'),
        join(dir, 'driver.scala'),
        '--assembly',
        '--server=false',
        '-o',
        jar,
        '-f',
      ],
      { cwd: dir, timeoutMs: BUILD_MS, env },
    );
    if (!build.ok) return failure('scala', build);
    const run = runTool(java, ['-jar', jar], { cwd: dir, timeoutMs: RUN_MS });
    if (!run.ok) return failure('run', run);
    return { stdout: run.stdout };
  },
};
