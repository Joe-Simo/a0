/**
 * Perl: u32 values are plain integers (64-bit IV/UV, no `use integer`) masked with & 0xFFFFFFFF
 * after every operation that can leave the range; a product of two u32 values is masked on its
 * own before it is added, so no sum overflows into a double. Records and u32x4 are array refs.
 * Checked with perl -c, run with perl.
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

const M = '0xFFFFFFFF';

function literal(v: Value, t: Type | undefined): string {
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  const fields = recordFields(t);
  return `[${Array.from(v as ArrayLike<Value>, (x, i) => literal(x, fields[i])).join(', ')}]`;
}

function render(expr: string, t: Type | undefined): string {
  if (t === 'bool') return `fb(${expr})`;
  const fields = recordFields(t);
  if (fields.length > 0)
    return `'[' . ${fields.map((ft, i) => render(`${expr}->[${i}]`, ft)).join(" . ',' . ")} . ']'`;
  return `sprintf('%u', ${expr})`;
}

function driver(tests: readonly LangCase[], typed: Parameters<LangSpec['driver']>[1]): string {
  const body = tests
    .map((t, i) => {
      const { params, result } = signature(typed, t.fn);
      const args = t.args.map((a, k) => literal(a, params[k])).join(', ');
      return `$v = ${t.fn}(${args});\nprint "R${i} " . ${render('$v', result)} . "\\n";`;
    })
    .join('\n');
  return `use strict;\nuse warnings;\nrequire './mod.pl';\n\nsub fb { return $_[0] ? 'true' : 'false'; }\n\nmy $v;\n${body}\nprint "DONE\\n";\n`;
}

const B: LangSpec['b'] = {
  'b-fits-inclusive': {
    source: 'sub fits {\n  my ($a, $b) = @_;\n  return $a < $b;\n}\n',
    reference: 'sub fits {\n  my ($a, $b) = @_;\n  return $a <= $b;\n}\n',
  },
  'b-sumfrom-eight': {
    source: `sub sumfrom {\n  my ($x) = @_;\n  my $s = $x;\n  for my $i (0 .. 4) {\n    $s = ($s + $i) & ${M};\n  }\n  return $s;\n}\n`,
    reference: `sub sumfrom {\n  my ($x) = @_;\n  my $s = $x;\n  for my $i (0 .. 7) {\n    $s = ($s + $i) & ${M};\n  }\n  return $s;\n}\n`,
  },
  'b-rot8-constant': {
    source: `sub rot8 {\n  my ($x) = @_;\n  return (($x << 8) | ($x >> 23)) & ${M};\n}\n`,
    reference: `sub rot8 {\n  my ($x) = @_;\n  return (($x << 8) | ($x >> 24)) & ${M};\n}\n`,
  },
  'b-onlyone-xor': {
    source: 'sub onlyone {\n  my ($a, $b) = @_;\n  return $a || $b;\n}\n',
    reference: 'sub onlyone {\n  my ($a, $b) = @_;\n  return ($a xor $b);\n}\n',
  },
  'b-avgfloor-nowrap': {
    source: `sub avgfloor {\n  my ($a, $b) = @_;\n  return (($a + $b) & ${M}) >> 1;\n}\n`,
    reference: 'sub avgfloor {\n  my ($a, $b) = @_;\n  return ($a & $b) + (($a ^ $b) >> 1);\n}\n',
  },
  'b-sumsq-array': {
    source: `sub sumsq {\n  my ($a) = @_;\n  my $s = 0;\n  for my $i (0 .. 3) {\n    $s = ($s + $a->[$i % 4]) & ${M};\n  }\n  return $s;\n}\n`,
    reference: `sub sumsq {\n  my ($a) = @_;\n  my $s = 0;\n  for my $i (0 .. 3) {\n    my $x = $a->[$i % 4];\n    $s = ($s + (($x * $x) & ${M})) & ${M};\n  }\n  return $s;\n}\n`,
  },
  'b-inrange-inclusive': {
    source: 'sub inrange {\n  my ($x, $lo, $hi) = @_;\n  return $x > $lo && $x < $hi;\n}\n',
    reference: 'sub inrange {\n  my ($x, $lo, $hi) = @_;\n  return $x >= $lo && $x <= $hi;\n}\n',
  },
  'b-bounds-largest': {
    source: `sub bounds {\n  my ($a) = @_;\n  my $lo = ${M};\n  my $hi = 0;\n  for my $i (0 .. 3) {\n    my $x = $a->[$i % 4];\n    if ($x < $lo) { $lo = $x; }\n    if ($x < $hi) { $hi = $x; }\n  }\n  return [$lo, $hi];\n}\n`,
    reference: `sub bounds {\n  my ($a) = @_;\n  my $lo = ${M};\n  my $hi = 0;\n  for my $i (0 .. 3) {\n    my $x = $a->[$i % 4];\n    if ($x < $lo) { $lo = $x; }\n    if ($x > $hi) { $hi = $x; }\n  }\n  return [$lo, $hi];\n}\n`,
  },
  'b-checksum-poly': {
    source: `sub checksum {\n  my ($a) = @_;\n  my $h = 0;\n  for my $i (0 .. 3) {\n    $h = ($h ^ $a->[$i % 4]) & ${M};\n  }\n  return $h;\n}\n`,
    reference: `sub checksum {\n  my ($a) = @_;\n  my $h = 7;\n  for my $i (0 .. 3) {\n    $h = ((($h * 31) & ${M}) + $a->[$i % 4]) & ${M};\n  }\n  return $h;\n}\n`,
  },
  'b-norm2-dot': {
    source: `sub dot {\n  my ($a, $b) = @_;\n  my $s = 0;\n  for my $i (0 .. 3) {\n    $s = ($s + (($a->[$i % 4] * $b->[$i % 4]) & ${M})) & ${M};\n  }\n  return $s;\n}\n`,
    reference: `sub dot {\n  my ($a, $b) = @_;\n  my $s = 0;\n  for my $i (0 .. 3) {\n    $s = ($s + (($a->[$i % 4] * $b->[$i % 4]) & ${M})) & ${M};\n  }\n  return $s;\n}\nsub norm2 {\n  my ($a) = @_;\n  return dot($a, $a);\n}\n`,
  },
  'b-pctof-limit': {
    source:
      'sub limit {\n  my ($x, $lo, $hi) = @_;\n  my $b = $x < $lo ? $lo : $x;\n  return $b > $hi ? $hi : $b;\n}\n',
    reference: `sub limit {\n  my ($x, $lo, $hi) = @_;\n  my $b = $x < $lo ? $lo : $x;\n  return $b > $hi ? $hi : $b;\n}\nsub pctof {\n  my ($part, $whole) = @_;\n  my $n = ($part * 100) & ${M};\n  my $q = $whole == 0 ? ${M} : int($n / $whole);\n  return limit($q, 0, 100);\n}\n`,
  },
  'b-hamming-popcnt': {
    source: `sub popcnt {\n  my ($x) = @_;\n  my $s = 0;\n  for my $i (0 .. 31) {\n    $s = ($s + (($x >> $i) & 1)) & ${M};\n  }\n  return $s;\n}\n`,
    reference: `sub popcnt {\n  my ($x) = @_;\n  my $s = 0;\n  for my $i (0 .. 31) {\n    $s = ($s + (($x >> $i) & 1)) & ${M};\n  }\n  return $s;\n}\nsub hamming {\n  my ($a, $b) = @_;\n  return popcnt(($a ^ $b) & ${M});\n}\n`,
  },
};

export const PERL: LangSpec = {
  semantics: `Integers are unsigned 32-bit held in Perl's 64-bit integers (no 'use integer'): mask every arithmetic result with & ${M}, mask a product of two values on its own before adding it, mask shift counts to 5 bits (& 31); comparisons are unsigned. Division by zero gives 4294967295; remainder by zero gives the dividend. Arrays and records are array references; booleans are Perl truth values. The file must pass perl -c and its subs run in package main.`,
  head: /^sub ([a-z_][A-Za-z0-9_]*)\b/,
  file: (body) => `use strict;\nuse warnings;\n\n${body}\n1;\n`,
  b: B,
  driver,
  compileLabel: 'perl',
  async buildAndRun(dir, source, drv) {
    const perl = tool('perl', 'A0_PERL', ['/usr/bin/perl', '/opt/homebrew/bin/perl']);
    await writeFile(join(dir, 'mod.pl'), source, 'utf8');
    await writeFile(join(dir, 'driver.pl'), drv, 'utf8');
    const check = runTool(perl, ['-c', join(dir, 'mod.pl')], { cwd: dir, timeoutMs: BUILD_MS });
    if (!check.ok) return failure('perl', check);
    const run = runTool(perl, [join(dir, 'driver.pl')], { cwd: dir, timeoutMs: RUN_MS });
    if (!run.ok) return failure('run', run);
    return { stdout: run.stdout };
  },
};
