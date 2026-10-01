/**
 * Swift: u32 values are UInt32 with the wrapping operators &+ &- &*; records are tuples
 * (UInt32, UInt32) and (UInt32, Bool); u32x4 arrays are [UInt32]. Built with swiftc
 * (lib.swift + main.swift into one executable), then run.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Type, Value } from '../../src/core.js';
import { runTool } from '../../src/toolchain.js';
import type { FillerFunction } from '../ai-edit-tasks-c.js';
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

const U = 'UInt32';

function literal(v: Value, t: Type | undefined): string {
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return String(v);
  const fields = recordFields(t);
  const items = Array.from(v as ArrayLike<Value>, (x, i) =>
    literal(x, fields.length > 0 ? fields[i] : arrayElem(t)),
  ).join(', ');
  return fields.length > 0 ? `(${items})` : `[${items}] as [${U}]`;
}

/** String-interpolation content that prints `expr` canonically. */
function render(expr: string, t: Type | undefined): string {
  const fields = recordFields(t);
  if (fields.length > 0) return `[${fields.map((ft, i) => render(`${expr}.${i}`, ft)).join(',')}]`;
  if (arrayElem(t) !== undefined) return `[\\(${expr}.map { String($0) }.joined(separator: ","))]`;
  return `\\(${expr})`;
}

function driver(tests: readonly LangCase[], typed: Parameters<LangSpec['driver']>[1]): string {
  const body = tests
    .map((t, i) => {
      const { params, result } = signature(typed, t.fn);
      const args = t.args.map((a, k) => literal(a, params[k])).join(', ');
      return `do {\n  let v = ${t.fn}(${args})\n  print("R${i} ${render('v', result)}")\n}`;
    })
    .join('\n');
  return `${body}\nprint("DONE")\n`;
}

const B: LangSpec['b'] = {
  'b-fits-inclusive': {
    source: `func fits(_ a: ${U}, _ b: ${U}) -> Bool {\n  return a < b\n}\n`,
    reference: `func fits(_ a: ${U}, _ b: ${U}) -> Bool {\n  return a <= b\n}\n`,
  },
  'b-sumfrom-eight': {
    source: `func sumfrom(_ x: ${U}) -> ${U} {\n  var s = x\n  for i: ${U} in 0..<5 {\n    s = s &+ i\n  }\n  return s\n}\n`,
    reference: `func sumfrom(_ x: ${U}) -> ${U} {\n  var s = x\n  for i: ${U} in 0..<8 {\n    s = s &+ i\n  }\n  return s\n}\n`,
  },
  'b-rot8-constant': {
    source: `func rot8(_ x: ${U}) -> ${U} {\n  return (x << 8) | (x >> 23)\n}\n`,
    reference: `func rot8(_ x: ${U}) -> ${U} {\n  return (x << 8) | (x >> 24)\n}\n`,
  },
  'b-onlyone-xor': {
    source: 'func onlyone(_ a: Bool, _ b: Bool) -> Bool {\n  return a || b\n}\n',
    reference: 'func onlyone(_ a: Bool, _ b: Bool) -> Bool {\n  return a != b\n}\n',
  },
  'b-avgfloor-nowrap': {
    source: `func avgfloor(_ a: ${U}, _ b: ${U}) -> ${U} {\n  return (a &+ b) >> 1\n}\n`,
    reference: `func avgfloor(_ a: ${U}, _ b: ${U}) -> ${U} {\n  return (a & b) &+ ((a ^ b) >> 1)\n}\n`,
  },
  'b-sumsq-array': {
    source: `func sumsq(_ a: [${U}]) -> ${U} {\n  var s: ${U} = 0\n  for i in 0..<4 {\n    s = s &+ a[i]\n  }\n  return s\n}\n`,
    reference: `func sumsq(_ a: [${U}]) -> ${U} {\n  var s: ${U} = 0\n  for i in 0..<4 {\n    s = s &+ a[i] &* a[i]\n  }\n  return s\n}\n`,
  },
  'b-inrange-inclusive': {
    source: `func inrange(_ x: ${U}, _ lo: ${U}, _ hi: ${U}) -> Bool {\n  return x > lo && x < hi\n}\n`,
    reference: `func inrange(_ x: ${U}, _ lo: ${U}, _ hi: ${U}) -> Bool {\n  return x >= lo && x <= hi\n}\n`,
  },
  'b-bounds-largest': {
    source: `func bounds(_ a: [${U}]) -> (${U}, ${U}) {\n  var lo: ${U} = 0xFFFFFFFF\n  var hi: ${U} = 0\n  for i in 0..<4 {\n    let x = a[i]\n    if x < lo {\n      lo = x\n    }\n    if x < hi {\n      hi = x\n    }\n  }\n  return (lo, hi)\n}\n`,
    reference: `func bounds(_ a: [${U}]) -> (${U}, ${U}) {\n  var lo: ${U} = 0xFFFFFFFF\n  var hi: ${U} = 0\n  for i in 0..<4 {\n    let x = a[i]\n    if x < lo {\n      lo = x\n    }\n    if x > hi {\n      hi = x\n    }\n  }\n  return (lo, hi)\n}\n`,
  },
  'b-checksum-poly': {
    source: `func checksum(_ a: [${U}]) -> ${U} {\n  var h: ${U} = 0\n  for i in 0..<4 {\n    h = h ^ a[i]\n  }\n  return h\n}\n`,
    reference: `func checksum(_ a: [${U}]) -> ${U} {\n  var h: ${U} = 7\n  for i in 0..<4 {\n    h = h &* 31 &+ a[i]\n  }\n  return h\n}\n`,
  },
  'b-norm2-dot': {
    source: `func dot(_ a: [${U}], _ b: [${U}]) -> ${U} {\n  var s: ${U} = 0\n  for i in 0..<4 {\n    s = s &+ a[i] &* b[i]\n  }\n  return s\n}\n`,
    reference: `func dot(_ a: [${U}], _ b: [${U}]) -> ${U} {\n  var s: ${U} = 0\n  for i in 0..<4 {\n    s = s &+ a[i] &* b[i]\n  }\n  return s\n}\nfunc norm2(_ a: [${U}]) -> ${U} {\n  return dot(a, a)\n}\n`,
  },
  'b-pctof-limit': {
    source: `func limit(_ x: ${U}, _ lo: ${U}, _ hi: ${U}) -> ${U} {\n  let b = x < lo ? lo : x\n  return b > hi ? hi : b\n}\n`,
    reference: `func limit(_ x: ${U}, _ lo: ${U}, _ hi: ${U}) -> ${U} {\n  let b = x < lo ? lo : x\n  return b > hi ? hi : b\n}\nfunc pctof(_ part: ${U}, _ whole: ${U}) -> ${U} {\n  let n = part &* 100\n  let q: ${U} = whole == 0 ? 0xFFFFFFFF : n / whole\n  return limit(q, 0, 100)\n}\n`,
  },
  'b-hamming-popcnt': {
    source: `func popcnt(_ x: ${U}) -> ${U} {\n  var s: ${U} = 0\n  for i: ${U} in 0..<32 {\n    s = s &+ ((x &>> i) & 1)\n  }\n  return s\n}\n`,
    reference: `func popcnt(_ x: ${U}) -> ${U} {\n  var s: ${U} = 0\n  for i: ${U} in 0..<32 {\n    s = s &+ ((x &>> i) & 1)\n  }\n  return s\n}\nfunc hamming(_ a: ${U}, _ b: ${U}) -> ${U} {\n  return popcnt(a ^ b)\n}\n`,
  },
};

