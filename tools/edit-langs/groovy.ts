/**
 * Groovy 6: u32 values are long holding 0..4294967295, masked with `& M` after every operation
 * that can leave the range; u32x4 arrays are List<Long>, records are two-element List<Long>.
 * The candidate is a @CompileStatic class Lib of static methods built with groovyc; the driver
 * is a Groovy script run with `groovy -cp` against the compiled classes.
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

function literal(v: Value): string {
  if (typeof v === 'number') return `${v}L`;
  if (typeof v === 'boolean') return String(v);
  return `[${Array.from(v as ArrayLike<Value>, literal).join(', ')}]`;
}

function render(expr: string, t: Type | undefined): string {
  if (recordFields(t).length === 2) return `"[\${${expr}[0]},\${${expr}[1]}]"`;
  return `"\${${expr}}"`;
}

function driver(tests: readonly LangCase[], typed: Parameters<LangSpec['driver']>[1]): string {
  const body = tests
    .map((t, i) => {
      const { result } = signature(typed, t.fn);
      const args = t.args.map(literal).join(', ');
      return `def v${i} = Lib.${t.fn}(${args})\nprintln("R${i} " + ${render(`v${i}`, result)})`;
    })
    .join('\n');
  return `${body}\nprintln('DONE')\n`;
}

const B: LangSpec['b'] = {
  'b-fits-inclusive': {
    source: 'static boolean fits(long a, long b) {\n    return a < b\n}\n',
    reference: 'static boolean fits(long a, long b) {\n    return a <= b\n}\n',
  },
  'b-sumfrom-eight': {
    source:
      'static long sumfrom(long x) {\n    long s = x\n    for (long i = 0; i < 5; i++) {\n        s = (s + i) & M\n    }\n    return s\n}\n',
    reference:
      'static long sumfrom(long x) {\n    long s = x\n    for (long i = 0; i < 8; i++) {\n        s = (s + i) & M\n    }\n    return s\n}\n',
  },
  'b-rot8-constant': {
    source: 'static long rot8(long x) {\n    return ((x << 8) | (x >>> 23)) & M\n}\n',
    reference: 'static long rot8(long x) {\n    return ((x << 8) | (x >>> 24)) & M\n}\n',
  },
  'b-onlyone-xor': {
    source: 'static boolean onlyone(boolean a, boolean b) {\n    return a || b\n}\n',
    reference: 'static boolean onlyone(boolean a, boolean b) {\n    return a != b\n}\n',
  },
  'b-avgfloor-nowrap': {
    source: 'static long avgfloor(long a, long b) {\n    return ((a + b) & M) >>> 1\n}\n',
    reference:
      'static long avgfloor(long a, long b) {\n    return (((a ^ b) >>> 1) + (a & b)) & M\n}\n',
  },
  'b-sumsq-array': {
    source:
      'static long sumsq(List<Long> a) {\n    long s = 0\n    for (int i = 0; i < 4; i++) {\n        s = (s + a[i % 4]) & M\n    }\n    return s\n}\n',
    reference:
      'static long sumsq(List<Long> a) {\n    long s = 0\n    for (int i = 0; i < 4; i++) {\n        long x = a[i % 4]\n        s = (s + x * x) & M\n    }\n    return s\n}\n',
  },
  'b-inrange-inclusive': {
    source: 'static boolean inrange(long x, long lo, long hi) {\n    return x > lo && x < hi\n}\n',
    reference:
      'static boolean inrange(long x, long lo, long hi) {\n    return x >= lo && x <= hi\n}\n',
  },
  'b-bounds-largest': {
    source:
      'static List<Long> bounds(List<Long> a) {\n    long lo = 0xFFFFFFFFL\n    long hi = 0\n    for (int i = 0; i < 4; i++) {\n        long x = a[i % 4]\n        if (x < lo) lo = x\n        if (x < hi) hi = x\n    }\n    return [lo, hi]\n}\n',
    reference:
      'static List<Long> bounds(List<Long> a) {\n    long lo = 0xFFFFFFFFL\n    long hi = 0\n    for (int i = 0; i < 4; i++) {\n        long x = a[i % 4]\n        if (x < lo) lo = x\n        if (x > hi) hi = x\n    }\n    return [lo, hi]\n}\n',
  },
  'b-checksum-poly': {
    source:
      'static long checksum(List<Long> a) {\n    long h = 0\n    for (int i = 0; i < 4; i++) {\n        h = (h ^ a[i % 4]) & M\n    }\n    return h\n}\n',
    reference:
      'static long checksum(List<Long> a) {\n    long h = 7\n    for (int i = 0; i < 4; i++) {\n        h = (h * 31 + a[i % 4]) & M\n    }\n    return h\n}\n',
  },
  'b-norm2-dot': {
    source:
      'static long dot(List<Long> a, List<Long> b) {\n    long s = 0\n    for (int i = 0; i < 4; i++) {\n        s = (s + a[i % 4] * b[i % 4]) & M\n    }\n    return s\n}\n',
    reference:
      'static long dot(List<Long> a, List<Long> b) {\n    long s = 0\n    for (int i = 0; i < 4; i++) {\n        s = (s + a[i % 4] * b[i % 4]) & M\n    }\n    return s\n}\nstatic long norm2(List<Long> a) {\n    return dot(a, a)\n}\n',
  },
  'b-pctof-limit': {
    source:
      'static long limit(long x, long lo, long hi) {\n    long b = x < lo ? lo : x\n    return b > hi ? hi : b\n}\n',
    reference:
      'static long limit(long x, long lo, long hi) {\n    long b = x < lo ? lo : x\n    return b > hi ? hi : b\n}\nstatic long pctof(long part, long whole) {\n    long n = (part * 100) & M\n    long q = whole == 0 ? 0xFFFFFFFFL : Math.floorDiv(n, whole)\n    return limit(q, 0, 100)\n}\n',
  },
  'b-hamming-popcnt': {
    source:
      'static long popcnt(long x) {\n    long s = 0\n    for (int i = 0; i < 32; i++) {\n        s = (s + ((x >>> i) & 1)) & M\n    }\n    return s\n}\n',
    reference:
      'static long popcnt(long x) {\n    long s = 0\n    for (int i = 0; i < 32; i++) {\n        s = (s + ((x >>> i) & 1)) & M\n    }\n    return s\n}\nstatic long hamming(long a, long b) {\n    return popcnt((a ^ b) & M)\n}\n',
  },
};

/** JAVA_HOME for groovy, which would otherwise pick the macOS java stub. */
function javaHome(java: string): string {
  const home = dirname(dirname(java));
  const brewHome = join(home, 'libexec', 'openjdk.jdk', 'Contents', 'Home');
  return existsSync(brewHome) ? brewHome : home;
}

