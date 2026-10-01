/**
 * Lua 5.5: u32 values are 64-bit integers masked with & 0xFFFFFFFF after every operation that
 * can leave the range; records and u32x4 arrays are tables (1-based). Checked with luac -p.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Value } from '../../src/core.js';
import { runTool } from '../../src/toolchain.js';
import { BUILD_MS, failure, type LangCase, type LangSpec, RUN_MS, tool } from './spec.js';

const M = '0xFFFFFFFF';

function literal(v: Value): string {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return `{${Array.from(v as ArrayLike<Value>, literal).join(', ')}}`;
}

function driver(tests: readonly LangCase[]): string {
  const body = tests
    .map((t, i) => `print("R${i} " .. fmt(${t.fn}(${t.args.map(literal).join(', ')})))`)
    .join('\n');
  return `dofile('mod.lua')

local function fmt(v)
  if type(v) == 'table' then
    local parts = {}
    for i = 1, #v do
      parts[i] = fmt(v[i])
    end
    return '[' .. table.concat(parts, ',') .. ']'
  end
  return tostring(v)
end

${body}
print('DONE')
`;
}

const B: LangSpec['b'] = {
  'b-fits-inclusive': {
    source: 'function fits(a, b)\n  return a < b\nend\n',
    reference: 'function fits(a, b)\n  return a <= b\nend\n',
  },
  'b-sumfrom-eight': {
    source: `function sumfrom(x)\n  local s = x\n  for i = 0, 4 do\n    s = (s + i) & ${M}\n  end\n  return s\nend\n`,
    reference: `function sumfrom(x)\n  local s = x\n  for i = 0, 7 do\n    s = (s + i) & ${M}\n  end\n  return s\nend\n`,
  },
  'b-rot8-constant': {
    source: `function rot8(x)\n  return ((x << 8) | (x >> 23)) & ${M}\nend\n`,
    reference: `function rot8(x)\n  return ((x << 8) | (x >> 24)) & ${M}\nend\n`,
  },
  'b-onlyone-xor': {
    source: 'function onlyone(a, b)\n  return a or b\nend\n',
    reference: 'function onlyone(a, b)\n  return a ~= b\nend\n',
  },
  'b-avgfloor-nowrap': {
    source: `function avgfloor(a, b)\n  return ((a + b) & ${M}) >> 1\nend\n`,
    reference: 'function avgfloor(a, b)\n  return (a & b) + ((a ~ b) >> 1)\nend\n',
  },
  'b-sumsq-array': {
    source: `function sumsq(a)\n  local s = 0\n  for i = 1, 4 do\n    s = (s + a[i]) & ${M}\n  end\n  return s\nend\n`,
    reference: `function sumsq(a)\n  local s = 0\n  for i = 1, 4 do\n    s = (s + a[i] * a[i]) & ${M}\n  end\n  return s\nend\n`,
  },
  'b-inrange-inclusive': {
    source: 'function inrange(x, lo, hi)\n  return x > lo and x < hi\nend\n',
    reference: 'function inrange(x, lo, hi)\n  return x >= lo and x <= hi\nend\n',
  },
  'b-bounds-largest': {
    source: `function bounds(a)\n  local lo = ${M}\n  local hi = 0\n  for i = 1, 4 do\n    local x = a[i]\n    if x < lo then lo = x end\n    if x < hi then hi = x end\n  end\n  return {lo, hi}\nend\n`,
    reference: `function bounds(a)\n  local lo = ${M}\n  local hi = 0\n  for i = 1, 4 do\n    local x = a[i]\n    if x < lo then lo = x end\n    if x > hi then hi = x end\n  end\n  return {lo, hi}\nend\n`,
  },
  'b-checksum-poly': {
    source:
      'function checksum(a)\n  local h = 0\n  for i = 1, 4 do\n    h = h ~ a[i]\n  end\n  return h\nend\n',
    reference: `function checksum(a)\n  local h = 7\n  for i = 1, 4 do\n    h = (h * 31 + a[i]) & ${M}\n  end\n  return h\nend\n`,
  },
  'b-norm2-dot': {
    source: `function dot(a, b)\n  local s = 0\n  for i = 1, 4 do\n    s = (s + a[i] * b[i]) & ${M}\n  end\n  return s\nend\n`,
    reference: `function dot(a, b)\n  local s = 0\n  for i = 1, 4 do\n    s = (s + a[i] * b[i]) & ${M}\n  end\n  return s\nend\nfunction norm2(a)\n  return dot(a, a)\nend\n`,
  },
  'b-pctof-limit': {
    source:
      'function limit(x, lo, hi)\n  local b = x\n  if x < lo then b = lo end\n  if b > hi then return hi end\n  return b\nend\n',
    reference: `function limit(x, lo, hi)\n  local b = x\n  if x < lo then b = lo end\n  if b > hi then return hi end\n  return b\nend\nfunction pctof(part, whole)\n  local n = (part * 100) & ${M}\n  local q = ${M}\n  if whole ~= 0 then q = n // whole end\n  return limit(q, 0, 100)\nend\n`,
  },
  'b-hamming-popcnt': {
    source: `function popcnt(x)\n  local s = 0\n  for i = 0, 31 do\n    s = (s + ((x >> i) & 1)) & ${M}\n  end\n  return s\nend\n`,
    reference: `function popcnt(x)\n  local s = 0\n  for i = 0, 31 do\n    s = (s + ((x >> i) & 1)) & ${M}\n  end\n  return s\nend\nfunction hamming(a, b)\n  return popcnt(a ~ b)\nend\n`,
  },
};

export const LUA: LangSpec = {
  semantics: `Integers are unsigned 32-bit held in Lua 64-bit integers: mask every arithmetic result with & ${M}, mask shift counts to 5 bits (& 31); comparisons are unsigned. Division by zero gives 4294967295; remainder by zero gives the dividend. Arrays and records are 1-based tables; functions are globals and the file must load with lua.`,
  head: /^function ([A-Za-z_][A-Za-z0-9_]*)\(/,
  file: (body) => body,
  b: B,
  driver,
  compileLabel: 'luac',
  async buildAndRun(dir, source, drv) {
    const bin = tool('lua', 'A0_LUA', ['/opt/homebrew/bin/lua']);
    const luac = tool('luac', 'A0_LUAC', ['/opt/homebrew/bin/luac']);
    await writeFile(join(dir, 'mod.lua'), source, 'utf8');
    await writeFile(join(dir, 'driver.lua'), drv, 'utf8');
    const check = runTool(luac, ['-p', join(dir, 'mod.lua')], { cwd: dir, timeoutMs: BUILD_MS });
    if (!check.ok) return failure('luac', check);
    const run = runTool(bin, [join(dir, 'driver.lua')], { cwd: dir, timeoutMs: RUN_MS });
    if (!run.ok) return failure('run', run);
    return { stdout: run.stdout };
  },
};
