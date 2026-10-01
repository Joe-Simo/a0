/**
 * C: u32 values are uint32_t (stdint.h), whose unsigned arithmetic wraps mod 2^32; records are
 * the struct rec2_t and u32x4 arrays are const uint32_t pointers. The candidate is mod.c,
 * compiled separately from the generated driver main.c and linked, both with clang -O2.
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

const HEADER = `#include <stdbool.h>
#include <stdint.h>

typedef struct {
  uint32_t f0;
  uint32_t f1;
} rec2_t;
`;

function literal(v: Value): string {
  if (typeof v === 'number') return `${v}u`;
  if (typeof v === 'boolean') return String(v);
  return `(const uint32_t[]){${Array.from(v as ArrayLike<Value>, literal).join(', ')}}`;
}

function ctype(t: Type | undefined): string {
  if (t === 'bool') return 'bool';
  if (recordFields(t).length > 0) return 'rec2_t';
  if (t !== undefined && typeof t !== 'string' && t.kind === 'arr') return 'const uint32_t *';
  return 'uint32_t';
}

/** Statements printing `expr` of type `t` canonically. */
function render(expr: string, t: Type | undefined): string {
  if (t === 'bool') return `fputs(${expr} ? "true" : "false", stdout);`;
  const fields = recordFields(t);
  if (fields.length > 0)
    return `fputs("[", stdout); ${fields
      .map((ft, i) => render(`${expr}.f${i}`, ft))
      .join(' fputs(",", stdout); ')} fputs("]", stdout);`;
  return `printf("%u", (unsigned)${expr});`;
}

function driver(tests: readonly LangCase[], typed: Parameters<LangSpec['driver']>[1]): string {
  const protos = new Map<string, string>();
  const body = tests
    .map((t, i) => {
      const { params, result } = signature(typed, t.fn);
      protos.set(t.fn, `${ctype(result)} ${t.fn}(${params.map(ctype).join(', ') || 'void'});`);
      const args = t.args.map(literal).join(', ');
      const call = `v${i}`;
      return `  {\n    ${ctype(result)} ${call} = ${t.fn}(${args});\n    fputs("R${i} ", stdout);\n    ${render(call, result)}\n    fputs("\\n", stdout);\n  }`;
    })
    .join('\n');
  return `#include <stdio.h>\n${HEADER}\n${[...protos.values()].join('\n')}\n\nint main(void) {\n${body}\n  puts("DONE");\n  return 0;\n}\n`;
}

