/**
 * Ruby: u32 values are Integers masked with & 0xFFFFFFFF after every operation that can
 * leave the range; records and u32x4 arrays are Arrays. Checked with ruby -c, run with ruby.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Type, Value } from '../../src/core.js';
import { runTool } from '../../src/toolchain.js';
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

const M = '0xFFFFFFFF';

function literal(v: Value, t: Type | undefined): string {
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return String(v);
  const fields = recordFields(t);
  return `[${Array.from(v as ArrayLike<Value>, (x, i) => literal(x, fields[i])).join(', ')}]`;
}

function render(expr: string, t: Type | undefined): string {
  if (t === 'bool') return `fb(${expr})`;
  const fields = recordFields(t);
  if (fields.length > 0)
    return `"[" + ${fields.map((ft, i) => render(`${expr}[${i}]`, ft)).join(' + "," + ')} + "]"`;
  return `fu(${expr})`;
}

function driver(tests: readonly LangCase[], typed: Parameters<LangSpec['driver']>[1]): string {
  const body = tests
    .map((t, i) => {
      const { params, result } = signature(typed, t.fn);
      const args = t.args.map((a, k) => literal(a, params[k])).join(', ');
      return `v = ${t.fn}(${args})\nputs "R${i} " + ${render('v', result)}`;
    })
    .join('\n');
  return `require_relative 'mod'\n\ndef fu(v)\n  v.is_a?(Integer) && v >= 0 && v <= ${M} ? v.to_s : v.inspect\nend\n\ndef fb(v)\n  v == true ? 'true' : v == false ? 'false' : v.inspect\nend\n\n${body}\nputs 'DONE'\n`;
}

const B: LangSpec['b'] = {
  'b-fits-inclusive': {
    source: 'def fits(a, b)\n  a < b\nend\n',
    reference: 'def fits(a, b)\n  a <= b\nend\n',
  },
  'b-sumfrom-eight': {
    source: `def sumfrom(x)\n  s = x\n  (0...5).each do |i|\n    s = (s + i) & ${M}\n  end\n  s\nend\n`,
    reference: `def sumfrom(x)\n  s = x\n  (0...8).each do |i|\n    s = (s + i) & ${M}\n  end\n  s\nend\n`,
  },
  'b-rot8-constant': {
    source: `def rot8(x)\n  ((x << 8) | (x >> 23)) & ${M}\nend\n`,
    reference: `def rot8(x)\n  ((x << 8) | (x >> 24)) & ${M}\nend\n`,
  },
  'b-onlyone-xor': {
    source: 'def onlyone(a, b)\n  a || b\nend\n',
    reference: 'def onlyone(a, b)\n  a != b\nend\n',
  },
  'b-avgfloor-nowrap': {
    source: `def avgfloor(a, b)\n  ((a + b) & ${M}) >> 1\nend\n`,
    reference: 'def avgfloor(a, b)\n  (a & b) + ((a ^ b) >> 1)\nend\n',
  },
  'b-sumsq-array': {
    source: `def sumsq(a)\n  s = 0\n  (0...4).each do |i|\n    s = (s + a[i]) & ${M}\n  end\n  s\nend\n`,
    reference: `def sumsq(a)\n  s = 0\n  (0...4).each do |i|\n    s = (s + a[i] * a[i]) & ${M}\n  end\n  s\nend\n`,
  },
  'b-inrange-inclusive': {
    source: 'def inrange(x, lo, hi)\n  x > lo && x < hi\nend\n',
    reference: 'def inrange(x, lo, hi)\n  x >= lo && x <= hi\nend\n',
  },
  'b-bounds-largest': {
    source: `def bounds(a)\n  lo = ${M}\n  hi = 0\n  (0...4).each do |i|\n    x = a[i]\n    lo = x if x < lo\n    hi = x if x < hi\n  end\n  [lo, hi]\nend\n`,
    reference: `def bounds(a)\n  lo = ${M}\n  hi = 0\n  (0...4).each do |i|\n    x = a[i]\n    lo = x if x < lo\n    hi = x if x > hi\n  end\n  [lo, hi]\nend\n`,
  },
  'b-checksum-poly': {
    source: 'def checksum(a)\n  h = 0\n  (0...4).each do |i|\n    h ^= a[i]\n  end\n  h\nend\n',
    reference: `def checksum(a)\n  h = 7\n  (0...4).each do |i|\n    h = (h * 31 + a[i]) & ${M}\n  end\n  h\nend\n`,
  },
  'b-norm2-dot': {
    source: `def dot(a, b)\n  s = 0\n  (0...4).each do |i|\n    s = (s + a[i] * b[i]) & ${M}\n  end\n  s\nend\n`,
    reference: `def dot(a, b)\n  s = 0\n  (0...4).each do |i|\n    s = (s + a[i] * b[i]) & ${M}\n  end\n  s\nend\ndef norm2(a)\n  dot(a, a)\nend\n`,
  },
  'b-pctof-limit': {
    source: 'def limit(x, lo, hi)\n  b = x < lo ? lo : x\n  b > hi ? hi : b\nend\n',
    reference: `def limit(x, lo, hi)\n  b = x < lo ? lo : x\n  b > hi ? hi : b\nend\ndef pctof(part, whole)\n  n = (part * 100) & ${M}\n  q = whole == 0 ? ${M} : n / whole\n  limit(q, 0, 100)\nend\n`,
  },
  'b-hamming-popcnt': {
    source: `def popcnt(x)\n  s = 0\n  (0...32).each do |i|\n    s = (s + ((x >> i) & 1)) & ${M}\n  end\n  s\nend\n`,
    reference: `def popcnt(x)\n  s = 0\n  (0...32).each do |i|\n    s = (s + ((x >> i) & 1)) & ${M}\n  end\n  s\nend\ndef hamming(a, b)\n  popcnt(a ^ b)\nend\n`,
  },
};

const FILLER = `def affine(x, scale, offset)
  (x * scale + offset) & ${M}
end
def clamp(x, hi)
  hi < x ? hi : x
end
def rotl(x, n)
  ((x << (n & 31)) | (x << ((32 - n) & 31))) & ${M}
end
def sq(x)
  (x * x) & ${M}
end
def quad(x)
  sq(x)
end
def absdiff(a, b)
  (a - b) & ${M}
end
def combine4(a, b, c, d)
  (a + b + c + d) & ${M}
end
def min2(a, b)
  b < a ? b : a
end
def sumto(n)
  s = 0
  (0...n).each do |i|
    s = (s + i) & ${M}
  end
  s
end
def countup(limit, cap)
  s = 0
  cap.times do
    break unless s < limit
    s = (s + 1) & ${M}
  end
  s
end
def pick(r)
  r[0]
end
def byte1(x)
  (x >> 8) & 0xFF
end
def sadd(a, b)
  (a + b) & ${M}
end
def is_even(x)
  (x & 1) == 0
end
def addi(acc, i)
  (acc + i) & ${M}
end
def inc(s, i, limit)
  (s + 1) & ${M}
end
def below(s, i, limit)
  s < limit
end
def addel(acc, i, a)
  (acc + a[i % 4]) & ${M}
end
def minmax(acc, i, a)
  lo, hi = acc
  x = a[i % 4]
  nlo = x < lo ? x : lo
  nhi = x < hi ? x : hi
  [nlo, nhi]
end
def mixel(acc, i, a)
  acc ^ a[i % 4]
end
def dstep(acc, i, a, b)
  (acc + a[i % 4] * b[i % 4]) & ${M}
end
def pstep(acc, i, x)
  (acc + ((x >> (i & 31)) & 1)) & ${M}
end
def nb(grid, r, c)
  row = grid[r % 32]
  (row >> (c & 31)) & 1
end
def count(grid, r, c)
  ru = (r - 1) & ${M}
  rd = (r + 1) & ${M}
  cl = (c - 1) & ${M}
  cr = (c + 1) & ${M}
  s = nb(grid, ru, cl)
  s = (s + nb(grid, ru, c)) & ${M}
  s = (s + nb(grid, ru, cr)) & ${M}
  s = (s + nb(grid, r, cl)) & ${M}
  s = (s + nb(grid, r, cr)) & ${M}
  s = (s + nb(grid, rd, cl)) & ${M}
  s = (s + nb(grid, rd, c)) & ${M}
  s = (s + nb(grid, rd, cr)) & ${M}
  s
end
def bitstep(acc, i, x)
  (acc + ((x >> (i & 31)) & 1)) & ${M}
end
def popcount(x)
  n = 0
  (0...32).each do |i|
    n = bitstep(n, i, x)
  end
  n
end
def rowpop(acc, i, grid)
  (acc + popcount(grid[i % 32])) & ${M}
end
def population(grid)
  n = 0
  (0...32).each do |i|
    n = rowpop(n, i, grid)
  end
  n
end
`;

function fillerText(f: FillerFunction): string {
  const s = f.spec;
  const fn = (params: string, e: string): string => `def ${f.name}(${params})\n  ${e}\nend\n`;
  switch (s.template) {
    case 'lin':
      return fn('x', `(x * ${s.m} + ${s.c}) & ${M}`);
    case 'xs':
      return fn('x', `x ^ (x >> ${s.s})`);
    case 'cap':
      return fn('x', `x < ${s.c} ? x : ${s.c}`);
    case 'pair':
      return fn('a, b', `((a + b) & ${M}) ^ ${s.c}`);
    case 'sum':
      return fn('x', `(${s.g}(x) + ${s.h}(x)) & ${M}`);
    case 'mixin':
      return fn('a, b', `${s.g}(a) ^ b`);
  }
}

export const RUBY: LangSpec = {
  semantics: `Integers are unsigned 32-bit: mask every arithmetic result with & ${M}, mask shift counts to 5 bits (& 31); comparisons are unsigned. Division by zero gives 4294967295; remainder by zero gives the dividend. The file must run with ruby.`,
  head: /^def ([a-z_][A-Za-z0-9_]*)\(/,
  file: (body) => body,
  b: B,
  filler: FILLER,
  fillerText,
  driver,
  compileLabel: 'ruby',
  async buildAndRun(dir, source, drv) {
    const ruby = tool('ruby', 'A0_RUBY', ['/opt/homebrew/opt/ruby/bin/ruby', '/usr/bin/ruby']);
    await writeFile(join(dir, 'mod.rb'), source, 'utf8');
    await writeFile(join(dir, 'driver.rb'), drv, 'utf8');
    const check = runTool(ruby, ['-c', join(dir, 'mod.rb')], { cwd: dir, timeoutMs: BUILD_MS });
    if (!check.ok) return failure('ruby', check);
    const run = runTool(ruby, [join(dir, 'driver.rb')], { cwd: dir, timeoutMs: RUN_MS });
    if (!run.ok) return failure('run', run);
    return { stdout: run.stdout };
  },
};
