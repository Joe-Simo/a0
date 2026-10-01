/**
 * R: u32 values are doubles in [0, 2^32); the helpers add32, mul32, shl, shr, and32, or32 and
 * xor32 (provided by the file) keep every result exact. Checked with parse(), run with Rscript.
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

const M = '4294967295';

const HELPERS = `M32 <- 4294967296
add32 <- function(a, b) (a + b) %% M32
mul32 <- function(a, b) ((a * (b %% 65536)) %% M32 + ((a * (b %/% 65536)) %% 65536) * 65536) %% M32
shl <- function(x, n) (x * 2^(n %% 32)) %% M32
shr <- function(x, n) x %/% 2^(n %% 32)
and32 <- function(a, b) bitwAnd(a %/% 65536, b %/% 65536) * 65536 + bitwAnd(a %% 65536, b %% 65536)
or32 <- function(a, b) bitwOr(a %/% 65536, b %/% 65536) * 65536 + bitwOr(a %% 65536, b %% 65536)
xor32 <- function(a, b) bitwXor(a %/% 65536, b %/% 65536) * 65536 + bitwXor(a %% 65536, b %% 65536)
`;

function literal(v: Value, t: Type | undefined): string {
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  const items = Array.from(v as ArrayLike<Value>, (x, i) =>
    literal(x, arrayElem(t) ?? recordFields(t)[i]),
  );
  return `c(${items.join(', ')})`;
}

function render(expr: string, t: Type | undefined): string {
  if (t === 'bool') return `fb(${expr})`;
  const fields = recordFields(t);
  if (fields.length > 0)
    return `paste0("[", ${fields.map((ft, i) => render(`${expr}[${i + 1}]`, ft)).join(', ",", ')}, "]")`;
  return `fu(${expr})`;
}

function driver(tests: readonly LangCase[], typed: Parameters<LangSpec['driver']>[1]): string {
  const body = tests
    .map((t, i) => {
      const { params, result } = signature(typed, t.fn);
      const args = t.args.map((a, k) => literal(a, params[k])).join(', ');
      return `v <- ${t.fn}(${args})\ncat("R${i} ", ${render('v', result)}, "\\n", sep = "")`;
    })
    .join('\n');
  return `source("mod.R")\nfu <- function(v) sprintf("%.0f", v)\nfb <- function(v) if (isTRUE(v)) "true" else "false"\n${body}\ncat("DONE\\n")\n`;
}

const loop = (n: number, body: string): string => `  for (i in 0:${n - 1}) {\n${body}\n  }\n`;

const B: LangSpec['b'] = {
  'b-fits-inclusive': {
    source: 'fits <- function(a, b) {\n  a < b\n}\n',
    reference: 'fits <- function(a, b) {\n  a <= b\n}\n',
  },
  'b-sumfrom-eight': {
    source: `sumfrom <- function(x) {\n  s <- x\n${loop(5, '    s <- add32(s, i)')}  s\n}\n`,
    reference: `sumfrom <- function(x) {\n  s <- x\n${loop(8, '    s <- add32(s, i)')}  s\n}\n`,
  },
  'b-rot8-constant': {
    source: 'rot8 <- function(x) {\n  or32(shl(x, 8), shr(x, 23))\n}\n',
    reference: 'rot8 <- function(x) {\n  or32(shl(x, 8), shr(x, 24))\n}\n',
  },
  'b-onlyone-xor': {
    source: 'onlyone <- function(a, b) {\n  a || b\n}\n',
    reference: 'onlyone <- function(a, b) {\n  a != b\n}\n',
  },
  'b-avgfloor-nowrap': {
    source: 'avgfloor <- function(a, b) {\n  shr(add32(a, b), 1)\n}\n',
    reference: 'avgfloor <- function(a, b) {\n  add32(and32(a, b), shr(xor32(a, b), 1))\n}\n',
  },
  'b-sumsq-array': {
    source: `sumsq <- function(a) {\n  s <- 0\n${loop(4, '    s <- add32(s, a[i + 1])')}  s\n}\n`,
    reference: `sumsq <- function(a) {\n  s <- 0\n${loop(4, '    s <- add32(s, mul32(a[i + 1], a[i + 1]))')}  s\n}\n`,
  },
  'b-inrange-inclusive': {
    source: 'inrange <- function(x, lo, hi) {\n  x > lo && x < hi\n}\n',
    reference: 'inrange <- function(x, lo, hi) {\n  x >= lo && x <= hi\n}\n',
  },
  'b-bounds-largest': {
    source: `bounds <- function(a) {\n  lo <- ${M}\n  hi <- 0\n${loop(4, '    x <- a[i + 1]\n    if (x < lo) lo <- x\n    if (x < hi) hi <- x')}  c(lo, hi)\n}\n`,
    reference: `bounds <- function(a) {\n  lo <- ${M}\n  hi <- 0\n${loop(4, '    x <- a[i + 1]\n    if (x < lo) lo <- x\n    if (x > hi) hi <- x')}  c(lo, hi)\n}\n`,
  },
  'b-checksum-poly': {
    source: `checksum <- function(a) {\n  h <- 0\n${loop(4, '    h <- xor32(h, a[i + 1])')}  h\n}\n`,
    reference: `checksum <- function(a) {\n  h <- 7\n${loop(4, '    h <- add32(mul32(h, 31), a[i + 1])')}  h\n}\n`,
  },
  'b-norm2-dot': {
    source: `dot <- function(a, b) {\n  s <- 0\n${loop(4, '    s <- add32(s, mul32(a[i + 1], b[i + 1]))')}  s\n}\n`,
    reference: `dot <- function(a, b) {\n  s <- 0\n${loop(4, '    s <- add32(s, mul32(a[i + 1], b[i + 1]))')}  s\n}\nnorm2 <- function(a) {\n  dot(a, a)\n}\n`,
  },
  'b-pctof-limit': {
    source:
      'limit <- function(x, lo, hi) {\n  b <- if (x < lo) lo else x\n  if (b > hi) hi else b\n}\n',
    reference: `limit <- function(x, lo, hi) {\n  b <- if (x < lo) lo else x\n  if (b > hi) hi else b\n}\npctof <- function(part, whole) {\n  n <- mul32(part, 100)\n  q <- if (whole == 0) ${M} else n %/% whole\n  limit(q, 0, 100)\n}\n`,
  },
  'b-hamming-popcnt': {
    source: `popcnt <- function(x) {\n  s <- 0\n${loop(32, '    s <- add32(s, and32(shr(x, i), 1))')}  s\n}\n`,
    reference: `popcnt <- function(x) {\n  s <- 0\n${loop(32, '    s <- add32(s, and32(shr(x, i), 1))')}  s\n}\nhamming <- function(a, b) {\n  popcnt(xor32(a, b))\n}\n`,
  },
};

export const R: LangSpec = {
  semantics:
    'Integers are unsigned 32-bit values held in doubles: use the provided helpers add32, mul32, shl, shr, and32, or32, xor32 (they wrap mod 2^32 exactly) for every arithmetic and bit operation; never use + or * on values that can leave the range. Comparisons are unsigned; arrays are numeric vectors (1-based) and records are c(lo, hi). Division by zero gives 4294967295; remainder by zero gives the dividend. The file must parse and run with Rscript.',
  head: /^([a-z_][A-Za-z0-9_.]*) <- function\(/,
  file: (body) => `${HELPERS}${body}`,
  b: B,
  driver,
  compileLabel: 'Rscript',
  async buildAndRun(dir, source, drv) {
    const rscript = tool('Rscript', 'A0_RSCRIPT', ['/opt/homebrew/bin/Rscript']);
    await writeFile(join(dir, 'mod.R'), source, 'utf8');
    await writeFile(join(dir, 'driver.R'), drv, 'utf8');
    await writeFile(join(dir, 'check.R'), 'invisible(parse(file = "mod.R"))\n', 'utf8');
    const check = runTool(rscript, ['check.R'], {
      cwd: dir,
      timeoutMs: BUILD_MS,
    });
    if (!check.ok) return failure('Rscript', check);
    const run = runTool(rscript, ['driver.R'], { cwd: dir, timeoutMs: RUN_MS });
    if (!run.ok) return failure('run', run);
    return { stdout: run.stdout };
  },
};
