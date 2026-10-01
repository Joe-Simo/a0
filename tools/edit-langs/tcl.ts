/**
 * Tcl 9: u32 values are integers masked with & 0xFFFFFFFF after every operation that can
 * leave the range (Tcl promotes overflow to bignums, so products are exact before masking);
 * records and u32x4 arrays are lists. Sourcing the candidate in tclsh is the build step.
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

function literal(v: Value): string {
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  return `[list ${Array.from(v as ArrayLike<Value>, literal).join(' ')}]`;
}

/** Text embedded in a double-quoted Tcl string that prints the value held in `expr`. */
function render(expr: string, t: Type | undefined): string {
  if (t === 'bool') return `[fb ${expr}]`;
  const fields = recordFields(t);
  if (fields.length > 0)
    return `\\[${fields.map((ft, i) => render(`[lindex ${expr} ${i}]`, ft)).join(',')}\\]`;
  return `[fu ${expr}]`;
}

function driver(tests: readonly LangCase[], typed: Parameters<LangSpec['driver']>[1]): string {
  const body = tests
    .map((t, i) => {
      const { result } = signature(typed, t.fn);
      const args = t.args.map((a) => literal(a)).join(' ');
      return `set v [${t.fn} ${args}]\nputs "R${i} ${render('$v', result)}"`;
    })
    .join('\n');
  return `source [file join [file dirname [info script]] mod.tcl]\n\nproc fu {v} {\n  return $v\n}\n\nproc fb {v} {\n  expr {$v ? "true" : "false"}\n}\n\n${body}\nputs DONE\n`;
}

