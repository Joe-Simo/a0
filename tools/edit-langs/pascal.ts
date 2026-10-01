/**
 * Free Pascal: u32 values are Cardinal with overflow and range checks off ({$Q-}{$R-}), so
 * sums, products and shifts wrap; intermediate results are cast back with Cardinal(...) where
 * the compiler could widen them. Records are U32x2 arrays and u32x4 arrays are U32x4. The
 * candidate is the unit cand (cand.pas), compiled on its own, then used by the driver program.
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

const M = '4294967295';

const U32_TYPES = 'type\n  U32x4 = array[0..3] of Cardinal;\n  U32x2 = array[0..1] of Cardinal;\n';

function literal(v: Value): string {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return `(${Array.from(v as ArrayLike<Value>, literal).join(', ')})`;
}

function render(expr: string, t: Type | undefined): string {
  if (t === 'bool') return `BoolStr(${expr})`;
  const fields = recordFields(t);
  if (fields.length > 0) {
    const parts = fields.map((ft, i) => render(`${expr}[${i}]`, ft));
    return `'[' + ${parts.join(" + ',' + ")} + ']'`;
  }
  return `IntToStr(${expr})`;
}

function driver(tests: readonly LangCase[], typed: Parameters<LangSpec['driver']>[1]): string {
  const consts: string[] = [];
  const lines = tests.map((t, i) => {
    const { result } = signature(typed, t.fn);
    const args = t.args.map((a, k) => {
      if (typeof a === 'number' || typeof a === 'boolean') return String(a);
      const len = (a as ArrayLike<Value>).length;
      const name = `C${i}_${k}`;
      consts.push(`  ${name}: ${len === 2 ? 'U32x2' : 'U32x4'} = ${literal(a)};`);
      return name;
    });
    const call = `${t.fn}(${args.join(', ')})`;
    return `  WriteLn('R${i} ' + ${render(call, result)});`;
  });
  return `program driver;
{$mode objfpc}{$H+}{$Q-}{$R-}
uses SysUtils, cand;
function BoolStr(b: Boolean): string;
begin
  if b then BoolStr := 'true' else BoolStr := 'false';
end;
${consts.length > 0 ? `const\n${consts.join('\n')}\n` : ''}begin
${lines.join('\n')}
  WriteLn('DONE');
end.
`;
}

const loop = (to: number, step: string): string => `  for i := 0 to ${to} do\n    ${step};\n`;

const B: LangSpec['b'] = {
  'b-fits-inclusive': {
    source: 'function fits(a, b: Cardinal): Boolean;\nbegin\n  fits := a < b;\nend;\n',
    reference: 'function fits(a, b: Cardinal): Boolean;\nbegin\n  fits := a <= b;\nend;\n',
  },
  'b-sumfrom-eight': {
    source: `function sumfrom(x: Cardinal): Cardinal;\nvar s, i: Cardinal;\nbegin\n  s := x;\n${loop(4, 's := Cardinal(s + i)')}  sumfrom := s;\nend;\n`,
    reference: `function sumfrom(x: Cardinal): Cardinal;\nvar s, i: Cardinal;\nbegin\n  s := x;\n${loop(7, 's := Cardinal(s + i)')}  sumfrom := s;\nend;\n`,
  },
  'b-rot8-constant': {
    source:
      'function rot8(x: Cardinal): Cardinal;\nbegin\n  rot8 := Cardinal(Cardinal(x shl 8) or Cardinal(x shr 23));\nend;\n',
    reference:
      'function rot8(x: Cardinal): Cardinal;\nbegin\n  rot8 := Cardinal(Cardinal(x shl 8) or Cardinal(x shr 24));\nend;\n',
  },
  'b-onlyone-xor': {
    source: 'function onlyone(a, b: Boolean): Boolean;\nbegin\n  onlyone := a or b;\nend;\n',
    reference: 'function onlyone(a, b: Boolean): Boolean;\nbegin\n  onlyone := a <> b;\nend;\n',
  },
  'b-avgfloor-nowrap': {
    source:
      'function avgfloor(a, b: Cardinal): Cardinal;\nbegin\n  avgfloor := Cardinal(a + b) shr 1;\nend;\n',
    reference:
      'function avgfloor(a, b: Cardinal): Cardinal;\nbegin\n  avgfloor := (a and b) + ((a xor b) shr 1);\nend;\n',
  },
  'b-sumsq-array': {
    source: `function sumsq(a: U32x4): Cardinal;\nvar s, i: Cardinal;\nbegin\n  s := 0;\n${loop(3, 's := Cardinal(s + a[i])')}  sumsq := s;\nend;\n`,
    reference: `function sumsq(a: U32x4): Cardinal;\nvar s, i: Cardinal;\nbegin\n  s := 0;\n${loop(3, 's := Cardinal(s + Cardinal(a[i] * a[i]))')}  sumsq := s;\nend;\n`,
  },
  'b-inrange-inclusive': {
    source:
      'function inrange(x, lo, hi: Cardinal): Boolean;\nbegin\n  inrange := (x > lo) and (x < hi);\nend;\n',
    reference:
      'function inrange(x, lo, hi: Cardinal): Boolean;\nbegin\n  inrange := (x >= lo) and (x <= hi);\nend;\n',
  },
  'b-bounds-largest': {
    source: `function bounds(a: U32x4): U32x2;\nvar lo, hi, x, i: Cardinal;\nbegin\n  lo := ${M};\n  hi := 0;\n  for i := 0 to 3 do\n  begin\n    x := a[i];\n    if x < lo then lo := x;\n    if x < hi then hi := x;\n  end;\n  bounds[0] := lo;\n  bounds[1] := hi;\nend;\n`,
    reference: `function bounds(a: U32x4): U32x2;\nvar lo, hi, x, i: Cardinal;\nbegin\n  lo := ${M};\n  hi := 0;\n  for i := 0 to 3 do\n  begin\n    x := a[i];\n    if x < lo then lo := x;\n    if x > hi then hi := x;\n  end;\n  bounds[0] := lo;\n  bounds[1] := hi;\nend;\n`,
  },
  'b-checksum-poly': {
    source: `function checksum(a: U32x4): Cardinal;\nvar h, i: Cardinal;\nbegin\n  h := 0;\n${loop(3, 'h := h xor a[i]')}  checksum := h;\nend;\n`,
    reference: `function checksum(a: U32x4): Cardinal;\nvar h, i: Cardinal;\nbegin\n  h := 7;\n${loop(3, 'h := Cardinal(Cardinal(h * 31) + a[i])')}  checksum := h;\nend;\n`,
  },
  'b-norm2-dot': {
    source: `function dot(a, b: U32x4): Cardinal;\nvar s, i: Cardinal;\nbegin\n  s := 0;\n${loop(3, 's := Cardinal(s + Cardinal(a[i] * b[i]))')}  dot := s;\nend;\n`,
    reference: `function dot(a, b: U32x4): Cardinal;\nvar s, i: Cardinal;\nbegin\n  s := 0;\n${loop(3, 's := Cardinal(s + Cardinal(a[i] * b[i]))')}  dot := s;\nend;\nfunction norm2(a: U32x4): Cardinal;\nbegin\n  norm2 := dot(a, a);\nend;\n`,
  },
  'b-pctof-limit': {
    source:
      'function limit(x, lo, hi: Cardinal): Cardinal;\nvar b: Cardinal;\nbegin\n  if x < lo then b := lo else b := x;\n  if b > hi then limit := hi else limit := b;\nend;\n',
    reference: `function limit(x, lo, hi: Cardinal): Cardinal;\nvar b: Cardinal;\nbegin\n  if x < lo then b := lo else b := x;\n  if b > hi then limit := hi else limit := b;\nend;\nfunction pctof(part, whole: Cardinal): Cardinal;\nvar n, q: Cardinal;\nbegin\n  n := Cardinal(part * 100);\n  if whole = 0 then q := ${M} else q := n div whole;\n  pctof := limit(q, 0, 100);\nend;\n`,
  },
  'b-hamming-popcnt': {
    source: `function popcnt(x: Cardinal): Cardinal;\nvar s, i: Cardinal;\nbegin\n  s := 0;\n${loop(31, 's := Cardinal(s + ((x shr i) and 1))')}  popcnt := s;\nend;\n`,
    reference: `function popcnt(x: Cardinal): Cardinal;\nvar s, i: Cardinal;\nbegin\n  s := 0;\n${loop(31, 's := Cardinal(s + ((x shr i) and 1))')}  popcnt := s;\nend;\nfunction hamming(a, b: Cardinal): Cardinal;\nbegin\n  hamming := popcnt(a xor b);\nend;\n`,
  },
};

export const PASCAL: LangSpec = {
  semantics:
    'Integers are unsigned 32-bit values of type Cardinal with overflow and range checks off; wrap arithmetic results with Cardinal(...) and mask shift counts to 5 bits (and 31); comparisons are unsigned; records are U32x2 and u32x4 values are U32x4 (array[0..3] of Cardinal, a[i]). Division by zero gives 4294967295; remainder by zero gives the dividend. Write top-level functions only; they are exported from the unit cand (cand.pas) automatically and compiled with fpc, then the driver program uses cand.',
  head: /^function ([A-Za-z_][A-Za-z0-9_]*)\b/,
  file(body) {
    const decls = body
      .split('\n')
      .filter((l) => /^function .*;\s*$/.test(l))
      .join('\n');
    return `unit cand;
{$mode objfpc}{$H+}{$Q-}{$R-}
interface
${U32_TYPES}${decls}
implementation
${body}
end.
`;
  },
  b: B,
  driver,
  compileLabel: 'fpc',
  async buildAndRun(dir, source, drv) {
    const fpc = tool('fpc', 'A0_FPC', ['/opt/homebrew/bin/fpc']);
    // fpc silently ignores everything after the unit's final `end.`; that is a mistake here.
    if (!/\bend\.\s*$/.test(source))
      return { error: 'fpc: text after the final "end." of the unit (or "end." missing)' };
    await writeFile(join(dir, 'cand.pas'), source, 'utf8');
    await writeFile(join(dir, 'driver.pas'), drv, 'utf8');
    const unit = runTool(fpc, ['-B', '-O1', '-v0', 'cand.pas'], { cwd: dir, timeoutMs: BUILD_MS });
    if (!unit.ok) return failure('fpc', unit);
    const build = runTool(fpc, ['-B', '-O1', '-v0', '-Fu.', '-odriver_bin', 'driver.pas'], {
      cwd: dir,
      timeoutMs: BUILD_MS,
    });
    if (!build.ok) return failure('fpc', build);
    const run = runTool(join(dir, 'driver_bin'), [], { cwd: dir, timeoutMs: RUN_MS });
    if (!run.ok) return failure('run', run);
    return { stdout: run.stdout };
  },
};