const FILLER = `func affine(_ x: ${U}, _ scale: ${U}, _ offset: ${U}) -> ${U} {
  return x &* scale &+ offset
}
func clamp(_ x: ${U}, _ hi: ${U}) -> ${U} {
  return hi < x ? hi : x
}
func rotl(_ x: ${U}, _ n: ${U}) -> ${U} {
  return (x &<< (n & 31)) | (x &<< ((32 &- n) & 31))
}
func sq(_ x: ${U}) -> ${U} {
  return x &* x
}
func quad(_ x: ${U}) -> ${U} {
  return sq(x)
}
func absdiff(_ a: ${U}, _ b: ${U}) -> ${U} {
  return a &- b
}
func combine4(_ a: ${U}, _ b: ${U}, _ c: ${U}, _ d: ${U}) -> ${U} {
  return a &+ b &+ c &+ d
}
func min2(_ a: ${U}, _ b: ${U}) -> ${U} {
  return b < a ? b : a
}
func sumto(_ n: ${U}) -> ${U} {
  var s: ${U} = 0
  for i in 0..<n {
    s = s &+ i
  }
  return s
}
func countup(_ limit: ${U}, _ cap: ${U}) -> ${U} {
  var s: ${U} = 0
  for _ in 0..<cap {
    if !(s < limit) {
      break
    }
    s = s &+ 1
  }
  return s
}
func pick(_ r: (${U}, Bool)) -> ${U} {
  return r.0
}
func byte1(_ x: ${U}) -> ${U} {
  return (x >> 8) & 0xFF
}
func sadd(_ a: ${U}, _ b: ${U}) -> ${U} {
  return a &+ b
}
func is_even(_ x: ${U}) -> Bool {
  return (x & 1) == 0
}
func addi(_ acc: ${U}, _ i: ${U}) -> ${U} {
  return acc &+ i
}
func inc(_ s: ${U}, _ i: ${U}, _ limit: ${U}) -> ${U} {
  return s &+ 1
}
func below(_ s: ${U}, _ i: ${U}, _ limit: ${U}) -> Bool {
  return s < limit
}
func addel(_ acc: ${U}, _ i: ${U}, _ a: [${U}]) -> ${U} {
  return acc &+ a[Int(i % 4)]
}
func minmax(_ acc: (${U}, ${U}), _ i: ${U}, _ a: [${U}]) -> (${U}, ${U}) {
  let (lo, hi) = acc
  let x = a[Int(i % 4)]
  let nlo = x < lo ? x : lo
  let nhi = x < hi ? x : hi
  return (nlo, nhi)
}
func mixel(_ acc: ${U}, _ i: ${U}, _ a: [${U}]) -> ${U} {
  return acc ^ a[Int(i % 4)]
}
func dstep(_ acc: ${U}, _ i: ${U}, _ a: [${U}], _ b: [${U}]) -> ${U} {
  return acc &+ a[Int(i % 4)] &* b[Int(i % 4)]
}
func pstep(_ acc: ${U}, _ i: ${U}, _ x: ${U}) -> ${U} {
  return acc &+ ((x &>> (i & 31)) & 1)
}
func nb(_ grid: [${U}], _ r: ${U}, _ c: ${U}) -> ${U} {
  let row = grid[Int(r % 32)]
  return (row &>> (c & 31)) & 1
}
func count(_ grid: [${U}], _ r: ${U}, _ c: ${U}) -> ${U} {
  let ru = r &- 1
  let rd = r &+ 1
  let cl = c &- 1
  let cr = c &+ 1
  var s = nb(grid, ru, cl)
  s = s &+ nb(grid, ru, c)
  s = s &+ nb(grid, ru, cr)
  s = s &+ nb(grid, r, cl)
  s = s &+ nb(grid, r, cr)
  s = s &+ nb(grid, rd, cl)
  s = s &+ nb(grid, rd, c)
  s = s &+ nb(grid, rd, cr)
  return s
}
func bitstep(_ acc: ${U}, _ i: ${U}, _ x: ${U}) -> ${U} {
  return acc &+ ((x &>> (i & 31)) & 1)
}
func popcount(_ x: ${U}) -> ${U} {
  var n: ${U} = 0
  for i: ${U} in 0..<32 {
    n = bitstep(n, i, x)
  }
  return n
}
func rowpop(_ acc: ${U}, _ i: ${U}, _ grid: [${U}]) -> ${U} {
  return acc &+ popcount(grid[Int(i % 32)])
}
func population(_ grid: [${U}]) -> ${U} {
  var n: ${U} = 0
  for i: ${U} in 0..<32 {
    n = rowpop(n, i, grid)
  }
  return n
}
`;

