/**
 * Second half of the baseline language table (see exec-bench-languages.ts for the contract).
 * Every entry: hand-written kernels with u32 semantics, a driver template printing
 * "ns-per-call checksum", a toolchain finder, and build/run commands. Toolchains that are
 * missing are reported as skipped-no-toolchain by the harness; a kernel whose checksum
 * does not match the A0 result is skipped-checksum-mismatch and never timed.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  args,
  each,
  javaOnly,
  type KernelSpec,
  type Language,
  locate,
  M,
  single,
  TIER,
  type Toolchain,
  versionLine,
} from './exec-bench-languages.js';

const cap = (s: string): string => `${s[0]?.toUpperCase() ?? ''}${s.slice(1)}`;
/** Capitalised argument names A0, A1, ... for Erlang and Prolog variables. */
const ARGS = (k: KernelSpec): string =>
  Array.from({ length: k.arity }, (_, i) => `A${i}`).join(', ');
/** Sequential generator steps as `s1 = rng(s0); a0 = s1; ...` for languages without mutation. */
const chain = (k: KernelSpec, step: (i: number) => string, sep: string): string =>
  Array.from({ length: k.arity }, (_, i) => step(i)).join(sep);

function dotnet(): Toolchain | undefined {
  const home = process.env.HOME ?? '';
  const p = locate('dotnet', 'A0_DOTNET', [
    `${home}/.dotnet/dotnet`,
    '/opt/homebrew/bin/dotnet',
    '/usr/local/share/dotnet/dotnet',
  ]);
  if (p === undefined) return undefined;
  const version = versionLine(p, ['--version']);
  const major = version.split('.')[0] ?? '10';
  return { version: `dotnet ${version}`, bin: { main: p, tfm: `net${major}.0` } };
}

const dotnetEnv = (): Readonly<Record<string, string>> => ({
  DOTNET_CLI_TELEMETRY_OPTOUT: '1',
  DOTNET_NOLOGO: '1',
  DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
  DOTNET_CLI_UI_LANGUAGE: 'en',
});

const dotnetProject = (t: Toolchain, extra: string, items = ''): string =>
  `<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <OutputType>Exe</OutputType>\n    <TargetFramework>${t.bin.tfm}</TargetFramework>\n    <AssemblyName>bench</AssemblyName>\n    <UseAppHost>false</UseAppHost>\n    <InvariantGlobalization>true</InvariantGlobalization>\n    <SatelliteResourceLanguages>en</SatelliteResourceLanguages>\n${extra}  </PropertyGroup>\n${items}</Project>\n`;

const dotnetBuild = (
  dir: string,
  t: Toolchain,
): readonly (readonly [string, readonly string[]])[] => [
  [t.bin.main as string, ['build', '-c', 'Release', '-o', join(dir, 'out'), '--nologo', '-v', 'q']],
];

/** JAVA_HOME for tools (scala-cli) that would otherwise pick the macOS java stub. */
function javaHome(java: string): string {
  const bin = dirname(java);
  const home = dirname(bin);
  const brewHome = join(home, 'libexec', 'openjdk.jdk', 'Contents', 'Home');
  return existsSync(brewHome) ? brewHome : home;
}

