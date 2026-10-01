/**
 * OCaml: u32 values are native ints (63-bit) masked with land 0xFFFFFFFF after every
 * operation that can leave the range (sums and products wrap mod 2^63, so the low 32 bits
 * stay exact); records are tuples and u32x4 arrays are int arrays. Built with ocamlopt.
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
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const fields = recordFields(t);
  if (fields.length > 0)
    return `(${Array.from(v as ArrayLike<Value>, (x, i) => literal(x, fields[i])).join(', ')})`;
  return `[|${Array.from(v as ArrayLike<Value>, (x) => literal(x, undefined)).join('; ')}|]`;
}

function render(expr: string, t: Type | undefined, depth = 0): string {
  if (t === 'bool') return `string_of_bool ${expr}`;
  const fields = recordFields(t);
  if (fields.length > 0) {
    const names = fields.map((_, i) => `f${depth}_${i}`);
    const parts = fields.map((ft, i) => `(${render(names[i] ?? '', ft, depth + 1)})`);
    return `(match ${expr} with (${names.join(', ')}) -> "[" ^ ${parts.join(' ^ "," ^ ')} ^ "]")`;
  }
  return `string_of_int ${expr}`;
}

function driver(tests: readonly LangCase[], typed: Parameters<LangSpec['driver']>[1]): string {
  const body = tests
    .map((t, i) => {
      const { params, result } = signature(typed, t.fn);
      const args = t.args.map((a, k) => ` (${literal(a, params[k])})`).join('');
      return `let () = print_endline ("R${i} " ^ ${render(`(Lib.${t.fn}${args})`, result)})`;
    })
    .join('\n');
  return `${body}\nlet () = print_endline "DONE"\n`;
}

const loop4 = (step: string): string => `  for i = 0 to 3 do\n    ${step}\n  done;\n`;

const B: LangSpec['b'] = {
  'b-fits-inclusive': {
    source: 'let fits a b =\n  a < b\n',
    reference: 'let fits a b =\n  a <= b\n',
  },
  'b-sumfrom-eight': {
    source: `let sumfrom x =\n  let s = ref x in\n  for i = 0 to 4 do\n    s := (!s + i) land ${M}\n  done;\n  !s\n`,
    reference: `let sumfrom x =\n  let s = ref x in\n  for i = 0 to 7 do\n    s := (!s + i) land ${M}\n  done;\n  !s\n`,
  },
  'b-rot8-constant': {
    source: `let rot8 x =\n  ((x lsl 8) lor (x lsr 23)) land ${M}\n`,
    reference: `let rot8 x =\n  ((x lsl 8) lor (x lsr 24)) land ${M}\n`,
  },
  'b-onlyone-xor': {
    source: 'let onlyone a b =\n  a || b\n',
    reference: 'let onlyone a b =\n  a <> b\n',
  },
  'b-avgfloor-nowrap': {
    source: `let avgfloor a b =\n  ((a + b) land ${M}) lsr 1\n`,
    reference: 'let avgfloor a b =\n  (a land b) + ((a lxor b) lsr 1)\n',
  },
  'b-sumsq-array': {
    source: `let sumsq a =\n  let s = ref 0 in\n${loop4(`s := (!s + a.(i)) land ${M}`)}  !s\n`,
    reference: `let sumsq a =\n  let s = ref 0 in\n${loop4(`s := (!s + a.(i) * a.(i)) land ${M}`)}  !s\n`,
  },
  'b-inrange-inclusive': {
    source: 'let inrange x lo hi =\n  x > lo && x < hi\n',
    reference: 'let inrange x lo hi =\n  x >= lo && x <= hi\n',
  },
  'b-bounds-largest': {
    source: `let bounds a =\n  let lo = ref ${M} in\n  let hi = ref 0 in\n  for i = 0 to 3 do\n    let x = a.(i) in\n    if x < !lo then lo := x;\n    if x < !hi then hi := x\n  done;\n  (!lo, !hi)\n`,
    reference: `let bounds a =\n  let lo = ref ${M} in\n  let hi = ref 0 in\n  for i = 0 to 3 do\n    let x = a.(i) in\n    if x < !lo then lo := x;\n    if x > !hi then hi := x\n  done;\n  (!lo, !hi)\n`,
  },
  'b-checksum-poly': {
    source: `let checksum a =\n  let h = ref 0 in\n${loop4('h := !h lxor a.(i)')}  !h\n`,
    reference: `let checksum a =\n  let h = ref 7 in\n${loop4(`h := (!h * 31 + a.(i)) land ${M}`)}  !h\n`,
  },
  'b-norm2-dot': {
    source: `let dot a b =\n  let s = ref 0 in\n${loop4(`s := (!s + a.(i) * b.(i)) land ${M}`)}  !s\n`,
    reference: `let dot a b =\n  let s = ref 0 in\n${loop4(`s := (!s + a.(i) * b.(i)) land ${M}`)}  !s\nlet norm2 a =\n  dot a a\n`,
  },
  'b-pctof-limit': {
    source:
      'let limit x lo hi =\n  let b = if x < lo then lo else x in\n  if b > hi then hi else b\n',
    reference: `let limit x lo hi =\n  let b = if x < lo then lo else x in\n  if b > hi then hi else b\nlet pctof part whole =\n  let n = (part * 100) land ${M} in\n  let q = if whole = 0 then ${M} else n / whole in\n  limit q 0 100\n`,
  },
  'b-hamming-popcnt': {
    source: `let popcnt x =\n  let s = ref 0 in\n  for i = 0 to 31 do\n    s := (!s + ((x lsr i) land 1)) land ${M}\n  done;\n  !s\n`,
    reference: `let popcnt x =\n  let s = ref 0 in\n  for i = 0 to 31 do\n    s := (!s + ((x lsr i) land 1)) land ${M}\n  done;\n  !s\nlet hamming a b =\n  popcnt (a lxor b)\n`,
  },
};

const FILLER = `let affine x scale offset =
  (x * scale + offset) land ${M}
let clamp x hi =
  if hi < x then hi else x
let rotl x n =
  ((x lsl (n land 31)) lor (x lsl ((32 - n) land 31))) land ${M}
let sq x =
  (x * x) land ${M}
let quad x =
  sq x
let absdiff a b =
  (a - b) land ${M}
let combine4 a b c d =
  (a + b + c + d) land ${M}
let min2 a b =
  if b < a then b else a
let sumto n =
  let s = ref 0 in
  for i = 0 to n - 1 do
    s := (!s + i) land ${M}
  done;
  !s
let countup limit cap =
  let s = ref 0 in
  let k = ref 0 in
  while !k < cap && !s < limit do
    s := (!s + 1) land ${M};
    incr k
  done;
  !s
let pick r =
  fst r
let byte1 x =
  (x lsr 8) land 0xFF
let sadd a b =
  (a + b) land ${M}
let is_even x =
  x land 1 = 0
let addi acc i =
  (acc + i) land ${M}
let inc s i limit =
  (s + 1) land ${M}
let below s i limit =
  s < limit
let addel acc i a =
  (acc + a.(i mod 4)) land ${M}
let minmax acc i a =
  let (lo, hi) = acc in
  let x = a.(i mod 4) in
  let nlo = if x < lo then x else lo in
  let nhi = if x < hi then x else hi in
  (nlo, nhi)
let mixel acc i a =
  acc lxor a.(i mod 4)
let dstep acc i a b =
  (acc + a.(i mod 4) * b.(i mod 4)) land ${M}
let pstep acc i x =
  (acc + ((x lsr (i land 31)) land 1)) land ${M}
let nb grid r c =
  let row = grid.(r mod 32) in
  (row lsr (c land 31)) land 1
let count grid r c =
  let ru = (r - 1) land ${M} in
  let rd = (r + 1) land ${M} in
  let cl = (c - 1) land ${M} in
  let cr = (c + 1) land ${M} in
  let s = nb grid ru cl in
  let s = (s + nb grid ru c) land ${M} in
  let s = (s + nb grid ru cr) land ${M} in
  let s = (s + nb grid r cl) land ${M} in
  let s = (s + nb grid r cr) land ${M} in
  let s = (s + nb grid rd cl) land ${M} in
  let s = (s + nb grid rd c) land ${M} in
  let s = (s + nb grid rd cr) land ${M} in
  s
let bitstep acc i x =
  (acc + ((x lsr (i land 31)) land 1)) land ${M}
let popcount x =
  let n = ref 0 in
  for i = 0 to 31 do
    n := bitstep !n i x
  done;
  !n
let rowpop acc i grid =
  (acc + popcount grid.(i mod 32)) land ${M}
let population grid =
  let n = ref 0 in
  for i = 0 to 31 do
    n := rowpop !n i grid
  done;
  !n
`;

function fillerText(f: FillerFunction): string {
  const s = f.spec;
  const fn = (params: string, e: string): string => `let ${f.name} ${params} =\n  ${e}\n`;
  switch (s.template) {
    case 'lin':
      return fn('x', `(x * ${s.m} + ${s.c}) land ${M}`);
    case 'xs':
      return fn('x', `x lxor (x lsr ${s.s})`);
    case 'cap':
      return fn('x', `if x < ${s.c} then x else ${s.c}`);
    case 'pair':
      return fn('a b', `((a + b) land ${M}) lxor ${s.c}`);
    case 'sum':
      return fn('x', `(${s.g} x + ${s.h} x) land ${M}`);
    case 'mixin':
      return fn('a b', `(${s.g} a) lxor b`);
  }
}

export const OCAML: LangSpec = {
  semantics: `Integers are unsigned 32-bit values held in native int: mask every arithmetic result with land ${M}, mask shift counts to 5 bits (land 31); comparisons are unsigned; records are tuples and u32x4 values are int arrays (a.(i)). Division by zero gives 4294967295; remainder by zero gives the dividend. The file is lib.ml and must build with ocamlopt lib.ml driver.ml (callers use Lib.name).`,
  head: /^let (?:rec )?([a-z_][A-Za-z0-9_']*)[ =]/,
  file: (body) => body,
  b: B,
  filler: FILLER,
  fillerText,
  driver,
  compileLabel: 'ocamlopt',
  async buildAndRun(dir, source, drv) {
    const ocamlopt = tool('ocamlopt', 'A0_OCAMLOPT', ['/opt/homebrew/bin/ocamlopt']);
    await writeFile(join(dir, 'lib.ml'), source, 'utf8');
    await writeFile(join(dir, 'driver.ml'), drv, 'utf8');
    const build = runTool(ocamlopt, ['-w', '-a', 'lib.ml', 'driver.ml', '-o', 'prog'], {
      cwd: dir,
      timeoutMs: BUILD_MS,
    });
    if (!build.ok) return failure('ocamlopt', build);
    const run = runTool(join(dir, 'prog'), [], { cwd: dir, timeoutMs: RUN_MS });
    if (!run.ok) return failure('run', run);
    return { stdout: run.stdout };
  },
};
