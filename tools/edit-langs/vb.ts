/**
 * Visual Basic .NET: u32 values are UInteger. The project sets RemoveIntegerChecks, so
 * arithmetic wraps mod 2^32 (no overflow trap); comparisons are unsigned and shift counts
 * are masked to 5 bits by the runtime. Records are Tuple(Of UInteger, UInteger) and u32x4
 * arrays are UInteger(). Built with dotnet build (Lib.vb holding the candidate, then
 * Driver.vb) and run with dotnet.
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
  if (typeof v === 'number') return `${v}UI`;
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  const fields = recordFields(t);
  const items = Array.from(v as ArrayLike<Value>, (x, i) => literal(x, fields[i]));
  return fields.length > 0
    ? `Tuple.Create(${items.join(', ')})`
    : `New UInteger() {${items.join(', ')}}`;
}

function render(expr: string, t: Type | undefined): string {
  if (t === 'bool') return `If(${expr}, "true", "false")`;
  const fields = recordFields(t);
  if (fields.length > 0) {
    const parts = fields.map((ft, i) => render(`(${expr}).Item${i + 1}`, ft));
    return `"[" & ${parts.join(' & "," & ')} & "]"`;
  }
  return `(${expr}).ToString()`;
}

function driver(tests: readonly LangCase[], typed: Parameters<LangSpec['driver']>[1]): string {
  const body = tests
    .map((t, i) => {
      const { params, result } = signature(typed, t.fn);
      const args = t.args.map((a, k) => literal(a, params[k])).join(', ');
      return `        Console.WriteLine("R${i} " & ${render(`Cand.${t.fn}(${args})`, result)})`;
    })
    .join('\n');
  return `Imports System\n\nModule Driver\n    Sub Main()\n${body}\n        Console.WriteLine("DONE")\n    End Sub\nEnd Module\n`;
}

const fn = (sig: string, body: string): string => `Function ${sig}\n${body}End Function\n`;

const FITS = 'fits(a As UInteger, b As UInteger) As Boolean';
const SUMFROM = 'sumfrom(x As UInteger) As UInteger';
const sumfrom = (hi: number): string =>
  fn(
    SUMFROM,
    `    Dim s As UInteger = x\n    For i As UInteger = 0UI To ${hi}UI\n        s = s + i\n    Next\n    Return s\n`,
  );
const ROT8 = 'rot8(x As UInteger) As UInteger';
const ONLYONE = 'onlyone(a As Boolean, b As Boolean) As Boolean';
const AVGFLOOR = 'avgfloor(a As UInteger, b As UInteger) As UInteger';
const SUMSQ = 'sumsq(a As UInteger()) As UInteger';
const sumsq = (term: string): string =>
  fn(
    SUMSQ,
    `    Dim s As UInteger = 0UI\n    For i As Integer = 0 To 3\n        s = s + ${term}\n    Next\n    Return s\n`,
  );
const INRANGE = 'inrange(x As UInteger, lo As UInteger, hi As UInteger) As Boolean';
const BOUNDS = 'bounds(a As UInteger()) As Tuple(Of UInteger, UInteger)';
const bounds = (cmp: string): string =>
  fn(
    BOUNDS,
    `    Dim lo As UInteger = 4294967295UI\n    Dim hi As UInteger = 0UI\n    For i As Integer = 0 To 3\n        Dim x As UInteger = a(i)\n        If x < lo Then lo = x\n        If x ${cmp} hi Then hi = x\n    Next\n    Return Tuple.Create(lo, hi)\n`,
  );
const CHECKSUM = 'checksum(a As UInteger()) As UInteger';
const DOT = 'dot(a As UInteger(), b As UInteger()) As UInteger';
const dot = fn(
  DOT,
  '    Dim s As UInteger = 0UI\n    For i As Integer = 0 To 3\n        s = s + a(i) * b(i)\n    Next\n    Return s\n',
);
const LIMIT = 'limit(x As UInteger, lo As UInteger, hi As UInteger) As UInteger';
const limit = fn(
  LIMIT,
  '    Dim b As UInteger = If(x < lo, lo, x)\n    Return If(b > hi, hi, b)\n',
);
const POPCNT = 'popcnt(x As UInteger) As UInteger';
const popcnt = fn(
  POPCNT,
  '    Dim s As UInteger = 0UI\n    For i As Integer = 0 To 31\n        s = s + ((x >> i) And 1UI)\n    Next\n    Return s\n',
);

const B: LangSpec['b'] = {
  'b-fits-inclusive': {
    source: fn(FITS, '    Return a < b\n'),
    reference: fn(FITS, '    Return a <= b\n'),
  },
  'b-sumfrom-eight': { source: sumfrom(4), reference: sumfrom(7) },
  'b-rot8-constant': {
    source: fn(ROT8, '    Return (x << 8) Or (x >> 23)\n'),
    reference: fn(ROT8, '    Return (x << 8) Or (x >> 24)\n'),
  },
  'b-onlyone-xor': {
    source: fn(ONLYONE, '    Return a OrElse b\n'),
    reference: fn(ONLYONE, '    Return a <> b\n'),
  },
  'b-avgfloor-nowrap': {
    source: fn(AVGFLOOR, '    Return (a + b) >> 1\n'),
    reference: fn(AVGFLOOR, '    Return (a And b) + ((a Xor b) >> 1)\n'),
  },
  'b-sumsq-array': { source: sumsq('a(i)'), reference: sumsq('a(i) * a(i)') },
  'b-inrange-inclusive': {
    source: fn(INRANGE, '    Return x > lo AndAlso x < hi\n'),
    reference: fn(INRANGE, '    Return x >= lo AndAlso x <= hi\n'),
  },
  'b-bounds-largest': { source: bounds('<'), reference: bounds('>') },
  'b-checksum-poly': {
    source: fn(
      CHECKSUM,
      '    Dim h As UInteger = 0UI\n    For i As Integer = 0 To 3\n        h = h Xor a(i)\n    Next\n    Return h\n',
    ),
    reference: fn(
      CHECKSUM,
      '    Dim h As UInteger = 7UI\n    For i As Integer = 0 To 3\n        h = h * 31UI + a(i)\n    Next\n    Return h\n',
    ),
  },
  'b-norm2-dot': {
    source: dot,
    reference: `${dot}${fn('norm2(a As UInteger()) As UInteger', '    Return dot(a, a)\n')}`,
  },
  'b-pctof-limit': {
    source: limit,
    reference: `${limit}${fn(
      'pctof(part As UInteger, whole As UInteger) As UInteger',
      '    Dim n As UInteger = part * 100UI\n    Dim q As UInteger = If(whole = 0UI, 4294967295UI, n \\ whole)\n    Return limit(q, 0UI, 100UI)\n',
    )}`,
  },
  'b-hamming-popcnt': {
    source: popcnt,
    reference: `${popcnt}${fn('hamming(a As UInteger, b As UInteger) As UInteger', '    Return popcnt(a Xor b)\n')}`,
  },
};

const PROJECT =
  '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <OutputType>Exe</OutputType>\n    <TargetFramework>net10.0</TargetFramework>\n    <AssemblyName>candidate</AssemblyName>\n    <UseAppHost>false</UseAppHost>\n    <InvariantGlobalization>true</InvariantGlobalization>\n    <SatelliteResourceLanguages>en</SatelliteResourceLanguages>\n    <RootNamespace>Candidate</RootNamespace>\n    <OptionStrict>On</OptionStrict>\n    <RemoveIntegerChecks>true</RemoveIntegerChecks>\n    <GenerateDocumentationFile>false</GenerateDocumentationFile>\n  </PropertyGroup>\n</Project>\n';

export const VB: LangSpec = {
  semantics:
    'Integers are UInteger: with integer overflow checks removed (RemoveIntegerChecks) arithmetic wraps mod 2^32, comparisons are unsigned and shift counts are masked to 5 bits by the runtime; records are Tuple(Of UInteger, UInteger) and u32x4 values are UInteger() (a(i)). Integer division by zero throws, so guard it (result 4294967295; remainder by zero gives the dividend). The file is Lib.vb (Module Cand, Option Strict On) and must build with dotnet build; callers use Cand.name(args).',
  head: /^Function ([A-Za-z_][A-Za-z0-9_]*)\(/,
  file: (body) =>
    `Option Strict On\nImports System\n\nModule Cand\n${body
      .split('\n')
      .map((l) => (l.length > 0 ? `    ${l}` : l))
      .join('\n')}End Module\n`,
  b: B,
  driver,
  compileLabel: 'dotnet',
  async buildAndRun(dir, source, drv) {
    const dotnet = tool('dotnet', 'A0_DOTNET', [
      `${process.env.HOME ?? ''}/.dotnet/dotnet`,
      '/usr/local/share/dotnet/dotnet',
      '/opt/homebrew/bin/dotnet',
    ]);
    await writeFile(join(dir, 'Lib.vb'), source, 'utf8');
    await writeFile(join(dir, 'Driver.vb'), drv, 'utf8');
    await writeFile(join(dir, 'candidate.vbproj'), PROJECT, 'utf8');
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
