/**
 * Elixir: u32 values are integers masked with band(x, 0xFFFFFFFF) after every operation that
 * can leave the range; records and u32x4 arrays are tuples read with elem. The module Lib is
 * compiled with elixirc, the driver runs with elixir -pa.
 */

import { mkdir, writeFile } from 'node:fs/promises';
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
  return `{${Array.from(v as ArrayLike<Value>, (x, i) => literal(x, fields[i])).join(', ')}}`;
}

function render(expr: string, t: Type | undefined): string {
  if (t === 'bool') return `fb(${expr})`;
  const fields = recordFields(t);
  if (fields.length > 0)
    return `"[" <> ${fields.map((ft, i) => render(`elem(${expr}, ${i})`, ft)).join(' <> "," <> ')} <> "]"`;
  return `fu(${expr})`;
}

function driver(tests: readonly LangCase[], typed: Parameters<LangSpec['driver']>[1]): string {
  const body = tests
    .map((t, i) => {
      const { params, result } = signature(typed, t.fn);
      const args = t.args.map((a, k) => literal(a, params[k])).join(', ');
      return `    v = Lib.${t.fn}(${args})\n    IO.puts("R${i} " <> ${render('v', result)})`;
    })
    .join('\n');
  return `defmodule Driver do\n  def fu(v) when is_integer(v) and v >= 0 and v <= ${M}, do: Integer.to_string(v)\n  def fu(v), do: inspect(v)\n  def fb(true), do: "true"\n  def fb(false), do: "false"\n  def fb(v), do: inspect(v)\n\n  def main do\n${body}\n    IO.puts("DONE")\n  end\nend\n\nDriver.main()\n`;
}

const loop4 = (step: string): string => `  Enum.reduce(0..3, s, fn i, s ->\n    ${step}\n  end)\n`;

const B: LangSpec['b'] = {
  'b-fits-inclusive': {
    source: 'def fits(a, b) do\n  a < b\nend\n',
    reference: 'def fits(a, b) do\n  a <= b\nend\n',
  },
  'b-sumfrom-eight': {
    source: `def sumfrom(x) do\n  Enum.reduce(0..4, x, fn i, s ->\n    band(s + i, ${M})\n  end)\nend\n`,
    reference: `def sumfrom(x) do\n  Enum.reduce(0..7, x, fn i, s ->\n    band(s + i, ${M})\n  end)\nend\n`,
  },
  'b-rot8-constant': {
    source: `def rot8(x) do\n  band(bor(bsl(x, 8), bsr(x, 23)), ${M})\nend\n`,
    reference: `def rot8(x) do\n  band(bor(bsl(x, 8), bsr(x, 24)), ${M})\nend\n`,
  },
  'b-onlyone-xor': {
    source: 'def onlyone(a, b) do\n  a or b\nend\n',
    reference: 'def onlyone(a, b) do\n  a != b\nend\n',
  },
  'b-avgfloor-nowrap': {
    source: `def avgfloor(a, b) do\n  bsr(band(a + b, ${M}), 1)\nend\n`,
    reference: 'def avgfloor(a, b) do\n  band(a, b) + bsr(bxor(a, b), 1)\nend\n',
  },
  'b-sumsq-array': {
    source: `def sumsq(a) do\n  s = 0\n${loop4(`band(s + elem(a, i), ${M})`)}end\n`,
    reference: `def sumsq(a) do\n  s = 0\n${loop4(`band(s + elem(a, i) * elem(a, i), ${M})`)}end\n`,
  },
  'b-inrange-inclusive': {
    source: 'def inrange(x, lo, hi) do\n  x > lo and x < hi\nend\n',
    reference: 'def inrange(x, lo, hi) do\n  x >= lo and x <= hi\nend\n',
  },
  'b-bounds-largest': {
    source: `def bounds(a) do\n  Enum.reduce(0..3, {${M}, 0}, fn i, {lo, hi} ->\n    x = elem(a, i)\n    lo = if x < lo, do: x, else: lo\n    hi = if x < hi, do: x, else: hi\n    {lo, hi}\n  end)\nend\n`,
    reference: `def bounds(a) do\n  Enum.reduce(0..3, {${M}, 0}, fn i, {lo, hi} ->\n    x = elem(a, i)\n    lo = if x < lo, do: x, else: lo\n    hi = if x > hi, do: x, else: hi\n    {lo, hi}\n  end)\nend\n`,
  },
  'b-checksum-poly': {
    source:
      'def checksum(a) do\n  Enum.reduce(0..3, 0, fn i, h ->\n    bxor(h, elem(a, i))\n  end)\nend\n',
    reference: `def checksum(a) do\n  Enum.reduce(0..3, 7, fn i, h ->\n    band(h * 31 + elem(a, i), ${M})\n  end)\nend\n`,
  },
  'b-norm2-dot': {
    source: `def dot(a, b) do\n  s = 0\n${loop4(`band(s + elem(a, i) * elem(b, i), ${M})`)}end\n`,
    reference: `def dot(a, b) do\n  s = 0\n${loop4(`band(s + elem(a, i) * elem(b, i), ${M})`)}end\ndef norm2(a) do\n  dot(a, a)\nend\n`,
  },
  'b-pctof-limit': {
    source:
      'def limit(x, lo, hi) do\n  b = if x < lo, do: lo, else: x\n  if b > hi, do: hi, else: b\nend\n',
    reference: `def limit(x, lo, hi) do\n  b = if x < lo, do: lo, else: x\n  if b > hi, do: hi, else: b\nend\ndef pctof(part, whole) do\n  n = band(part * 100, ${M})\n  q = if whole == 0, do: ${M}, else: div(n, whole)\n  limit(q, 0, 100)\nend\n`,
  },
  'b-hamming-popcnt': {
    source: `def popcnt(x) do\n  Enum.reduce(0..31, 0, fn i, s ->\n    band(s + band(bsr(x, i), 1), ${M})\n  end)\nend\n`,
    reference: `def popcnt(x) do\n  Enum.reduce(0..31, 0, fn i, s ->\n    band(s + band(bsr(x, i), 1), ${M})\n  end)\nend\ndef hamming(a, b) do\n  popcnt(bxor(a, b))\nend\n`,
  },
};

