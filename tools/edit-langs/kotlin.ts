/**
 * Kotlin: u32 values are UInt (wrapping arithmetic, unsigned compares); u32x4 arrays are
 * List<UInt>, records are Pair. Built with kotlinc into a jar, run with java -jar.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Type, Value } from '../../src/core.js';
import { findJava, runTool } from '../../src/toolchain.js';
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

function literal(v: Value, t: Type | undefined): string {
  if (typeof v === 'number') return `${v}u`;
  if (typeof v === 'boolean') return String(v);
  const fields = recordFields(t);
  const items = Array.from(v as ArrayLike<Value>, (x, i) => literal(x, fields[i])).join(', ');
  return fields.length > 0 ? `Pair(${items})` : `listOf(${items})`;
}

function render(expr: string, t: Type | undefined): string {
  const fields = recordFields(t);
  if (fields.length === 2)
    return `"[" + ${render(`${expr}.first`, fields[0])} + "," + ${render(`${expr}.second`, fields[1])} + "]"`;
  return `${expr}.toString()`;
}

function driver(tests: readonly LangCase[], typed: Parameters<LangSpec['driver']>[1]): string {
  const body = tests
    .map((t, i) => {
      const { params, result } = signature(typed, t.fn);
      const args = t.args.map((a, k) => literal(a, params[k])).join(', ');
      return `    val v${i} = ${t.fn}(${args})\n    println("R${i} " + ${render(`v${i}`, result)})`;
    })
    .join('\n');
  return `fun main() {\n${body}\n    println("DONE")\n}\n`;
}

const B: LangSpec['b'] = {
  'b-fits-inclusive': {
    source: 'fun fits(a: UInt, b: UInt): Boolean {\n    return a < b\n}\n',
    reference: 'fun fits(a: UInt, b: UInt): Boolean {\n    return a <= b\n}\n',
  },
  'b-sumfrom-eight': {
    source:
      'fun sumfrom(x: UInt): UInt {\n    var s = x\n    for (i in 0u until 5u) {\n        s += i\n    }\n    return s\n}\n',
    reference:
      'fun sumfrom(x: UInt): UInt {\n    var s = x\n    for (i in 0u until 8u) {\n        s += i\n    }\n    return s\n}\n',
  },
  'b-rot8-constant': {
    source: 'fun rot8(x: UInt): UInt {\n    return (x shl 8) or (x shr 23)\n}\n',
    reference: 'fun rot8(x: UInt): UInt {\n    return (x shl 8) or (x shr 24)\n}\n',
  },
  'b-onlyone-xor': {
    source: 'fun onlyone(a: Boolean, b: Boolean): Boolean {\n    return a || b\n}\n',
    reference: 'fun onlyone(a: Boolean, b: Boolean): Boolean {\n    return a != b\n}\n',
  },
  'b-avgfloor-nowrap': {
    source: 'fun avgfloor(a: UInt, b: UInt): UInt {\n    return (a + b) shr 1\n}\n',
    reference:
      'fun avgfloor(a: UInt, b: UInt): UInt {\n    return (a and b) + ((a xor b) shr 1)\n}\n',
  },
  'b-sumsq-array': {
    source:
      'fun sumsq(a: List<UInt>): UInt {\n    var s = 0u\n    for (i in 0 until 4) {\n        s += a[i]\n    }\n    return s\n}\n',
    reference:
      'fun sumsq(a: List<UInt>): UInt {\n    var s = 0u\n    for (i in 0 until 4) {\n        s += a[i] * a[i]\n    }\n    return s\n}\n',
  },
  'b-inrange-inclusive': {
    source: 'fun inrange(x: UInt, lo: UInt, hi: UInt): Boolean {\n    return x > lo && x < hi\n}\n',
    reference:
      'fun inrange(x: UInt, lo: UInt, hi: UInt): Boolean {\n    return x >= lo && x <= hi\n}\n',
  },
  'b-bounds-largest': {
    source:
      'fun bounds(a: List<UInt>): Pair<UInt, UInt> {\n    var lo = 4294967295u\n    var hi = 0u\n    for (i in 0 until 4) {\n        val x = a[i]\n        if (x < lo) lo = x\n        if (x < hi) hi = x\n    }\n    return Pair(lo, hi)\n}\n',
    reference:
      'fun bounds(a: List<UInt>): Pair<UInt, UInt> {\n    var lo = 4294967295u\n    var hi = 0u\n    for (i in 0 until 4) {\n        val x = a[i]\n        if (x < lo) lo = x\n        if (x > hi) hi = x\n    }\n    return Pair(lo, hi)\n}\n',
  },
  'b-checksum-poly': {
    source:
      'fun checksum(a: List<UInt>): UInt {\n    var h = 0u\n    for (i in 0 until 4) {\n        h = h xor a[i]\n    }\n    return h\n}\n',
    reference:
      'fun checksum(a: List<UInt>): UInt {\n    var h = 7u\n    for (i in 0 until 4) {\n        h = h * 31u + a[i]\n    }\n    return h\n}\n',
  },
  'b-norm2-dot': {
    source:
      'fun dot(a: List<UInt>, b: List<UInt>): UInt {\n    var s = 0u\n    for (i in 0 until 4) {\n        s += a[i] * b[i]\n    }\n    return s\n}\n',
    reference:
      'fun dot(a: List<UInt>, b: List<UInt>): UInt {\n    var s = 0u\n    for (i in 0 until 4) {\n        s += a[i] * b[i]\n    }\n    return s\n}\nfun norm2(a: List<UInt>): UInt {\n    return dot(a, a)\n}\n',
  },
  'b-pctof-limit': {
    source:
      'fun limit(x: UInt, lo: UInt, hi: UInt): UInt {\n    val b = if (x < lo) lo else x\n    return if (b > hi) hi else b\n}\n',
    reference:
      'fun limit(x: UInt, lo: UInt, hi: UInt): UInt {\n    val b = if (x < lo) lo else x\n    return if (b > hi) hi else b\n}\nfun pctof(part: UInt, whole: UInt): UInt {\n    val n = part * 100u\n    val q = if (whole == 0u) 4294967295u else n / whole\n    return limit(q, 0u, 100u)\n}\n',
  },
  'b-hamming-popcnt': {
    source:
      'fun popcnt(x: UInt): UInt {\n    var s = 0u\n    for (i in 0 until 32) {\n        s += (x shr i) and 1u\n    }\n    return s\n}\n',
    reference:
      'fun popcnt(x: UInt): UInt {\n    var s = 0u\n    for (i in 0 until 32) {\n        s += (x shr i) and 1u\n    }\n    return s\n}\nfun hamming(a: UInt, b: UInt): UInt {\n    return popcnt(a xor b)\n}\n',
  },
};

const FILLER = `fun affine(x: UInt, scale: UInt, offset: UInt): UInt {
    return x * scale + offset
}
fun clamp(x: UInt, hi: UInt): UInt {
    return if (hi < x) hi else x
}
fun rotl(x: UInt, n: UInt): UInt {
    return (x shl (n and 31u).toInt()) or (x shl ((32u - n) and 31u).toInt())
}
fun sq(x: UInt): UInt {
    return x * x
}
fun quad(x: UInt): UInt {
    return sq(x)
}
fun absdiff(a: UInt, b: UInt): UInt {
    return a - b
}
fun combine4(a: UInt, b: UInt, c: UInt, d: UInt): UInt {
    return a + b + c + d
}
fun min2(a: UInt, b: UInt): UInt {
    return if (b < a) b else a
}
fun sumto(n: UInt): UInt {
    var s = 0u
    for (i in 0u until n) {
        s += i
    }
    return s
}
fun countup(limit: UInt, cap: UInt): UInt {
    var s = 0u
    for (k in 0u until cap) {
        if (!(s < limit)) break
        s += 1u
    }
    return s
}
fun pick(r: Pair<UInt, Boolean>): UInt {
    return r.first
}
fun byte1(x: UInt): UInt {
    return (x shr 8) and 0xFFu
}
fun sadd(a: UInt, b: UInt): UInt {
    return a + b
}
fun is_even(x: UInt): Boolean {
    return (x and 1u) == 0u
}
fun addi(acc: UInt, i: UInt): UInt {
    return acc + i
}
fun inc(s: UInt, i: UInt, limit: UInt): UInt {
    return s + 1u
}
fun below(s: UInt, i: UInt, limit: UInt): Boolean {
    return s < limit
}
fun addel(acc: UInt, i: UInt, a: List<UInt>): UInt {
    return acc + a[(i % 4u).toInt()]
}
fun minmax(acc: Pair<UInt, UInt>, i: UInt, a: List<UInt>): Pair<UInt, UInt> {
    val (lo, hi) = acc
    val x = a[(i % 4u).toInt()]
    val nlo = if (x < lo) x else lo
    val nhi = if (x < hi) x else hi
    return Pair(nlo, nhi)
}
fun mixel(acc: UInt, i: UInt, a: List<UInt>): UInt {
    return acc xor a[(i % 4u).toInt()]
}
fun dstep(acc: UInt, i: UInt, a: List<UInt>, b: List<UInt>): UInt {
    return acc + a[(i % 4u).toInt()] * b[(i % 4u).toInt()]
}
fun pstep(acc: UInt, i: UInt, x: UInt): UInt {
    return acc + ((x shr (i and 31u).toInt()) and 1u)
}
fun nb(grid: List<UInt>, r: UInt, c: UInt): UInt {
    val row = grid[(r % 32u).toInt()]
    return (row shr (c and 31u).toInt()) and 1u
}
fun count(grid: List<UInt>, r: UInt, c: UInt): UInt {
    val ru = r - 1u
    val rd = r + 1u
    val cl = c - 1u
    val cr = c + 1u
    var s = nb(grid, ru, cl)
    s += nb(grid, ru, c)
    s += nb(grid, ru, cr)
    s += nb(grid, r, cl)
    s += nb(grid, r, cr)
    s += nb(grid, rd, cl)
    s += nb(grid, rd, c)
    s += nb(grid, rd, cr)
    return s
}
fun bitstep(acc: UInt, i: UInt, x: UInt): UInt {
    return acc + ((x shr (i and 31u).toInt()) and 1u)
}
fun popcount(x: UInt): UInt {
    var n = 0u
    for (i in 0u until 32u) {
        n = bitstep(n, i, x)
    }
    return n
}
fun rowpop(acc: UInt, i: UInt, grid: List<UInt>): UInt {
    return acc + popcount(grid[(i % 32u).toInt()])
}
fun population(grid: List<UInt>): UInt {
    var n = 0u
    for (i in 0u until 32u) {
        n = rowpop(n, i, grid)
    }
    return n
}
`;

function fillerText(f: FillerFunction): string {
  const s = f.spec;
  const fn = (params: string, e: string): string =>
    `fun ${f.name}(${params}): UInt {\n    return ${e}\n}\n`;
  switch (s.template) {
    case 'lin':
      return fn('x: UInt', `x * ${s.m}u + ${s.c}u`);
    case 'xs':
      return fn('x: UInt', `x xor (x shr ${s.s})`);
    case 'cap':
      return fn('x: UInt', `if (x < ${s.c}u) x else ${s.c}u`);
    case 'pair':
      return fn('a: UInt, b: UInt', `(a + b) xor ${s.c}u`);
    case 'sum':
      return fn('x: UInt', `${s.g}(x) + ${s.h}(x)`);
    case 'mixin':
      return fn('a: UInt, b: UInt', `${s.g}(a) xor b`);
  }
}

export const KOTLIN: LangSpec = {
  semantics:
    'Integers are UInt (unsigned 32-bit; literals need the u suffix, e.g. 4294967295u): +, -, * wrap modulo 2^32, comparisons are unsigned, shl/shr take an Int count that is masked to 5 bits. Division by zero gives 4294967295; remainder by zero gives the dividend. u32x4 arrays are List<UInt> and records are Pair. Functions are top-level with no package; the file is compiled together with a driver by kotlinc into a jar and run with java -jar.',
  head: /^fun ([a-z_][A-Za-z0-9_]*)\(/,
  file: (body) => body,
  b: B,
  filler: FILLER,
  fillerText,
  driver,
  compileLabel: 'kotlinc',
  async buildAndRun(dir, source, drv) {
    const kotlinc = tool('kotlinc', 'A0_KOTLINC', ['/opt/homebrew/bin/kotlinc']);
    const java = findJava().path;
    if (java === undefined) return { error: 'kotlinc: java not found (set A0_JAVA)' };
    await writeFile(join(dir, 'lib.kt'), source, 'utf8');
    await writeFile(join(dir, 'driver.kt'), drv, 'utf8');
    const jar = join(dir, 'out.jar');
    const build = runTool(
      kotlinc,
      [join(dir, 'lib.kt'), join(dir, 'driver.kt'), '-include-runtime', '-nowarn', '-d', jar],
      { cwd: dir, timeoutMs: BUILD_MS },
    );
    if (!build.ok) return failure('kotlinc', build);
    const run = runTool(java, ['-jar', jar], { cwd: dir, timeoutMs: RUN_MS });
    if (!run.ok) return failure('run', run);
    return { stdout: run.stdout };
  },
};
