/**
 * F#: u32 values are uint32 (unchecked, wrapping arithmetic, unsigned compares, shift counts
 * masked by the runtime); u32x4 arrays are uint32[], records are tuples. Built with dotnet
 * build (Lib.fs holding the candidate, then Driver.fs) and run with dotnet.
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
  if (typeof v === 'number') return `${v}u`;
  if (typeof v === 'boolean') return String(v);
  const fields = recordFields(t);
  const items = Array.from(v as ArrayLike<Value>, (x, i) => literal(x, fields[i]));
  return fields.length > 0 ? `(${items.join(', ')})` : `[| ${items.join('; ')} |]`;
}

function render(expr: string, t: Type | undefined, depth = 0): string {
  if (t === 'bool') return `(if ${expr} then "true" else "false")`;
  const fields = recordFields(t);
  if (fields.length > 0) {
    const names = fields.map((_, i) => `f${depth}_${i}`);
    const parts = fields.map((ft, i) => render(names[i] ?? '', ft, depth + 1));
    return `(let (${names.join(', ')}) = ${expr} in "[" + ${parts.join(' + "," + ')} + "]")`;
  }
  return `(string ${expr})`;
}

function driver(tests: readonly LangCase[], typed: Parameters<LangSpec['driver']>[1]): string {
  const body = tests
    .map((t, i) => {
      const { params, result } = signature(typed, t.fn);
      const args = t.args.map((a, k) => ` (${literal(a, params[k])})`).join('');
      return `printfn "%s" ("R${i} " + ${render(`(Lib.${t.fn}${args})`, result)})`;
    })
    .join('\n');
  return `${body}\nprintfn "DONE"\n`;
}

const B: LangSpec['b'] = {
  'b-fits-inclusive': {
    source: 'let fits (a: uint32) (b: uint32) : bool =\n    a < b\n',
    reference: 'let fits (a: uint32) (b: uint32) : bool =\n    a <= b\n',
  },
  'b-sumfrom-eight': {
    source:
      'let sumfrom (x: uint32) : uint32 =\n    let mutable s = x\n    for i in 0u .. 4u do\n        s <- s + i\n    s\n',
    reference:
      'let sumfrom (x: uint32) : uint32 =\n    let mutable s = x\n    for i in 0u .. 7u do\n        s <- s + i\n    s\n',
  },
  'b-rot8-constant': {
    source: 'let rot8 (x: uint32) : uint32 =\n    (x <<< 8) ||| (x >>> 23)\n',
    reference: 'let rot8 (x: uint32) : uint32 =\n    (x <<< 8) ||| (x >>> 24)\n',
  },
  'b-onlyone-xor': {
    source: 'let onlyone (a: bool) (b: bool) : bool =\n    a || b\n',
    reference: 'let onlyone (a: bool) (b: bool) : bool =\n    a <> b\n',
  },
  'b-avgfloor-nowrap': {
    source: 'let avgfloor (a: uint32) (b: uint32) : uint32 =\n    (a + b) >>> 1\n',
    reference:
      'let avgfloor (a: uint32) (b: uint32) : uint32 =\n    (a &&& b) + ((a ^^^ b) >>> 1)\n',
  },
  'b-sumsq-array': {
    source:
      'let sumsq (a: uint32[]) : uint32 =\n    let mutable s = 0u\n    for i in 0 .. 3 do\n        s <- s + a.[i]\n    s\n',
    reference:
      'let sumsq (a: uint32[]) : uint32 =\n    let mutable s = 0u\n    for i in 0 .. 3 do\n        s <- s + a.[i] * a.[i]\n    s\n',
  },
  'b-inrange-inclusive': {
    source: 'let inrange (x: uint32) (lo: uint32) (hi: uint32) : bool =\n    x > lo && x < hi\n',
    reference:
      'let inrange (x: uint32) (lo: uint32) (hi: uint32) : bool =\n    x >= lo && x <= hi\n',
  },
  'b-bounds-largest': {
    source:
      'let bounds (a: uint32[]) : uint32 * uint32 =\n    let mutable lo = 4294967295u\n    let mutable hi = 0u\n    for i in 0 .. 3 do\n        let x = a.[i]\n        if x < lo then lo <- x\n        if x < hi then hi <- x\n    (lo, hi)\n',
    reference:
      'let bounds (a: uint32[]) : uint32 * uint32 =\n    let mutable lo = 4294967295u\n    let mutable hi = 0u\n    for i in 0 .. 3 do\n        let x = a.[i]\n        if x < lo then lo <- x\n        if x > hi then hi <- x\n    (lo, hi)\n',
  },
  'b-checksum-poly': {
    source:
      'let checksum (a: uint32[]) : uint32 =\n    let mutable h = 0u\n    for i in 0 .. 3 do\n        h <- h ^^^ a.[i]\n    h\n',
    reference:
      'let checksum (a: uint32[]) : uint32 =\n    let mutable h = 7u\n    for i in 0 .. 3 do\n        h <- h * 31u + a.[i]\n    h\n',
  },
  'b-norm2-dot': {
    source:
      'let dot (a: uint32[]) (b: uint32[]) : uint32 =\n    let mutable s = 0u\n    for i in 0 .. 3 do\n        s <- s + a.[i] * b.[i]\n    s\n',
    reference:
      'let dot (a: uint32[]) (b: uint32[]) : uint32 =\n    let mutable s = 0u\n    for i in 0 .. 3 do\n        s <- s + a.[i] * b.[i]\n    s\nlet norm2 (a: uint32[]) : uint32 =\n    dot a a\n',
  },
  'b-pctof-limit': {
    source:
      'let limit (x: uint32) (lo: uint32) (hi: uint32) : uint32 =\n    let b = if x < lo then lo else x\n    if b > hi then hi else b\n',
    reference:
      'let limit (x: uint32) (lo: uint32) (hi: uint32) : uint32 =\n    let b = if x < lo then lo else x\n    if b > hi then hi else b\nlet pctof (part: uint32) (whole: uint32) : uint32 =\n    let n = part * 100u\n    let q = if whole = 0u then 4294967295u else n / whole\n    limit q 0u 100u\n',
  },
  'b-hamming-popcnt': {
    source:
      'let popcnt (x: uint32) : uint32 =\n    let mutable s = 0u\n    for i in 0 .. 31 do\n        s <- s + ((x >>> i) &&& 1u)\n    s\n',
    reference:
      'let popcnt (x: uint32) : uint32 =\n    let mutable s = 0u\n    for i in 0 .. 31 do\n        s <- s + ((x >>> i) &&& 1u)\n    s\nlet hamming (a: uint32) (b: uint32) : uint32 =\n    popcnt (a ^^^ b)\n',
  },
};

const PROJECT =
  '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <OutputType>Exe</OutputType>\n    <TargetFramework>net10.0</TargetFramework>\n    <AssemblyName>candidate</AssemblyName>\n    <UseAppHost>false</UseAppHost>\n    <InvariantGlobalization>true</InvariantGlobalization>\n    <SatelliteResourceLanguages>en</SatelliteResourceLanguages>\n    <TreatWarningsAsErrors>false</TreatWarningsAsErrors>\n    <GenerateDocumentationFile>false</GenerateDocumentationFile>\n  </PropertyGroup>\n  <ItemGroup>\n    <Compile Include="Lib.fs" />\n    <Compile Include="Driver.fs" />\n  </ItemGroup>\n</Project>\n';

export const FSHARP: LangSpec = {
  semantics:
    'Integers are uint32: arithmetic wraps mod 2^32, comparisons are unsigned and shift counts are masked to 5 bits by the runtime; records are tuples (uint32 * uint32) and u32x4 values are uint32[] (a.[i]). Division by zero throws, so guard it (result 4294967295; remainder by zero gives the dividend). The file is Lib.fs (module Lib) and must build with dotnet build; callers use Lib.name with curried arguments.',
  head: /^let (?:rec )?([a-z_][A-Za-z0-9_']*)[ =]/,
  file: (body) => `module Lib\n\n${body}`,
  b: B,
  driver,
  compileLabel: 'dotnet',
  async buildAndRun(dir, source, drv) {
    const dotnet = tool('dotnet', 'A0_DOTNET', [
      `${process.env.HOME ?? ''}/.dotnet/dotnet`,
      '/usr/local/share/dotnet/dotnet',
      '/opt/homebrew/bin/dotnet',
    ]);
    await writeFile(join(dir, 'Lib.fs'), source, 'utf8');
    await writeFile(join(dir, 'Driver.fs'), drv, 'utf8');
    await writeFile(join(dir, 'candidate.fsproj'), PROJECT, 'utf8');
    const env = {
      ...process.env,
      DOTNET_CLI_TELEMETRY_OPTOUT: '1',
      DOTNET_NOLOGO: '1',
      DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
      DOTNET_CLI_UI_LANGUAGE: 'en',
    };
    const build = runTool(
      dotnet,
      ['build', '-c', 'Release', '-o', join(dir, 'out'), '--nologo', '-v', 'q', '-nodeReuse:false'],
      { cwd: dir, env, timeoutMs: BUILD_MS },
    );
    if (!build.ok) {
      const errors = build.stdout
        .split('\n')
        .filter((l) => l.includes('error'))
        .join('\n');
      return failure('dotnet', { stdout: errors || build.stdout, stderr: build.stderr });
    }
    const run = runTool(dotnet, [join(dir, 'out', 'candidate.dll')], {
      cwd: dir,
      env,
      timeoutMs: RUN_MS,
    });
    if (!run.ok) return failure('run', run);
    return { stdout: run.stdout };
  },
};
