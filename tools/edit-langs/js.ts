/**
 * JavaScript (node): u32 values are numbers kept in range with >>> 0 after every operation
 * that can leave it, products use Math.imul; records and u32x4 arrays are Arrays. The
 * candidate is an ES module (mod.mjs) checked with node --check, the driver runs with node.
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
  if (typeof v === 'boolean') return String(v);
  const fields = recordFields(t);
  return `[${Array.from(v as ArrayLike<Value>, (x, i) => literal(x, fields[i])).join(', ')}]`;
}

function driver(tests: readonly LangCase[], typed: Parameters<LangSpec['driver']>[1]): string {
  const body = tests
    .map((t, i) => {
      const { params } = signature(typed, t.fn);
      const args = t.args.map((a, k) => literal(a, params[k])).join(', ');
      return `console.log('R${i} ' + show(m.${t.fn}(${args})));`;
    })
    .join('\n');
  return `import * as m from './mod.mjs';

function show(v) {
  return Array.isArray(v) ? '[' + v.map(show).join(',') + ']' : String(v);
}

${body}
console.log('DONE');
`;
}

const B: LangSpec['b'] = {
  'b-fits-inclusive': {
    source: 'export function fits(a, b) {\n  return a < b;\n}\n',
    reference: 'export function fits(a, b) {\n  return a <= b;\n}\n',
  },
  'b-sumfrom-eight': {
    source:
      'export function sumfrom(x) {\n  let s = x >>> 0;\n  for (let i = 0; i < 5; i++) {\n    s = (s + i) >>> 0;\n  }\n  return s;\n}\n',
    reference:
      'export function sumfrom(x) {\n  let s = x >>> 0;\n  for (let i = 0; i < 8; i++) {\n    s = (s + i) >>> 0;\n  }\n  return s;\n}\n',
  },
  'b-rot8-constant': {
    source: 'export function rot8(x) {\n  return ((x << 8) | (x >>> 23)) >>> 0;\n}\n',
    reference: 'export function rot8(x) {\n  return ((x << 8) | (x >>> 24)) >>> 0;\n}\n',
  },
  'b-onlyone-xor': {
    source: 'export function onlyone(a, b) {\n  return a || b;\n}\n',
    reference: 'export function onlyone(a, b) {\n  return a !== b;\n}\n',
  },
  'b-avgfloor-nowrap': {
    source: 'export function avgfloor(a, b) {\n  return ((a + b) >>> 0) >>> 1;\n}\n',
    reference: 'export function avgfloor(a, b) {\n  return ((a & b) + ((a ^ b) >>> 1)) >>> 0;\n}\n',
  },
  'b-sumsq-array': {
    source:
      'export function sumsq(a) {\n  let s = 0;\n  for (let i = 0; i < 4; i++) {\n    s = (s + a[i % 4]) >>> 0;\n  }\n  return s;\n}\n',
    reference:
      'export function sumsq(a) {\n  let s = 0;\n  for (let i = 0; i < 4; i++) {\n    const x = a[i % 4];\n    s = (s + Math.imul(x, x)) >>> 0;\n  }\n  return s;\n}\n',
  },
  'b-inrange-inclusive': {
    source: 'export function inrange(x, lo, hi) {\n  return x > lo && x < hi;\n}\n',
    reference: 'export function inrange(x, lo, hi) {\n  return x >= lo && x <= hi;\n}\n',
  },
  'b-bounds-largest': {
    source:
      'export function bounds(a) {\n  let lo = 0xffffffff;\n  let hi = 0;\n  for (let i = 0; i < 4; i++) {\n    const x = a[i % 4];\n    if (x < lo) lo = x;\n    if (x < hi) hi = x;\n  }\n  return [lo, hi];\n}\n',
    reference:
      'export function bounds(a) {\n  let lo = 0xffffffff;\n  let hi = 0;\n  for (let i = 0; i < 4; i++) {\n    const x = a[i % 4];\n    if (x < lo) lo = x;\n    if (x > hi) hi = x;\n  }\n  return [lo, hi];\n}\n',
  },
  'b-checksum-poly': {
    source:
      'export function checksum(a) {\n  let h = 0;\n  for (let i = 0; i < 4; i++) {\n    h = (h ^ a[i % 4]) >>> 0;\n  }\n  return h;\n}\n',
    reference:
      'export function checksum(a) {\n  let h = 7;\n  for (let i = 0; i < 4; i++) {\n    h = (Math.imul(h, 31) + a[i % 4]) >>> 0;\n  }\n  return h;\n}\n',
  },
  'b-norm2-dot': {
    source:
      'export function dot(a, b) {\n  let s = 0;\n  for (let i = 0; i < 4; i++) {\n    s = (s + Math.imul(a[i % 4], b[i % 4])) >>> 0;\n  }\n  return s;\n}\n',
    reference:
      'export function dot(a, b) {\n  let s = 0;\n  for (let i = 0; i < 4; i++) {\n    s = (s + Math.imul(a[i % 4], b[i % 4])) >>> 0;\n  }\n  return s;\n}\nexport function norm2(a) {\n  return dot(a, a);\n}\n',
  },
  'b-pctof-limit': {
    source:
      'export function limit(x, lo, hi) {\n  const b = x < lo ? lo : x;\n  return b > hi ? hi : b;\n}\n',
    reference:
      'export function limit(x, lo, hi) {\n  const b = x < lo ? lo : x;\n  return b > hi ? hi : b;\n}\nexport function pctof(part, whole) {\n  const n = Math.imul(part, 100) >>> 0;\n  const q = whole === 0 ? 0xffffffff : Math.floor(n / whole);\n  return limit(q, 0, 100);\n}\n',
  },
  'b-hamming-popcnt': {
    source:
      'export function popcnt(x) {\n  let s = 0;\n  for (let i = 0; i < 32; i++) {\n    s = (s + ((x >>> i) & 1)) >>> 0;\n  }\n  return s;\n}\n',
    reference:
      'export function popcnt(x) {\n  let s = 0;\n  for (let i = 0; i < 32; i++) {\n    s = (s + ((x >>> i) & 1)) >>> 0;\n  }\n  return s;\n}\nexport function hamming(a, b) {\n  return popcnt((a ^ b) >>> 0);\n}\n',
  },
};

export const JS: LangSpec = {
  semantics:
    'Values are unsigned 32-bit numbers: normalise every arithmetic, bitwise and shift result with >>> 0, multiply with Math.imul, and mask shift counts to 5 bits. The file is an ES module (exported functions, no type annotations) that must pass node --check and run with node.',
  head: /^export function ([A-Za-z_][A-Za-z0-9_]*)\(/,
  file: (body) => body,
  b: B,
  driver,
  compileLabel: 'node',
  async buildAndRun(dir, source, drv) {
    const node = tool('node', 'A0_NODE');
    await writeFile(join(dir, 'mod.mjs'), source, 'utf8');
    await writeFile(join(dir, 'driver.mjs'), drv, 'utf8');
    const check = runTool(node, ['--check', join(dir, 'mod.mjs')], {
      cwd: dir,
      timeoutMs: BUILD_MS,
    });
    if (!check.ok) return failure('node', check);
    const run = runTool(node, [join(dir, 'driver.mjs')], { cwd: dir, timeoutMs: RUN_MS });
    if (!run.ok) return failure('run', run);
    return { stdout: run.stdout };
  },
};