export const MORE_LANGUAGES: readonly Language[] = [
  // ---------------------------------------------------------------- C# (dotnet, Release)
  {
    id: 'csharp',
    label: 'C#',
    family: 'jit',
    startupGroup: 'compiled',
    iterations: TIER.jit,
    file: 'Program.cs',
    find: dotnet,
    env: dotnetEnv,
    kernels: {
      affine: 'static uint Affine(uint x, uint s, uint o) => x * s + o;',
      rotl: 'static uint Rotl(uint x, uint n) => (x << (int)(n & 31)) | (x >> (int)((32 - n) & 31));',
      clamp: 'static uint Clamp(uint x, uint lo, uint hi) => Math.Max(Math.Min(x, hi), lo);',
      mix: 'static uint Mix(uint x, uint y) { uint a = x ^ y; uint d = (a << 13) | (a >> 19); uint f = d * 2654435761u + x; return f ^ (f >> 16); }',
      ident: 'static uint Ident(uint x) => x;',
      noop: 'static uint Noop(uint x) => x;',
      chain3:
        'static uint Inc1(uint x) => x + 1;\nstatic uint Dbl(uint x) => x + x;\nstatic uint Chain3(uint x, uint y) => Inc1(Dbl(Inc1(x))) + y;',
      branchy:
        'static uint Branchy(uint x, uint y) { uint m = x < y ? y - x : x - y; uint z = x == y ? 0u : m; return (z & 1) == 1 ? z : x; }',
      arrfill:
        'static uint Arrfill(uint x, uint y) { Span<uint> a = stackalloc uint[8]; for (int i = 0; i < 8; i++) a[i] = (uint)i + x; return a[(int)(y % 8)] + a[3]; }',
      loop64:
        'static uint Loop64(uint s, uint k) { for (uint i = 0; i < 64; i++) { uint b = (s ^ k) * 2654435761u; s = (b ^ (b >> 15)) + i; } return s; }',
    },
    program: (k, src) => `using System;
using System.Diagnostics;
using System.Globalization;
static class Bench {
${src}
  static uint Rng(ref uint s) { uint x = s; x ^= x << 13; x ^= x >> 17; x ^= x << 5; s = x; return x; }
  static uint Run(long iters, ref uint s) {
    uint acc = 0;
    for (long i = 0; i < iters; i++) {
      ${each(k, (i) => `uint a${i} = Rng(ref s);`)}
      acc ^= ${cap(k.name)}(${args(k)});
    }
    return acc;
  }
  static void Main(string[] argv) {
    long iters = argv.Length > 0 ? long.Parse(argv[0], CultureInfo.InvariantCulture) : ${TIER.jit}L;
    uint s = 0x9e3779b9;
    Run(iters, ref s);
    s = 0x9e3779b9;
    var sw = Stopwatch.StartNew();
    uint acc = Run(iters, ref s);
    double ns = sw.Elapsed.TotalMilliseconds * 1e6 / iters;
    Console.WriteLine(string.Format(CultureInfo.InvariantCulture, "{0:F4} {1}", ns, acc));
  }
}
`,
    extraFiles: (_dir, t) => ({
      'bench.csproj': dotnetProject(
        t,
        '    <Nullable>enable</Nullable>\n    <ImplicitUsings>disable</ImplicitUsings>\n',
      ),
    }),
    build: dotnetBuild,
    run: (dir, t, iters) => [t.bin.main as string, [join(dir, 'out', 'bench.dll'), iters]],
  },
  // ---------------------------------------------------------------- F# (dotnet, Release)
  {
    id: 'fsharp',
    label: 'F#',
    family: 'jit',
    startupGroup: 'compiled',
    iterations: TIER.jit,
    file: 'Program.fs',
    find: dotnet,
    env: dotnetEnv,
    kernels: {
      affine: 'let affine (x: uint32) (s: uint32) (o: uint32) = x * s + o',
      rotl: 'let rotl (x: uint32) (n: uint32) = (x <<< int (n &&& 31u)) ||| (x >>> int ((32u - n) &&& 31u))',
      clamp: 'let clamp (x: uint32) (lo: uint32) (hi: uint32) = max (min x hi) lo',
      mix: 'let mix (x: uint32) (y: uint32) =\n    let a = x ^^^ y\n    let d = (a <<< 13) ||| (a >>> 19)\n    let f = d * 2654435761u + x\n    f ^^^ (f >>> 16)',
      ident: 'let ident (x: uint32) = x',
      noop: 'let noop (x: uint32) = x',
      chain3:
        'let inc1 (x: uint32) = x + 1u\nlet dbl (x: uint32) = x + x\nlet chain3 (x: uint32) (y: uint32) = inc1 (dbl (inc1 x)) + y',
      branchy:
        'let branchy (x: uint32) (y: uint32) =\n    let m = if x < y then y - x else x - y\n    let z = if x = y then 0u else m\n    if (z &&& 1u) = 1u then z else x',
      arrfill:
        'let arrfill (x: uint32) (y: uint32) =\n    let a = Array.zeroCreate<uint32> 8\n    for i in 0 .. 7 do\n        a.[i] <- uint32 i + x\n    a.[int (y % 8u)] + a.[3]',
      loop64:
        'let loop64 (s0: uint32) (k: uint32) =\n    let mutable s = s0\n    for i in 0u .. 63u do\n        let b = (s ^^^ k) * 2654435761u\n        s <- (b ^^^ (b >>> 15)) + i\n    s',
    },
    program: (k, src) => `open System.Diagnostics
open System.Globalization
${src}
let mutable state = 0x9e3779b9u
let rng () =
    let mutable x = state
    x <- x ^^^ (x <<< 13)
    x <- x ^^^ (x >>> 17)
    x <- x ^^^ (x <<< 5)
    state <- x
    x
let run (iters: int64) =
    state <- 0x9e3779b9u
    let mutable acc = 0u
    let mutable i = 0L
    while i < iters do
        ${each(k, (i) => `let a${i} = rng ()`, '\n        ')}
        acc <- acc ^^^ ${k.name} ${args(k, ' ')}
        i <- i + 1L
    acc
[<EntryPoint>]
let main argv =
    let iters = if argv.Length > 0 then int64 argv.[0] else ${TIER.jit}L
    run iters |> ignore
    let sw = Stopwatch.StartNew()
    let acc = run iters
    let ns = sw.Elapsed.TotalMilliseconds * 1e6 / float iters
    printfn "%s %u" (ns.ToString("F4", CultureInfo.InvariantCulture)) acc
    0
`,
    extraFiles: (_dir, t) => ({
      'bench.fsproj': dotnetProject(
        t,
        '',
        '  <ItemGroup>\n    <Compile Include="Program.fs" />\n  </ItemGroup>\n',
      ),
    }),
    build: dotnetBuild,
    run: (dir, t, iters) => [t.bin.main as string, [join(dir, 'out', 'bench.dll'), iters]],
  },
  // ---------------------------------------------------------------- Visual Basic (dotnet, Release)
  {
    id: 'vb',
    label: 'Visual Basic',
    family: 'jit',
    startupGroup: 'compiled',
    iterations: TIER.jit,
    file: 'Program.vb',
    find: dotnet,
    env: dotnetEnv,
    kernels: {
      affine:
        '    Function Affine(x As UInteger, s As UInteger, o As UInteger) As UInteger\n        Return x * s + o\n    End Function',
      rotl: '    Function Rotl(x As UInteger, n As UInteger) As UInteger\n        Return (x << CInt(n And 31UI)) Or (x >> CInt((32UI - n) And 31UI))\n    End Function',
      clamp:
        '    Function Clamp(x As UInteger, lo As UInteger, hi As UInteger) As UInteger\n        Dim t As UInteger = If(hi < x, hi, x)\n        Return If(t < lo, lo, t)\n    End Function',
      mix: '    Function Mix(x As UInteger, y As UInteger) As UInteger\n        Dim a As UInteger = x Xor y\n        Dim d As UInteger = (a << 13) Or (a >> 19)\n        Dim f As UInteger = d * 2654435761UI + x\n        Return f Xor (f >> 16)\n    End Function',
      ident: '    Function Ident(x As UInteger) As UInteger\n        Return x\n    End Function',
      noop: '    Function Noop(x As UInteger) As UInteger\n        Return x\n    End Function',
      chain3:
        '    Function Inc1(x As UInteger) As UInteger\n        Return x + 1UI\n    End Function\n    Function Dbl(x As UInteger) As UInteger\n        Return x + x\n    End Function\n    Function Chain3(x As UInteger, y As UInteger) As UInteger\n        Return Inc1(Dbl(Inc1(x))) + y\n    End Function',
      branchy:
        '    Function Branchy(x As UInteger, y As UInteger) As UInteger\n        Dim m As UInteger = If(x < y, y - x, x - y)\n        Dim z As UInteger = If(x = y, 0UI, m)\n        Return If((z And 1UI) = 1UI, z, x)\n    End Function',
      arrfill:
        '    Function Arrfill(x As UInteger, y As UInteger) As UInteger\n        Dim a(7) As UInteger\n        For i As UInteger = 0 To 7\n            a(CInt(i)) = i + x\n        Next\n        Return a(CInt(y Mod 8UI)) + a(3)\n    End Function',
      loop64:
        '    Function Loop64(s0 As UInteger, k As UInteger) As UInteger\n        Dim s As UInteger = s0\n        For i As UInteger = 0 To 63\n            Dim b As UInteger = (s Xor k) * 2654435761UI\n            s = (b Xor (b >> 15)) + i\n        Next\n        Return s\n    End Function',
    },
    program: (k, src) => `Imports System
Imports System.Diagnostics
Imports System.Globalization
Module Bench
${src}
    Function Rng(ByRef s As UInteger) As UInteger
        Dim x As UInteger = s
        x = x Xor (x << 13)
        x = x Xor (x >> 17)
        x = x Xor (x << 5)
        s = x
        Return x
    End Function
    Function Run(iters As Long, ByRef s As UInteger) As UInteger
        Dim acc As UInteger = 0
        For i As Long = 0 To iters - 1
            ${each(k, (i) => `Dim a${i} As UInteger = Rng(s)`, '\n            ')}
            acc = acc Xor ${cap(k.name)}(${args(k)})
        Next
        Return acc
    End Function
    Sub Main(argv As String())
        Dim iters As Long = If(argv.Length > 0, Long.Parse(argv(0), CultureInfo.InvariantCulture), ${TIER.jit}L)
        Dim s As UInteger = 2654435769UI
        Run(iters, s)
        s = 2654435769UI
        Dim sw As Stopwatch = Stopwatch.StartNew()
        Dim acc As UInteger = Run(iters, s)
        Dim ns As Double = sw.Elapsed.TotalMilliseconds * 1000000.0 / iters
        Console.WriteLine(ns.ToString("F4", CultureInfo.InvariantCulture) & " " & acc.ToString())
    End Sub
End Module
`,
    extraFiles: (_dir, t) => ({
      'bench.vbproj': dotnetProject(
        t,
        '    <RootNamespace>Bench</RootNamespace>\n    <OptionStrict>On</OptionStrict>\n    <RemoveIntegerChecks>true</RemoveIntegerChecks>\n',
      ),
    }),
    build: dotnetBuild,
    run: (dir, t, iters) => [t.bin.main as string, [join(dir, 'out', 'bench.dll'), iters]],
  },
  // ---------------------------------------------------------------- Dart (AOT exe)
  {
    id: 'dart',
    label: 'Dart',
    family: 'compiled-native',
    startupGroup: 'compiled',
    iterations: TIER.native,
    file: 'bench.dart',
    find: single('dart', 'A0_DART', ['--version']),
    kernels: {
      affine: `int affine(int x, int s, int o) => (x * s + o) & ${M};`,
      rotl: `int rotl(int x, int n) => ((x << (n & 31)) | (x >> ((32 - n) & 31))) & ${M};`,
      clamp:
        'int clamp(int x, int lo, int hi) { final t = hi < x ? hi : x; return t < lo ? lo : t; }',
      mix: `int mix(int x, int y) { final a = x ^ y; final d = ((a << 13) | (a >> 19)) & ${M}; final f = (d * 2654435761 + x) & ${M}; return f ^ (f >> 16); }`,
      ident: 'int ident(int x) => x;',
      noop: 'int noop(int x) => x;',
      chain3: `int inc1(int x) => (x + 1) & ${M};\nint dbl(int x) => (x + x) & ${M};\nint chain3(int x, int y) => (inc1(dbl(inc1(x))) + y) & ${M};`,
      branchy: `int branchy(int x, int y) { final m = x < y ? (y - x) & ${M} : (x - y) & ${M}; final z = x == y ? 0 : m; return (z & 1) == 1 ? z : x; }`,
      arrfill: `int arrfill(int x, int y) { final a = Uint32List(8); for (var i = 0; i < 8; i++) a[i] = i + x; return (a[y % 8] + a[3]) & ${M}; }`,
      loop64: `int loop64(int s, int k) { for (var i = 0; i < 64; i++) { final b = ((s ^ k) * 2654435761) & ${M}; s = ((b ^ (b >> 15)) + i) & ${M}; } return s; }`,
    },
    program: (k, src) => `import 'dart:typed_data';
${src}
int rng(int s) { s ^= (s << 13) & ${M}; s ^= s >> 17; s ^= (s << 5) & ${M}; return s; }
int run(int iters) {
  var s = 0x9e3779b9;
  var acc = 0;
  for (var i = 0; i < iters; i++) {
    ${each(k, (i) => `s = rng(s); final a${i} = s;`)}
    acc = (acc ^ ${k.name}(${args(k)})) & ${M};
  }
  return acc;
}
void main(List<String> argv) {
  final iters = argv.isNotEmpty ? int.parse(argv[0]) : ${TIER.native};
  final sw = Stopwatch()..start();
  final acc = run(iters);
  final ns = sw.elapsedMicroseconds * 1000 / iters;
  print('$ns $acc');
}
`,
    build: (dir, t) => [
      [t.bin.main as string, ['compile', 'exe', join(dir, 'bench.dart'), '-o', join(dir, 'bench')]],
    ],
    run: (dir, _t, iters) => [join(dir, 'bench'), [iters]],
  },
  // ---------------------------------------------------------------- Scala 3 (scala-cli assembly, java)
  {
    id: 'scala',
    label: 'Scala',
    family: 'jit',
    startupGroup: 'compiled',
    iterations: TIER.jit,
    file: 'bench.scala',
    find: () => {
      const java = javaOnly();
      const cli = locate('scala-cli', 'A0_SCALA_CLI');
      if (java === undefined || cli === undefined) return undefined;
      return { version: versionLine(cli, ['version'], /Scala version/), bin: { ...java.bin, cli } };
    },
    env: (t) => ({ JAVA_HOME: javaHome(t.bin.java as string) }),
    kernels: {
      affine: 'def affine(x: Int, s: Int, o: Int): Int = x * s + o',
      rotl: 'def rotl(x: Int, n: Int): Int = (x << (n & 31)) | (x >>> ((32 - n) & 31))',
      clamp:
        'def clamp(x: Int, lo: Int, hi: Int): Int = { val t = if (java.lang.Integer.compareUnsigned(hi, x) < 0) hi else x; if (java.lang.Integer.compareUnsigned(t, lo) < 0) lo else t }',
      mix: 'def mix(x: Int, y: Int): Int = { val a = x ^ y; val d = (a << 13) | (a >>> 19); val f = d * -1640531535 + x; f ^ (f >>> 16) }',
      ident: 'def ident(x: Int): Int = x',
      noop: 'def noop(x: Int): Int = x',
      chain3:
        'def inc1(x: Int): Int = x + 1\ndef dbl(x: Int): Int = x + x\ndef chain3(x: Int, y: Int): Int = inc1(dbl(inc1(x))) + y',
      branchy:
        'def branchy(x: Int, y: Int): Int = { val m = if (java.lang.Integer.compareUnsigned(x, y) < 0) y - x else x - y; val z = if (x == y) 0 else m; if ((z & 1) == 1) z else x }',
      arrfill:
        'def arrfill(x: Int, y: Int): Int = { val a = new Array[Int](8); var i = 0; while (i < 8) { a(i) = i + x; i += 1 }; a(java.lang.Integer.remainderUnsigned(y, 8)) + a(3) }',
      loop64:
        'def loop64(s0: Int, k: Int): Int = { var s = s0; var i = 0; while (i < 64) { val b = (s ^ k) * -1640531535; s = (b ^ (b >>> 15)) + i; i += 1 }; s }',
    },
    program: (k, src) => `object Bench {
${src}
  def rng(st: Array[Int]): Int = { var x = st(0); x ^= x << 13; x ^= x >>> 17; x ^= x << 5; st(0) = x; x }
  def run(iters: Long, st: Array[Int]): Int = {
    var acc = 0
    var i = 0L
    while (i < iters) {
      ${each(k, (i) => `val a${i} = rng(st)`, '; ')}
      acc ^= ${k.name}(${args(k)})
      i += 1
    }
    acc
  }
  def main(argv: Array[String]): Unit = {
    val iters = if (argv.length > 0) argv(0).toLong else ${TIER.jit}L
    val st = Array(-1640531527)
    run(iters, st)
    st(0) = -1640531527
    val t0 = System.nanoTime()
    val acc = run(iters, st)
    val ns = (System.nanoTime() - t0).toDouble / iters.toDouble
    println(s"$ns \${java.lang.Integer.toUnsignedString(acc)}")
  }
}
`,
    build: (dir, t) => [
      [
        t.bin.cli as string,
        [
          '--power',
          'package',
          join(dir, 'bench.scala'),
          '--assembly',
          '--server=false',
          '-o',
          join(dir, 'bench.jar'),
          '-f',
        ],
      ],
    ],
    run: (dir, t, iters) => [t.bin.java as string, ['-jar', join(dir, 'bench.jar'), iters]],
  },
  // ---------------------------------------------------------------- Clojure (clojure CLI, unchecked math)
  {
    id: 'clojure',
    label: 'Clojure',
    family: 'jit',
    startupGroup: 'interpreters',
    iterations: TIER.vm,
    file: 'bench.clj',
    find: () => {
      const java = javaOnly();
      const clj = locate('clojure', 'A0_CLOJURE');
      if (java === undefined || clj === undefined) return undefined;
      return { version: versionLine(clj, ['--version']), bin: { ...java.bin, clj } };
    },
    env: (t) => ({ JAVA_HOME: javaHome(t.bin.java as string) }),
    kernels: {
      affine: `(defn affine ^long [^long x ^long s ^long o] (bit-and (+ (* x s) o) ${M}))`,
      rotl: `(defn rotl ^long [^long x ^long n] (bit-and (bit-or (bit-shift-left x (bit-and n 31)) (bit-shift-right x (bit-and (- 32 n) 31))) ${M}))`,
      clamp:
        '(defn clamp ^long [^long x ^long lo ^long hi] (let [t (if (< hi x) hi x)] (if (< t lo) lo t)))',
      mix: `(defn mix ^long [^long x ^long y] (let [a (bit-xor x y) d (bit-and (bit-or (bit-shift-left a 13) (bit-shift-right a 19)) ${M}) f (bit-and (+ (* d 2654435761) x) ${M})] (bit-xor f (bit-shift-right f 16))))`,
      ident: '(defn ident ^long [^long x] x)',
      noop: '(defn noop ^long [^long x] x)',
      chain3: `(defn inc1 ^long [^long x] (bit-and (+ x 1) ${M}))\n(defn dbl ^long [^long x] (bit-and (+ x x) ${M}))\n(defn chain3 ^long [^long x ^long y] (bit-and (+ (inc1 (dbl (inc1 x))) y) ${M}))`,
      branchy: `(defn branchy ^long [^long x ^long y] (let [m (if (< x y) (bit-and (- y x) ${M}) (bit-and (- x y) ${M})) z (if (== x y) 0 m)] (if (== (bit-and z 1) 1) z x)))`,
      arrfill: `(defn arrfill ^long [^long x ^long y] (let [a (long-array 8)] (dotimes [i 8] (aset a i (bit-and (+ i x) ${M}))) (bit-and (+ (aget a (int (rem y 8))) (aget a 3)) ${M})))`,
      loop64: `(defn loop64 ^long [^long s0 ^long k] (loop [i 0 s s0] (if (< i 64) (let [b (bit-and (* (bit-xor s k) 2654435761) ${M})] (recur (inc i) (bit-and (+ (bit-xor b (bit-shift-right b 15)) i) ${M}))) s)))`,
    },
    program: (k, src) => `(set! *unchecked-math* true)
${src}
(defn rng ^long [^long s0] (let [s1 (bit-and (bit-xor s0 (bit-shift-left s0 13)) ${M}) s2 (bit-xor s1 (bit-shift-right s1 17))] (bit-and (bit-xor s2 (bit-shift-left s2 5)) ${M})))
(defn run ^long [^long iters]
  (loop [i 0 s 0x9e3779b9 acc 0]
    (if (< i iters)
      (let [${chain(k, (i) => `s (rng s) a${i} s`, ' ')}]
        (recur (inc i) s (bit-and (bit-xor acc (${k.name} ${args(k, ' ')})) ${M})))
      acc)))
(let [iters (if (seq *command-line-args*) (Long/parseLong (first *command-line-args*)) ${TIER.vm})]
  (run iters)
  (let [t0 (System/nanoTime) acc (run iters) ns (/ (double (- (System/nanoTime) t0)) iters)]
    (println (str ns " " acc))))
`,
    run: (dir, t, iters) => [t.bin.clj as string, ['-M', join(dir, 'bench.clj'), iters]],
  },
  // ---------------------------------------------------------------- Groovy (@CompileStatic)
  {
    id: 'groovy',
    label: 'Groovy',
    family: 'jit',
    startupGroup: 'interpreters',
    iterations: TIER.vm,
    file: 'Bench.groovy',
    find: () => {
      const java = javaOnly();
      const groovy = locate('groovy', 'A0_GROOVY');
      if (java === undefined || groovy === undefined) return undefined;
      return { version: versionLine(groovy, ['--version']), bin: { ...java.bin, groovy } };
    },
    env: (t) => ({ JAVA_HOME: javaHome(t.bin.java as string) }),
    kernels: {
      affine: '  static int affine(int x, int s, int o) { x * s + o }',
      rotl: '  static int rotl(int x, int n) { (x << (n & 31)) | (x >>> ((32 - n) & 31)) }',
      clamp:
        '  static int clamp(int x, int lo, int hi) { int t = Integer.compareUnsigned(hi, x) < 0 ? hi : x; Integer.compareUnsigned(t, lo) < 0 ? lo : t }',
      mix: '  static int mix(int x, int y) { int a = x ^ y; int d = (a << 13) | (a >>> 19); int f = d * -1640531535 + x; f ^ (f >>> 16) }',
      ident: '  static int ident(int x) { x }',
      noop: '  static int noop(int x) { x }',
      chain3:
        '  static int inc1(int x) { x + 1 }\n  static int dbl(int x) { x + x }\n  static int chain3(int x, int y) { inc1(dbl(inc1(x))) + y }',
      branchy:
        '  static int branchy(int x, int y) { int m = Integer.compareUnsigned(x, y) < 0 ? y - x : x - y; int z = x == y ? 0 : m; (z & 1) == 1 ? z : x }',
      arrfill:
        '  static int arrfill(int x, int y) { int[] a = new int[8]; for (int i = 0; i < 8; i++) a[i] = i + x; a[Integer.remainderUnsigned(y, 8)] + a[3] }',
      loop64:
        '  static int loop64(int s, int k) { for (int i = 0; i < 64; i++) { int b = (s ^ k) * -1640531535; s = (b ^ (b >>> 15)) + i }; s }',
    },
    program: (k, src) => `import groovy.transform.CompileStatic
@CompileStatic
class Bench {
${src}
  static int rng(int[] st) { int x = st[0]; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; st[0] = x; x }
  static int run(long iters, int[] st) {
    int acc = 0
    for (long i = 0L; i < iters; i++) {
      ${each(k, (i) => `int a${i} = rng(st)`, '; ')}
      acc ^= ${k.name}(${args(k)})
    }
    acc
  }
  static void main(String[] argv) {
    long iters = argv.length > 0 ? Long.parseLong(argv[0]) : ${TIER.vm}L
    int[] st = [-1640531527] as int[]
    run(iters, st)
    st[0] = -1640531527
    long t0 = System.nanoTime()
    int acc = run(iters, st)
    double ns = (System.nanoTime() - t0) / (double) iters
    println("\${ns} \${Integer.toUnsignedString(acc)}")
  }
}
`,
    run: (dir, t, iters) => [t.bin.groovy as string, [join(dir, 'Bench.groovy'), iters]],
  },
  // ---------------------------------------------------------------- Elixir (BEAM)
  {
    id: 'elixir',
    label: 'Elixir',
    family: 'vm',
    startupGroup: 'interpreters',
    iterations: TIER.interpreted,
    file: 'bench.exs',
    find: single('elixir', 'A0_ELIXIR', ['--version'], { pick: /^Elixir/ }),
    kernels: {
      affine: '  def affine(x, s, o), do: band(x * s + o, @m)',
      rotl: '  def rotl(x, n), do: band(bor(bsl(x, band(n, 31)), bsr(x, band(32 - n, 31))), @m)',
      clamp:
        '  def clamp(x, lo, hi) do\n    t = if hi < x, do: hi, else: x\n    if t < lo, do: lo, else: t\n  end',
      mix: '  def mix(x, y) do\n    a = bxor(x, y)\n    d = band(bor(bsl(a, 13), bsr(a, 19)), @m)\n    f = band(d * 2654435761 + x, @m)\n    bxor(f, bsr(f, 16))\n  end',
      ident: '  def ident(x), do: x',
      noop: '  def noop(x), do: x',
      chain3:
        '  def inc1(x), do: band(x + 1, @m)\n  def dbl(x), do: band(x + x, @m)\n  def chain3(x, y), do: band(inc1(dbl(inc1(x))) + y, @m)',
      branchy:
        '  def branchy(x, y) do\n    m = if x < y, do: band(y - x, @m), else: band(x - y, @m)\n    z = if x == y, do: 0, else: m\n    if band(z, 1) == 1, do: z, else: x\n  end',
      arrfill:
        '  def arrfill(x, y) do\n    a = List.to_tuple(for i <- 0..7, do: band(i + x, @m))\n    band(elem(a, rem(y, 8)) + elem(a, 3), @m)\n  end',
      loop64:
        '  def loop64(s, k) do\n    Enum.reduce(0..63, s, fn i, s ->\n      b = band(bxor(s, k) * 2654435761, @m)\n      band(bxor(b, bsr(b, 15)) + i, @m)\n    end)\n  end',
    },
    program: (k, src) => `import Bitwise
defmodule Bench do
  @m ${M}
${src}
  def rng(s) do
    s = bxor(s, band(bsl(s, 13), @m))
    s = bxor(s, bsr(s, 17))
    bxor(s, band(bsl(s, 5), @m))
  end
  def run(0, _s, acc), do: acc
  def run(n, s, acc) do
    ${each(k, (i) => `s = rng(s)\n    a${i} = s`, '\n    ')}
    run(n - 1, s, band(bxor(acc, ${k.name}(${args(k)})), @m))
  end
  def main(argv) do
    iters = case argv do
      [n | _] -> String.to_integer(n)
      _ -> ${TIER.interpreted}
    end
    t0 = System.monotonic_time(:nanosecond)
    acc = run(iters, 0x9e3779b9, 0)
    ns = (System.monotonic_time(:nanosecond) - t0) / iters
    IO.puts("#{ns} #{acc}")
  end
end
Bench.main(System.argv())
`,
    run: (dir, t, iters) => [t.bin.main as string, [join(dir, 'bench.exs'), iters]],
  },
  // ---------------------------------------------------------------- Erlang (escript, compiled mode)
  {
    id: 'erlang',
    label: 'Erlang',
    family: 'vm',
    startupGroup: 'interpreters',
    iterations: TIER.interpreted,
    file: 'bench.erl',
    find: () => {
      const escript = locate('escript', 'A0_ESCRIPT');
      const erl = locate('erl', 'A0_ERL');
      if (escript === undefined || erl === undefined) return undefined;
      return { version: versionLine(erl, ['+V']), bin: { main: escript, erl } };
    },
    kernels: {
      affine: 'affine(X, S, O) -> (X * S + O) band ?M.',
      rotl: 'rotl(X, N) -> ((X bsl (N band 31)) bor (X bsr ((32 - N) band 31))) band ?M.',
      clamp:
        'clamp(X, Lo, Hi) ->\n    T = if Hi < X -> Hi; true -> X end,\n    if T < Lo -> Lo; true -> T end.',
      mix: 'mix(X, Y) ->\n    A = X bxor Y,\n    D = ((A bsl 13) bor (A bsr 19)) band ?M,\n    F = (D * 2654435761 + X) band ?M,\n    F bxor (F bsr 16).',
      ident: 'ident(X) -> X.',
      noop: 'noop(X) -> X.',
      chain3:
        'inc1(X) -> (X + 1) band ?M.\ndbl(X) -> (X + X) band ?M.\nchain3(X, Y) -> (inc1(dbl(inc1(X))) + Y) band ?M.',
      branchy:
        'branchy(X, Y) ->\n    M = if X < Y -> (Y - X) band ?M; true -> (X - Y) band ?M end,\n    Z = if X == Y -> 0; true -> M end,\n    if Z band 1 == 1 -> Z; true -> X end.',
      arrfill:
        'arrfill(X, Y) ->\n    A = list_to_tuple([(I + X) band ?M || I <- lists:seq(0, 7)]),\n    (element((Y rem 8) + 1, A) + element(4, A)) band ?M.',
      loop64:
        'loop64(S0, K) ->\n    lists:foldl(fun(I, S) -> B = ((S bxor K) * 2654435761) band ?M, ((B bxor (B bsr 15)) + I) band ?M end, S0, lists:seq(0, 63)).',
    },
    program: (k, src) => `#!/usr/bin/env escript
-mode(compile).
-define(M, 16#FFFFFFFF).
${src}
rng(S0) ->
    S1 = S0 bxor ((S0 bsl 13) band ?M),
    S2 = S1 bxor (S1 bsr 17),
    S2 bxor ((S2 bsl 5) band ?M).
run(0, _S, Acc) -> Acc;
run(N, S0, Acc) ->
    ${chain(k, (i) => `S${i + 1} = rng(S${i}), A${i} = S${i + 1},`, '\n    ')}
    run(N - 1, S${k.arity}, (Acc bxor ${k.name}(${ARGS(k)})) band ?M).
main(Argv) ->
    Iters = case Argv of [N | _] -> list_to_integer(N); _ -> ${TIER.interpreted} end,
    T0 = erlang:monotonic_time(nanosecond),
    Acc = run(Iters, 16#9e3779b9, 0),
    Ns = (erlang:monotonic_time(nanosecond) - T0) / Iters,
    io:format("~.4f ~B~n", [Ns, Acc]).
`,
    run: (dir, t, iters) => [t.bin.main as string, [join(dir, 'bench.erl'), iters]],
  },
  // ---------------------------------------------------------------- Haskell (ghc -O2)
  {
    id: 'haskell',
    label: 'Haskell',
    family: 'compiled-native',
    startupGroup: 'compiled',
    iterations: TIER.native,
    file: 'bench.hs',
    find: single('ghc', 'A0_GHC', ['--version']),
    kernels: {
      affine: 'affine :: Word32 -> Word32 -> Word32 -> Word32\naffine x s o = x * s + o',
      rotl: 'rotl :: Word32 -> Word32 -> Word32\nrotl x n = (x `shiftL` fromIntegral (n .&. 31)) .|. (x `shiftR` fromIntegral ((32 - n) .&. 31))',
      clamp: 'clamp :: Word32 -> Word32 -> Word32 -> Word32\nclamp x lo hi = max (min x hi) lo',
      mix: 'mix :: Word32 -> Word32 -> Word32\nmix x y = let a = x `xor` y; d = (a `shiftL` 13) .|. (a `shiftR` 19); f = d * 2654435761 + x in f `xor` (f `shiftR` 16)',
      ident: 'ident :: Word32 -> Word32\nident x = x',
      noop: 'noop :: Word32 -> Word32\nnoop x = x',
      chain3:
        'inc1 :: Word32 -> Word32\ninc1 x = x + 1\ndbl :: Word32 -> Word32\ndbl x = x + x\nchain3 :: Word32 -> Word32 -> Word32\nchain3 x y = inc1 (dbl (inc1 x)) + y',
      branchy:
        'branchy :: Word32 -> Word32 -> Word32\nbranchy x y = let m = if x < y then y - x else x - y; z = if x == y then 0 else m in if z .&. 1 == 1 then z else x',
      arrfill:
        'arrfill :: Word32 -> Word32 -> Word32\narrfill x y = let a = listArray (0, 7) [i + x | i <- [0 .. 7]] :: UArray Word32 Word32 in a ! (y `mod` 8) + a ! 3',
      loop64:
        'loop64 :: Word32 -> Word32 -> Word32\nloop64 s0 k = go 0 s0\n  where\n    go :: Word32 -> Word32 -> Word32\n    go !i !s | i >= 64 = s\n             | otherwise = let b = (s `xor` k) * 2654435761 in go (i + 1) ((b `xor` (b `shiftR` 15)) + i)',
    },
    program: (k, src) => `{-# LANGUAGE BangPatterns #-}
module Main where
import Data.Array.Unboxed
import Data.Bits
import Data.Word (Word32)
import GHC.Clock (getMonotonicTimeNSec)
import System.Environment (getArgs)
${src}
rng :: Word32 -> Word32
rng s0 = let s1 = s0 \`xor\` (s0 \`shiftL\` 13); s2 = s1 \`xor\` (s1 \`shiftR\` 17) in s2 \`xor\` (s2 \`shiftL\` 5)
run :: Int -> Word32
run iters = go 0 0x9e3779b9 0
  where
    go :: Int -> Word32 -> Word32 -> Word32
    go !i !s !acc
      | i >= iters = acc
      | otherwise =
          let ${chain(k, (i) => `!s${i + 1} = rng s${i}; !a${i} = s${i + 1}`, '; ').replace(/rng s0/g, 'rng s')}
          in go (i + 1) s${k.arity} (acc \`xor\` ${k.name} ${args(k, ' ')})
main :: IO ()
main = do
  argv <- getArgs
  let iters = case argv of (n : _) -> read n; _ -> ${TIER.native}
  t0 <- getMonotonicTimeNSec
  let !acc = run iters
  t1 <- getMonotonicTimeNSec
  putStrLn (show (fromIntegral (t1 - t0) / fromIntegral iters :: Double) ++ " " ++ show acc)
`,
    build: (dir, t) => [
      [
        t.bin.main as string,
        [
          '-O2',
          '-v0',
          '-outputdir',
          join(dir, 'obj'),
          '-o',
          join(dir, 'bench'),
          join(dir, 'bench.hs'),
        ],
      ],
    ],
    run: (dir, _t, iters) => [join(dir, 'bench'), [iters]],
  },
  // ---------------------------------------------------------------- OCaml (ocamlopt)
  {
    id: 'ocaml',
    label: 'OCaml',
    family: 'compiled-native',
    startupGroup: 'compiled',
    iterations: TIER.native,
    file: 'bench.ml',
    find: single('ocamlopt', 'A0_OCAMLOPT', ['-version']),
    kernels: {
      affine: 'let affine x s o = (x * s + o) land m',
      rotl: 'let rotl x n = ((x lsl (n land 31)) lor (x lsr ((32 - n) land 31))) land m',
      clamp: 'let clamp x lo hi = let t = if hi < x then hi else x in if t < lo then lo else t',
      mix: 'let mix x y = let a = x lxor y in let d = ((a lsl 13) lor (a lsr 19)) land m in let f = (d * 2654435761 + x) land m in f lxor (f lsr 16)',
      ident: 'let ident x = x',
      noop: 'let noop x = x',
      chain3:
        'let inc1 x = (x + 1) land m\nlet dbl x = (x + x) land m\nlet chain3 x y = (inc1 (dbl (inc1 x)) + y) land m',
      branchy:
        'let branchy x y = let mm = if x < y then (y - x) land m else (x - y) land m in let z = if x = y then 0 else mm in if z land 1 = 1 then z else x',
      arrfill:
        'let arrfill x y = let a = Array.make 8 0 in for i = 0 to 7 do a.(i) <- (i + x) land m done; (a.(y mod 8) + a.(3)) land m',
      loop64:
        'let loop64 s0 k = let s = ref s0 in for i = 0 to 63 do let b = ((!s lxor k) * 2654435761) land m in s := ((b lxor (b lsr 15)) + i) land m done; !s',
    },
    program: (k, src) => `let m = ${M}
${src}
let rng s = let s = s lxor ((s lsl 13) land m) in let s = s lxor (s lsr 17) in s lxor ((s lsl 5) land m)
let run iters =
  let s = ref 0x9e3779b9 and acc = ref 0 in
  for _ = 1 to iters do
    ${each(k, (i) => `s := rng !s; let a${i} = !s in`, '\n    ')}
    acc := (!acc lxor ${k.name} ${args(k, ' ')}) land m
  done;
  !acc
let () =
  let iters = if Array.length Sys.argv > 1 then int_of_string Sys.argv.(1) else ${TIER.native} in
  let t0 = Unix.gettimeofday () in
  let acc = run iters in
  let ns = (Unix.gettimeofday () -. t0) *. 1e9 /. float_of_int iters in
  Printf.printf "%.4f %d\\n" ns acc
`,
    build: (dir, t) => [
      [
        t.bin.main as string,
        ['-O3', '-I', '+unix', 'unix.cmxa', '-o', join(dir, 'bench'), join(dir, 'bench.ml')],
      ],
    ],
    run: (dir, _t, iters) => [join(dir, 'bench'), [iters]],
  },
  // ---------------------------------------------------------------- Julia (JIT, warm)
  {
    id: 'julia',
    label: 'Julia',
    family: 'jit',
    startupGroup: 'interpreters',
    iterations: TIER.jit,
    file: 'bench.jl',
    find: single('julia', 'A0_JULIA', ['--version']),
    kernels: {
      affine: 'affine(x::UInt32, s::UInt32, o::UInt32) = x * s + o',
      rotl: 'rotl(x::UInt32, n::UInt32) = (x << (n & 31)) | (x >> ((32 - n) & 31))',
      clamp: 'clamp32(x::UInt32, lo::UInt32, hi::UInt32) = max(min(x, hi), lo)',
      mix: 'function mix(x::UInt32, y::UInt32)\n    a = xor(x, y)\n    d = (a << 13) | (a >> 19)\n    f = d * 0x9e3779b1 + x\n    return xor(f, f >> 16)\nend',
      ident: 'ident(x::UInt32) = x',
      noop: 'noop(x::UInt32) = x',
      chain3:
        'inc1(x::UInt32) = x + UInt32(1)\ndbl(x::UInt32) = x + x\nchain3(x::UInt32, y::UInt32) = inc1(dbl(inc1(x))) + y',
      branchy:
        'function branchy(x::UInt32, y::UInt32)\n    m = x < y ? y - x : x - y\n    z = x == y ? UInt32(0) : m\n    return (z & 1) == 1 ? z : x\nend',
      arrfill:
        'function arrfill(x::UInt32, y::UInt32)\n    a = zeros(UInt32, 8)\n    for i in 0:7\n        a[i + 1] = UInt32(i) + x\n    end\n    return a[(y % 8) + 1] + a[4]\nend',
      loop64:
        'function loop64(s0::UInt32, k::UInt32)\n    s = s0\n    for i in 0:63\n        b = xor(s, k) * 0x9e3779b1\n        s = xor(b, b >> 15) + UInt32(i)\n    end\n    return s\nend',
    },
    program: (k, src) => `${src}
function rng(s::UInt32)
    s = xor(s, s << 13)
    s = xor(s, s >> 17)
    return xor(s, s << 5)
end
function run(iters::Int)
    s = 0x9e3779b9
    acc = UInt32(0)
    for _ in 1:iters
        ${each(k, (i) => `s = rng(s); a${i} = s`, '\n        ')}
        acc = xor(acc, ${k.name === 'clamp' ? 'clamp32' : k.name}(${args(k)}))
    end
    return acc
end
function main()
    iters = length(ARGS) > 0 ? parse(Int, ARGS[1]) : ${TIER.jit}
    run(iters)
    t0 = time_ns()
    acc = run(iters)
    ns = (time_ns() - t0) / iters
    println(ns, " ", Int(acc))
end
main()
`,
    run: (dir, t, iters) => [
      t.bin.main as string,
      ['--startup-file=no', join(dir, 'bench.jl'), iters],
    ],
  },
  // ---------------------------------------------------------------- R (Rscript; u32 emulated on doubles)
  {
    id: 'r',
    label: 'R',
    family: 'interpreted',
    startupGroup: 'interpreters',
    iterations: TIER.slow,
    file: 'bench.R',
    find: single('Rscript', 'A0_RSCRIPT', ['--version']),
    kernels: {
      affine: 'affine <- function(x, s, o) (mul32(x, s) + o) %% M',
      rotl: 'rotl <- function(x, n) or32(shl(x, n %% 32), shr(x, (32 - n) %% 32))',
      clamp: 'clamp <- function(x, lo, hi) { t <- if (hi < x) hi else x; if (t < lo) lo else t }',
      mix: 'mix <- function(x, y) { a <- xor32(x, y); d <- or32(shl(a, 13), shr(a, 19)); f <- (mul32(d, 2654435761) + x) %% M; xor32(f, shr(f, 16)) }',
      ident: 'ident <- function(x) x',
      noop: 'noop <- function(x) x',
      chain3:
        'inc1 <- function(x) (x + 1) %% M\ndbl <- function(x) (x + x) %% M\nchain3 <- function(x, y) (inc1(dbl(inc1(x))) + y) %% M',
      branchy:
        'branchy <- function(x, y) { m <- if (x < y) (y - x) %% M else (x - y) %% M; z <- if (x == y) 0 else m; if (and32(z, 1) == 1) z else x }',
      arrfill:
        'arrfill <- function(x, y) { a <- numeric(8); for (i in 0:7) a[i + 1] <- (i + x) %% M; (a[(y %% 8) + 1] + a[4]) %% M }',
      loop64:
        'loop64 <- function(s, k) { for (i in 0:63) { b <- mul32(xor32(s, k), 2654435761); s <- (xor32(b, shr(b, 15)) + i) %% M }; s }',
    },
    program: (
      k,
      src,
    ) => `# R has no 32-bit unsigned integers: values are doubles, the bit operations work on 16-bit halves.
M <- 4294967296
shl <- function(x, n) (x * 2^n) %% M
shr <- function(x, n) x %/% 2^n
xor32 <- function(a, b) bitwXor(a %/% 65536, b %/% 65536) * 65536 + bitwXor(a %% 65536, b %% 65536)
and32 <- function(a, b) bitwAnd(a %/% 65536, b %/% 65536) * 65536 + bitwAnd(a %% 65536, b %% 65536)
or32 <- function(a, b) bitwOr(a %/% 65536, b %/% 65536) * 65536 + bitwOr(a %% 65536, b %% 65536)
mul32 <- function(a, b) ((a * (b %% 65536)) %% M + ((a * (b %/% 65536)) %% 65536) * 65536) %% M
${src}
argv <- commandArgs(trailingOnly = TRUE)
iters <- if (length(argv) > 0) as.integer(argv[1]) else ${TIER.slow}
s <- 2654435769
acc <- 0
t0 <- proc.time()[["elapsed"]]
for (i in seq_len(iters)) {
  ${each(k, (i) => `s <- xor32(s, shl(s, 13)); s <- xor32(s, shr(s, 17)); s <- xor32(s, shl(s, 5)); a${i} <- s`, '\n  ')}
  acc <- xor32(acc, ${k.name}(${args(k)}))
}
ns <- (proc.time()[["elapsed"]] - t0) * 1e9 / iters
cat(sprintf("%.3f %.0f\\n", ns, acc))
`,
    run: (dir, t, iters) => [t.bin.main as string, ['--vanilla', join(dir, 'bench.R'), iters]],
  },
  // ---------------------------------------------------------------- Nim (-d:release)
  {
    id: 'nim',
    label: 'Nim',
    family: 'compiled-native',
    startupGroup: 'compiled',
    iterations: TIER.native,
    file: 'bench.nim',
    find: single('nim', 'A0_NIM', ['-v']),
    kernels: {
      affine: 'proc affine(x, s, o: uint32): uint32 = x * s + o',
      rotl: "proc rotl(x, n: uint32): uint32 = (x shl (n and 31'u32)) or (x shr ((32'u32 - n) and 31'u32))",
      clamp: 'proc clamp(x, lo, hi: uint32): uint32 = max(min(x, hi), lo)',
      mix: "proc mix(x, y: uint32): uint32 =\n  let a = x xor y\n  let d = (a shl 13) or (a shr 19)\n  let f = d * 2654435761'u32 + x\n  f xor (f shr 16)",
      ident: 'proc ident(x: uint32): uint32 = x',
      noop: 'proc noop(x: uint32): uint32 = x',
      chain3:
        "proc inc1(x: uint32): uint32 = x + 1'u32\nproc dbl(x: uint32): uint32 = x + x\nproc chain3(x, y: uint32): uint32 = inc1(dbl(inc1(x))) + y",
      branchy:
        "proc branchy(x, y: uint32): uint32 =\n  let m = if x < y: y - x else: x - y\n  let z = if x == y: 0'u32 else: m\n  if (z and 1'u32) == 1'u32: z else: x",
      arrfill:
        "proc arrfill(x, y: uint32): uint32 =\n  var a: array[8, uint32]\n  for i in 0 ..< 8: a[i] = uint32(i) + x\n  a[int(y mod 8'u32)] + a[3]",
      loop64:
        "proc loop64(s0, k: uint32): uint32 =\n  var s = s0\n  for i in 0'u32 ..< 64'u32:\n    let b = (s xor k) * 2654435761'u32\n    s = (b xor (b shr 15)) + i\n  s",
    },
    program: (k, src) => `import std/[monotimes, os, strutils, times]
${src}
proc rng(s: var uint32): uint32 =
  var x = s
  x = x xor (x shl 13)
  x = x xor (x shr 17)
  x = x xor (x shl 5)
  s = x
  x
proc run(iters: int): uint32 =
  var s = 0x9e3779b9'u32
  var acc = 0'u32
  for _ in 0 ..< iters:
    ${each(k, (i) => `let a${i} = rng(s)`, '\n    ')}
    acc = acc xor ${k.name}(${args(k)})
  acc
proc main() =
  let iters = if paramCount() > 0: parseInt(paramStr(1)) else: ${TIER.native}
  let t0 = getMonoTime()
  let acc = run(iters)
  let ns = (getMonoTime() - t0).inNanoseconds.float / iters.float
  echo ns, " ", acc
main()
`,
    build: (dir, t) => [
      [
        t.bin.main as string,
        [
          'c',
          '-d:release',
          '--opt:speed',
          '--hints:off',
          '--verbosity:0',
          `-o:${join(dir, 'bench')}`,
          join(dir, 'bench.nim'),
        ],
      ],
    ],
    run: (dir, _t, iters) => [join(dir, 'bench'), [iters]],
  },
  // ---------------------------------------------------------------- Crystal (--release)
  {
    id: 'crystal',
    label: 'Crystal',
    family: 'compiled-native',
    startupGroup: 'compiled',
    iterations: TIER.native,
    file: 'bench.cr',
    find: single('crystal', 'A0_CRYSTAL', ['--version']),
    kernels: {
      affine: 'def affine(x : UInt32, s : UInt32, o : UInt32) : UInt32\n  x &* s &+ o\nend',
      rotl: 'def rotl(x : UInt32, n : UInt32) : UInt32\n  (x << (n & 31)) | (x >> ((32_u32 &- n) & 31))\nend',
      clamp:
        'def clamp(x : UInt32, lo : UInt32, hi : UInt32) : UInt32\n  t = hi < x ? hi : x\n  t < lo ? lo : t\nend',
      mix: 'def mix(x : UInt32, y : UInt32) : UInt32\n  a = x ^ y\n  d = (a << 13) | (a >> 19)\n  f = d &* 2654435761_u32 &+ x\n  f ^ (f >> 16)\nend',
      ident: 'def ident(x : UInt32) : UInt32\n  x\nend',
      noop: 'def noop(x : UInt32) : UInt32\n  x\nend',
      chain3:
        'def inc1(x : UInt32) : UInt32\n  x &+ 1\nend\ndef dbl(x : UInt32) : UInt32\n  x &+ x\nend\ndef chain3(x : UInt32, y : UInt32) : UInt32\n  inc1(dbl(inc1(x))) &+ y\nend',
      branchy:
        'def branchy(x : UInt32, y : UInt32) : UInt32\n  m = x < y ? y &- x : x &- y\n  z = x == y ? 0_u32 : m\n  (z & 1) == 1 ? z : x\nend',
      arrfill:
        'def arrfill(x : UInt32, y : UInt32) : UInt32\n  a = StaticArray(UInt32, 8).new(0_u32)\n  8.times { |i| a[i] = i.to_u32 &+ x }\n  a[(y % 8).to_i] &+ a[3]\nend',
      loop64:
        'def loop64(s0 : UInt32, k : UInt32) : UInt32\n  s = s0\n  64.times { |i| b = (s ^ k) &* 2654435761_u32; s = (b ^ (b >> 15)) &+ i.to_u32 }\n  s\nend',
    },
    program: (k, src) => `${src}
def rng(s : UInt32) : UInt32
  s ^= s << 13
  s ^= s >> 17
  s ^= s << 5
  s
end
def run(iters : Int64) : UInt32
  s = 0x9e3779b9_u32
  acc = 0_u32
  iters.times do
    ${each(k, (i) => `s = rng(s); a${i} = s`, '\n    ')}
    acc ^= ${k.name}(${args(k)})
  end
  acc
end
iters = ARGV.size > 0 ? ARGV[0].to_i64 : ${TIER.native}_i64
t0 = Time.monotonic
acc = run(iters)
ns = (Time.monotonic - t0).total_nanoseconds / iters
puts "#{ns} #{acc}"
`,
    build: (dir, t) => [
      [
        t.bin.main as string,
        ['build', '--release', '-o', join(dir, 'bench'), join(dir, 'bench.cr')],
      ],
    ],
    run: (dir, _t, iters) => [join(dir, 'bench'), [iters]],
  },
  // ---------------------------------------------------------------- D (ldc2 -O3)
  {
    id: 'd',
    label: 'D',
    family: 'compiled-native',
    startupGroup: 'compiled',
    iterations: TIER.native,
    file: 'bench.d',
    find: single('ldc2', 'A0_LDC2', ['--version']),
    kernels: {
      affine: 'uint affine(uint x, uint s, uint o) { return x * s + o; }',
      rotl: 'uint rotl(uint x, uint n) { return (x << (n & 31)) | (x >> ((32 - n) & 31)); }',
      clamp: 'uint clamp(uint x, uint lo, uint hi) { return max(min(x, hi), lo); }',
      mix: 'uint mix(uint x, uint y) { uint a = x ^ y; uint d = (a << 13) | (a >> 19); uint f = d * 2654435761u + x; return f ^ (f >> 16); }',
      ident: 'uint ident(uint x) { return x; }',
      noop: 'uint noop(uint x) { return x; }',
      chain3:
        'uint inc1(uint x) { return x + 1; }\nuint dbl(uint x) { return x + x; }\nuint chain3(uint x, uint y) { return inc1(dbl(inc1(x))) + y; }',
      branchy:
        'uint branchy(uint x, uint y) { uint m = x < y ? y - x : x - y; uint z = x == y ? 0u : m; return (z & 1u) == 1u ? z : x; }',
      arrfill:
        'uint arrfill(uint x, uint y) { uint[8] a; foreach (uint i; 0 .. 8) a[i] = i + x; return a[y % 8] + a[3]; }',
      loop64:
        'uint loop64(uint s, uint k) { foreach (uint i; 0 .. 64) { uint b = (s ^ k) * 2654435761u; s = (b ^ (b >> 15)) + i; } return s; }',
    },
    program: (k, src) => `import core.time;
import std.algorithm : max, min;
import std.conv : to;
import std.stdio : writefln;
${src}
uint rng(ref uint s) { uint x = s; x ^= x << 13; x ^= x >> 17; x ^= x << 5; s = x; return x; }
void main(string[] argv) {
  long iters = argv.length > 1 ? to!long(argv[1]) : ${TIER.native};
  uint s = 0x9e3779b9, acc = 0;
  auto t0 = MonoTime.currTime;
  for (long i = 0; i < iters; i++) {
    ${each(k, (i) => `uint a${i} = rng(s);`)}
    acc ^= ${k.name}(${args(k)});
  }
  double ns = cast(double)(MonoTime.currTime - t0).total!"nsecs" / cast(double) iters;
  writefln("%.4f %d", ns, acc);
}
`,
    build: (dir, t) => [
      [
        t.bin.main as string,
        ['-O3', '-release', '-w', `-of=${join(dir, 'bench')}`, join(dir, 'bench.d')],
      ],
    ],
    run: (dir, _t, iters) => [join(dir, 'bench'), [iters]],
  },
  // ---------------------------------------------------------------- Free Pascal (fpc -O2)
  {
    id: 'pascal',
    label: 'Pascal',
    family: 'compiled-native',
    startupGroup: 'compiled',
    iterations: TIER.native,
    file: 'bench.pas',
    find: single('fpc', 'A0_FPC', ['-iV']),
    timer: 'GetTickCount64 (millisecond resolution; every sample runs for hundreds of ms)',
    kernels: {
      affine: 'function affine(x, s, o: LongWord): LongWord;\nbegin\n  affine := x * s + o;\nend;',
      rotl: 'function rotl(x, n: LongWord): LongWord;\nbegin\n  rotl := (x shl (n and 31)) or (x shr ((32 - n) and 31));\nend;',
      clamp:
        'function clamp(x, lo, hi: LongWord): LongWord;\nvar t: LongWord;\nbegin\n  if hi < x then t := hi else t := x;\n  if t < lo then clamp := lo else clamp := t;\nend;',
      mix: 'function mix(x, y: LongWord): LongWord;\nvar a, d, f: LongWord;\nbegin\n  a := x xor y;\n  d := (a shl 13) or (a shr 19);\n  f := d * 2654435761 + x;\n  mix := f xor (f shr 16);\nend;',
      ident: 'function ident(x: LongWord): LongWord;\nbegin\n  ident := x;\nend;',
      noop: 'function noop(x: LongWord): LongWord;\nbegin\n  noop := x;\nend;',
      chain3:
        'function inc1(x: LongWord): LongWord;\nbegin\n  inc1 := x + 1;\nend;\nfunction dbl(x: LongWord): LongWord;\nbegin\n  dbl := x + x;\nend;\nfunction chain3(x, y: LongWord): LongWord;\nbegin\n  chain3 := inc1(dbl(inc1(x))) + y;\nend;',
      branchy:
        'function branchy(x, y: LongWord): LongWord;\nvar m, z: LongWord;\nbegin\n  if x < y then m := y - x else m := x - y;\n  if x = y then z := 0 else z := m;\n  if (z and 1) = 1 then branchy := z else branchy := x;\nend;',
      arrfill:
        'function arrfill(x, y: LongWord): LongWord;\nvar a: array[0..7] of LongWord; i: LongWord;\nbegin\n  for i := 0 to 7 do a[i] := i + x;\n  arrfill := a[y mod 8] + a[3];\nend;',
      loop64:
        'function loop64(s0, k: LongWord): LongWord;\nvar i, b, s: LongWord;\nbegin\n  s := s0;\n  for i := 0 to 63 do\n  begin\n    b := (s xor k) * 2654435761;\n    s := (b xor (b shr 15)) + i;\n  end;\n  loop64 := s;\nend;',
    },
    program: (k, src) => `program bench;
{$mode objfpc}{$H+}{$R-}{$Q-}
uses SysUtils;
${src}
function rng(var s: LongWord): LongWord;
var x: LongWord;
begin
  x := s;
  x := x xor (x shl 13);
  x := x xor (x shr 17);
  x := x xor (x shl 5);
  s := x;
  rng := x;
end;
var
  iters, i: Int64;
  s, acc, ${args(k)}: LongWord;
  t0: QWord;
  ns: Double;
begin
  iters := ${TIER.native};
  if ParamCount >= 1 then iters := StrToInt64(ParamStr(1));
  s := $9e3779b9;
  acc := 0;
  t0 := GetTickCount64;
  for i := 1 to iters do
  begin
    ${each(k, (i) => `a${i} := rng(s);`, '\n    ')}
    acc := acc xor ${k.name}(${args(k)});
  end;
  ns := (GetTickCount64 - t0) * 1e6 / iters;
  WriteLn(ns:0:4, ' ', acc);
end.
`,
    build: (dir, t) => [
      [t.bin.main as string, ['-O2', '-v0', `-o${join(dir, 'bench')}`, join(dir, 'bench.pas')]],
    ],
    run: (dir, _t, iters) => [join(dir, 'bench'), [iters]],
  },
  // ---------------------------------------------------------------- Racket (CS)
  {
    id: 'racket',
    label: 'Racket',
    family: 'vm',
    startupGroup: 'interpreters',
    iterations: TIER.vm,
    file: 'bench.rkt',
    find: single('racket', 'A0_RACKET', ['--version']),
    kernels: {
      affine: '(define (affine x s o) (bitwise-and (+ (* x s) o) M))',
      rotl: '(define (rotl x n) (bitwise-and (bitwise-ior (arithmetic-shift x (bitwise-and n 31)) (arithmetic-shift x (- (bitwise-and (- 32 n) 31)))) M))',
      clamp: '(define (clamp x lo hi) (let ([t (if (< hi x) hi x)]) (if (< t lo) lo t)))',
      mix: '(define (mix x y) (let* ([a (bitwise-xor x y)] [d (bitwise-and (bitwise-ior (arithmetic-shift a 13) (arithmetic-shift a -19)) M)] [f (bitwise-and (+ (* d 2654435761) x) M)]) (bitwise-xor f (arithmetic-shift f -16))))',
      ident: '(define (ident x) x)',
      noop: '(define (noop x) x)',
      chain3:
        '(define (inc1 x) (bitwise-and (+ x 1) M))\n(define (dbl x) (bitwise-and (+ x x) M))\n(define (chain3 x y) (bitwise-and (+ (inc1 (dbl (inc1 x))) y) M))',
      branchy:
        '(define (branchy x y) (let* ([m (if (< x y) (bitwise-and (- y x) M) (bitwise-and (- x y) M))] [z (if (= x y) 0 m)]) (if (= (bitwise-and z 1) 1) z x)))',
      arrfill:
        '(define (arrfill x y) (let ([a (make-vector 8 0)]) (for ([i 8]) (vector-set! a i (bitwise-and (+ i x) M))) (bitwise-and (+ (vector-ref a (modulo y 8)) (vector-ref a 3)) M)))',
      loop64:
        '(define (loop64 s0 k) (let loop ([i 0] [s s0]) (if (>= i 64) s (let ([b (bitwise-and (* (bitwise-xor s k) 2654435761) M)]) (loop (add1 i) (bitwise-and (+ (bitwise-xor b (arithmetic-shift b -15)) i) M))))))',
    },
    program: (k, src) => `#lang racket/base
(define M #xFFFFFFFF)
${src}
(define (rng s)
  (let* ([s (bitwise-xor s (bitwise-and (arithmetic-shift s 13) M))]
         [s (bitwise-xor s (arithmetic-shift s -17))])
    (bitwise-xor s (bitwise-and (arithmetic-shift s 5) M))))
(define (run iters)
  (let loop ([i 0] [s #x9e3779b9] [acc 0])
    (if (>= i iters)
        acc
        (let* (${chain(k, (i) => `[s (rng s)] [a${i} s]`, ' ')})
          (loop (add1 i) s (bitwise-and (bitwise-xor acc (${k.name} ${args(k, ' ')})) M))))))
(define iters (let ([v (current-command-line-arguments)]) (if (> (vector-length v) 0) (string->number (vector-ref v 0)) ${TIER.vm})))
(define t0 (current-inexact-monotonic-milliseconds))
(define acc (run iters))
(define ns (/ (* (- (current-inexact-monotonic-milliseconds) t0) 1e6) iters))
(printf "~a ~a\\n" ns acc)
`,
    run: (dir, t, iters) => [t.bin.main as string, [join(dir, 'bench.rkt'), iters]],
  },
  // ---------------------------------------------------------------- Common Lisp (SBCL, compiled with type declarations)
  {
    id: 'commonlisp',
    label: 'Common Lisp',
    family: 'jit',
    startupGroup: 'interpreters',
    iterations: TIER.jit,
    file: 'bench.lisp',
    find: single('sbcl', 'A0_SBCL', ['--version']),
    kernels: {
      affine:
        '(defun affine (x s o) (declare (type (unsigned-byte 32) x s o)) (logand (+ (* x s) o) +m+))',
      rotl: '(defun rotl (x n) (declare (type (unsigned-byte 32) x n)) (logand (logior (ash x (logand n 31)) (ash x (- (logand (- 32 n) 31)))) +m+))',
      clamp:
        '(defun clamp (x lo hi) (declare (type (unsigned-byte 32) x lo hi)) (max (min x hi) lo))',
      mix: '(defun mix (x y) (declare (type (unsigned-byte 32) x y)) (let* ((a (logxor x y)) (d (logand (logior (ash a 13) (ash a -19)) +m+)) (f (logand (+ (* d 2654435761) x) +m+))) (logxor f (ash f -16))))',
      ident: '(defun ident (x) (declare (type (unsigned-byte 32) x)) x)',
      noop: '(defun noop (x) (declare (type (unsigned-byte 32) x)) x)',
      chain3:
        '(defun inc1 (x) (declare (type (unsigned-byte 32) x)) (logand (+ x 1) +m+))\n(defun dbl (x) (declare (type (unsigned-byte 32) x)) (logand (+ x x) +m+))\n(defun chain3 (x y) (declare (type (unsigned-byte 32) x y)) (logand (+ (inc1 (dbl (inc1 x))) y) +m+))',
      branchy:
        '(defun branchy (x y) (declare (type (unsigned-byte 32) x y)) (let* ((m (if (< x y) (logand (- y x) +m+) (logand (- x y) +m+))) (z (if (= x y) 0 m))) (if (= (logand z 1) 1) z x)))',
      arrfill:
        "(defun arrfill (x y) (declare (type (unsigned-byte 32) x y)) (let ((a (make-array 8 :element-type '(unsigned-byte 32) :initial-element 0))) (dotimes (i 8) (setf (aref a i) (logand (+ i x) +m+))) (logand (+ (aref a (mod y 8)) (aref a 3)) +m+)))",
      loop64:
        '(defun loop64 (s0 k) (declare (type (unsigned-byte 32) s0 k)) (let ((s s0)) (declare (type (unsigned-byte 32) s)) (dotimes (i 64) (let ((b (logand (* (logxor s k) 2654435761) +m+))) (setf s (logand (+ (logxor b (ash b -15)) i) +m+)))) s))',
    },
    program: (k, src) => `(declaim (optimize (speed 3) (safety 0) (debug 0)))
(defconstant +m+ #xFFFFFFFF)
${src}
(defun rng (s) (declare (type (unsigned-byte 32) s))
  (let* ((s (logxor s (logand (ash s 13) +m+))) (s (logxor s (ash s -17)))) (logxor s (logand (ash s 5) +m+))))
(defun run (iters) (declare (type fixnum iters))
  (let ((s #x9e3779b9) (acc 0))
    (declare (type (unsigned-byte 32) s acc))
    (dotimes (i iters)
      (let* (${chain(k, (i) => `(a${i} (setf s (rng s)))`, ' ')})
        (setf acc (logxor acc (${k.name} ${args(k, ' ')})))))
    acc))
(let* ((argv sb-ext:*posix-argv*)
       (given (and (> (length argv) 1) (parse-integer (car (last argv)) :junk-allowed t)))
       (iters (or given ${TIER.jit})))
  (let* ((t0 (get-internal-real-time))
         (acc (run iters))
         (dt (- (get-internal-real-time) t0))
         (ns (/ (* dt 1d9) internal-time-units-per-second iters)))
    (format t "~,4f ~d~%" ns acc)))
`,
    run: (dir, t, iters) => [t.bin.main as string, ['--script', join(dir, 'bench.lisp'), iters]],
  },
  // ---------------------------------------------------------------- COBOL (GnuCOBOL, free format)
  // Boolean operators (B-XOR, B-SHIFT-*) are kept in their own COMPUTE statements: GnuCOBOL 3.2
  // evaluates them wrongly for values above 2^31 when nested inside a FUNCTION MOD argument.
  {
    id: 'cobol',
    label: 'COBOL',
    family: 'compiled-native',
    startupGroup: 'compiled',
    iterations: TIER.vm,
    file: 'bench.cob',
    find: single('cobc', 'A0_COBC', ['--version']),
    timer: 'FUNCTION CURRENT-DATE (10 ms resolution; every sample runs for seconds)',
    kernels: {
      affine: 'AFFINE.\n    COMPUTE R = FUNCTION MOD(A0 * A1 + A2, 4294967296).',
      rotl: 'ROTL.\n    COMPUTE T = A1 B-AND 31.\n    COMPUTE J = FUNCTION MOD(32 - A1, 32).\n    COMPUTE R = ((A0 B-SHIFT-L T) B-OR (A0 B-SHIFT-R J)) B-AND 4294967295.',
      clamp:
        'CLAMP.\n    IF A2 < A0 MOVE A2 TO T ELSE MOVE A0 TO T END-IF.\n    IF T < A1 MOVE A1 TO R ELSE MOVE T TO R END-IF.',
      mix: 'MIX.\n    COMPUTE T = A0 B-XOR A1.\n    COMPUTE D = ((T B-SHIFT-L 13) B-OR (T B-SHIFT-R 19)) B-AND 4294967295.\n    COMPUTE F = FUNCTION MOD(D * 2654435761 + A0, 4294967296).\n    COMPUTE R = F B-XOR (F B-SHIFT-R 16).',
      ident: 'IDENT.\n    MOVE A0 TO R.',
      noop: 'NOOP.\n    MOVE A0 TO R.',
      chain3:
        'INC1.\n    COMPUTE T = FUNCTION MOD(T + 1, 4294967296).\nDBL.\n    COMPUTE T = FUNCTION MOD(T + T, 4294967296).\nCHAIN3.\n    MOVE A0 TO T.\n    PERFORM INC1.\n    PERFORM DBL.\n    PERFORM INC1.\n    COMPUTE R = FUNCTION MOD(T + A1, 4294967296).',
      branchy:
        'BRANCHY.\n    IF A0 < A1 COMPUTE T = A1 - A0 ELSE COMPUTE T = A0 - A1 END-IF.\n    IF A0 = A1 MOVE 0 TO Z ELSE MOVE T TO Z END-IF.\n    IF (Z B-AND 1) = 1 MOVE Z TO R ELSE MOVE A0 TO R END-IF.',
      arrfill:
        'ARRFILL.\n    PERFORM VARYING I2 FROM 0 BY 1 UNTIL I2 > 7\n        COMPUTE ARR(I2 + 1) = FUNCTION MOD(I2 + A0, 4294967296)\n    END-PERFORM.\n    COMPUTE T = FUNCTION MOD(A1, 8).\n    COMPUTE R = FUNCTION MOD(ARR(T + 1) + ARR(4), 4294967296).',
      loop64:
        'LOOP64.\n    MOVE A0 TO S2.\n    PERFORM VARYING I2 FROM 0 BY 1 UNTIL I2 > 63\n        COMPUTE T = S2 B-XOR A1\n        COMPUTE B = FUNCTION MOD(T * 2654435761, 4294967296)\n        COMPUTE T = B B-XOR (B B-SHIFT-R 15)\n        COMPUTE S2 = FUNCTION MOD(T + I2, 4294967296)\n    END-PERFORM.\n    MOVE S2 TO R.',
    },
    program: (k, src) => `IDENTIFICATION DIVISION.
PROGRAM-ID. BENCH.
DATA DIVISION.
WORKING-STORAGE SECTION.
01 ITERS PIC 9(12) COMP-5.
01 I PIC 9(12) COMP-5.
01 I2 PIC 9(4) COMP-5.
01 S PIC 9(10) COMP-5.
01 S2 PIC 9(10) COMP-5.
01 ACC PIC 9(10) COMP-5.
01 A0 PIC 9(10) COMP-5.
01 A1 PIC 9(10) COMP-5.
01 A2 PIC 9(10) COMP-5.
01 R PIC 9(10) COMP-5.
01 T PIC 9(10) COMP-5.
01 J PIC 9(10) COMP-5.
01 D PIC 9(10) COMP-5.
01 F PIC 9(10) COMP-5.
01 Z PIC 9(10) COMP-5.
01 B PIC 9(10) COMP-5.
01 ARR-TABLE.
   05 ARR PIC 9(10) COMP-5 OCCURS 8 TIMES.
01 ARG PIC X(20).
01 TS0 PIC X(21).
01 TS1 PIC X(21).
01 SEC0 PIC 9(7)V99.
01 SEC1 PIC 9(7)V99.
01 NS PIC 9(12)V9(4).
01 NS-OUT PIC Z(11)9.9(4).
01 ACC-OUT PIC Z(9)9.
PROCEDURE DIVISION.
MAIN-PARA.
    ACCEPT ARG FROM COMMAND-LINE.
    IF ARG = SPACES
        MOVE ${TIER.vm} TO ITERS
    ELSE
        COMPUTE ITERS = FUNCTION NUMVAL(ARG)
    END-IF.
    MOVE 2654435769 TO S.
    MOVE 0 TO ACC.
    MOVE FUNCTION CURRENT-DATE TO TS0.
    PERFORM ITERS TIMES
        ${each(k, (i) => `COMPUTE S = S B-XOR ((S B-SHIFT-L 13) B-AND 4294967295)\n        COMPUTE S = S B-XOR (S B-SHIFT-R 17)\n        COMPUTE S = S B-XOR ((S B-SHIFT-L 5) B-AND 4294967295)\n        MOVE S TO A${i}`, '\n        ')}
        PERFORM ${k.name.toUpperCase()}
        COMPUTE ACC = (ACC B-XOR R) B-AND 4294967295
    END-PERFORM.
    MOVE FUNCTION CURRENT-DATE TO TS1.
    COMPUTE SEC0 = FUNCTION NUMVAL(TS0(9:2)) * 3600 + FUNCTION NUMVAL(TS0(11:2)) * 60 + FUNCTION NUMVAL(TS0(13:2)) + FUNCTION NUMVAL(TS0(15:2)) / 100.
    COMPUTE SEC1 = FUNCTION NUMVAL(TS1(9:2)) * 3600 + FUNCTION NUMVAL(TS1(11:2)) * 60 + FUNCTION NUMVAL(TS1(13:2)) + FUNCTION NUMVAL(TS1(15:2)) / 100.
    IF SEC1 < SEC0 ADD 86400 TO SEC1 END-IF.
    COMPUTE NS = (SEC1 - SEC0) * 1000000000 / ITERS.
    MOVE NS TO NS-OUT.
    MOVE ACC TO ACC-OUT.
    DISPLAY FUNCTION TRIM(NS-OUT) ' ' FUNCTION TRIM(ACC-OUT).
    STOP RUN.
${src}
`,
    build: (dir, t) => [
      [
        t.bin.main as string,
        ['-x', '-free', '-O2', '-o', join(dir, 'bench'), join(dir, 'bench.cob')],
      ],
    ],
    run: (dir, _t, iters) => [join(dir, 'bench'), [iters]],
  },
  // ---------------------------------------------------------------- Prolog (SWI-Prolog)
  {
    id: 'prolog',
    label: 'Prolog',
    family: 'interpreted',
    startupGroup: 'interpreters',
    iterations: TIER.interpreted,
    file: 'bench.pl',
    find: single('swipl', 'A0_SWIPL', ['--version']),
    kernels: {
      affine: `affine(X, S, O, R) :- R is (X * S + O) /\\ ${M}.`,
      rotl: `rotl(X, N, R) :- R is ((X << (N /\\ 31)) \\/ (X >> ((32 - N) /\\ 31))) /\\ ${M}.`,
      clamp: 'clamp(X, Lo, Hi, R) :- ( Hi < X -> T = Hi ; T = X ), ( T < Lo -> R = Lo ; R = T ).',
      mix: `mix(X, Y, R) :- A is X xor Y, D is ((A << 13) \\/ (A >> 19)) /\\ ${M}, F is (D * 2654435761 + X) /\\ ${M}, R is F xor (F >> 16).`,
      ident: 'ident(X, X).',
      noop: 'noop(X, X).',
      chain3: `inc1(X, R) :- R is (X + 1) /\\ ${M}.\ndbl(X, R) :- R is (X + X) /\\ ${M}.\nchain3(X, Y, R) :- inc1(X, A), dbl(A, B), inc1(B, C), R is (C + Y) /\\ ${M}.`,
      branchy: `branchy(X, Y, R) :- ( X < Y -> M is (Y - X) /\\ ${M} ; M is (X - Y) /\\ ${M} ), ( X =:= Y -> Z = 0 ; Z = M ), ( Z /\\ 1 =:= 1 -> R = Z ; R = X ).`,
      arrfill: `arrfill(X, Y, R) :- findall(V, (between(0, 7, I), V is (I + X) /\\ ${M}), L), Idx is Y mod 8, nth0(Idx, L, V1), nth0(3, L, V2), R is (V1 + V2) /\\ ${M}.`,
      loop64: `loop64(S0, K, R) :- loop64_(0, S0, K, R).\nloop64_(64, S, _, S) :- !.\nloop64_(I, S, K, R) :- B is ((S xor K) * 2654435761) /\\ ${M}, S1 is ((B xor (B >> 15)) + I) /\\ ${M}, I1 is I + 1, loop64_(I1, S1, K, R).`,
    },
    program: (k, src) => `:- initialization(main, main).
${src}
rng(S0, S) :- S1 is S0 xor ((S0 << 13) /\\ ${M}), S2 is S1 xor (S1 >> 17), S is S2 xor ((S2 << 5) /\\ ${M}).
run(0, _, Acc, Acc) :- !.
run(N, S0, Acc0, Acc) :-
    ${chain(k, (i) => `rng(S${i}, S${i + 1}), A${i} = S${i + 1},`, '\n    ')}
    ${k.name}(${ARGS(k)}, R),
    Acc1 is (Acc0 xor R) /\\ ${M},
    N1 is N - 1,
    run(N1, S${k.arity}, Acc1, Acc).
main(Argv) :-
    ( Argv = [A | _] -> atom_number(A, Iters) ; Iters = ${TIER.interpreted} ),
    get_time(T0),
    run(Iters, 0x9e3779b9, 0, Acc),
    get_time(T1),
    Ns is (T1 - T0) * 1.0e9 / Iters,
    format("~4f ~d~n", [Ns, Acc]).
`,
    run: (dir, t, iters) => [t.bin.main as string, [join(dir, 'bench.pl'), iters]],
  },
  // ---------------------------------------------------------------- Scheme (Guile 3)
  {
    id: 'guile',
    label: 'Scheme (Guile)',
    family: 'vm',
    startupGroup: 'interpreters',
    iterations: TIER.interpreted,
    file: 'bench.scm',
    find: single('guile', 'A0_GUILE', ['--version']),
    kernels: {
      affine: '(define (affine x s o) (logand (+ (* x s) o) M))',
      rotl: '(define (rotl x n) (logand (logior (ash x (logand n 31)) (ash x (- (logand (- 32 n) 31)))) M))',
      clamp: '(define (clamp x lo hi) (let ((t (if (< hi x) hi x))) (if (< t lo) lo t)))',
      mix: '(define (mix x y) (let* ((a (logxor x y)) (d (logand (logior (ash a 13) (ash a -19)) M)) (f (logand (+ (* d 2654435761) x) M))) (logxor f (ash f -16))))',
      ident: '(define (ident x) x)',
      noop: '(define (noop x) x)',
      chain3:
        '(define (inc1 x) (logand (+ x 1) M))\n(define (dbl x) (logand (+ x x) M))\n(define (chain3 x y) (logand (+ (inc1 (dbl (inc1 x))) y) M))',
      branchy:
        '(define (branchy x y) (let* ((m (if (< x y) (logand (- y x) M) (logand (- x y) M))) (z (if (= x y) 0 m))) (if (= (logand z 1) 1) z x)))',
      arrfill:
        '(define (arrfill x y) (let ((a (make-vector 8 0))) (do ((i 0 (+ i 1))) ((= i 8)) (vector-set! a i (logand (+ i x) M))) (logand (+ (vector-ref a (modulo y 8)) (vector-ref a 3)) M)))',
      loop64:
        '(define (loop64 s0 k) (let loop ((i 0) (s s0)) (if (>= i 64) s (let ((b (logand (* (logxor s k) 2654435761) M))) (loop (+ i 1) (logand (+ (logxor b (ash b -15)) i) M))))))',
    },
    program: (k, src) => `(use-modules (ice-9 format))
(define M #xFFFFFFFF)
${src}
(define (rng s)
  (let* ((s (logxor s (logand (ash s 13) M)))
         (s (logxor s (ash s -17))))
    (logxor s (logand (ash s 5) M))))
(define (run iters)
  (let loop ((i 0) (s #x9e3779b9) (acc 0))
    (if (>= i iters)
        acc
        (let* (${chain(k, (i) => `(s (rng s)) (a${i} s)`, ' ')})
          (loop (+ i 1) s (logand (logxor acc (${k.name} ${args(k, ' ')})) M))))))
(define iters (let* ((a (command-line)) (n (and (> (length a) 1) (string->number (car (last-pair a)))))) (or n ${TIER.interpreted})))
(define t0 (get-internal-real-time))
(define acc (run iters))
(define ns (/ (* (- (get-internal-real-time) t0) 1e9) internal-time-units-per-second iters))
(format #t "~a ~a\\n" ns acc)
`,
    run: (dir, t, iters) => [
      t.bin.main as string,
      ['--no-auto-compile', join(dir, 'bench.scm'), iters],
    ],
  },
  // ---------------------------------------------------------------- Scheme (CHICKEN, compiled)
  {
    id: 'chicken',
    label: 'Scheme (CHICKEN)',
    family: 'compiled-native',
    startupGroup: 'compiled',
    iterations: TIER.vm,
    file: 'bench.scm',
    find: single('csc', 'A0_CSC', ['-version'], { pick: /Version/ }),
    timer:
      'current-process-milliseconds (process CPU time, ms resolution; samples run for hundreds of ms)',
    kernels: {
      affine: '(define (affine x s o) (bitwise-and (+ (* x s) o) M))',
      rotl: '(define (rotl x n) (bitwise-and (bitwise-ior (arithmetic-shift x (bitwise-and n 31)) (arithmetic-shift x (- (bitwise-and (- 32 n) 31)))) M))',
      clamp: '(define (clamp x lo hi) (let ((t (if (< hi x) hi x))) (if (< t lo) lo t)))',
      mix: '(define (mix x y) (let* ((a (bitwise-xor x y)) (d (bitwise-and (bitwise-ior (arithmetic-shift a 13) (arithmetic-shift a -19)) M)) (f (bitwise-and (+ (* d 2654435761) x) M))) (bitwise-xor f (arithmetic-shift f -16))))',
      ident: '(define (ident x) x)',
      noop: '(define (noop x) x)',
      chain3:
        '(define (inc1 x) (bitwise-and (+ x 1) M))\n(define (dbl x) (bitwise-and (+ x x) M))\n(define (chain3 x y) (bitwise-and (+ (inc1 (dbl (inc1 x))) y) M))',
      branchy:
        '(define (branchy x y) (let* ((m (if (< x y) (bitwise-and (- y x) M) (bitwise-and (- x y) M))) (z (if (= x y) 0 m))) (if (= (bitwise-and z 1) 1) z x)))',
      arrfill:
        '(define (arrfill x y) (let ((a (make-vector 8 0))) (do ((i 0 (+ i 1))) ((= i 8)) (vector-set! a i (bitwise-and (+ i x) M))) (bitwise-and (+ (vector-ref a (modulo y 8)) (vector-ref a 3)) M)))',
      loop64:
        '(define (loop64 s0 k) (let loop ((i 0) (s s0)) (if (>= i 64) s (let ((b (bitwise-and (* (bitwise-xor s k) 2654435761) M))) (loop (+ i 1) (bitwise-and (+ (bitwise-xor b (arithmetic-shift b -15)) i) M))))))',
    },
    program: (
      k,
      src,
    ) => `(import (chicken bitwise) (chicken format) (chicken process-context) (chicken time))
(define M #xFFFFFFFF)
${src}
(define (rng s)
  (let* ((s (bitwise-xor s (bitwise-and (arithmetic-shift s 13) M)))
         (s (bitwise-xor s (arithmetic-shift s -17))))
    (bitwise-xor s (bitwise-and (arithmetic-shift s 5) M))))
(define (run iters)
  (let loop ((i 0) (s #x9e3779b9) (acc 0))
    (if (>= i iters)
        acc
        (let* (${chain(k, (i) => `(s (rng s)) (a${i} s)`, ' ')})
          (loop (+ i 1) s (bitwise-and (bitwise-xor acc (${k.name} ${args(k, ' ')})) M))))))
(define iters (let ((a (command-line-arguments))) (if (null? a) ${TIER.vm} (string->number (car a)))))
(define t0 (current-process-milliseconds))
(define acc (run iters))
(define ns (/ (* (- (current-process-milliseconds) t0) 1e6) iters))
(printf "~a ~a\\n" ns acc)
`,
    build: (dir, t) => [
      [t.bin.main as string, ['-O3', '-o', join(dir, 'bench'), join(dir, 'bench.scm')]],
    ],
    run: (dir, _t, iters) => [join(dir, 'bench'), [iters]],
  },
  // ---------------------------------------------------------------- Smalltalk (GNU Smalltalk)
  {
    id: 'smalltalk',
    label: 'Smalltalk',
    family: 'interpreted',
    startupGroup: 'interpreters',
    iterations: TIER.slow,
    file: 'bench.st',
    find: single('gst', 'A0_GST', ['--version']),
    timer: 'Time millisecondClock (ms resolution; samples run for hundreds of ms)',
    kernels: {
      affine: '    Bench class >> affine: x with: s with: o [ ^(x * s + o) bitAnd: 16rFFFFFFFF ]',
      rotl: '    Bench class >> rotl: x with: n [ ^((x bitShift: (n bitAnd: 31)) bitOr: (x bitShift: ((32 - n) bitAnd: 31) negated)) bitAnd: 16rFFFFFFFF ]',
      clamp:
        '    Bench class >> clamp: x with: lo with: hi [ | t | t := hi < x ifTrue: [hi] ifFalse: [x]. ^t < lo ifTrue: [lo] ifFalse: [t] ]',
      mix: '    Bench class >> mix: x with: y [ | a d f | a := x bitXor: y. d := ((a bitShift: 13) bitOr: (a bitShift: -19)) bitAnd: 16rFFFFFFFF. f := (d * 2654435761 + x) bitAnd: 16rFFFFFFFF. ^f bitXor: (f bitShift: -16) ]',
      ident: '    Bench class >> ident: x [ ^x ]',
      noop: '    Bench class >> noop: x [ ^x ]',
      chain3:
        '    Bench class >> inc1: x [ ^(x + 1) bitAnd: 16rFFFFFFFF ]\n    Bench class >> dbl: x [ ^(x + x) bitAnd: 16rFFFFFFFF ]\n    Bench class >> chain3: x with: y [ ^((self inc1: (self dbl: (self inc1: x))) + y) bitAnd: 16rFFFFFFFF ]',
      branchy:
        '    Bench class >> branchy: x with: y [ | m z | m := x < y ifTrue: [(y - x) bitAnd: 16rFFFFFFFF] ifFalse: [(x - y) bitAnd: 16rFFFFFFFF]. z := x = y ifTrue: [0] ifFalse: [m]. ^(z bitAnd: 1) = 1 ifTrue: [z] ifFalse: [x] ]',
      arrfill:
        '    Bench class >> arrfill: x with: y [ | a | a := Array new: 8. 0 to: 7 do: [:i | a at: i + 1 put: ((i + x) bitAnd: 16rFFFFFFFF)]. ^((a at: (y \\\\ 8) + 1) + (a at: 4)) bitAnd: 16rFFFFFFFF ]',
      loop64:
        '    Bench class >> loop64: s0 with: k [ | s b | s := s0. 0 to: 63 do: [:i | b := ((s bitXor: k) * 2654435761) bitAnd: 16rFFFFFFFF. s := ((b bitXor: (b bitShift: -15)) + i) bitAnd: 16rFFFFFFFF]. ^s ]',
    },
    program: (k, src) => `Object subclass: Bench [
${src}
]
| iters s acc t0 ns ${args(k, ' ')} |
iters := Smalltalk arguments isEmpty ifTrue: [${TIER.slow}] ifFalse: [(Smalltalk arguments at: 1) asNumber].
s := 16r9E3779B9.
acc := 0.
t0 := Time millisecondClock.
1 to: iters do: [:i |
    ${each(k, (i) => `s := s bitXor: ((s bitShift: 13) bitAnd: 16rFFFFFFFF). s := s bitXor: (s bitShift: -17). s := s bitXor: ((s bitShift: 5) bitAnd: 16rFFFFFFFF). a${i} := s.`, '\n    ')}
    acc := (acc bitXor: (Bench ${k.name}: a0${Array.from({ length: k.arity - 1 }, (_, i) => ` with: a${i + 1}`).join('')})) bitAnd: 16rFFFFFFFF].
ns := ((Time millisecondClock - t0) * 1000000 / iters) asFloat.
Transcript showCr: ns printString, ' ', acc printString.
`,
    run: (dir, t, iters) => [t.bin.main as string, [join(dir, 'bench.st'), '-a', iters]],
  },
  // ---------------------------------------------------------------- Forth (gforth)
  {
    id: 'forth',
    label: 'Forth',
    family: 'interpreted',
    startupGroup: 'interpreters',
    iterations: TIER.interpreted,
    file: 'bench.fs',
    find: single('gforth', 'A0_GFORTH', ['--version']),
    kernels: {
      affine: ': affine ( x s o -- r ) >r * r> + M and ;',
      rotl: ': rotl ( x n -- r ) 2dup 31 and lshift -rot 32 swap - 31 and rshift or M and ;',
      clamp:
        ': clamp ( x lo hi -- r ) rot 2dup u< if drop else nip then 2dup u< if nip else drop then ;',
      mix: ': mix ( x y -- r ) over xor dup 13 lshift swap 19 rshift or M and 2654435761 * + M and dup 16 rshift xor ;',
      ident: ': ident ( x -- x ) ;',
      noop: ': noop ( x -- x ) ;',
      chain3:
        ': inc1 ( x -- r ) 1+ M and ;\n: dbl ( x -- r ) dup + M and ;\n: chain3 ( x y -- r ) swap inc1 dbl inc1 + M and ;',
      branchy:
        ': branchy ( x y -- r ) over over u< if over over swap - else over over - then M and over 3 pick = if drop 0 then nip dup 1 and 1 = if nip else drop then ;',
      arrfill:
        'create arr 8 cells allot\n: arrfill ( x y -- r ) 8 0 do i 2 pick + M and arr i cells + ! loop 7 and cells arr + @ arr 3 cells + @ + M and nip ;',
      loop64:
        ': loop64 ( s k -- r ) 64 0 do over over xor 2654435761 * M and dup 15 rshift xor i + M and rot drop swap loop drop ;',
    },
    program: (k, src) => `$FFFFFFFF constant M
${src}
variable seed
: rng ( -- v ) seed @ dup 13 lshift M and xor dup 17 rshift xor dup 5 lshift M and xor dup seed ! ;
: run ( iters -- acc ) $9e3779b9 seed ! 0 swap 0 do ${each(k, () => 'rng')} ${k.name} xor M and loop ;
: main ( iters -- ) dup utime drop >r run utime drop r> - 1000 * rot / . . cr ;
`,
    run: (dir, t, iters) => [
      t.bin.main as string,
      [join(dir, 'bench.fs'), '-e', iters, '-e', 'main', '-e', 'bye'],
    ],
  },
  // ---------------------------------------------------------------- Haxe (eval interpreter; Int is 32-bit)
  {
    id: 'haxe',
    label: 'Haxe',
    family: 'interpreted',
    startupGroup: 'interpreters',
    iterations: TIER.interpreted,
    file: 'Bench.hx',
    find: single('haxe', 'A0_HAXE', ['--version']),
    kernels: {
      affine: '  static function affine(x:Int, s:Int, o:Int):Int { return x * s + o; }',
      rotl: '  static function rotl(x:Int, n:Int):Int { return (x << (n & 31)) | (x >>> ((32 - n) & 31)); }',
      clamp:
        '  static function clamp(x:Int, lo:Int, hi:Int):Int { var t = ult(hi, x) ? hi : x; return ult(t, lo) ? lo : t; }',
      mix: '  static function mix(x:Int, y:Int):Int { var a = x ^ y; var d = (a << 13) | (a >>> 19); var f = d * -1640531535 + x; return f ^ (f >>> 16); }',
      ident: '  static function ident(x:Int):Int { return x; }',
      noop: '  static function noop(x:Int):Int { return x; }',
      chain3:
        '  static function inc1(x:Int):Int { return x + 1; }\n  static function dbl(x:Int):Int { return x + x; }\n  static function chain3(x:Int, y:Int):Int { return inc1(dbl(inc1(x))) + y; }',
      branchy:
        '  static function branchy(x:Int, y:Int):Int { var m = ult(x, y) ? y - x : x - y; var z = x == y ? 0 : m; return (z & 1) == 1 ? z : x; }',
      arrfill:
        '  static function arrfill(x:Int, y:Int):Int { var a = new haxe.ds.Vector<Int>(8); for (i in 0...8) a[i] = i + x; return a[(y >>> 0) & 7] + a[3]; }',
      loop64:
        '  static function loop64(s:Int, k:Int):Int { for (i in 0...64) { var b = (s ^ k) * -1640531535; s = (b ^ (b >>> 15)) + i; } return s; }',
    },
    program: (k, src) => `class Bench {
  // Haxe Int is a signed 32-bit integer: unsigned comparison flips the sign bit.
  static inline function ult(a:Int, b:Int):Bool { return (a ^ -2147483648) < (b ^ -2147483648); }
${src}
  static function rng(s:Int):Int { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return s; }
  static function run(iters:Int):Int {
    var s = -1640531527;
    var acc = 0;
    for (i in 0...iters) {
      ${each(k, (i) => `s = rng(s); var a${i} = s;`)}
      acc ^= ${k.name}(${args(k)});
    }
    return acc;
  }
  static function main() {
    var argv = Sys.args();
    var iters = argv.length > 0 ? Std.parseInt(argv[0]) : ${TIER.interpreted};
    var t0 = haxe.Timer.stamp();
    var acc = run(iters);
    var ns = (haxe.Timer.stamp() - t0) * 1e9 / iters;
    var u:Float = acc < 0 ? acc + 4294967296.0 : acc;
    Sys.println(Std.string(ns) + " " + Std.string(u));
  }
}
`,
    run: (dir, t, iters) => [t.bin.main as string, ['-cp', dir, '--run', 'Bench', iters]],
  },
  // ---------------------------------------------------------------- V (-prod)
  {
    id: 'v',
    label: 'V',
    family: 'compiled-native',
    startupGroup: 'compiled',
    iterations: TIER.native,
    file: 'bench.v',
    find: single('v', 'A0_V', ['version']),
    kernels: {
      affine: 'fn affine(x u32, s u32, o u32) u32 { return x * s + o }',
      rotl: 'fn rotl(x u32, n u32) u32 { return (x << (n & 31)) | (x >> ((32 - n) & 31)) }',
      clamp:
        'fn clamp(x u32, lo u32, hi u32) u32 { t := if hi < x { hi } else { x }\n\treturn if t < lo { lo } else { t } }',
      mix: 'fn mix(x u32, y u32) u32 { a := x ^ y\n\td := (a << 13) | (a >> 19)\n\tf := d * u32(2654435761) + x\n\treturn f ^ (f >> 16) }',
      ident: 'fn ident(x u32) u32 { return x }',
      noop: 'fn noop(x u32) u32 { return x }',
      chain3:
        'fn inc1(x u32) u32 { return x + 1 }\nfn dbl(x u32) u32 { return x + x }\nfn chain3(x u32, y u32) u32 { return inc1(dbl(inc1(x))) + y }',
      branchy:
        'fn branchy(x u32, y u32) u32 { m := if x < y { y - x } else { x - y }\n\tz := if x == y { u32(0) } else { m }\n\treturn if (z & 1) == 1 { z } else { x } }',
      arrfill:
        'fn arrfill(x u32, y u32) u32 { mut a := [8]u32{}\n\tfor i in 0 .. 8 { a[i] = u32(i) + x }\n\treturn a[int(y % 8)] + a[3] }',
      loop64:
        'fn loop64(s0 u32, k u32) u32 { mut s := s0\n\tfor i in 0 .. 64 { b := (s ^ k) * u32(2654435761)\n\t\ts = (b ^ (b >> 15)) + u32(i) }\n\treturn s }',
    },
    program: (k, src) => `import os
import time

${src}

fn rng(s u32) u32 {
\tmut x := s
\tx ^= x << 13
\tx ^= x >> 17
\tx ^= x << 5
\treturn x
}

fn main() {
\titers := if os.args.len > 1 { os.args[1].i64() } else { i64(${TIER.native}) }
\tmut s := u32(0x9e3779b9)
\tmut acc := u32(0)
\tsw := time.new_stopwatch()
\tfor _ in 0 .. iters {
\t\t${each(k, (i) => `s = rng(s)\n\t\ta${i} := s`, '\n\t\t')}
\t\tacc ^= ${k.name}(${args(k)})
\t}
\tns := f64(sw.elapsed().nanoseconds()) / f64(iters)
\tprintln('\${ns} \${acc}')
}
`,
    build: (dir, t) => [
      [t.bin.main as string, ['-prod', '-o', join(dir, 'bench'), join(dir, 'bench.v')]],
    ],
    run: (dir, _t, iters) => [join(dir, 'bench'), [iters]],
  },
  // ---------------------------------------------------------------- Odin (-o:speed)
  {
    id: 'odin',
    label: 'Odin',
    family: 'compiled-native',
    startupGroup: 'compiled',
    iterations: TIER.native,
    file: 'bench.odin',
    find: single('odin', 'A0_ODIN', ['version']),
    kernels: {
      affine: 'affine :: proc(x, s, o: u32) -> u32 { return x * s + o }',
      rotl: 'rotl :: proc(x, n: u32) -> u32 { return (x << (n & 31)) | (x >> ((32 - n) & 31)) }',
      clamp: 'clamp :: proc(x, lo, hi: u32) -> u32 { return max(min(x, hi), lo) }',
      mix: 'mix :: proc(x, y: u32) -> u32 { a := x ~ y; d := (a << 13) | (a >> 19); f := d * 2654435761 + x; return f ~ (f >> 16) }',
      ident: 'ident :: proc(x: u32) -> u32 { return x }',
      noop: 'noop :: proc(x: u32) -> u32 { return x }',
      chain3:
        'inc1 :: proc(x: u32) -> u32 { return x + 1 }\ndbl :: proc(x: u32) -> u32 { return x + x }\nchain3 :: proc(x, y: u32) -> u32 { return inc1(dbl(inc1(x))) + y }',
      branchy:
        'branchy :: proc(x, y: u32) -> u32 { m := y - x if x < y else x - y; z: u32 = 0 if x == y else m; return z if (z & 1) == 1 else x }',
      arrfill:
        'arrfill :: proc(x, y: u32) -> u32 { a: [8]u32; for i in 0 ..< 8 { a[i] = u32(i) + x }; return a[y % 8] + a[3] }',
      loop64:
        'loop64 :: proc(s0, k: u32) -> u32 { s := s0; for i in u32(0) ..< 64 { b := (s ~ k) * 2654435761; s = (b ~ (b >> 15)) + i }; return s }',
    },
    program: (k, src) => `package main
import "core:fmt"
import "core:os"
import "core:strconv"
import "core:time"
${src}
rng :: proc(s: ^u32) -> u32 { x := s^; x ~= x << 13; x ~= x >> 17; x ~= x << 5; s^ = x; return x }
main :: proc() {
  iters: u64 = ${TIER.native}
  if len(os.args) > 1 {
    v, ok := strconv.parse_u64(os.args[1])
    if ok { iters = v }
  }
  s: u32 = 0x9e3779b9
  acc: u32 = 0
  t0 := time.tick_now()
  for i: u64 = 0; i < iters; i += 1 {
    ${each(k, (i) => `a${i} := rng(&s)`, '; ')}
    acc ~= ${k.name}(${args(k)})
  }
  ns := f64(time.tick_since(t0)) / f64(iters)
  fmt.printf("%.4f %d\\n", ns, acc)
}
`,
    build: (dir, t) => [
      [
        t.bin.main as string,
        ['build', join(dir, 'bench.odin'), '-file', '-o:speed', `-out:${join(dir, 'bench')}`],
      ],
    ],
    run: (dir, _t, iters) => [join(dir, 'bench'), [iters]],
  },
  // ---------------------------------------------------------------- Vala (valac, C backend -O2)
  {
    id: 'vala',
    label: 'Vala',
    family: 'compiled-native',
    startupGroup: 'compiled',
    iterations: TIER.native,
    file: 'bench.vala',
    find: single('valac', 'A0_VALAC', ['--version']),
    kernels: {
      affine: 'uint32 affine(uint32 x, uint32 s, uint32 o) { return x * s + o; }',
      rotl: 'uint32 rotl(uint32 x, uint32 n) { return (x << (n & 31)) | (x >> ((32 - n) & 31)); }',
      clamp:
        'uint32 clamp(uint32 x, uint32 lo, uint32 hi) { uint32 t = hi < x ? hi : x; return t < lo ? lo : t; }',
      mix: 'uint32 mix(uint32 x, uint32 y) { uint32 a = x ^ y; uint32 d = (a << 13) | (a >> 19); uint32 f = d * 2654435761u + x; return f ^ (f >> 16); }',
      ident: 'uint32 ident(uint32 x) { return x; }',
      noop: 'uint32 noop(uint32 x) { return x; }',
      chain3:
        'uint32 inc1(uint32 x) { return x + 1; }\nuint32 dbl(uint32 x) { return x + x; }\nuint32 chain3(uint32 x, uint32 y) { return inc1(dbl(inc1(x))) + y; }',
      branchy:
        'uint32 branchy(uint32 x, uint32 y) { uint32 m = x < y ? y - x : x - y; uint32 z = x == y ? 0u : m; return (z & 1u) == 1u ? z : x; }',
      arrfill:
        'uint32 arrfill(uint32 x, uint32 y) { uint32[] a = new uint32[8]; for (uint32 i = 0; i < 8; i++) a[i] = i + x; return a[y % 8] + a[3]; }',
      loop64:
        'uint32 loop64(uint32 s, uint32 k) { for (uint32 i = 0; i < 64; i++) { uint32 b = (s ^ k) * 2654435761u; s = (b ^ (b >> 15)) + i; } return s; }',
    },
    program: (k, src) => `${src}
uint32 rng(ref uint32 s) { uint32 x = s; x ^= x << 13; x ^= x >> 17; x ^= x << 5; s = x; return x; }
int main(string[] argv) {
  int64 iters = argv.length > 1 ? int64.parse(argv[1]) : ${TIER.native};
  uint32 s = 0x9e3779b9u;
  uint32 acc = 0;
  int64 t0 = GLib.get_monotonic_time();
  for (int64 i = 0; i < iters; i++) {
    ${each(k, (i) => `uint32 a${i} = rng(ref s);`)}
    acc ^= ${k.name}(${args(k)});
  }
  double ns = (GLib.get_monotonic_time() - t0) * 1000.0 / iters;
  stdout.printf("%.4f %u\\n", ns, acc);
  return 0;
}
`,
    build: (dir, t) => [
      [
        t.bin.main as string,
        ['-X', '-O2', '-X', '-w', '-o', join(dir, 'bench'), join(dir, 'bench.vala')],
      ],
    ],
    run: (dir, _t, iters) => [join(dir, 'bench'), [iters]],
  },
  // ---------------------------------------------------------------- Gleam (Erlang target, no dependencies)
  {
    id: 'gleam',
    label: 'Gleam',
    family: 'vm',
    startupGroup: 'interpreters',
    iterations: TIER.interpreted,
    file: join('src', 'bench.gleam'),
    find: () => {
      const gleam = locate('gleam', 'A0_GLEAM');
      const erl = locate('erl', 'A0_ERL');
      if (gleam === undefined || erl === undefined) return undefined;
      return { version: versionLine(gleam, ['--version']), bin: { main: gleam, erl } };
    },
    kernels: {
      affine: 'pub fn affine(x: Int, s: Int, o: Int) -> Int { band(x * s + o, m) }',
      rotl: 'pub fn rotl(x: Int, n: Int) -> Int { band(bor(bsl(x, band(n, 31)), bsr(x, band(32 - n, 31))), m) }',
      clamp:
        'pub fn clamp(x: Int, lo: Int, hi: Int) -> Int {\n  let t = case hi < x { True -> hi False -> x }\n  case t < lo { True -> lo False -> t }\n}',
      mix: 'pub fn mix(x: Int, y: Int) -> Int {\n  let a = bxor(x, y)\n  let d = band(bor(bsl(a, 13), bsr(a, 19)), m)\n  let f = band(d * 2654435761 + x, m)\n  bxor(f, bsr(f, 16))\n}',
      ident: 'pub fn ident(x: Int) -> Int { x }',
      noop: 'pub fn noop(x: Int) -> Int { x }',
      chain3:
        'pub fn inc1(x: Int) -> Int { band(x + 1, m) }\npub fn dbl(x: Int) -> Int { band(x + x, m) }\npub fn chain3(x: Int, y: Int) -> Int { band(inc1(dbl(inc1(x))) + y, m) }',
      branchy:
        'pub fn branchy(x: Int, y: Int) -> Int {\n  let mm = case x < y { True -> band(y - x, m) False -> band(x - y, m) }\n  let z = case x == y { True -> 0 False -> mm }\n  case band(z, 1) == 1 { True -> z False -> x }\n}',
      arrfill:
        'pub fn arrfill(x: Int, y: Int) -> Int {\n  let a = fill(0, x, [])\n  band(at(a, y % 8) + at(a, 3), m)\n}\nfn fill(i: Int, x: Int, acc: List(Int)) -> List(Int) {\n  case i { 8 -> reverse(acc, []) _ -> fill(i + 1, x, [band(i + x, m), ..acc]) }\n}\nfn reverse(l: List(Int), acc: List(Int)) -> List(Int) {\n  case l { [] -> acc [h, ..t] -> reverse(t, [h, ..acc]) }\n}\nfn at(l: List(Int), i: Int) -> Int {\n  case l { [] -> 0 [h, ..t] -> case i { 0 -> h _ -> at(t, i - 1) } }\n}',
      loop64:
        'pub fn loop64(s: Int, k: Int) -> Int { loop64_(0, s, k) }\nfn loop64_(i: Int, s: Int, k: Int) -> Int {\n  case i {\n    64 -> s\n    _ -> {\n      let b = band(bxor(s, k) * 2654435761, m)\n      loop64_(i + 1, band(bxor(b, bsr(b, 15)) + i, m), k)\n    }\n  }\n}',
    },
    program: (
      k,
      src,
    ) => `// Gleam without gleam_stdlib (no network fetch): bit operations and I/O through Erlang externals.
const m = ${M}

@external(erlang, "erlang", "band")
fn band(a: Int, b: Int) -> Int
@external(erlang, "erlang", "bor")
fn bor(a: Int, b: Int) -> Int
@external(erlang, "erlang", "bxor")
fn bxor(a: Int, b: Int) -> Int
@external(erlang, "erlang", "bsl")
fn bsl(a: Int, b: Int) -> Int
@external(erlang, "erlang", "bsr")
fn bsr(a: Int, b: Int) -> Int
@external(erlang, "erlang", "monotonic_time")
fn monotonic_time(unit: Unit) -> Int
@external(erlang, "init", "get_plain_arguments")
fn plain_arguments() -> List(List(Int))
@external(erlang, "erlang", "list_to_integer")
fn list_to_integer(s: List(Int)) -> Int
@external(erlang, "io", "format")
fn io_format_float(fmt: List(Int), args: List(Float)) -> Nil
@external(erlang, "io", "format")
fn io_format_int(fmt: List(Int), args: List(Int)) -> Nil
@external(erlang, "erlang", "float")
fn to_float(i: Int) -> Float

pub type Unit {
  Nanosecond
}

${src}

fn rng(s: Int) -> Int {
  let s = bxor(s, band(bsl(s, 13), m))
  let s = bxor(s, bsr(s, 17))
  bxor(s, band(bsl(s, 5), m))
}

fn run(n: Int, s: Int, acc: Int) -> Int {
  case n {
    0 -> acc
    _ -> {
      ${chain(k, (i) => `let s = rng(s)\n      let a${i} = s`, '\n      ')}
      run(n - 1, s, band(bxor(acc, ${k.name}(${args(k)})), m))
    }
  }
}

pub fn main() {
  let iters = case plain_arguments() {
    [a, ..] -> list_to_integer(a)
    _ -> ${TIER.interpreted}
  }
  let t0 = monotonic_time(Nanosecond)
  let acc = run(iters, 2654435769, 0)
  let dt = monotonic_time(Nanosecond) - t0
  let ns = to_float(dt) /. to_float(iters)
  // "~.4f " then "~B~n" (format strings as Erlang charlists).
  io_format_float([126, 46, 52, 102, 32], [ns])
  io_format_int([126, 66, 126, 110], [acc])
}
`,
    extraFiles: () => ({
      'gleam.toml':
        'name = "bench"\nversion = "0.0.0"\ntarget = "erlang"\n\n[dependencies]\n\n[dev-dependencies]\n',
    }),
    build: (_dir, t) => [[t.bin.main as string, ['build', '--target', 'erlang']]],
    run: (dir, t, iters) => [
      t.bin.erl as string,
      [
        '-noshell',
        '-pa',
        join(dir, 'build', 'dev', 'erlang', 'bench', 'ebin'),
        '-s',
        'bench',
        'main',
        '-s',
        'init',
        'stop',
        '-extra',
        iters,
      ],
    ],
  },
];