const B: LangSpec['b'] = {
  'b-fits-inclusive': {
    source: 'bool fits(uint32_t a, uint32_t b) {\n  return a < b;\n}\n',
    reference: 'bool fits(uint32_t a, uint32_t b) {\n  return a <= b;\n}\n',
  },
  'b-sumfrom-eight': {
    source:
      'uint32_t sumfrom(uint32_t x) {\n  uint32_t s = x;\n  for (uint32_t i = 0; i < 5; i++) {\n    s = s + i;\n  }\n  return s;\n}\n',
    reference:
      'uint32_t sumfrom(uint32_t x) {\n  uint32_t s = x;\n  for (uint32_t i = 0; i < 8; i++) {\n    s = s + i;\n  }\n  return s;\n}\n',
  },
  'b-rot8-constant': {
    source: 'uint32_t rot8(uint32_t x) {\n  return (x << 8) | (x >> 23);\n}\n',
    reference: 'uint32_t rot8(uint32_t x) {\n  return (x << 8) | (x >> 24);\n}\n',
  },
  'b-onlyone-xor': {
    source: 'bool onlyone(bool a, bool b) {\n  return a || b;\n}\n',
    reference: 'bool onlyone(bool a, bool b) {\n  return a != b;\n}\n',
  },
  'b-avgfloor-nowrap': {
    source: 'uint32_t avgfloor(uint32_t a, uint32_t b) {\n  return (a + b) >> 1;\n}\n',
    reference:
      'uint32_t avgfloor(uint32_t a, uint32_t b) {\n  return (a & b) + ((a ^ b) >> 1);\n}\n',
  },
  'b-sumsq-array': {
    source:
      'uint32_t sumsq(const uint32_t *a) {\n  uint32_t s = 0;\n  for (uint32_t i = 0; i < 4; i++) {\n    s = s + a[i % 4];\n  }\n  return s;\n}\n',
    reference:
      'uint32_t sumsq(const uint32_t *a) {\n  uint32_t s = 0;\n  for (uint32_t i = 0; i < 4; i++) {\n    uint32_t x = a[i % 4];\n    s = s + x * x;\n  }\n  return s;\n}\n',
  },
  'b-inrange-inclusive': {
    source: 'bool inrange(uint32_t x, uint32_t lo, uint32_t hi) {\n  return x > lo && x < hi;\n}\n',
    reference:
      'bool inrange(uint32_t x, uint32_t lo, uint32_t hi) {\n  return x >= lo && x <= hi;\n}\n',
  },
  'b-bounds-largest': {
    source:
      'rec2_t bounds(const uint32_t *a) {\n  uint32_t lo = 0xFFFFFFFFu;\n  uint32_t hi = 0;\n  for (uint32_t i = 0; i < 4; i++) {\n    uint32_t x = a[i % 4];\n    if (x < lo) lo = x;\n    if (x < hi) hi = x;\n  }\n  return (rec2_t){lo, hi};\n}\n',
    reference:
      'rec2_t bounds(const uint32_t *a) {\n  uint32_t lo = 0xFFFFFFFFu;\n  uint32_t hi = 0;\n  for (uint32_t i = 0; i < 4; i++) {\n    uint32_t x = a[i % 4];\n    if (x < lo) lo = x;\n    if (x > hi) hi = x;\n  }\n  return (rec2_t){lo, hi};\n}\n',
  },
  'b-checksum-poly': {
    source:
      'uint32_t checksum(const uint32_t *a) {\n  uint32_t h = 0;\n  for (uint32_t i = 0; i < 4; i++) {\n    h = h ^ a[i % 4];\n  }\n  return h;\n}\n',
    reference:
      'uint32_t checksum(const uint32_t *a) {\n  uint32_t h = 7;\n  for (uint32_t i = 0; i < 4; i++) {\n    h = h * 31 + a[i % 4];\n  }\n  return h;\n}\n',
  },
  'b-norm2-dot': {
    source:
      'uint32_t dot(const uint32_t *a, const uint32_t *b) {\n  uint32_t s = 0;\n  for (uint32_t i = 0; i < 4; i++) {\n    s = s + a[i % 4] * b[i % 4];\n  }\n  return s;\n}\n',
    reference:
      'uint32_t dot(const uint32_t *a, const uint32_t *b) {\n  uint32_t s = 0;\n  for (uint32_t i = 0; i < 4; i++) {\n    s = s + a[i % 4] * b[i % 4];\n  }\n  return s;\n}\nuint32_t norm2(const uint32_t *a) {\n  return dot(a, a);\n}\n',
  },
  'b-pctof-limit': {
    source:
      'uint32_t limit(uint32_t x, uint32_t lo, uint32_t hi) {\n  uint32_t b = x < lo ? lo : x;\n  return b > hi ? hi : b;\n}\n',
    reference:
      'uint32_t limit(uint32_t x, uint32_t lo, uint32_t hi) {\n  uint32_t b = x < lo ? lo : x;\n  return b > hi ? hi : b;\n}\nuint32_t pctof(uint32_t part, uint32_t whole) {\n  uint32_t n = part * 100;\n  uint32_t q = whole == 0 ? 0xFFFFFFFFu : n / whole;\n  return limit(q, 0, 100);\n}\n',
  },
  'b-hamming-popcnt': {
    source:
      'uint32_t popcnt(uint32_t x) {\n  uint32_t s = 0;\n  for (uint32_t i = 0; i < 32; i++) {\n    s = s + ((x >> i) & 1);\n  }\n  return s;\n}\n',
    reference:
      'uint32_t popcnt(uint32_t x) {\n  uint32_t s = 0;\n  for (uint32_t i = 0; i < 32; i++) {\n    s = s + ((x >> i) & 1);\n  }\n  return s;\n}\nuint32_t hamming(uint32_t a, uint32_t b) {\n  return popcnt(a ^ b);\n}\n',
  },
};

