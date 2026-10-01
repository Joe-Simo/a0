/**
 * Gleam (Erlang target, no dependencies): u32 values are Ints (Erlang bignums, exact) masked
 * with band(x, m) after every operation that can leave the range; u32x4 arrays are List(Int)
 * read with at(a, i), records are tuples #(Int, Int). Gleam has no loops, so each loop is a
 * private tail-recursive helper next to its function. gleam_stdlib is not used (it is not
 * fetched offline, as in the exec-bench entry): the bit operations are Erlang externals.
 */

import { mkdir, writeFile } from 'node:fs/promises';
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

const M = '4294967295';

const EXTERNALS = `@external(erlang, "erlang", "band")
fn band(a: Int, b: Int) -> Int
@external(erlang, "erlang", "bor")
fn bor(a: Int, b: Int) -> Int
@external(erlang, "erlang", "bxor")
fn bxor(a: Int, b: Int) -> Int
@external(erlang, "erlang", "bsl")
fn bsl(a: Int, b: Int) -> Int
@external(erlang, "erlang", "bsr")
fn bsr(a: Int, b: Int) -> Int
`;

function literal(v: Value, t: Type | undefined): string {
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  const fields = recordFields(t);
  const items = Array.from(v as ArrayLike<Value>, (x, i) => literal(x, fields[i]));
  return fields.length > 0 ? `#(${items.join(', ')})` : `[${items.join(', ')}]`;
}

function render(expr: string, t: Type | undefined, depth = 0): string {
  if (t === 'bool') return `case ${expr} { True -> "true" False -> "false" }`;
  const fields = recordFields(t);
  if (fields.length > 0) {
    const names = fields.map((_, i) => `f${depth}_${i}`);
    const parts = fields.map((ft, i) => render(names[i] ?? '', ft, depth + 1));
    return `{ let #(${names.join(', ')}) = ${expr}\n    "[" <> ${parts.map((p) => `{ ${p} }`).join(' <> "," <> ')} <> "]" }`;
  }
  return `int_to_binary(${expr})`;
}

function driver(tests: readonly LangCase[], typed: Parameters<LangSpec['driver']>[1]): string {
  const lines = tests.map((t, i) => {
    const { params, result } = signature(typed, t.fn);
    const args = t.args.map((a, k) => literal(a, params[k])).join(', ');
    return `  put("R${i} " <> { ${render(`lib.${t.fn}(${args})`, result)} } <> "\\n")`;
  });
  return `import lib

@external(erlang, "erlang", "integer_to_binary")
fn int_to_binary(i: Int) -> String
@external(erlang, "io", "put_chars")
fn put(s: String) -> Nil

pub fn main() {
${lines.join('\n')}
  put("DONE\\n")
}
`;
}