const FILLER = `def affine(x, scale, offset) do
  band(x * scale + offset, ${M})
end
def clamp(x, hi) do
  if hi < x, do: hi, else: x
end
def rotl(x, n) do
  band(bor(bsl(x, band(n, 31)), bsl(x, band(32 - n, 31))), ${M})
end
def sq(x) do
  band(x * x, ${M})
end
def quad(x) do
  sq(x)
end
def absdiff(a, b) do
  band(a - b, ${M})
end
def combine4(a, b, c, d) do
  band(a + b + c + d, ${M})
end
def min2(a, b) do
  if b < a, do: b, else: a
end
def sumto(n) do
  Enum.reduce(0..(n - 1)//1, 0, fn i, s ->
    band(s + i, ${M})
  end)
end
def countup(limit, cap) do
  Enum.reduce_while(0..(cap - 1)//1, 0, fn _, s ->
    if s < limit, do: {:cont, band(s + 1, ${M})}, else: {:halt, s}
  end)
end
def pick(r) do
  elem(r, 0)
end
def byte1(x) do
  band(bsr(x, 8), 0xFF)
end
def sadd(a, b) do
  band(a + b, ${M})
end
def is_even(x) do
  band(x, 1) == 0
end
def addi(acc, i) do
  band(acc + i, ${M})
end
def inc(s, i, limit) do
  band(s + 1, ${M})
end
def below(s, i, limit) do
  s < limit
end
def addel(acc, i, a) do
  band(acc + elem(a, rem(i, 4)), ${M})
end
def minmax(acc, i, a) do
  {lo, hi} = acc
  x = elem(a, rem(i, 4))
  nlo = if x < lo, do: x, else: lo
  nhi = if x < hi, do: x, else: hi
  {nlo, nhi}
end
def mixel(acc, i, a) do
  bxor(acc, elem(a, rem(i, 4)))
end
def dstep(acc, i, a, b) do
  band(acc + elem(a, rem(i, 4)) * elem(b, rem(i, 4)), ${M})
end
def pstep(acc, i, x) do
  band(acc + band(bsr(x, band(i, 31)), 1), ${M})
end
def nb(grid, r, c) do
  row = elem(grid, rem(r, 32))
  band(bsr(row, band(c, 31)), 1)
end
def count(grid, r, c) do
  ru = band(r - 1, ${M})
  rd = band(r + 1, ${M})
  cl = band(c - 1, ${M})
  cr = band(c + 1, ${M})
  s = nb(grid, ru, cl)
  s = band(s + nb(grid, ru, c), ${M})
  s = band(s + nb(grid, ru, cr), ${M})
  s = band(s + nb(grid, r, cl), ${M})
  s = band(s + nb(grid, r, cr), ${M})
  s = band(s + nb(grid, rd, cl), ${M})
  s = band(s + nb(grid, rd, c), ${M})
  s = band(s + nb(grid, rd, cr), ${M})
  s
end
def bitstep(acc, i, x) do
  band(acc + band(bsr(x, band(i, 31)), 1), ${M})
end
def popcount(x) do
  Enum.reduce(0..31, 0, fn i, n -> bitstep(n, i, x) end)
end
def rowpop(acc, i, grid) do
  band(acc + popcount(elem(grid, rem(i, 32))), ${M})
end
def population(grid) do
  Enum.reduce(0..31, 0, fn i, n -> rowpop(n, i, grid) end)
end
`;