function fillerText(f: FillerFunction): string {
  const s = f.spec;
  const x1 = `_ x: ${U}`;
  const x2 = `_ a: ${U}, _ b: ${U}`;
  const fn = (params: string, e: string): string =>
    `func ${f.name}(${params}) -> ${U} {\n  return ${e}\n}\n`;
  switch (s.template) {
    case 'lin':
      return fn(x1, `x &* ${s.m} &+ ${s.c}`);
    case 'xs':
      return fn(x1, `x ^ (x >> ${s.s})`);
    case 'cap':
      return fn(x1, `x < ${s.c} ? x : ${s.c}`);
    case 'pair':
      return fn(x2, `(a &+ b) ^ ${s.c}`);
    case 'sum':
      return fn(x1, `${s.g}(x) &+ ${s.h}(x)`);
    case 'mixin':
      return fn(x2, `${s.g}(a) ^ b`);
  }
}

export const SWIFT: LangSpec = {
  semantics:
    'Integers are UInt32: use the wrapping operators &+ &- &* (plain + - * trap on overflow); comparisons are unsigned; shift counts are masked to 5 bits (&<< and &>> with a count & 31). Division by zero gives 4294967295; remainder by zero gives the dividend. Records are tuples such as (UInt32, UInt32) and (UInt32, Bool); u32x4 values are [UInt32] of length 4, indexed with Int. Functions take unlabeled parameters (_ x: UInt32). The file is compiled with swiftc together with a main.swift driver into one executable.',
  head: /^func ([a-z_][A-Za-z0-9_]*)\(/,
  file: (body) => body,
  b: B,
  filler: FILLER,
  fillerText,
  driver,
  compileLabel: 'swiftc',
  async buildAndRun(dir, source, drv) {
    const swiftc = tool('swiftc', 'A0_SWIFTC', ['/usr/bin/swiftc']);
    const exe = join(dir, 'prog');
    await writeFile(join(dir, 'lib.swift'), source, 'utf8');
    await writeFile(join(dir, 'main.swift'), drv, 'utf8');
    const build = runTool(
      swiftc,
      [
        '-Onone',
        '-module-name',
        'prog',
        join(dir, 'lib.swift'),
        join(dir, 'main.swift'),
        '-o',
        exe,
      ],
      { cwd: dir, timeoutMs: BUILD_MS },
    );
    if (!build.ok) return failure('swiftc', build);
    const run = runTool(exe, [], { cwd: dir, timeoutMs: RUN_MS });
    if (!run.ok) return failure('run', run);
    return { stdout: run.stdout };
  },
};
