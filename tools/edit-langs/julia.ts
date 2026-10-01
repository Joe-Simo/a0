/**
 * Julia: u32 values are native UInt32 (arithmetic wraps mod 2^32, shifts by 32 or more give
 * 0); records are tuples and u32x4 arrays are Vector{UInt32}. The candidate is parsed first
 * (Meta.parseall), then included by the generated driver and run with julia.
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
  if (typeof v === 'number') return `UInt32(${v})`;
  if (typeof v === 'boolean') return String(v);
  const fields = recordFields(t);
  const items = Array.from(v as ArrayLike<Value>, (x, i) => literal(x, fields[i]));
  if (fields.length > 0) return `(${items.join(', ')}${items.length === 1 ? ',' : ''})`;
  return `UInt32[${items.join(', ')}]`;
}

function driver(tests: readonly LangCase[], typed: Parameters<LangSpec['driver']>[1]): string {
  const body = tests
    .map((t, i) => {
      const { params } = signature(typed, t.fn);
      const args = t.args.map((a, k) => literal(a, params[k])).join(', ');
      return `println("R${i} ", fmt(${t.fn}(${args})))`;
    })
    .join('\n');
  return `include("mod.jl")

fmt(v::Bool) = v ? "true" : "false"
fmt(v::Integer) = string(v)
fmt(v::Union{Tuple,AbstractVector}) = "[" * join(map(fmt, v), ",") * "]"

${body}
println("DONE")
`;
}

const CHECK = `function finderr(e)
    e isa Expr || return nothing
    (e.head === :error || e.head === :incomplete) && return e
    for a in e.args
        r = finderr(a)
        r === nothing || return r
    end
    return nothing
end
e = finderr(Meta.parseall(read(ARGS[1], String)))
if e !== nothing
    println(stderr, "syntax error: ", e)
    exit(1)
end
`;

const B: LangSpec['b'] = {
  'b-fits-inclusive': {
    source: 'function fits(a::UInt32, b::UInt32)::Bool\n    return a < b\nend\n',
    reference: 'function fits(a::UInt32, b::UInt32)::Bool\n    return a <= b\nend\n',
  },
  'b-sumfrom-eight': {
    source:
      'function sumfrom(x::UInt32)::UInt32\n    s = x\n    for i in 0:4\n        s = s + UInt32(i)\n    end\n    return s\nend\n',
    reference:
      'function sumfrom(x::UInt32)::UInt32\n    s = x\n    for i in 0:7\n        s = s + UInt32(i)\n    end\n    return s\nend\n',
  },
  'b-rot8-constant': {
    source: 'function rot8(x::UInt32)::UInt32\n    return (x << 8) | (x >> 23)\nend\n',
    reference: 'function rot8(x::UInt32)::UInt32\n    return (x << 8) | (x >> 24)\nend\n',
  },
  'b-onlyone-xor': {
    source: 'function onlyone(a::Bool, b::Bool)::Bool\n    return a || b\nend\n',
    reference: 'function onlyone(a::Bool, b::Bool)::Bool\n    return a != b\nend\n',
  },
  'b-avgfloor-nowrap': {
    source: 'function avgfloor(a::UInt32, b::UInt32)::UInt32\n    return (a + b) >> 1\nend\n',
    reference:
      'function avgfloor(a::UInt32, b::UInt32)::UInt32\n    return (a & b) + (xor(a, b) >> 1)\nend\n',
  },
  'b-sumsq-array': {
    source:
      'function sumsq(a::Vector{UInt32})::UInt32\n    s = UInt32(0)\n    for i in 0:3\n        s = s + a[i % 4 + 1]\n    end\n    return s\nend\n',
    reference:
      'function sumsq(a::Vector{UInt32})::UInt32\n    s = UInt32(0)\n    for i in 0:3\n        x = a[i % 4 + 1]\n        s = s + x * x\n    end\n    return s\nend\n',
  },
  'b-inrange-inclusive': {
    source:
      'function inrange(x::UInt32, lo::UInt32, hi::UInt32)::Bool\n    return x > lo && x < hi\nend\n',
    reference:
      'function inrange(x::UInt32, lo::UInt32, hi::UInt32)::Bool\n    return x >= lo && x <= hi\nend\n',
  },
  'b-bounds-largest': {
    source:
      'function bounds(a::Vector{UInt32})::Tuple{UInt32,UInt32}\n    lo = 0xffffffff\n    hi = UInt32(0)\n    for i in 0:3\n        x = a[i % 4 + 1]\n        if x < lo\n            lo = x\n        end\n        if x < hi\n            hi = x\n        end\n    end\n    return (lo, hi)\nend\n',
    reference:
      'function bounds(a::Vector{UInt32})::Tuple{UInt32,UInt32}\n    lo = 0xffffffff\n    hi = UInt32(0)\n    for i in 0:3\n        x = a[i % 4 + 1]\n        if x < lo\n            lo = x\n        end\n        if x > hi\n            hi = x\n        end\n    end\n    return (lo, hi)\nend\n',
  },
  'b-checksum-poly': {
    source:
      'function checksum(a::Vector{UInt32})::UInt32\n    h = UInt32(0)\n    for i in 0:3\n        h = xor(h, a[i % 4 + 1])\n    end\n    return h\nend\n',
    reference:
      'function checksum(a::Vector{UInt32})::UInt32\n    h = UInt32(7)\n    for i in 0:3\n        h = h * UInt32(31) + a[i % 4 + 1]\n    end\n    return h\nend\n',
  },
  'b-norm2-dot': {
    source:
      'function dot(a::Vector{UInt32}, b::Vector{UInt32})::UInt32\n    s = UInt32(0)\n    for i in 0:3\n        s = s + a[i % 4 + 1] * b[i % 4 + 1]\n    end\n    return s\nend\n',
    reference:
      'function dot(a::Vector{UInt32}, b::Vector{UInt32})::UInt32\n    s = UInt32(0)\n    for i in 0:3\n        s = s + a[i % 4 + 1] * b[i % 4 + 1]\n    end\n    return s\nend\nfunction norm2(a::Vector{UInt32})::UInt32\n    return dot(a, a)\nend\n',
  },
  'b-pctof-limit': {
    source:
      'function limit(x::UInt32, lo::UInt32, hi::UInt32)::UInt32\n    b = x < lo ? lo : x\n    return b > hi ? hi : b\nend\n',
    reference:
      'function limit(x::UInt32, lo::UInt32, hi::UInt32)::UInt32\n    b = x < lo ? lo : x\n    return b > hi ? hi : b\nend\nfunction pctof(part::UInt32, whole::UInt32)::UInt32\n    n = part * UInt32(100)\n    q = whole == 0 ? 0xffffffff : div(n, whole)\n    return limit(q, UInt32(0), UInt32(100))\nend\n',
  },
  'b-hamming-popcnt': {
    source:
      'function popcnt(x::UInt32)::UInt32\n    s = UInt32(0)\n    for i in 0:31\n        s = s + ((x >> i) & UInt32(1))\n    end\n    return s\nend\n',
    reference:
      'function popcnt(x::UInt32)::UInt32\n    s = UInt32(0)\n    for i in 0:31\n        s = s + ((x >> i) & UInt32(1))\n    end\n    return s\nend\nfunction hamming(a::UInt32, b::UInt32)::UInt32\n    return popcnt(xor(a, b))\nend\n',
  },
};

export const JULIA: LangSpec = {
  semantics:
    'Values are UInt32: annotate parameters and results as UInt32 and use UInt32(...) for integer constants in arithmetic (a bare Int literal promotes the result to Int64); +, - and * wrap mod 2^32, shifts by 32 or more give 0, comparisons are unsigned, xor is xor(a, b). The file must parse and define the functions at top level; it is include()d and run with julia.',
  head: /^function ([a-z_][A-Za-z0-9_]*)\(/,
  file: (body) => body,
  b: B,
  driver,
  compileLabel: 'julia',
  async buildAndRun(dir, source, drv) {
    const julia = tool('julia', 'A0_JULIA', ['/opt/homebrew/bin/julia']);
    await writeFile(join(dir, 'mod.jl'), source, 'utf8');
    await writeFile(join(dir, 'check.jl'), CHECK, 'utf8');
    await writeFile(join(dir, 'driver.jl'), drv, 'utf8');
    const flags = ['--startup-file=no'];
    const check = runTool(julia, [...flags, join(dir, 'check.jl'), join(dir, 'mod.jl')], {
      cwd: dir,
      timeoutMs: BUILD_MS,
    });
    if (!check.ok) return failure('julia', check);
    const run = runTool(julia, [...flags, join(dir, 'driver.jl')], { cwd: dir, timeoutMs: RUN_MS });
    if (!run.ok) return failure('run', run);
    return { stdout: run.stdout };
  },
};