/** Set-A originals and set-C extras that fill the project program (the C++ text, with C types). */
const FILLER = `uint32_t affine(uint32_t x, uint32_t scale, uint32_t offset) {
  return x * scale + offset;
}
uint32_t clamp(uint32_t x, uint32_t hi) {
  return hi < x ? hi : x;
}
uint32_t rotl(uint32_t x, uint32_t n) {
  return (x << (n & 31)) | (x << ((32 - n) & 31));
}
uint32_t sq(uint32_t x) {
  return x * x;
}
uint32_t quad(uint32_t x) {
  return sq(x);
}
uint32_t absdiff(uint32_t a, uint32_t b) {
  return a - b;
}
uint32_t combine4(uint32_t a, uint32_t b, uint32_t c, uint32_t d) {
  return a + b + c + d;
}
uint32_t min2(uint32_t a, uint32_t b) {
  return b < a ? b : a;
}
uint32_t sumto(uint32_t n) {
  uint32_t s = 0;
  for (uint32_t i = 0; i < n; i++) {
    s += i;
  }
  return s;
}
uint32_t countup(uint32_t limit, uint32_t cap) {
  uint32_t s = 0;
  for (uint32_t i = 0; i < cap; i++) {
    if (!(s < limit)) {
      break;
    }
    s += 1;
  }
  return s;
}
uint32_t pick(rec2_t r) {
  return r.f0;
}
uint32_t byte1(uint32_t x) {
  return (x >> 8) & 0xFF;
}
uint32_t sadd(uint32_t a, uint32_t b) {
  return a + b;
}
bool is_even(uint32_t x) {
  return (x & 1) == 0;
}
uint32_t addi(uint32_t acc, uint32_t i) {
  return acc + i;
}
uint32_t inc(uint32_t s, uint32_t i, uint32_t limit) {
  return s + 1;
}
bool below(uint32_t s, uint32_t i, uint32_t limit) {
  return s < limit;
}
uint32_t addel(uint32_t acc, uint32_t i, const uint32_t *a) {
  return acc + a[i % 4];
}
rec2_t minmax(rec2_t acc, uint32_t i, const uint32_t *a) {
  uint32_t lo = acc.f0;
  uint32_t hi = acc.f1;
  uint32_t x = a[i % 4];
  uint32_t nlo = x < lo ? x : lo;
  uint32_t nhi = x < hi ? x : hi;
  return (rec2_t){nlo, nhi};
}
uint32_t mixel(uint32_t acc, uint32_t i, const uint32_t *a) {
  return acc ^ a[i % 4];
}
uint32_t dstep(uint32_t acc, uint32_t i, const uint32_t *a, const uint32_t *b) {
  return acc + a[i % 4] * b[i % 4];
}
uint32_t pstep(uint32_t acc, uint32_t i, uint32_t x) {
  return acc + ((x >> (i & 31)) & 1);
}
uint32_t nb(const uint32_t *grid, uint32_t r, uint32_t c) {
  uint32_t row = grid[r % 32];
  return (row >> (c & 31)) & 1;
}
uint32_t count(const uint32_t *grid, uint32_t r, uint32_t c) {
  uint32_t ru = r - 1;
  uint32_t rd = r + 1;
  uint32_t cl = c - 1;
  uint32_t cr = c + 1;
  uint32_t s = nb(grid, ru, cl);
  s += nb(grid, ru, c);
  s += nb(grid, ru, cr);
  s += nb(grid, r, cl);
  s += nb(grid, r, cr);
  s += nb(grid, rd, cl);
  s += nb(grid, rd, c);
  s += nb(grid, rd, cr);
  return s;
}
uint32_t bitstep(uint32_t acc, uint32_t i, uint32_t x) {
  return acc + ((x >> (i & 31)) & 1);
}
uint32_t popcount(uint32_t x) {
  uint32_t n = 0;
  for (uint32_t i = 0; i < 32; i++) {
    n = bitstep(n, i, x);
  }
  return n;
}
uint32_t rowpop(uint32_t acc, uint32_t i, const uint32_t *grid) {
  return acc + popcount(grid[i % 32]);
}
uint32_t population(const uint32_t *grid) {
  uint32_t n = 0;
  for (uint32_t i = 0; i < 32; i++) {
    n = rowpop(n, i, grid);
  }
  return n;
}
`;