const B: LangSpec['b'] = {
  'b-fits-inclusive': {
    source: 'pub fn fits(a: Int, b: Int) -> Bool {\n  a < b\n}\n',
    reference: 'pub fn fits(a: Int, b: Int) -> Bool {\n  a <= b\n}\n',
  },
  'b-sumfrom-eight': {
    source: `pub fn sumfrom(x: Int) -> Int {\n  sumfrom_loop(0, x)\n}\nfn sumfrom_loop(i: Int, s: Int) -> Int {\n  case i < 5 {\n    True -> sumfrom_loop(i + 1, band(s + i, m))\n    False -> s\n  }\n}\n`,
    reference: `pub fn sumfrom(x: Int) -> Int {\n  sumfrom_loop(0, x)\n}\nfn sumfrom_loop(i: Int, s: Int) -> Int {\n  case i < 8 {\n    True -> sumfrom_loop(i + 1, band(s + i, m))\n    False -> s\n  }\n}\n`,
  },
  'b-rot8-constant': {
    source: 'pub fn rot8(x: Int) -> Int {\n  band(bor(bsl(x, 8), bsr(x, 23)), m)\n}\n',
    reference: 'pub fn rot8(x: Int) -> Int {\n  band(bor(bsl(x, 8), bsr(x, 24)), m)\n}\n',
  },
  'b-onlyone-xor': {
    source: 'pub fn onlyone(a: Bool, b: Bool) -> Bool {\n  a || b\n}\n',
    reference: 'pub fn onlyone(a: Bool, b: Bool) -> Bool {\n  a != b\n}\n',
  },
  'b-avgfloor-nowrap': {
    source: 'pub fn avgfloor(a: Int, b: Int) -> Int {\n  bsr(band(a + b, m), 1)\n}\n',
    reference:
      'pub fn avgfloor(a: Int, b: Int) -> Int {\n  band(band(a, b) + bsr(bxor(a, b), 1), m)\n}\n',
  },
  'b-sumsq-array': {
    source: `pub fn sumsq(a: List(Int)) -> Int {\n  sumsq_loop(a, 0, 0)\n}\nfn sumsq_loop(a: List(Int), i: Int, s: Int) -> Int {\n  case i < 4 {\n    True -> sumsq_loop(a, i + 1, band(s + at(a, i % 4), m))\n    False -> s\n  }\n}\n`,
    reference: `pub fn sumsq(a: List(Int)) -> Int {\n  sumsq_loop(a, 0, 0)\n}\nfn sumsq_loop(a: List(Int), i: Int, s: Int) -> Int {\n  case i < 4 {\n    True -> {\n      let x = at(a, i % 4)\n      sumsq_loop(a, i + 1, band(s + x * x, m))\n    }\n    False -> s\n  }\n}\n`,
  },
  'b-inrange-inclusive': {
    source: 'pub fn inrange(x: Int, lo: Int, hi: Int) -> Bool {\n  x > lo && x < hi\n}\n',
    reference: 'pub fn inrange(x: Int, lo: Int, hi: Int) -> Bool {\n  x >= lo && x <= hi\n}\n',
  },
  'b-bounds-largest': {
    source: `pub fn bounds(a: List(Int)) -> #(Int, Int) {\n  bounds_loop(a, 0, ${M}, 0)\n}\nfn bounds_loop(a: List(Int), i: Int, lo: Int, hi: Int) -> #(Int, Int) {\n  case i < 4 {\n    True -> {\n      let x = at(a, i % 4)\n      let lo = case x < lo { True -> x False -> lo }\n      let hi = case x < hi { True -> x False -> hi }\n      bounds_loop(a, i + 1, lo, hi)\n    }\n    False -> #(lo, hi)\n  }\n}\n`,
    reference: `pub fn bounds(a: List(Int)) -> #(Int, Int) {\n  bounds_loop(a, 0, ${M}, 0)\n}\nfn bounds_loop(a: List(Int), i: Int, lo: Int, hi: Int) -> #(Int, Int) {\n  case i < 4 {\n    True -> {\n      let x = at(a, i % 4)\n      let lo = case x < lo { True -> x False -> lo }\n      let hi = case x > hi { True -> x False -> hi }\n      bounds_loop(a, i + 1, lo, hi)\n    }\n    False -> #(lo, hi)\n  }\n}\n`,
  },
  'b-checksum-poly': {
    source: `pub fn checksum(a: List(Int)) -> Int {\n  checksum_loop(a, 0, 0)\n}\nfn checksum_loop(a: List(Int), i: Int, h: Int) -> Int {\n  case i < 4 {\n    True -> checksum_loop(a, i + 1, bxor(h, at(a, i % 4)))\n    False -> h\n  }\n}\n`,
    reference: `pub fn checksum(a: List(Int)) -> Int {\n  checksum_loop(a, 0, 7)\n}\nfn checksum_loop(a: List(Int), i: Int, h: Int) -> Int {\n  case i < 4 {\n    True -> checksum_loop(a, i + 1, band(h * 31 + at(a, i % 4), m))\n    False -> h\n  }\n}\n`,
  },
  'b-norm2-dot': {
    source: `pub fn dot(a: List(Int), b: List(Int)) -> Int {\n  dot_loop(a, b, 0, 0)\n}\nfn dot_loop(a: List(Int), b: List(Int), i: Int, s: Int) -> Int {\n  case i < 4 {\n    True -> dot_loop(a, b, i + 1, band(s + at(a, i % 4) * at(b, i % 4), m))\n    False -> s\n  }\n}\n`,
    reference: `pub fn dot(a: List(Int), b: List(Int)) -> Int {\n  dot_loop(a, b, 0, 0)\n}\nfn dot_loop(a: List(Int), b: List(Int), i: Int, s: Int) -> Int {\n  case i < 4 {\n    True -> dot_loop(a, b, i + 1, band(s + at(a, i % 4) * at(b, i % 4), m))\n    False -> s\n  }\n}\npub fn norm2(a: List(Int)) -> Int {\n  dot(a, a)\n}\n`,
  },
  'b-pctof-limit': {
    source:
      'pub fn limit(x: Int, lo: Int, hi: Int) -> Int {\n  let b = case x < lo { True -> lo False -> x }\n  case b > hi { True -> hi False -> b }\n}\n',
    reference: `pub fn limit(x: Int, lo: Int, hi: Int) -> Int {\n  let b = case x < lo { True -> lo False -> x }\n  case b > hi { True -> hi False -> b }\n}\npub fn pctof(part: Int, whole: Int) -> Int {\n  let n = band(part * 100, m)\n  let q = case whole == 0 { True -> ${M} False -> n / whole }\n  limit(q, 0, 100)\n}\n`,
  },
  'b-hamming-popcnt': {
    source: `pub fn popcnt(x: Int) -> Int {\n  popcnt_loop(x, 0, 0)\n}\nfn popcnt_loop(x: Int, i: Int, s: Int) -> Int {\n  case i < 32 {\n    True -> popcnt_loop(x, i + 1, band(s + band(bsr(x, i), 1), m))\n    False -> s\n  }\n}\n`,
    reference: `pub fn popcnt(x: Int) -> Int {\n  popcnt_loop(x, 0, 0)\n}\nfn popcnt_loop(x: Int, i: Int, s: Int) -> Int {\n  case i < 32 {\n    True -> popcnt_loop(x, i + 1, band(s + band(bsr(x, i), 1), m))\n    False -> s\n  }\n}\npub fn hamming(a: Int, b: Int) -> Int {\n  popcnt(bxor(a, b))\n}\n`,
  },
};