const B: LangSpec['b'] = {
  'b-fits-inclusive': {
    source: 'proc fits {a b} {\n  expr {$a < $b}\n}\n',
    reference: 'proc fits {a b} {\n  expr {$a <= $b}\n}\n',
  },
  'b-sumfrom-eight': {
    source: `proc sumfrom {x} {\n  set s $x\n  for {set i 0} {$i < 5} {incr i} {\n    set s [expr {($s + $i) & ${M}}]\n  }\n  return $s\n}\n`,
    reference: `proc sumfrom {x} {\n  set s $x\n  for {set i 0} {$i < 8} {incr i} {\n    set s [expr {($s + $i) & ${M}}]\n  }\n  return $s\n}\n`,
  },
  'b-rot8-constant': {
    source: `proc rot8 {x} {\n  expr {(($x << 8) | ($x >> 23)) & ${M}}\n}\n`,
    reference: `proc rot8 {x} {\n  expr {(($x << 8) | ($x >> 24)) & ${M}}\n}\n`,
  },
  'b-onlyone-xor': {
    source: 'proc onlyone {a b} {\n  expr {$a || $b}\n}\n',
    reference: 'proc onlyone {a b} {\n  expr {$a != $b}\n}\n',
  },
  'b-avgfloor-nowrap': {
    source: `proc avgfloor {a b} {\n  expr {(($a + $b) & ${M}) >> 1}\n}\n`,
    reference: 'proc avgfloor {a b} {\n  expr {($a & $b) + (($a ^ $b) >> 1)}\n}\n',
  },
  'b-sumsq-array': {
    source: `proc sumsq {a} {\n  set s 0\n  for {set i 0} {$i < 4} {incr i} {\n    set s [expr {($s + [lindex $a $i]) & ${M}}]\n  }\n  return $s\n}\n`,
    reference: `proc sumsq {a} {\n  set s 0\n  for {set i 0} {$i < 4} {incr i} {\n    set s [expr {($s + [lindex $a $i] * [lindex $a $i]) & ${M}}]\n  }\n  return $s\n}\n`,
  },
  'b-inrange-inclusive': {
    source: 'proc inrange {x lo hi} {\n  expr {$x > $lo && $x < $hi}\n}\n',
    reference: 'proc inrange {x lo hi} {\n  expr {$x >= $lo && $x <= $hi}\n}\n',
  },
  'b-bounds-largest': {
    source: `proc bounds {a} {\n  set lo ${M}\n  set hi 0\n  for {set i 0} {$i < 4} {incr i} {\n    set x [lindex $a $i]\n    if {$x < $lo} {set lo $x}\n    if {$x < $hi} {set hi $x}\n  }\n  return [list $lo $hi]\n}\n`,
    reference: `proc bounds {a} {\n  set lo ${M}\n  set hi 0\n  for {set i 0} {$i < 4} {incr i} {\n    set x [lindex $a $i]\n    if {$x < $lo} {set lo $x}\n    if {$x > $hi} {set hi $x}\n  }\n  return [list $lo $hi]\n}\n`,
  },
  'b-checksum-poly': {
    source:
      'proc checksum {a} {\n  set h 0\n  for {set i 0} {$i < 4} {incr i} {\n    set h [expr {$h ^ [lindex $a $i]}]\n  }\n  return $h\n}\n',
    reference: `proc checksum {a} {\n  set h 7\n  for {set i 0} {$i < 4} {incr i} {\n    set h [expr {($h * 31 + [lindex $a $i]) & ${M}}]\n  }\n  return $h\n}\n`,
  },
  'b-norm2-dot': {
    source: `proc dot {a b} {\n  set s 0\n  for {set i 0} {$i < 4} {incr i} {\n    set s [expr {($s + [lindex $a $i] * [lindex $b $i]) & ${M}}]\n  }\n  return $s\n}\n`,
    reference: `proc dot {a b} {\n  set s 0\n  for {set i 0} {$i < 4} {incr i} {\n    set s [expr {($s + [lindex $a $i] * [lindex $b $i]) & ${M}}]\n  }\n  return $s\n}\nproc norm2 {a} {\n  return [dot $a $a]\n}\n`,
  },
  'b-pctof-limit': {
    source:
      'proc limit {x lo hi} {\n  set b [expr {$x < $lo ? $lo : $x}]\n  expr {$b > $hi ? $hi : $b}\n}\n',
    reference: `proc limit {x lo hi} {\n  set b [expr {$x < $lo ? $lo : $x}]\n  expr {$b > $hi ? $hi : $b}\n}\nproc pctof {part whole} {\n  set n [expr {($part * 100) & ${M}}]\n  set q [expr {$whole == 0 ? ${M} : $n / $whole}]\n  return [limit $q 0 100]\n}\n`,
  },
  'b-hamming-popcnt': {
    source: `proc popcnt {x} {\n  set s 0\n  for {set i 0} {$i < 32} {incr i} {\n    set s [expr {($s + (($x >> $i) & 1)) & ${M}}]\n  }\n  return $s\n}\n`,
    reference: `proc popcnt {x} {\n  set s 0\n  for {set i 0} {$i < 32} {incr i} {\n    set s [expr {($s + (($x >> $i) & 1)) & ${M}}]\n  }\n  return $s\n}\nproc hamming {a b} {\n  return [popcnt [expr {$a ^ $b}]]\n}\n`,
  },
};

export const TCL: LangSpec = {
  semantics: `Integers are unsigned 32-bit: mask every arithmetic result with & ${M} (Tcl integers are wider and promote on overflow), mask shift counts to 5 bits (& 31); comparisons are unsigned. Booleans are 1/0 from expr; arrays and records are lists. Division by zero gives 4294967295; remainder by zero gives the dividend. The file must be sourceable by tclsh.`,
  head: /^proc ([a-z_][A-Za-z0-9_]*) \{/,
  file: (body) => body,
  b: B,
  driver,
  compileLabel: 'tclsh',
  async buildAndRun(dir, source, drv) {
    const tclsh = tool('tclsh', 'A0_TCLSH', ['/opt/homebrew/bin/tclsh', '/usr/bin/tclsh']);
    await writeFile(join(dir, 'mod.tcl'), source, 'utf8');
    await writeFile(join(dir, 'driver.tcl'), drv, 'utf8');
    await writeFile(
      join(dir, 'check.tcl'),
      'source [file join [file dirname [info script]] mod.tcl]\n',
      'utf8',
    );
    const check = runTool(tclsh, [join(dir, 'check.tcl')], { cwd: dir, timeoutMs: BUILD_MS });
    if (!check.ok) return failure('tclsh', check);
    const run = runTool(tclsh, [join(dir, 'driver.tcl')], { cwd: dir, timeoutMs: RUN_MS });
    if (!run.ok) return failure('run', run);
    return { stdout: run.stdout };
  },
};
