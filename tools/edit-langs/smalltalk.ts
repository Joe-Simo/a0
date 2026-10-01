/**
 * GNU Smalltalk 3.2.5: u32 values are arbitrary-precision Integers masked with
 * bitAnd: 16rFFFFFFFF after every operation that can leave the range; records and u32x4 arrays
 * are Arrays (1-based). The candidate is a bang-less class `Lib` loaded with gst, checked by
 * loading it alone (any output means a parse or compile error), then loaded with the driver.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Type, Value } from '../../src/core.js';
import { runTool } from '../../src/toolchain.js';
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

const M = '16rFFFFFFFF';

function literal(v: Value): string {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return `#(${Array.from(v as ArrayLike<Value>, literal).join(' ')})`;
}

function render(expr: string, t: Type | undefined): string {
  const fields = recordFields(t);
  if (fields.length > 0)
    return `'[', ${fields.map((ft, i) => `(${render(`(${expr} at: ${i + 1})`, ft)})`).join(", ',', ")}, ']'`;
  if (arrayElem(t) !== undefined)
    return `'[', (${expr} inject: '' into: [:acc :e | acc, (acc isEmpty ifTrue: [''] ifFalse: [',']), e printString]), ']'`;
  return `${expr} printString`;
}

function driver(tests: readonly LangCase[], typed: Parameters<LangSpec['driver']>[1]): string {
  const body = tests
    .map((t, i) => {
      const { result } = signature(typed, t.fn);
      const args = t.args.map((a, k) => `${k === 0 ? t.fn : 'with'}: ${literal(a)}`);
      return `v := Lib ${args.join(' ')}.\n('R${i} ', ${render('v', result)}) displayNl.`;
    })
    .join('\n');
  return `| v |\n${body}\n'DONE' displayNl.\n`;
}

const B: LangSpec['b'] = {
  'b-fits-inclusive': {
    source: 'Lib class >> fits: a with: b [\n    ^a < b\n]\n',
    reference: 'Lib class >> fits: a with: b [\n    ^a <= b\n]\n',
  },
  'b-sumfrom-eight': {
    source: `Lib class >> sumfrom: x [\n    | s |\n    s := x.\n    0 to: 4 do: [:i | s := (s + i) bitAnd: ${M}].\n    ^s\n]\n`,
    reference: `Lib class >> sumfrom: x [\n    | s |\n    s := x.\n    0 to: 7 do: [:i | s := (s + i) bitAnd: ${M}].\n    ^s\n]\n`,
  },
  'b-rot8-constant': {
    source: `Lib class >> rot8: x [\n    ^((x bitShift: 8) bitOr: (x bitShift: -23)) bitAnd: ${M}\n]\n`,
    reference: `Lib class >> rot8: x [\n    ^((x bitShift: 8) bitOr: (x bitShift: -24)) bitAnd: ${M}\n]\n`,
  },
  'b-onlyone-xor': {
    source: 'Lib class >> onlyone: a with: b [\n    ^a or: [b]\n]\n',
    reference: 'Lib class >> onlyone: a with: b [\n    ^a ~= b\n]\n',
  },
  'b-avgfloor-nowrap': {
    source: `Lib class >> avgfloor: a with: b [\n    ^((a + b) bitAnd: ${M}) bitShift: -1\n]\n`,
    reference:
      'Lib class >> avgfloor: a with: b [\n    ^(a bitAnd: b) + ((a bitXor: b) bitShift: -1)\n]\n',
  },
  'b-sumsq-array': {
    source: `Lib class >> sumsq: a [\n    | s |\n    s := 0.\n    0 to: 3 do: [:i | s := (s + (a at: i + 1)) bitAnd: ${M}].\n    ^s\n]\n`,
    reference: `Lib class >> sumsq: a [\n    | s |\n    s := 0.\n    0 to: 3 do: [:i | s := (s + ((a at: i + 1) * (a at: i + 1))) bitAnd: ${M}].\n    ^s\n]\n`,
  },
  'b-inrange-inclusive': {
    source: 'Lib class >> inrange: x with: lo with: hi [\n    ^x > lo and: [x < hi]\n]\n',
    reference: 'Lib class >> inrange: x with: lo with: hi [\n    ^x >= lo and: [x <= hi]\n]\n',
  },
  'b-bounds-largest': {
    source: `Lib class >> bounds: a [\n    | lo hi x |\n    lo := ${M}.\n    hi := 0.\n    0 to: 3 do: [:i |\n        x := a at: i + 1.\n        x < lo ifTrue: [lo := x].\n        x < hi ifTrue: [hi := x]].\n    ^Array with: lo with: hi\n]\n`,
    reference: `Lib class >> bounds: a [\n    | lo hi x |\n    lo := ${M}.\n    hi := 0.\n    0 to: 3 do: [:i |\n        x := a at: i + 1.\n        x < lo ifTrue: [lo := x].\n        x > hi ifTrue: [hi := x]].\n    ^Array with: lo with: hi\n]\n`,
  },
  'b-checksum-poly': {
    source:
      'Lib class >> checksum: a [\n    | h |\n    h := 0.\n    0 to: 3 do: [:i | h := h bitXor: (a at: i + 1)].\n    ^h\n]\n',
    reference: `Lib class >> checksum: a [\n    | h |\n    h := 7.\n    0 to: 3 do: [:i | h := (h * 31 + (a at: i + 1)) bitAnd: ${M}].\n    ^h\n]\n`,
  },
  'b-norm2-dot': {
    source: `Lib class >> dot: a with: b [\n    | s |\n    s := 0.\n    0 to: 3 do: [:i | s := (s + ((a at: i + 1) * (b at: i + 1))) bitAnd: ${M}].\n    ^s\n]\n`,
    reference: `Lib class >> dot: a with: b [\n    | s |\n    s := 0.\n    0 to: 3 do: [:i | s := (s + ((a at: i + 1) * (b at: i + 1))) bitAnd: ${M}].\n    ^s\n]\nLib class >> norm2: a [\n    ^self dot: a with: a\n]\n`,
  },
  'b-pctof-limit': {
    source:
      'Lib class >> limit: x with: lo with: hi [\n    | b |\n    b := x < lo ifTrue: [lo] ifFalse: [x].\n    ^b > hi ifTrue: [hi] ifFalse: [b]\n]\n',
    reference: `Lib class >> limit: x with: lo with: hi [\n    | b |\n    b := x < lo ifTrue: [lo] ifFalse: [x].\n    ^b > hi ifTrue: [hi] ifFalse: [b]\n]\nLib class >> pctof: part with: whole [\n    | n q |\n    n := (part * 100) bitAnd: ${M}.\n    q := whole = 0 ifTrue: [${M}] ifFalse: [n // whole].\n    ^self limit: q with: 0 with: 100\n]\n`,
  },
  'b-hamming-popcnt': {
    source: `Lib class >> popcnt: x [\n    | s |\n    s := 0.\n    0 to: 31 do: [:i | s := (s + ((x bitShift: i negated) bitAnd: 1)) bitAnd: ${M}].\n    ^s\n]\n`,
    reference: `Lib class >> popcnt: x [\n    | s |\n    s := 0.\n    0 to: 31 do: [:i | s := (s + ((x bitShift: i negated) bitAnd: 1)) bitAnd: ${M}].\n    ^s\n]\nLib class >> hamming: a with: b [\n    ^self popcnt: (a bitXor: b)\n]\n`,
  },
};

export const SMALLTALK: LangSpec = {
  semantics: `Integers are arbitrary precision, used as unsigned 32-bit: mask every arithmetic result with bitAnd: ${M}; comparisons are unsigned. Division by zero gives 4294967295; remainder by zero gives the dividend. Functions are class-side methods of class Lib (Lib class >> name: a with: b [ ... ], bang-less gst syntax, 1-based arrays); the file must load with gst without errors.`,
  head: /^Lib class >> ([A-Za-z][A-Za-z0-9]*):/,
  file: (body) => `Object subclass: Lib [\n${body}]\n`,
  b: B,
  driver,
  compileLabel: 'gst',
  async buildAndRun(dir, source, drv) {
    const gst = tool('gst', 'A0_GST', ['/opt/homebrew/bin/gst', '/usr/local/bin/gst']);
    await writeFile(join(dir, 'mod.st'), source, 'utf8');
    await writeFile(join(dir, 'driver.st'), drv, 'utf8');
    // gst reports parse and compile errors on stderr/stdout and exits 0: any output is an error.
    const check = runTool(gst, ['-q', join(dir, 'mod.st')], { cwd: dir, timeoutMs: BUILD_MS });
    if (!check.ok || check.stdout.trim().length > 0 || check.stderr.trim().length > 0)
      return failure('gst', check);
    const run = runTool(gst, ['-q', join(dir, 'mod.st'), join(dir, 'driver.st')], {
      cwd: dir,
      timeoutMs: RUN_MS,
    });
    if (!run.ok) return failure('run', run);
    return { stdout: run.stdout };
  },
};