function fillerText(f: FillerFunction): string {
  const s = f.spec;
  const fn = (params: string, e: string): string => `def ${f.name}(${params}) do\n  ${e}\nend\n`;
  switch (s.template) {
    case 'lin':
      return fn('x', `band(x * ${s.m} + ${s.c}, ${M})`);
    case 'xs':
      return fn('x', `bxor(x, bsr(x, ${s.s}))`);
    case 'cap':
      return fn('x', `if x < ${s.c}, do: x, else: ${s.c}`);
    case 'pair':
      return fn('a, b', `bxor(band(a + b, ${M}), ${s.c})`);
    case 'sum':
      return fn('x', `band(${s.g}(x) + ${s.h}(x), ${M})`);
    case 'mixin':
      return fn('a, b', `bxor(${s.g}(a), b)`);
  }
}

const indent = (body: string): string =>
  body
    .split('\n')
    .map((l) => (l.length > 0 ? `  ${l}` : l))
    .join('\n');

export const ELIXIR: LangSpec = {
  semantics: `Integers are unsigned 32-bit: mask every arithmetic result with band(x, ${M}), mask shift counts to 5 bits (band(n, 31)); comparisons are unsigned; records and 4-element u32 arrays are tuples read with elem. Division by zero gives 4294967295; remainder by zero gives the dividend. The file is the module Lib (with import Bitwise) and must compile with elixirc.`,
  head: /^def ([a-z_][A-Za-z0-9_]*)\(/,
  file: (body) => `defmodule Lib do\n  import Bitwise\n\n${indent(body)}end\n`,
  b: B,
  filler: FILLER,
  fillerText,
  driver,
  compileLabel: 'elixirc',
  async buildAndRun(dir, source, drv) {
    const elixirc = tool('elixirc', 'A0_ELIXIRC', ['/opt/homebrew/bin/elixirc']);
    const elixir = tool('elixir', 'A0_ELIXIR', ['/opt/homebrew/bin/elixir']);
    const ebin = join(dir, 'ebin');
    await mkdir(ebin, { recursive: true });
    await writeFile(join(dir, 'lib.ex'), source, 'utf8');
    await writeFile(join(dir, 'driver.exs'), drv, 'utf8');
    const build = runTool(elixirc, ['-o', ebin, join(dir, 'lib.ex')], {
      cwd: dir,
      timeoutMs: BUILD_MS,
    });
    if (!build.ok) return failure('elixirc', build);
    const run = runTool(elixir, ['-pa', ebin, join(dir, 'driver.exs')], {
      cwd: dir,
      timeoutMs: RUN_MS,
    });
    if (!run.ok) return failure('run', run);
    return { stdout: run.stdout };
  },
};