export const GLEAM: LangSpec = {
  semantics: `Integers are unsigned 32-bit values held in Gleam Ints (exact bignums on the Erlang target): mask every arithmetic result with band(x, m) (m = ${M}); band, bor, bxor, bsl, bsr are provided; mask shift counts to 5 bits when needed; comparisons are plain Int comparisons; Gleam Int division by zero gives 0, so handle it explicitly. u32x4 values are List(Int) (use at(a, i)), records are tuples #(Int, Int), loops are tail-recursive functions. The file is src/lib.gleam (no dependencies) and must build with gleam build; callers use lib.name.`,
  head: /^(?:pub )?fn ([a-z_][a-z0-9_]*)\(/,
  file: (body) =>
    `const m = ${M}\n\n${EXTERNALS}\nfn at(l: List(Int), i: Int) -> Int {\n  case l {\n    [] -> 0\n    [h, ..t] -> case i { 0 -> h _ -> at(t, i - 1) }\n  }\n}\n\n${body}`,
  b: B,
  driver,
  compileLabel: 'gleam',
  async buildAndRun(dir, source, drv) {
    const gleam = tool('gleam', 'A0_GLEAM', ['/opt/homebrew/bin/gleam']);
    const erl = tool('erl', 'A0_ERL', ['/opt/homebrew/bin/erl']);
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(
      join(dir, 'gleam.toml'),
      'name = "bench"\nversion = "0.0.0"\ntarget = "erlang"\n\n[dependencies]\n\n[dev-dependencies]\n',
      'utf8',
    );
    await writeFile(join(dir, 'src', 'lib.gleam'), source, 'utf8');
    await writeFile(join(dir, 'src', 'driver.gleam'), drv, 'utf8');
    const build = runTool(gleam, ['build', '--target', 'erlang'], {
      cwd: dir,
      timeoutMs: BUILD_MS,
    });
    if (!build.ok) return failure('gleam', build);
    const run = runTool(
      erl,
      [
        '-noshell',
        '-pa',
        join(dir, 'build', 'dev', 'erlang', 'bench', 'ebin'),
        '-s',
        'driver',
        'main',
        '-s',
        'init',
        'stop',
      ],
      { cwd: dir, timeoutMs: RUN_MS },
    );
    if (!run.ok) return failure('run', run);
    return { stdout: run.stdout };
  },
};
