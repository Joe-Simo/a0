/**
 * Forth (gforth): u32 values are single cells (64-bit) masked with M ($FFFFFFFF) after every
 * operation that can leave the range; comparisons use u< and u>. Convention: arguments are
 * pushed left to right; a u32x4 array is the address of 4 consecutive cells (a i cells + @);
 * booleans are flags (true = -1, false = 0); the 2-value bounds record is returned as two
 * stack cells (lo hi, hi on top). Loaded with gforth, which exits non-zero on a load error.
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

function literal(v: Value, t: Type | undefined): string {
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  const fields = recordFields(t);
  const items = Array.from(v as ArrayLike<Value>, (x, i) => literal(x, fields[i]));
  return fields.length > 0 ? items.join(' ') : `here ${items.map((x) => `${x} ,`).join(' ')}`;
}

/** Prints the value on top of the stack; a record occupies one cell per field. */
function render(t: Type | undefined): string {
  if (t === 'bool') return 'pb';
  const fields = recordFields(t);
  if (fields.length === 0) return 'pu';
  const n = fields.length;
  const parts = fields.map((ft, k) => `${n - 1 - k} roll ${render(ft)}`);
  return `s" [" type ${parts.join(' s" ," type ')} s" ]" type`;
}

function driver(tests: readonly LangCase[], typed: Parameters<LangSpec['driver']>[1]): string {
  const body = tests
    .map((t, i) => {
      const { params, result } = signature(typed, t.fn);
      const args = t.args.map((a, k) => literal(a, params[k])).join(' ');
      return `s" R${i} " type ${args} ${t.fn} ${render(result)} cr`;
    })
    .join('\n');
  return `: pu ( u -- ) 0 <# #s #> type ;\n: pb ( f -- ) if s" true" else s" false" then type ;\n${body}\ns" DONE" type cr\n`;
}