/** One generated filler helper (tools/ai-edit-tasks-c.ts generateFiller) as C. */
function fillerText(f: FillerFunction): string {
  const s = f.spec;
  const fn = (params: string, e: string): string =>
    `uint32_t ${f.name}(${params}) {\n  return ${e};\n}\n`;
  switch (s.template) {
    case 'lin':
      return fn('uint32_t x', `x * ${s.m}u + ${s.c}u`);
    case 'xs':
      return fn('uint32_t x', `x ^ (x >> ${s.s})`);
    case 'cap':
      return fn('uint32_t x', `x < ${s.c}u ? x : ${s.c}u`);
    case 'pair':
      return fn('uint32_t a, uint32_t b', `(a + b) ^ ${s.c}u`);
    case 'sum':
      return fn('uint32_t x', `${s.g}(x) + ${s.h}(x)`);
    case 'mixin':
      return fn('uint32_t a, uint32_t b', `${s.g}(a) ^ b`);
  }
}

export const C: LangSpec = {
  semantics:
    'Integers are uint32_t (stdint.h) with wrapping unsigned arithmetic; mask shift counts to 5 bits (& 31); comparisons are unsigned; booleans are bool; records are the rec2_t struct (fields f0, f1) and u32x4 values are const uint32_t * to four elements. Division by zero gives 4294967295; remainder by zero gives the dividend. The file is mod.c with the header shown, compiled with clang -O2 separately from the driver and linked (functions must be non-static with external linkage).',
  head: /^[A-Za-z_][A-Za-z0-9_ ]*[ *]([a-z_][A-Za-z0-9_]*)\(/,
  file: (body) => `${HEADER}\n${body}`,
  b: B,
  filler: FILLER,
  fillerText,
  driver,
  compileLabel: 'clang',
  async buildAndRun(dir, source, drv) {
    const clang = tool('clang', 'A0_CLANG', ['/usr/bin/clang']);
    await writeFile(join(dir, 'mod.c'), source, 'utf8');
    await writeFile(join(dir, 'main.c'), drv, 'utf8');
    const flags = ['-O2', '-std=c11'];
    const cand = runTool(clang, [...flags, '-c', 'mod.c', '-o', 'mod.o'], {
      cwd: dir,
      timeoutMs: BUILD_MS,
    });
    if (!cand.ok) return failure('clang', cand);
    const link = runTool(clang, [...flags, 'main.c', 'mod.o', '-o', 'prog'], {
      cwd: dir,
      timeoutMs: BUILD_MS,
    });
    if (!link.ok) return failure('clang', link);
    const run = runTool(join(dir, 'prog'), [], { cwd: dir, timeoutMs: RUN_MS });
    if (!run.ok) return failure('run', run);
    return { stdout: run.stdout };
  },
};