export const GROOVY: LangSpec = {
  semantics:
    'Integers are long values holding an unsigned 32-bit number (0..4294967295, literals may need the L suffix); mask with `& M` (M = 0xFFFFFFFFL, already defined) after every +, -, *, <<, ~ that can leave the range, and use >>> for right shifts, so arithmetic wraps modulo 2^32 and comparisons are unsigned. Division by zero gives 4294967295; remainder by zero gives the dividend; use Math.floorDiv for integer division, never / (it yields BigDecimal). u32x4 arrays are List<Long> and records are two-element List<Long>. Functions are static methods of a @CompileStatic class Lib (the file wrapper adds it); the file is compiled by groovyc and a driver script calls Lib.name(...).',
  head: /^static (?:long|boolean|List<Long>) ([a-z_][A-Za-z0-9_]*)\(/,
  file: (body) =>
    `import groovy.transform.CompileStatic\n\n@CompileStatic\nclass Lib {\n    static final long M = 0xFFFFFFFFL\n\n${body
      .split('\n')
      .map((l) => (l.length > 0 ? `    ${l}` : l))
      .join('\n')}}\n`,
  b: B,
  driver,
  compileLabel: 'groovy',
  async buildAndRun(dir, source, drv) {
    const groovyc = tool('groovyc', 'A0_GROOVYC', ['/opt/homebrew/bin/groovyc']);
    const groovy = tool('groovy', 'A0_GROOVY', ['/opt/homebrew/bin/groovy']);
    const java = findJava().path;
    if (java === undefined) return { error: 'groovy: java not found (set A0_JAVA)' };
    await writeFile(join(dir, 'Lib.groovy'), source, 'utf8');
    await writeFile(join(dir, 'driver.groovy'), drv, 'utf8');
    const env = { ...process.env, JAVA_HOME: javaHome(java) };
    const classes = join(dir, 'classes');
    const build = runTool(groovyc, ['-d', classes, join(dir, 'Lib.groovy')], {
      cwd: dir,
      env,
      timeoutMs: BUILD_MS,
    });
    if (!build.ok) return failure('groovy', build);
    const run = runTool(groovy, ['-cp', classes, join(dir, 'driver.groovy')], {
      cwd: dir,
      env,
      timeoutMs: RUN_MS,
    });
    if (!run.ok) return failure('run', run);
    return { stdout: run.stdout };
  },
};