const B: LangSpec['b'] = {
  'b-fits-inclusive': {
    source: ': fits ( a b -- f )\n  { a b }\n  a b u<\n;\n',
    reference: ': fits ( a b -- f )\n  { a b }\n  b a u< 0=\n;\n',
  },
  'b-sumfrom-eight': {
    source:
      ': sumfrom ( x -- r )\n  0 { x s }\n  x to s\n  5 0 do\n    s i + M and to s\n  loop\n  s\n;\n',
    reference:
      ': sumfrom ( x -- r )\n  0 { x s }\n  x to s\n  8 0 do\n    s i + M and to s\n  loop\n  s\n;\n',
  },
  'b-rot8-constant': {
    source: ': rot8 ( x -- r )\n  { x }\n  x 8 lshift x 23 rshift or M and\n;\n',
    reference: ': rot8 ( x -- r )\n  { x }\n  x 8 lshift x 24 rshift or M and\n;\n',
  },
  'b-onlyone-xor': {
    source: ': onlyone ( a b -- f )\n  { a b }\n  a b or\n;\n',
    reference: ': onlyone ( a b -- f )\n  { a b }\n  a b <>\n;\n',
  },
  'b-avgfloor-nowrap': {
    source: ': avgfloor ( a b -- r )\n  { a b }\n  a b + M and 1 rshift\n;\n',
    reference: ': avgfloor ( a b -- r )\n  { a b }\n  a b and a b xor 1 rshift +\n;\n',
  },
  'b-sumsq-array': {
    source:
      ': sumsq ( a -- r )\n  0 { a s }\n  0 to s\n  4 0 do\n    s a i cells + @ + M and to s\n  loop\n  s\n;\n',
    reference:
      ': sumsq ( a -- r )\n  0 { a s }\n  0 to s\n  4 0 do\n    s a i cells + @ dup * + M and to s\n  loop\n  s\n;\n',
  },
  'b-inrange-inclusive': {
    source: ': inrange ( x lo hi -- f )\n  { x lo hi }\n  x lo u> x hi u< and\n;\n',
    reference: ': inrange ( x lo hi -- f )\n  { x lo hi }\n  x lo u< 0= x hi u> 0= and\n;\n',
  },
  'b-bounds-largest': {
    source:
      ': bounds ( a -- lo hi )\n  0 0 0 { a lo hi x }\n  M to lo\n  0 to hi\n  4 0 do\n    a i cells + @ to x\n    x lo u< if x to lo then\n    x hi u< if x to hi then\n  loop\n  lo hi\n;\n',
    reference:
      ': bounds ( a -- lo hi )\n  0 0 0 { a lo hi x }\n  M to lo\n  0 to hi\n  4 0 do\n    a i cells + @ to x\n    x lo u< if x to lo then\n    x hi u> if x to hi then\n  loop\n  lo hi\n;\n',
  },
  'b-checksum-poly': {
    source:
      ': checksum ( a -- h )\n  0 { a h }\n  0 to h\n  4 0 do\n    h a i cells + @ xor to h\n  loop\n  h\n;\n',
    reference:
      ': checksum ( a -- h )\n  0 { a h }\n  7 to h\n  4 0 do\n    h 31 * a i cells + @ + M and to h\n  loop\n  h\n;\n',
  },
  'b-norm2-dot': {
    source:
      ': dot ( a b -- s )\n  0 { a b s }\n  0 to s\n  4 0 do\n    s a i cells + @ b i cells + @ * + M and to s\n  loop\n  s\n;\n',
    reference:
      ': dot ( a b -- s )\n  0 { a b s }\n  0 to s\n  4 0 do\n    s a i cells + @ b i cells + @ * + M and to s\n  loop\n  s\n;\n: norm2 ( a -- r )\n  { a }\n  a a dot\n;\n',
  },
  'b-pctof-limit': {
    source:
      ': limit ( x lo hi -- r )\n  0 { x lo hi b }\n  x lo u< if lo else x then to b\n  b hi u> if hi else b then\n;\n',
    reference:
      ': limit ( x lo hi -- r )\n  0 { x lo hi b }\n  x lo u< if lo else x then to b\n  b hi u> if hi else b then\n;\n: pctof ( part whole -- r )\n  0 0 { part whole n q }\n  part 100 * M and to n\n  whole 0= if M else n 0 whole um/mod nip then to q\n  q 0 100 limit\n;\n',
  },
  'b-hamming-popcnt': {
    source:
      ': popcnt ( x -- s )\n  0 { x s }\n  0 to s\n  32 0 do\n    s x i rshift 1 and + M and to s\n  loop\n  s\n;\n',
    reference:
      ': popcnt ( x -- s )\n  0 { x s }\n  0 to s\n  32 0 do\n    s x i rshift 1 and + M and to s\n  loop\n  s\n;\n: hamming ( a b -- r )\n  { a b }\n  a b xor popcnt\n;\n',
  },
};

export const FORTH: LangSpec = {
  semantics:
    'Integers are unsigned 32-bit values in 64-bit cells: mask every arithmetic result with M ($FFFFFFFF), mask shift counts to 5 bits (31 and), use u< and u> for comparisons. A u32x4 argument is the address of 4 cells, a bool is a flag (true -1, false 0), a record result is two stack values. Division by zero gives 4294967295; remainder by zero gives the dividend. The file must load in gforth.',
  head: /^: ([^\s]+)\s/,
  file: (body) => `$FFFFFFFF constant M\n${body}`,
  b: B,
  driver,
  compileLabel: 'gforth',
  async buildAndRun(dir, source, drv) {
    const gforth = tool('gforth', 'A0_GFORTH', ['/opt/homebrew/bin/gforth']);
    await writeFile(join(dir, 'mod.fs'), source, 'utf8');
    await writeFile(join(dir, 'driver.fs'), drv, 'utf8');
    const check = runTool(gforth, [join(dir, 'mod.fs'), '-e', 'bye'], {
      cwd: dir,
      timeoutMs: BUILD_MS,
    });
    if (!check.ok) return failure('gforth', check);
    const run = runTool(gforth, [join(dir, 'mod.fs'), join(dir, 'driver.fs'), '-e', 'bye'], {
      cwd: dir,
      timeoutMs: RUN_MS,
    });
    if (!run.ok) return failure('run', run);
    return { stdout: run.stdout };
  },
};
