/**
 * V: u32 values are the native u32 type (wrapping arithmetic, unsigned compares); u32x4
 * arrays are [4]u32, records are multiple return values. The candidate is `mod.v` and the
 * driver `main.v`, both `module main` in one directory that `v` compiles as a unit.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Value } from '../../src/core.js';
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
  if (typeof v === 'number') return `u32(${v})`;
  if (typeof v === 'boolean') return String(v);
  return `[${Array.from(v as ArrayLike<Value>, literal).join(', ')}]!`;
}

function driver(tests: readonly LangCase[], typed: Parameters<LangSpec['driver']>[1]): string {
  const body = tests
    .map((t, i) => {
      const args = t.args.map(literal).join(', ');
      const fields = recordFields(signature(typed, t.fn).result);
      if (fields.length > 0) {
        const names = fields.map((_, k) => `r${i}_${k}`);
        const shown = names.map((n) => `\${${n}}`).join(',');
        return `\t${names.join(', ')} := ${t.fn}(${args})\n\tprintln('R${i} [${shown}]')`;
      }
      return `\tr${i} := ${t.fn}(${args})\n\tprintln('R${i} \${r${i}}')`;
    })
    .join('\n');
  return `module main\n\nfn main() {\n${body}\n\tprintln('DONE')\n}\n`;
}

const B: LangSpec['b'] = {
  'b-fits-inclusive': {
    source: 'fn fits(a u32, b u32) bool {\n\treturn a < b\n}\n',
    reference: 'fn fits(a u32, b u32) bool {\n\treturn a <= b\n}\n',
  },
  'b-sumfrom-eight': {
    source:
      'fn sumfrom(x u32) u32 {\n\tmut s := x\n\tfor i in 0 .. 5 {\n\t\ts += u32(i)\n\t}\n\treturn s\n}\n',
    reference:
      'fn sumfrom(x u32) u32 {\n\tmut s := x\n\tfor i in 0 .. 8 {\n\t\ts += u32(i)\n\t}\n\treturn s\n}\n',
  },
  'b-rot8-constant': {
    source: 'fn rot8(x u32) u32 {\n\treturn (x << 8) | (x >> 23)\n}\n',
    reference: 'fn rot8(x u32) u32 {\n\treturn (x << 8) | (x >> 24)\n}\n',
  },
  'b-onlyone-xor': {
    source: 'fn onlyone(a bool, b bool) bool {\n\treturn a || b\n}\n',
    reference: 'fn onlyone(a bool, b bool) bool {\n\treturn a != b\n}\n',
  },
  'b-avgfloor-nowrap': {
    source: 'fn avgfloor(a u32, b u32) u32 {\n\treturn (a + b) >> 1\n}\n',
    reference: 'fn avgfloor(a u32, b u32) u32 {\n\treturn (a & b) + ((a ^ b) >> 1)\n}\n',
  },
  'b-sumsq-array': {
    source:
      'fn sumsq(a [4]u32) u32 {\n\tmut s := u32(0)\n\tfor i in 0 .. 4 {\n\t\ts += a[i % 4]\n\t}\n\treturn s\n}\n',
    reference:
      'fn sumsq(a [4]u32) u32 {\n\tmut s := u32(0)\n\tfor i in 0 .. 4 {\n\t\tx := a[i % 4]\n\t\ts += x * x\n\t}\n\treturn s\n}\n',
  },
  'b-inrange-inclusive': {
    source: 'fn inrange(x u32, lo u32, hi u32) bool {\n\treturn x > lo && x < hi\n}\n',
    reference: 'fn inrange(x u32, lo u32, hi u32) bool {\n\treturn x >= lo && x <= hi\n}\n',
  },
  'b-bounds-largest': {
    source:
      'fn bounds(a [4]u32) (u32, u32) {\n\tmut lo := u32(4294967295)\n\tmut hi := u32(0)\n\tfor i in 0 .. 4 {\n\t\tx := a[i % 4]\n\t\tif x < lo {\n\t\t\tlo = x\n\t\t}\n\t\tif x < hi {\n\t\t\thi = x\n\t\t}\n\t}\n\treturn lo, hi\n}\n',
    reference:
      'fn bounds(a [4]u32) (u32, u32) {\n\tmut lo := u32(4294967295)\n\tmut hi := u32(0)\n\tfor i in 0 .. 4 {\n\t\tx := a[i % 4]\n\t\tif x < lo {\n\t\t\tlo = x\n\t\t}\n\t\tif x > hi {\n\t\t\thi = x\n\t\t}\n\t}\n\treturn lo, hi\n}\n',
  },
  'b-checksum-poly': {
    source:
      'fn checksum(a [4]u32) u32 {\n\tmut h := u32(0)\n\tfor i in 0 .. 4 {\n\t\th = h ^ a[i % 4]\n\t}\n\treturn h\n}\n',
    reference:
      'fn checksum(a [4]u32) u32 {\n\tmut h := u32(7)\n\tfor i in 0 .. 4 {\n\t\th = h * 31 + a[i % 4]\n\t}\n\treturn h\n}\n',
  },
  'b-norm2-dot': {
    source:
      'fn dot(a [4]u32, b [4]u32) u32 {\n\tmut s := u32(0)\n\tfor i in 0 .. 4 {\n\t\ts += a[i % 4] * b[i % 4]\n\t}\n\treturn s\n}\n',
    reference:
      'fn dot(a [4]u32, b [4]u32) u32 {\n\tmut s := u32(0)\n\tfor i in 0 .. 4 {\n\t\ts += a[i % 4] * b[i % 4]\n\t}\n\treturn s\n}\nfn norm2(a [4]u32) u32 {\n\treturn dot(a, a)\n}\n',
  },
  'b-pctof-limit': {
    source:
      'fn limit(x u32, lo u32, hi u32) u32 {\n\tb := if x < lo { lo } else { x }\n\treturn if b > hi { hi } else { b }\n}\n',
    reference:
      'fn limit(x u32, lo u32, hi u32) u32 {\n\tb := if x < lo { lo } else { x }\n\treturn if b > hi { hi } else { b }\n}\nfn pctof(part u32, whole u32) u32 {\n\tn := part * 100\n\tq := if whole == 0 { u32(4294967295) } else { n / whole }\n\treturn limit(q, 0, 100)\n}\n',
  },
  'b-hamming-popcnt': {
    source:
      'fn popcnt(x u32) u32 {\n\tmut s := u32(0)\n\tfor i in 0 .. 32 {\n\t\ts += (x >> u32(i)) & 1\n\t}\n\treturn s\n}\n',
    reference:
      'fn popcnt(x u32) u32 {\n\tmut s := u32(0)\n\tfor i in 0 .. 32 {\n\t\ts += (x >> u32(i)) & 1\n\t}\n\treturn s\n}\nfn hamming(a u32, b u32) u32 {\n\treturn popcnt(a ^ b)\n}\n',
  },
};

export const V: LangSpec = {
  semantics:
    'Integers are u32 (unsigned 32-bit; cast literals as u32(4294967295)): +, -, * wrap modulo 2^32, comparisons are unsigned, shift counts must stay below 32 (mask with & 31). Division by zero gives 4294967295; remainder by zero gives the dividend. u32x4 arrays are [4]u32 and records are multiple return values like (u32, u32). The file is `module main` with plain top-level fn declarations, compiled together with a driver by v.',
  head: /^fn ([a-z_][A-Za-z0-9_]*)\(/,
  file: (body) => `module main\n\n${body}`,
  b: B,
  driver,
  compileLabel: 'v',
  async buildAndRun(dir, source, drv) {
    const v = tool('v', 'A0_V', ['/opt/homebrew/bin/v']);
    const src = join(dir, 'src');
    await mkdir(src, { recursive: true });
    await writeFile(join(src, 'mod.v'), source, 'utf8');
    await writeFile(join(src, 'main.v'), drv, 'utf8');
    const bin = join(dir, 'out');
    const build = runTool(v, ['-o', bin, src], { cwd: dir, timeoutMs: BUILD_MS });
    if (!build.ok) return failure('v', build);
    const run = runTool(bin, [], { cwd: dir, timeoutMs: RUN_MS });
    if (!run.ok) return failure('run', run);
    return { stdout: run.stdout };
  },
};
