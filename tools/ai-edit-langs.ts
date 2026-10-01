/**
 * Further representations for the AI-edit experiment: Python, Go, Java, C#, C++ (below),
 * and Kotlin, Swift, Ruby, PHP, Haskell, OCaml, Elixir, Zig (one LangSpec module each in
 * tools/edit-langs/).
 *
 * Hand-written translations of every function in task set B and in the set-C / c400
 * project program (the set-B originals and references, the set-A originals that fill
 * the project, the fold-helper and examples/ extras, and the six generated filler
 * templates), with the same names and u32 semantics as the A0, TypeScript and Rust
 * texts: Python masks with & 0xFFFFFFFF, Go uses uint32, Java int with unsigned compare
 * and divide, C# uint, C++ uint32_t; shift counts are masked to 5 bits; div by zero gives
 * 4294967295 (only pctof divides). Records: (u32,u32) and (u32,bool) are tuples in Python,
 * the U32U32 / U32Bool types in Go and Java, value tuples in C#, std::pair in C++.
 *
 * Acceptance follows acceptTs/acceptRust: write the candidate file, build it with the
 * installed toolchain (python3 -m py_compile, go build, javac, dotnet build, clang++),
 * run a generated driver that prints every test result in one canonical text form, and
 * compare against the expected values.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Type, TypedProgram, Value } from '../src/core.js';
import { findClangPlusPlus, findJava, findJavac, runTool, withTempDir } from '../src/toolchain.js';
import type { FillerFunction } from './ai-edit-tasks-c.js';
import { SPEC_LANGS, SPECS, type SpecLang } from './edit-langs/index.js';
import {
  type BTaskId,
  BUILD_MS,
  type LangCase,
  type Pair,
  RUN_MS,
  tool,
} from './edit-langs/spec.js';

export type { LangCase } from './edit-langs/spec.js';

const BASE_LANGS = ['python', 'go', 'java', 'csharp', 'cpp'] as const;
type BaseLang = (typeof BASE_LANGS)[number];
export const LANGS = [...BASE_LANGS, ...SPEC_LANGS] as const;
export type Lang = BaseLang | SpecLang;

export function isLang(x: string): x is Lang {
  return (LANGS as readonly string[]).includes(x);
}

const isSpecLang = (l: Lang): l is SpecLang => (SPEC_LANGS as readonly string[]).includes(l);

const fromSpecs = <T>(f: (l: SpecLang) => T): Record<SpecLang, T> =>
  Object.fromEntries(SPEC_LANGS.map((l) => [l, f(l)])) as Record<SpecLang, T>;

/** Language primers (bucket 1), the counterpart of TS_SEMANTICS and RUST_SEMANTICS. */
export const LANG_SEMANTICS: Record<Lang, string> = {
  ...fromSpecs((l) => SPECS[l].semantics),
  python:
    'Integers are unsigned 32-bit: mask every arithmetic result with & 0xFFFFFFFF, mask shift counts to 5 bits (& 31); comparisons are unsigned. Division by zero gives 4294967295; remainder by zero gives the dividend. The file must run with python3.',
  go: 'Integers are uint32 with wrapping arithmetic; mask shift counts to 5 bits (& 31), since Go shifts of 32 or more give 0; comparisons are unsigned. Division by zero gives 4294967295; remainder by zero gives the dividend. The file must build with go build (package main).',
  java: 'Integers are u32 held in int with wrapping arithmetic: compare with Integer.compareUnsigned, divide with Integer.divideUnsigned / remainderUnsigned, shift right with >>> (shift counts are masked to 5 bits). Division by zero gives 4294967295; remainder by zero gives the dividend. The file must compile with javac.',
  csharp:
    'Integers are uint with wrapping (unchecked) arithmetic; shift counts are masked to 5 bits; comparisons are unsigned; records are value tuples. Division by zero gives 4294967295; remainder by zero gives the dividend. The file must compile with the .NET SDK.',
  cpp: 'Integers are uint32_t with wrapping arithmetic; mask shift counts to 5 bits (& 31); comparisons are unsigned; records are std::pair. Division by zero gives 4294967295; remainder by zero gives the dividend. The file must compile with clang++ -std=c++20.',
};

// --- File layout ------------------------------------------------------------------

/** A top-level function's first line, by language (function texts are unindented). */
const HEAD: Record<Lang, RegExp> = {
  ...fromSpecs((l) => SPECS[l].head),
  python: /^def ([A-Za-z_][A-Za-z0-9_]*)\(/,
  go: /^func ([A-Za-z_][A-Za-z0-9_]*)\(/,
  java: /^public static .*? ([A-Za-z_][A-Za-z0-9_]*)\(/,
  csharp: /^public static .*? ([A-Za-z_][A-Za-z0-9_]*)\(/,
  cpp: /^[A-Za-z].*? ([A-Za-z_][A-Za-z0-9_]*)\(/,
};

/** Splits unindented function texts into name -> text (each ending in one newline). */
export function splitLang(lang: Lang, body: string): Map<string, string> {
  const out = new Map<string, string>();
  let name: string | undefined;
  let lines: string[] = [];
  const flush = (): void => {
    if (name !== undefined) out.set(name, `${lines.join('\n').trimEnd()}\n`);
  };
  for (const line of body.split('\n')) {
    const m = HEAD[lang].exec(line);
    if (m !== null) {
      flush();
      name = m[1];
      lines = [];
    }
    if (name !== undefined) lines.push(line);
  }
  flush();
  return out;
}

const indent = (text: string): string =>
  text
    .trimEnd()
    .split('\n')
    .map((l) => (l.length === 0 ? l : `    ${l}`))
    .join('\n');

/**
 * The source file for a list of function texts: the language's module wrapper (Go
 * package and record types, Java/C# static class, C++ includes) around the functions.
 * Record types are declared only when a function uses them.
 */
export function langFile(lang: Lang, body: string): string {
  if (isSpecLang(lang)) return SPECS[lang].file(body);
  const pair = body.includes('U32U32');
  const flag = body.includes('U32Bool');
  switch (lang) {
    case 'python':
      return body;
    case 'go': {
      const types = [
        ...(pair ? ['type U32U32 struct {\n\tA, B uint32\n}\n'] : []),
        ...(flag ? ['type U32Bool struct {\n\tA uint32\n\tB bool\n}\n'] : []),
      ];
      return `package main\n\n${types.map((t) => `${t}\n`).join('')}${body}`;
    }
    case 'java': {
      const records = [
        ...(pair ? ['public record U32U32(int a, int b) {}'] : []),
        ...(flag ? ['public record U32Bool(int a, boolean b) {}'] : []),
      ];
      const inner = [...records, body].join('\n');
      return `public final class Lib {\n${indent(inner)}\n}\n`;
    }
    case 'csharp':
      return `public static class Lib\n{\n${indent(body)}\n}\n`;
    case 'cpp':
      return `#include <array>\n#include <cstdint>\n#include <utility>\n\n${body}`;
  }
}

// --- Set B: originals and references ------------------------------------------------

/** Unindented function texts for the twelve set-B tasks, by task id (base languages). */
const BASE_B: Record<BTaskId, Record<BaseLang, Pair>> = {
  'b-fits-inclusive': {
    python: {
      source: 'def fits(a: int, b: int) -> bool:\n    return a < b\n',
      reference: 'def fits(a: int, b: int) -> bool:\n    return a <= b\n',
    },
    go: {
      source: 'func fits(a uint32, b uint32) bool {\n\treturn a < b\n}\n',
      reference: 'func fits(a uint32, b uint32) bool {\n\treturn a <= b\n}\n',
    },
    java: {
      source:
        'public static boolean fits(int a, int b) {\n    return Integer.compareUnsigned(a, b) < 0;\n}\n',
      reference:
        'public static boolean fits(int a, int b) {\n    return Integer.compareUnsigned(a, b) <= 0;\n}\n',
    },
    csharp: {
      source: 'public static bool fits(uint a, uint b)\n{\n    return a < b;\n}\n',
      reference: 'public static bool fits(uint a, uint b)\n{\n    return a <= b;\n}\n',
    },
    cpp: {
      source: 'bool fits(uint32_t a, uint32_t b) {\n    return a < b;\n}\n',
      reference: 'bool fits(uint32_t a, uint32_t b) {\n    return a <= b;\n}\n',
    },
  },
  'b-sumfrom-eight': {
    python: {
      source:
        'def sumfrom(x: int) -> int:\n    s = x\n    for i in range(5):\n        s = (s + i) & 0xFFFFFFFF\n    return s\n',
      reference:
        'def sumfrom(x: int) -> int:\n    s = x\n    for i in range(8):\n        s = (s + i) & 0xFFFFFFFF\n    return s\n',
    },
    go: {
      source:
        'func sumfrom(x uint32) uint32 {\n\ts := x\n\tfor i := uint32(0); i < 5; i++ {\n\t\ts += i\n\t}\n\treturn s\n}\n',
      reference:
        'func sumfrom(x uint32) uint32 {\n\ts := x\n\tfor i := uint32(0); i < 8; i++ {\n\t\ts += i\n\t}\n\treturn s\n}\n',
    },
    java: {
      source:
        'public static int sumfrom(int x) {\n    int s = x;\n    for (int i = 0; i < 5; i++) {\n        s += i;\n    }\n    return s;\n}\n',
      reference:
        'public static int sumfrom(int x) {\n    int s = x;\n    for (int i = 0; i < 8; i++) {\n        s += i;\n    }\n    return s;\n}\n',
    },
    csharp: {
      source:
        'public static uint sumfrom(uint x)\n{\n    uint s = x;\n    for (uint i = 0; i < 5; i++)\n    {\n        s += i;\n    }\n    return s;\n}\n',
      reference:
        'public static uint sumfrom(uint x)\n{\n    uint s = x;\n    for (uint i = 0; i < 8; i++)\n    {\n        s += i;\n    }\n    return s;\n}\n',
    },
    cpp: {
      source:
        'uint32_t sumfrom(uint32_t x) {\n    uint32_t s = x;\n    for (uint32_t i = 0; i < 5; i++) {\n        s += i;\n    }\n    return s;\n}\n',
      reference:
        'uint32_t sumfrom(uint32_t x) {\n    uint32_t s = x;\n    for (uint32_t i = 0; i < 8; i++) {\n        s += i;\n    }\n    return s;\n}\n',
    },
  },
  'b-rot8-constant': {
    python: {
      source: 'def rot8(x: int) -> int:\n    return ((x << 8) | (x >> 23)) & 0xFFFFFFFF\n',
      reference: 'def rot8(x: int) -> int:\n    return ((x << 8) | (x >> 24)) & 0xFFFFFFFF\n',
    },
    go: {
      source: 'func rot8(x uint32) uint32 {\n\treturn (x << 8) | (x >> 23)\n}\n',
      reference: 'func rot8(x uint32) uint32 {\n\treturn (x << 8) | (x >> 24)\n}\n',
    },
    java: {
      source: 'public static int rot8(int x) {\n    return (x << 8) | (x >>> 23);\n}\n',
      reference: 'public static int rot8(int x) {\n    return (x << 8) | (x >>> 24);\n}\n',
    },
    csharp: {
      source: 'public static uint rot8(uint x)\n{\n    return (x << 8) | (x >> 23);\n}\n',
      reference: 'public static uint rot8(uint x)\n{\n    return (x << 8) | (x >> 24);\n}\n',
    },
    cpp: {
      source: 'uint32_t rot8(uint32_t x) {\n    return (x << 8) | (x >> 23);\n}\n',
      reference: 'uint32_t rot8(uint32_t x) {\n    return (x << 8) | (x >> 24);\n}\n',
    },
  },
  'b-onlyone-xor': {
    python: {
      source: 'def onlyone(a: bool, b: bool) -> bool:\n    return a or b\n',
      reference: 'def onlyone(a: bool, b: bool) -> bool:\n    return a != b\n',
    },
    go: {
      source: 'func onlyone(a bool, b bool) bool {\n\treturn a || b\n}\n',
      reference: 'func onlyone(a bool, b bool) bool {\n\treturn a != b\n}\n',
    },
    java: {
      source: 'public static boolean onlyone(boolean a, boolean b) {\n    return a || b;\n}\n',
      reference: 'public static boolean onlyone(boolean a, boolean b) {\n    return a ^ b;\n}\n',
    },
    csharp: {
      source: 'public static bool onlyone(bool a, bool b)\n{\n    return a || b;\n}\n',
      reference: 'public static bool onlyone(bool a, bool b)\n{\n    return a ^ b;\n}\n',
    },
    cpp: {
      source: 'bool onlyone(bool a, bool b) {\n    return a || b;\n}\n',
      reference: 'bool onlyone(bool a, bool b) {\n    return a != b;\n}\n',
    },
  },
  'b-avgfloor-nowrap': {
    python: {
      source: 'def avgfloor(a: int, b: int) -> int:\n    return ((a + b) & 0xFFFFFFFF) >> 1\n',
      reference: 'def avgfloor(a: int, b: int) -> int:\n    return (a & b) + ((a ^ b) >> 1)\n',
    },
    go: {
      source: 'func avgfloor(a uint32, b uint32) uint32 {\n\treturn (a + b) >> 1\n}\n',
      reference:
        'func avgfloor(a uint32, b uint32) uint32 {\n\treturn (a & b) + ((a ^ b) >> 1)\n}\n',
    },
    java: {
      source: 'public static int avgfloor(int a, int b) {\n    return (a + b) >>> 1;\n}\n',
      reference:
        'public static int avgfloor(int a, int b) {\n    return (a & b) + ((a ^ b) >>> 1);\n}\n',
    },
    csharp: {
      source: 'public static uint avgfloor(uint a, uint b)\n{\n    return (a + b) >> 1;\n}\n',
      reference:
        'public static uint avgfloor(uint a, uint b)\n{\n    return (a & b) + ((a ^ b) >> 1);\n}\n',
    },
    cpp: {
      source: 'uint32_t avgfloor(uint32_t a, uint32_t b) {\n    return (a + b) >> 1;\n}\n',
      reference:
        'uint32_t avgfloor(uint32_t a, uint32_t b) {\n    return (a & b) + ((a ^ b) >> 1);\n}\n',
    },
  },
  'b-sumsq-array': {
    python: {
      source:
        'def sumsq(a: list[int]) -> int:\n    s = 0\n    for i in range(4):\n        s = (s + a[i]) & 0xFFFFFFFF\n    return s\n',
      reference:
        'def sumsq(a: list[int]) -> int:\n    s = 0\n    for i in range(4):\n        s = (s + a[i] * a[i]) & 0xFFFFFFFF\n    return s\n',
    },
    go: {
      source:
        'func sumsq(a [4]uint32) uint32 {\n\tvar s uint32\n\tfor i := 0; i < 4; i++ {\n\t\ts += a[i]\n\t}\n\treturn s\n}\n',
      reference:
        'func sumsq(a [4]uint32) uint32 {\n\tvar s uint32\n\tfor i := 0; i < 4; i++ {\n\t\ts += a[i] * a[i]\n\t}\n\treturn s\n}\n',
    },
    java: {
      source:
        'public static int sumsq(int[] a) {\n    int s = 0;\n    for (int i = 0; i < 4; i++) {\n        s += a[i];\n    }\n    return s;\n}\n',
      reference:
        'public static int sumsq(int[] a) {\n    int s = 0;\n    for (int i = 0; i < 4; i++) {\n        s += a[i] * a[i];\n    }\n    return s;\n}\n',
    },
    csharp: {
      source:
        'public static uint sumsq(uint[] a)\n{\n    uint s = 0;\n    for (int i = 0; i < 4; i++)\n    {\n        s += a[i];\n    }\n    return s;\n}\n',
      reference:
        'public static uint sumsq(uint[] a)\n{\n    uint s = 0;\n    for (int i = 0; i < 4; i++)\n    {\n        s += a[i] * a[i];\n    }\n    return s;\n}\n',
    },
    cpp: {
      source:
        'uint32_t sumsq(std::array<uint32_t, 4> a) {\n    uint32_t s = 0;\n    for (int i = 0; i < 4; i++) {\n        s += a[i];\n    }\n    return s;\n}\n',
      reference:
        'uint32_t sumsq(std::array<uint32_t, 4> a) {\n    uint32_t s = 0;\n    for (int i = 0; i < 4; i++) {\n        s += a[i] * a[i];\n    }\n    return s;\n}\n',
    },
  },
  'b-inrange-inclusive': {
    python: {
      source: 'def inrange(x: int, lo: int, hi: int) -> bool:\n    return x > lo and x < hi\n',
      reference: 'def inrange(x: int, lo: int, hi: int) -> bool:\n    return x >= lo and x <= hi\n',
    },
    go: {
      source: 'func inrange(x uint32, lo uint32, hi uint32) bool {\n\treturn x > lo && x < hi\n}\n',
      reference:
        'func inrange(x uint32, lo uint32, hi uint32) bool {\n\treturn x >= lo && x <= hi\n}\n',
    },
    java: {
      source:
        'public static boolean inrange(int x, int lo, int hi) {\n    return Integer.compareUnsigned(x, lo) > 0 && Integer.compareUnsigned(x, hi) < 0;\n}\n',
      reference:
        'public static boolean inrange(int x, int lo, int hi) {\n    return Integer.compareUnsigned(x, lo) >= 0 && Integer.compareUnsigned(x, hi) <= 0;\n}\n',
    },
    csharp: {
      source:
        'public static bool inrange(uint x, uint lo, uint hi)\n{\n    return x > lo && x < hi;\n}\n',
      reference:
        'public static bool inrange(uint x, uint lo, uint hi)\n{\n    return x >= lo && x <= hi;\n}\n',
    },
    cpp: {
      source:
        'bool inrange(uint32_t x, uint32_t lo, uint32_t hi) {\n    return x > lo && x < hi;\n}\n',
      reference:
        'bool inrange(uint32_t x, uint32_t lo, uint32_t hi) {\n    return x >= lo && x <= hi;\n}\n',
    },
  },
  'b-bounds-largest': {
    python: {
      source:
        'def bounds(a: list[int]) -> tuple[int, int]:\n    lo = 0xFFFFFFFF\n    hi = 0\n    for i in range(4):\n        x = a[i]\n        if x < lo:\n            lo = x\n        if x < hi:\n            hi = x\n    return (lo, hi)\n',
      reference:
        'def bounds(a: list[int]) -> tuple[int, int]:\n    lo = 0xFFFFFFFF\n    hi = 0\n    for i in range(4):\n        x = a[i]\n        if x < lo:\n            lo = x\n        if x > hi:\n            hi = x\n    return (lo, hi)\n',
    },
    go: {
      source:
        'func bounds(a [4]uint32) U32U32 {\n\tlo := uint32(0xFFFFFFFF)\n\thi := uint32(0)\n\tfor i := 0; i < 4; i++ {\n\t\tx := a[i]\n\t\tif x < lo {\n\t\t\tlo = x\n\t\t}\n\t\tif x < hi {\n\t\t\thi = x\n\t\t}\n\t}\n\treturn U32U32{lo, hi}\n}\n',
      reference:
        'func bounds(a [4]uint32) U32U32 {\n\tlo := uint32(0xFFFFFFFF)\n\thi := uint32(0)\n\tfor i := 0; i < 4; i++ {\n\t\tx := a[i]\n\t\tif x < lo {\n\t\t\tlo = x\n\t\t}\n\t\tif x > hi {\n\t\t\thi = x\n\t\t}\n\t}\n\treturn U32U32{lo, hi}\n}\n',
    },
    java: {
      source:
        'public static U32U32 bounds(int[] a) {\n    int lo = 0xFFFFFFFF;\n    int hi = 0;\n    for (int i = 0; i < 4; i++) {\n        int x = a[i];\n        if (Integer.compareUnsigned(x, lo) < 0) {\n            lo = x;\n        }\n        if (Integer.compareUnsigned(x, hi) < 0) {\n            hi = x;\n        }\n    }\n    return new U32U32(lo, hi);\n}\n',
      reference:
        'public static U32U32 bounds(int[] a) {\n    int lo = 0xFFFFFFFF;\n    int hi = 0;\n    for (int i = 0; i < 4; i++) {\n        int x = a[i];\n        if (Integer.compareUnsigned(x, lo) < 0) {\n            lo = x;\n        }\n        if (Integer.compareUnsigned(x, hi) > 0) {\n            hi = x;\n        }\n    }\n    return new U32U32(lo, hi);\n}\n',
    },
    csharp: {
      source:
        'public static (uint, uint) bounds(uint[] a)\n{\n    uint lo = uint.MaxValue;\n    uint hi = 0;\n    for (int i = 0; i < 4; i++)\n    {\n        uint x = a[i];\n        if (x < lo)\n        {\n            lo = x;\n        }\n        if (x < hi)\n        {\n            hi = x;\n        }\n    }\n    return (lo, hi);\n}\n',
      reference:
        'public static (uint, uint) bounds(uint[] a)\n{\n    uint lo = uint.MaxValue;\n    uint hi = 0;\n    for (int i = 0; i < 4; i++)\n    {\n        uint x = a[i];\n        if (x < lo)\n        {\n            lo = x;\n        }\n        if (x > hi)\n        {\n            hi = x;\n        }\n    }\n    return (lo, hi);\n}\n',
    },
    cpp: {
      source:
        'std::pair<uint32_t, uint32_t> bounds(std::array<uint32_t, 4> a) {\n    uint32_t lo = UINT32_MAX;\n    uint32_t hi = 0;\n    for (int i = 0; i < 4; i++) {\n        uint32_t x = a[i];\n        if (x < lo) {\n            lo = x;\n        }\n        if (x < hi) {\n            hi = x;\n        }\n    }\n    return {lo, hi};\n}\n',
      reference:
        'std::pair<uint32_t, uint32_t> bounds(std::array<uint32_t, 4> a) {\n    uint32_t lo = UINT32_MAX;\n    uint32_t hi = 0;\n    for (int i = 0; i < 4; i++) {\n        uint32_t x = a[i];\n        if (x < lo) {\n            lo = x;\n        }\n        if (x > hi) {\n            hi = x;\n        }\n    }\n    return {lo, hi};\n}\n',
    },
  },
  'b-checksum-poly': {
    python: {
      source:
        'def checksum(a: list[int]) -> int:\n    h = 0\n    for i in range(4):\n        h = h ^ a[i]\n    return h\n',
      reference:
        'def checksum(a: list[int]) -> int:\n    h = 7\n    for i in range(4):\n        h = (h * 31 + a[i]) & 0xFFFFFFFF\n    return h\n',
    },
    go: {
      source:
        'func checksum(a [4]uint32) uint32 {\n\tvar h uint32\n\tfor i := 0; i < 4; i++ {\n\t\th ^= a[i]\n\t}\n\treturn h\n}\n',
      reference:
        'func checksum(a [4]uint32) uint32 {\n\tvar h uint32 = 7\n\tfor i := 0; i < 4; i++ {\n\t\th = h*31 + a[i]\n\t}\n\treturn h\n}\n',
    },
    java: {
      source:
        'public static int checksum(int[] a) {\n    int h = 0;\n    for (int i = 0; i < 4; i++) {\n        h ^= a[i];\n    }\n    return h;\n}\n',
      reference:
        'public static int checksum(int[] a) {\n    int h = 7;\n    for (int i = 0; i < 4; i++) {\n        h = h * 31 + a[i];\n    }\n    return h;\n}\n',
    },
    csharp: {
      source:
        'public static uint checksum(uint[] a)\n{\n    uint h = 0;\n    for (int i = 0; i < 4; i++)\n    {\n        h ^= a[i];\n    }\n    return h;\n}\n',
      reference:
        'public static uint checksum(uint[] a)\n{\n    uint h = 7;\n    for (int i = 0; i < 4; i++)\n    {\n        h = h * 31 + a[i];\n    }\n    return h;\n}\n',
    },
    cpp: {
      source:
        'uint32_t checksum(std::array<uint32_t, 4> a) {\n    uint32_t h = 0;\n    for (int i = 0; i < 4; i++) {\n        h ^= a[i];\n    }\n    return h;\n}\n',
      reference:
        'uint32_t checksum(std::array<uint32_t, 4> a) {\n    uint32_t h = 7;\n    for (int i = 0; i < 4; i++) {\n        h = h * 31 + a[i];\n    }\n    return h;\n}\n',
    },
  },
  'b-norm2-dot': {
    python: {
      source:
        'def dot(a: list[int], b: list[int]) -> int:\n    s = 0\n    for i in range(4):\n        s = (s + a[i] * b[i]) & 0xFFFFFFFF\n    return s\n',
      reference:
        'def dot(a: list[int], b: list[int]) -> int:\n    s = 0\n    for i in range(4):\n        s = (s + a[i] * b[i]) & 0xFFFFFFFF\n    return s\ndef norm2(a: list[int]) -> int:\n    return dot(a, a)\n',
    },
    go: {
      source:
        'func dot(a [4]uint32, b [4]uint32) uint32 {\n\tvar s uint32\n\tfor i := 0; i < 4; i++ {\n\t\ts += a[i] * b[i]\n\t}\n\treturn s\n}\n',
      reference:
        'func dot(a [4]uint32, b [4]uint32) uint32 {\n\tvar s uint32\n\tfor i := 0; i < 4; i++ {\n\t\ts += a[i] * b[i]\n\t}\n\treturn s\n}\nfunc norm2(a [4]uint32) uint32 {\n\treturn dot(a, a)\n}\n',
    },
    java: {
      source:
        'public static int dot(int[] a, int[] b) {\n    int s = 0;\n    for (int i = 0; i < 4; i++) {\n        s += a[i] * b[i];\n    }\n    return s;\n}\n',
      reference:
        'public static int dot(int[] a, int[] b) {\n    int s = 0;\n    for (int i = 0; i < 4; i++) {\n        s += a[i] * b[i];\n    }\n    return s;\n}\npublic static int norm2(int[] a) {\n    return dot(a, a);\n}\n',
    },
    csharp: {
      source:
        'public static uint dot(uint[] a, uint[] b)\n{\n    uint s = 0;\n    for (int i = 0; i < 4; i++)\n    {\n        s += a[i] * b[i];\n    }\n    return s;\n}\n',
      reference:
        'public static uint dot(uint[] a, uint[] b)\n{\n    uint s = 0;\n    for (int i = 0; i < 4; i++)\n    {\n        s += a[i] * b[i];\n    }\n    return s;\n}\npublic static uint norm2(uint[] a)\n{\n    return dot(a, a);\n}\n',
    },
    cpp: {
      source:
        'uint32_t dot(std::array<uint32_t, 4> a, std::array<uint32_t, 4> b) {\n    uint32_t s = 0;\n    for (int i = 0; i < 4; i++) {\n        s += a[i] * b[i];\n    }\n    return s;\n}\n',
      reference:
        'uint32_t dot(std::array<uint32_t, 4> a, std::array<uint32_t, 4> b) {\n    uint32_t s = 0;\n    for (int i = 0; i < 4; i++) {\n        s += a[i] * b[i];\n    }\n    return s;\n}\nuint32_t norm2(std::array<uint32_t, 4> a) {\n    return dot(a, a);\n}\n',
    },
  },
  'b-pctof-limit': {
    python: {
      source:
        'def limit(x: int, lo: int, hi: int) -> int:\n    b = lo if x < lo else x\n    return hi if b > hi else b\n',
      reference:
        'def limit(x: int, lo: int, hi: int) -> int:\n    b = lo if x < lo else x\n    return hi if b > hi else b\ndef pctof(part: int, whole: int) -> int:\n    n = (part * 100) & 0xFFFFFFFF\n    q = 0xFFFFFFFF if whole == 0 else n // whole\n    return limit(q, 0, 100)\n',
    },
    go: {
      source:
        'func limit(x uint32, lo uint32, hi uint32) uint32 {\n\tb := x\n\tif x < lo {\n\t\tb = lo\n\t}\n\tif b > hi {\n\t\treturn hi\n\t}\n\treturn b\n}\n',
      reference:
        'func limit(x uint32, lo uint32, hi uint32) uint32 {\n\tb := x\n\tif x < lo {\n\t\tb = lo\n\t}\n\tif b > hi {\n\t\treturn hi\n\t}\n\treturn b\n}\nfunc pctof(part uint32, whole uint32) uint32 {\n\tn := part * 100\n\tq := uint32(0xFFFFFFFF)\n\tif whole != 0 {\n\t\tq = n / whole\n\t}\n\treturn limit(q, 0, 100)\n}\n',
    },
    java: {
      source:
        'public static int limit(int x, int lo, int hi) {\n    int b = Integer.compareUnsigned(x, lo) < 0 ? lo : x;\n    return Integer.compareUnsigned(b, hi) > 0 ? hi : b;\n}\n',
      reference:
        'public static int limit(int x, int lo, int hi) {\n    int b = Integer.compareUnsigned(x, lo) < 0 ? lo : x;\n    return Integer.compareUnsigned(b, hi) > 0 ? hi : b;\n}\npublic static int pctof(int part, int whole) {\n    int n = part * 100;\n    int q = whole == 0 ? 0xFFFFFFFF : Integer.divideUnsigned(n, whole);\n    return limit(q, 0, 100);\n}\n',
    },
    csharp: {
      source:
        'public static uint limit(uint x, uint lo, uint hi)\n{\n    uint b = x < lo ? lo : x;\n    return b > hi ? hi : b;\n}\n',
      reference:
        'public static uint limit(uint x, uint lo, uint hi)\n{\n    uint b = x < lo ? lo : x;\n    return b > hi ? hi : b;\n}\npublic static uint pctof(uint part, uint whole)\n{\n    uint n = part * 100;\n    uint q = whole == 0 ? uint.MaxValue : n / whole;\n    return limit(q, 0, 100);\n}\n',
    },
    cpp: {
      source:
        'uint32_t limit(uint32_t x, uint32_t lo, uint32_t hi) {\n    uint32_t b = x < lo ? lo : x;\n    return b > hi ? hi : b;\n}\n',
      reference:
        'uint32_t limit(uint32_t x, uint32_t lo, uint32_t hi) {\n    uint32_t b = x < lo ? lo : x;\n    return b > hi ? hi : b;\n}\nuint32_t pctof(uint32_t part, uint32_t whole) {\n    uint32_t n = part * 100;\n    uint32_t q = whole == 0 ? UINT32_MAX : n / whole;\n    return limit(q, 0, 100);\n}\n',
    },
  },
  'b-hamming-popcnt': {
    python: {
      source:
        'def popcnt(x: int) -> int:\n    s = 0\n    for i in range(32):\n        s = (s + ((x >> i) & 1)) & 0xFFFFFFFF\n    return s\n',
      reference:
        'def popcnt(x: int) -> int:\n    s = 0\n    for i in range(32):\n        s = (s + ((x >> i) & 1)) & 0xFFFFFFFF\n    return s\ndef hamming(a: int, b: int) -> int:\n    return popcnt(a ^ b)\n',
    },
    go: {
      source:
        'func popcnt(x uint32) uint32 {\n\tvar s uint32\n\tfor i := uint32(0); i < 32; i++ {\n\t\ts += (x >> i) & 1\n\t}\n\treturn s\n}\n',
      reference:
        'func popcnt(x uint32) uint32 {\n\tvar s uint32\n\tfor i := uint32(0); i < 32; i++ {\n\t\ts += (x >> i) & 1\n\t}\n\treturn s\n}\nfunc hamming(a uint32, b uint32) uint32 {\n\treturn popcnt(a ^ b)\n}\n',
    },
    java: {
      source:
        'public static int popcnt(int x) {\n    int s = 0;\n    for (int i = 0; i < 32; i++) {\n        s += (x >>> i) & 1;\n    }\n    return s;\n}\n',
      reference:
        'public static int popcnt(int x) {\n    int s = 0;\n    for (int i = 0; i < 32; i++) {\n        s += (x >>> i) & 1;\n    }\n    return s;\n}\npublic static int hamming(int a, int b) {\n    return popcnt(a ^ b);\n}\n',
    },
    csharp: {
      source:
        'public static uint popcnt(uint x)\n{\n    uint s = 0;\n    for (int i = 0; i < 32; i++)\n    {\n        s += (x >> i) & 1;\n    }\n    return s;\n}\n',
      reference:
        'public static uint popcnt(uint x)\n{\n    uint s = 0;\n    for (int i = 0; i < 32; i++)\n    {\n        s += (x >> i) & 1;\n    }\n    return s;\n}\npublic static uint hamming(uint a, uint b)\n{\n    return popcnt(a ^ b);\n}\n',
    },
    cpp: {
      source:
        'uint32_t popcnt(uint32_t x) {\n    uint32_t s = 0;\n    for (uint32_t i = 0; i < 32; i++) {\n        s += (x >> i) & 1;\n    }\n    return s;\n}\n',
      reference:
        'uint32_t popcnt(uint32_t x) {\n    uint32_t s = 0;\n    for (uint32_t i = 0; i < 32; i++) {\n        s += (x >> i) & 1;\n    }\n    return s;\n}\nuint32_t hamming(uint32_t a, uint32_t b) {\n    return popcnt(a ^ b);\n}\n',
    },
  },
};

// --- Project filler: set-A originals and the extras of set C --------------------------

/**
 * The set-A originals that fill the project program (affine, clamp, rotl, sq, quad,
 * absdiff, combine4, min2, sumto, countup, pick, byte1, sadd) followed by the set-C
 * extras (fold helpers and the examples/ functions), each a translation of the
 * TypeScript/Rust text in tools/ai-edit-experiment.ts and tools/ai-edit-tasks-c.ts.
 */
const BASE_FILLER: Record<BaseLang, string> = {
  python: `def affine(x: int, scale: int, offset: int) -> int:
    return (x * scale + offset) & 0xFFFFFFFF
def clamp(x: int, hi: int) -> int:
    return hi if hi < x else x
def rotl(x: int, n: int) -> int:
    return ((x << (n & 31)) | (x << ((32 - n) & 31))) & 0xFFFFFFFF
def sq(x: int) -> int:
    return (x * x) & 0xFFFFFFFF
def quad(x: int) -> int:
    return sq(x)
def absdiff(a: int, b: int) -> int:
    return (a - b) & 0xFFFFFFFF
def combine4(a: int, b: int, c: int, d: int) -> int:
    return (a + b + c + d) & 0xFFFFFFFF
def min2(a: int, b: int) -> int:
    return b if b < a else a
def sumto(n: int) -> int:
    s = 0
    for i in range(n):
        s = (s + i) & 0xFFFFFFFF
    return s
def countup(limit: int, cap: int) -> int:
    s = 0
    for _ in range(cap):
        if not (s < limit):
            break
        s = (s + 1) & 0xFFFFFFFF
    return s
def pick(r: tuple[int, bool]) -> int:
    return r[0]
def byte1(x: int) -> int:
    return (x >> 8) & 0xFF
def sadd(a: int, b: int) -> int:
    return (a + b) & 0xFFFFFFFF
def is_even(x: int) -> bool:
    return (x & 1) == 0
def addi(acc: int, i: int) -> int:
    return (acc + i) & 0xFFFFFFFF
def inc(s: int, i: int, limit: int) -> int:
    return (s + 1) & 0xFFFFFFFF
def below(s: int, i: int, limit: int) -> bool:
    return s < limit
def addel(acc: int, i: int, a: list[int]) -> int:
    return (acc + a[i % 4]) & 0xFFFFFFFF
def minmax(acc: tuple[int, int], i: int, a: list[int]) -> tuple[int, int]:
    lo, hi = acc
    x = a[i % 4]
    nlo = x if x < lo else lo
    nhi = x if x < hi else hi
    return (nlo, nhi)
def mixel(acc: int, i: int, a: list[int]) -> int:
    return acc ^ a[i % 4]
def dstep(acc: int, i: int, a: list[int], b: list[int]) -> int:
    return (acc + a[i % 4] * b[i % 4]) & 0xFFFFFFFF
def pstep(acc: int, i: int, x: int) -> int:
    return (acc + ((x >> (i & 31)) & 1)) & 0xFFFFFFFF
def nb(grid: list[int], r: int, c: int) -> int:
    row = grid[r % 32]
    return (row >> (c & 31)) & 1
def count(grid: list[int], r: int, c: int) -> int:
    ru = (r - 1) & 0xFFFFFFFF
    rd = (r + 1) & 0xFFFFFFFF
    cl = (c - 1) & 0xFFFFFFFF
    cr = (c + 1) & 0xFFFFFFFF
    s = nb(grid, ru, cl)
    s = (s + nb(grid, ru, c)) & 0xFFFFFFFF
    s = (s + nb(grid, ru, cr)) & 0xFFFFFFFF
    s = (s + nb(grid, r, cl)) & 0xFFFFFFFF
    s = (s + nb(grid, r, cr)) & 0xFFFFFFFF
    s = (s + nb(grid, rd, cl)) & 0xFFFFFFFF
    s = (s + nb(grid, rd, c)) & 0xFFFFFFFF
    s = (s + nb(grid, rd, cr)) & 0xFFFFFFFF
    return s
def bitstep(acc: int, i: int, x: int) -> int:
    return (acc + ((x >> (i & 31)) & 1)) & 0xFFFFFFFF
def popcount(x: int) -> int:
    n = 0
    for i in range(32):
        n = bitstep(n, i, x)
    return n
def rowpop(acc: int, i: int, grid: list[int]) -> int:
    return (acc + popcount(grid[i % 32])) & 0xFFFFFFFF
def population(grid: list[int]) -> int:
    n = 0
    for i in range(32):
        n = rowpop(n, i, grid)
    return n
`,
  go: `func affine(x uint32, scale uint32, offset uint32) uint32 {
\treturn x*scale + offset
}
func clamp(x uint32, hi uint32) uint32 {
\tif hi < x {
\t\treturn hi
\t}
\treturn x
}
func rotl(x uint32, n uint32) uint32 {
\treturn (x << (n & 31)) | (x << ((32 - n) & 31))
}
func sq(x uint32) uint32 {
\treturn x * x
}
func quad(x uint32) uint32 {
\treturn sq(x)
}
func absdiff(a uint32, b uint32) uint32 {
\treturn a - b
}
func combine4(a uint32, b uint32, c uint32, d uint32) uint32 {
\treturn a + b + c + d
}
func min2(a uint32, b uint32) uint32 {
\tif b < a {
\t\treturn b
\t}
\treturn a
}
func sumto(n uint32) uint32 {
\tvar s uint32
\tfor i := uint32(0); i < n; i++ {
\t\ts += i
\t}
\treturn s
}
func countup(limit uint32, cap uint32) uint32 {
\tvar s uint32
\tfor i := uint32(0); i < cap; i++ {
\t\tif !(s < limit) {
\t\t\tbreak
\t\t}
\t\ts++
\t}
\treturn s
}
func pick(r U32Bool) uint32 {
\treturn r.A
}
func byte1(x uint32) uint32 {
\treturn (x >> 8) & 0xFF
}
func sadd(a uint32, b uint32) uint32 {
\treturn a + b
}
func is_even(x uint32) bool {
\treturn x&1 == 0
}
func addi(acc uint32, i uint32) uint32 {
\treturn acc + i
}
func inc(s uint32, i uint32, limit uint32) uint32 {
\treturn s + 1
}
func below(s uint32, i uint32, limit uint32) bool {
\treturn s < limit
}
func addel(acc uint32, i uint32, a [4]uint32) uint32 {
\treturn acc + a[i%4]
}
func minmax(acc U32U32, i uint32, a [4]uint32) U32U32 {
\tlo, hi := acc.A, acc.B
\tx := a[i%4]
\tnlo, nhi := lo, hi
\tif x < lo {
\t\tnlo = x
\t}
\tif x < hi {
\t\tnhi = x
\t}
\treturn U32U32{nlo, nhi}
}
func mixel(acc uint32, i uint32, a [4]uint32) uint32 {
\treturn acc ^ a[i%4]
}
func dstep(acc uint32, i uint32, a [4]uint32, b [4]uint32) uint32 {
\treturn acc + a[i%4]*b[i%4]
}
func pstep(acc uint32, i uint32, x uint32) uint32 {
\treturn acc + ((x >> (i & 31)) & 1)
}
func nb(grid [32]uint32, r uint32, c uint32) uint32 {
\trow := grid[r%32]
\treturn (row >> (c & 31)) & 1
}
func count(grid [32]uint32, r uint32, c uint32) uint32 {
\tru := r - 1
\trd := r + 1
\tcl := c - 1
\tcr := c + 1
\ts := nb(grid, ru, cl)
\ts += nb(grid, ru, c)
\ts += nb(grid, ru, cr)
\ts += nb(grid, r, cl)
\ts += nb(grid, r, cr)
\ts += nb(grid, rd, cl)
\ts += nb(grid, rd, c)
\ts += nb(grid, rd, cr)
\treturn s
}
func bitstep(acc uint32, i uint32, x uint32) uint32 {
\treturn acc + ((x >> (i & 31)) & 1)
}
func popcount(x uint32) uint32 {
\tvar n uint32
\tfor i := uint32(0); i < 32; i++ {
\t\tn = bitstep(n, i, x)
\t}
\treturn n
}
func rowpop(acc uint32, i uint32, grid [32]uint32) uint32 {
\treturn acc + popcount(grid[i%32])
}
func population(grid [32]uint32) uint32 {
\tvar n uint32
\tfor i := uint32(0); i < 32; i++ {
\t\tn = rowpop(n, i, grid)
\t}
\treturn n
}
`,
  java: `public static int affine(int x, int scale, int offset) {
    return x * scale + offset;
}
public static int clamp(int x, int hi) {
    return Integer.compareUnsigned(hi, x) < 0 ? hi : x;
}
public static int rotl(int x, int n) {
    return (x << n) | (x << (32 - n));
}
public static int sq(int x) {
    return x * x;
}
public static int quad(int x) {
    return sq(x);
}
public static int absdiff(int a, int b) {
    return a - b;
}
public static int combine4(int a, int b, int c, int d) {
    return a + b + c + d;
}
public static int min2(int a, int b) {
    return Integer.compareUnsigned(b, a) < 0 ? b : a;
}
public static int sumto(int n) {
    int s = 0;
    for (int i = 0; Integer.compareUnsigned(i, n) < 0; i++) {
        s += i;
    }
    return s;
}
public static int countup(int limit, int cap) {
    int s = 0;
    for (int i = 0; Integer.compareUnsigned(i, cap) < 0; i++) {
        if (!(Integer.compareUnsigned(s, limit) < 0)) {
            break;
        }
        s += 1;
    }
    return s;
}
public static int pick(U32Bool r) {
    return r.a();
}
public static int byte1(int x) {
    return (x >>> 8) & 0xFF;
}
public static int sadd(int a, int b) {
    return a + b;
}
public static boolean is_even(int x) {
    return (x & 1) == 0;
}
public static int addi(int acc, int i) {
    return acc + i;
}
public static int inc(int s, int i, int limit) {
    return s + 1;
}
public static boolean below(int s, int i, int limit) {
    return Integer.compareUnsigned(s, limit) < 0;
}
public static int addel(int acc, int i, int[] a) {
    return acc + a[Integer.remainderUnsigned(i, 4)];
}
public static U32U32 minmax(U32U32 acc, int i, int[] a) {
    int lo = acc.a();
    int hi = acc.b();
    int x = a[Integer.remainderUnsigned(i, 4)];
    int nlo = Integer.compareUnsigned(x, lo) < 0 ? x : lo;
    int nhi = Integer.compareUnsigned(x, hi) < 0 ? x : hi;
    return new U32U32(nlo, nhi);
}
public static int mixel(int acc, int i, int[] a) {
    return acc ^ a[Integer.remainderUnsigned(i, 4)];
}
public static int dstep(int acc, int i, int[] a, int[] b) {
    return acc + a[Integer.remainderUnsigned(i, 4)] * b[Integer.remainderUnsigned(i, 4)];
}
public static int pstep(int acc, int i, int x) {
    return acc + ((x >>> i) & 1);
}
public static int nb(int[] grid, int r, int c) {
    int row = grid[Integer.remainderUnsigned(r, 32)];
    return (row >>> c) & 1;
}
public static int count(int[] grid, int r, int c) {
    int ru = r - 1;
    int rd = r + 1;
    int cl = c - 1;
    int cr = c + 1;
    int s = nb(grid, ru, cl);
    s += nb(grid, ru, c);
    s += nb(grid, ru, cr);
    s += nb(grid, r, cl);
    s += nb(grid, r, cr);
    s += nb(grid, rd, cl);
    s += nb(grid, rd, c);
    s += nb(grid, rd, cr);
    return s;
}
public static int bitstep(int acc, int i, int x) {
    return acc + ((x >>> i) & 1);
}
public static int popcount(int x) {
    int n = 0;
    for (int i = 0; i < 32; i++) {
        n = bitstep(n, i, x);
    }
    return n;
}
public static int rowpop(int acc, int i, int[] grid) {
    return acc + popcount(grid[Integer.remainderUnsigned(i, 32)]);
}
public static int population(int[] grid) {
    int n = 0;
    for (int i = 0; i < 32; i++) {
        n = rowpop(n, i, grid);
    }
    return n;
}
`,
  csharp: `public static uint affine(uint x, uint scale, uint offset)
{
    return x * scale + offset;
}
public static uint clamp(uint x, uint hi)
{
    return hi < x ? hi : x;
}
public static uint rotl(uint x, uint n)
{
    return (x << (int)n) | (x << (int)(32 - n));
}
public static uint sq(uint x)
{
    return x * x;
}
public static uint quad(uint x)
{
    return sq(x);
}
public static uint absdiff(uint a, uint b)
{
    return a - b;
}
public static uint combine4(uint a, uint b, uint c, uint d)
{
    return a + b + c + d;
}
public static uint min2(uint a, uint b)
{
    return b < a ? b : a;
}
public static uint sumto(uint n)
{
    uint s = 0;
    for (uint i = 0; i < n; i++)
    {
        s += i;
    }
    return s;
}
public static uint countup(uint limit, uint cap)
{
    uint s = 0;
    for (uint i = 0; i < cap; i++)
    {
        if (!(s < limit))
        {
            break;
        }
        s += 1;
    }
    return s;
}
public static uint pick((uint, bool) r)
{
    return r.Item1;
}
public static uint byte1(uint x)
{
    return (x >> 8) & 0xFF;
}
public static uint sadd(uint a, uint b)
{
    return a + b;
}
public static bool is_even(uint x)
{
    return (x & 1) == 0;
}
public static uint addi(uint acc, uint i)
{
    return acc + i;
}
public static uint inc(uint s, uint i, uint limit)
{
    return s + 1;
}
public static bool below(uint s, uint i, uint limit)
{
    return s < limit;
}
public static uint addel(uint acc, uint i, uint[] a)
{
    return acc + a[i % 4];
}
public static (uint, uint) minmax((uint, uint) acc, uint i, uint[] a)
{
    var (lo, hi) = acc;
    uint x = a[i % 4];
    uint nlo = x < lo ? x : lo;
    uint nhi = x < hi ? x : hi;
    return (nlo, nhi);
}
public static uint mixel(uint acc, uint i, uint[] a)
{
    return acc ^ a[i % 4];
}
public static uint dstep(uint acc, uint i, uint[] a, uint[] b)
{
    return acc + a[i % 4] * b[i % 4];
}
public static uint pstep(uint acc, uint i, uint x)
{
    return acc + ((x >> (int)i) & 1);
}
public static uint nb(uint[] grid, uint r, uint c)
{
    uint row = grid[r % 32];
    return (row >> (int)c) & 1;
}
public static uint count(uint[] grid, uint r, uint c)
{
    uint ru = r - 1;
    uint rd = r + 1;
    uint cl = c - 1;
    uint cr = c + 1;
    uint s = nb(grid, ru, cl);
    s += nb(grid, ru, c);
    s += nb(grid, ru, cr);
    s += nb(grid, r, cl);
    s += nb(grid, r, cr);
    s += nb(grid, rd, cl);
    s += nb(grid, rd, c);
    s += nb(grid, rd, cr);
    return s;
}
public static uint bitstep(uint acc, uint i, uint x)
{
    return acc + ((x >> (int)i) & 1);
}
public static uint popcount(uint x)
{
    uint n = 0;
    for (uint i = 0; i < 32; i++)
    {
        n = bitstep(n, i, x);
    }
    return n;
}
public static uint rowpop(uint acc, uint i, uint[] grid)
{
    return acc + popcount(grid[i % 32]);
}
public static uint population(uint[] grid)
{
    uint n = 0;
    for (uint i = 0; i < 32; i++)
    {
        n = rowpop(n, i, grid);
    }
    return n;
}
`,
  cpp: `uint32_t affine(uint32_t x, uint32_t scale, uint32_t offset) {
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
uint32_t pick(std::pair<uint32_t, bool> r) {
    return r.first;
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
uint32_t addel(uint32_t acc, uint32_t i, std::array<uint32_t, 4> a) {
    return acc + a[i % 4];
}
std::pair<uint32_t, uint32_t> minmax(std::pair<uint32_t, uint32_t> acc, uint32_t i, std::array<uint32_t, 4> a) {
    auto [lo, hi] = acc;
    uint32_t x = a[i % 4];
    uint32_t nlo = x < lo ? x : lo;
    uint32_t nhi = x < hi ? x : hi;
    return {nlo, nhi};
}
uint32_t mixel(uint32_t acc, uint32_t i, std::array<uint32_t, 4> a) {
    return acc ^ a[i % 4];
}
uint32_t dstep(uint32_t acc, uint32_t i, std::array<uint32_t, 4> a, std::array<uint32_t, 4> b) {
    return acc + a[i % 4] * b[i % 4];
}
uint32_t pstep(uint32_t acc, uint32_t i, uint32_t x) {
    return acc + ((x >> (i & 31)) & 1);
}
uint32_t nb(std::array<uint32_t, 32> grid, uint32_t r, uint32_t c) {
    uint32_t row = grid[r % 32];
    return (row >> (c & 31)) & 1;
}
uint32_t count(std::array<uint32_t, 32> grid, uint32_t r, uint32_t c) {
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
uint32_t rowpop(uint32_t acc, uint32_t i, std::array<uint32_t, 32> grid) {
    return acc + popcount(grid[i % 32]);
}
uint32_t population(std::array<uint32_t, 32> grid) {
    uint32_t n = 0;
    for (uint32_t i = 0; i < 32; i++) {
        n = rowpop(n, i, grid);
    }
    return n;
}
`,
};

/** Set B in every language, by task id. */
export const LANG_B: Record<string, Record<Lang, Pair>> = Object.fromEntries(
  Object.entries(BASE_B).map(([id, base]) => [
    id,
    { ...base, ...fromSpecs((l) => SPECS[l].b[id as BTaskId]) },
  ]),
);

export const LANG_PROJECT_FILLER: Partial<Record<Lang, string>> = {
  ...BASE_FILLER,
  ...Object.fromEntries(
    SPEC_LANGS.flatMap((l) => {
      const f = SPECS[l].filler;
      return f === undefined ? [] : [[l, f]];
    }),
  ),
};

/** Languages with a set-C project filler (set B only for the others). */
export const FILLER_LANGS: readonly Lang[] = LANGS.filter(
  (l) => LANG_PROJECT_FILLER[l] !== undefined,
);

/** One generated filler helper (tools/ai-edit-tasks-c.ts generateFiller) in `lang`. */
export function fillerText(lang: Lang, f: FillerFunction): string {
  if (isSpecLang(lang)) {
    const text = SPECS[lang].fillerText;
    if (text === undefined) throw new Error(`${lang} has no set-C filler (set B only)`);
    return text(f);
  }
  const s = f.spec;
  const n = f.name;
  const py = (sig: string, e: string): string => `def ${n}(${sig}) -> int:\n    return ${e}\n`;
  const go = (sig: string, e: string): string => `func ${n}(${sig}) uint32 {\n\treturn ${e}\n}\n`;
  const jv = (sig: string, e: string): string =>
    `public static int ${n}(${sig}) {\n    return ${e};\n}\n`;
  const cs = (sig: string, e: string): string =>
    `public static uint ${n}(${sig})\n{\n    return ${e};\n}\n`;
  const cc = (sig: string, e: string): string => `uint32_t ${n}(${sig}) {\n    return ${e};\n}\n`;
  const x1 = {
    python: 'x: int',
    go: 'x uint32',
    java: 'int x',
    csharp: 'uint x',
    cpp: 'uint32_t x',
  };
  const x2 = {
    python: 'a: int, b: int',
    go: 'a uint32, b uint32',
    java: 'int a, int b',
    csharp: 'uint a, uint b',
    cpp: 'uint32_t a, uint32_t b',
  };
  const emit = { python: py, go, java: jv, csharp: cs, cpp: cc }[lang];
  switch (s.template) {
    case 'lin':
      return emit(
        x1[lang],
        lang === 'python' ? `(x * ${s.m} + ${s.c}) & 0xFFFFFFFF` : `x * ${s.m} + ${s.c}`,
      );
    case 'xs':
      return emit(x1[lang], lang === 'java' ? `x ^ (x >>> ${s.s})` : `x ^ (x >> ${s.s})`);
    case 'cap':
      if (lang === 'go')
        return `func ${n}(x uint32) uint32 {\n\tif x < ${s.c} {\n\t\treturn x\n\t}\n\treturn ${s.c}\n}\n`;
      if (lang === 'python') return emit(x1[lang], `x if x < ${s.c} else ${s.c}`);
      if (lang === 'java')
        return emit(x1[lang], `Integer.compareUnsigned(x, ${s.c}) < 0 ? x : ${s.c}`);
      return emit(x1[lang], `x < ${s.c} ? x : ${s.c}`);
    case 'pair':
      return emit(
        x2[lang],
        lang === 'python' ? `((a + b) & 0xFFFFFFFF) ^ ${s.c}` : `(a + b) ^ ${s.c}`,
      );
    case 'sum':
      return emit(
        x1[lang],
        lang === 'python' ? `(${s.g}(x) + ${s.h}(x)) & 0xFFFFFFFF` : `${s.g}(x) + ${s.h}(x)`,
      );
    case 'mixin':
      return emit(x2[lang], `${s.g}(a) ^ b`);
  }
}

// --- Acceptance ---------------------------------------------------------------------

/** Canonical text of a value: u32 decimal, bool true/false, arrays and records [a,b]. */
export function canonical(v: Value): string {
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v) || ArrayBuffer.isView(v))
    return `[${Array.from(v as ArrayLike<Value>, canonical).join(',')}]`;
  return String(v);
}

function literal(lang: BaseLang, v: Value, t: Type | undefined): string {
  if (typeof v === 'number') {
    if (lang === 'go') return `uint32(${v})`;
    if (lang === 'java') return `0x${v.toString(16)}`;
    if (lang === 'python') return String(v);
    return `${v}u`;
  }
  if (typeof v === 'boolean') return lang === 'python' ? (v ? 'True' : 'False') : String(v);
  const items = Array.from(v as ArrayLike<Value>);
  if (t !== undefined && typeof t !== 'string' && t.kind === 'arr') {
    const els = items.map((x) => literal(lang, x, t.elem)).join(', ');
    switch (lang) {
      case 'python':
        return `[${els}]`;
      case 'go':
        return `[${items.length}]uint32{${els}}`;
      case 'java':
        return `new int[]{${els}}`;
      case 'csharp':
        return `new uint[]{${els}}`;
      case 'cpp':
        return `std::array<uint32_t, ${items.length}>{${els}}`;
    }
  }
  const fields = t !== undefined && typeof t !== 'string' && t.kind === 'rec' ? t.fields : [];
  const els = items.map((x, i) => literal(lang, x, fields[i])).join(', ');
  const flag = fields[1] === 'bool';
  switch (lang) {
    case 'python':
      return `(${els})`;
    case 'go':
      return `${flag ? 'U32Bool' : 'U32U32'}{${els}}`;
    case 'java':
      return `new Lib.${flag ? 'U32Bool' : 'U32U32'}(${els})`;
    case 'csharp':
      return `(${els})`;
    case 'cpp':
      return `std::pair<uint32_t, ${flag ? 'bool' : 'uint32_t'}>{${els}}`;
  }
}

/** Expression that renders `expr` (of A0 type `t`) in canonical text. */
function render(lang: BaseLang, expr: string, t: Type | undefined): string {
  if (t === 'bool')
    return {
      python: `fb(${expr})`,
      go: `fmt.Sprint(${expr})`,
      java: `String.valueOf(${expr})`,
      csharp: `(${expr} ? "true" : "false")`,
      cpp: `std::string(${expr} ? "true" : "false")`,
    }[lang];
  if (t !== undefined && typeof t !== 'string' && t.kind === 'rec') {
    const f = ((): [string, string] => {
      switch (lang) {
        case 'python':
          return [`${expr}[0]`, `${expr}[1]`];
        case 'go':
          return [`${expr}.A`, `${expr}.B`];
        case 'java':
          return [`${expr}.a()`, `${expr}.b()`];
        case 'csharp':
          return [`${expr}.Item1`, `${expr}.Item2`];
        case 'cpp':
          return [`${expr}.first`, `${expr}.second`];
      }
    })();
    const parts = t.fields.map((ft, i) => render(lang, f[i] ?? '', ft));
    return `"[" + ${parts.join(' + "," + ')} + "]"`;
  }
  return {
    python: `fu(${expr})`,
    go: `fmt.Sprint(${expr})`,
    java: `Integer.toUnsignedString(${expr})`,
    csharp: `${expr}.ToString()`,
    cpp: `std::to_string(${expr})`,
  }[lang];
}

function driver(lang: BaseLang, tests: readonly LangCase[], typed: TypedProgram): string {
  const lines = tests.map((t, i) => {
    const fn = typed.byName.get(t.fn);
    const args = t.args.map((a, k) => literal(lang, a, fn?.params[k])).join(', ');
    const out = render(lang, 'v', fn?.result);
    const call: Record<BaseLang, string> = {
      python: `v = mod.${t.fn}(${args})\nprint("R${i}", ${out})`,
      go: `\t{\n\t\tv := ${t.fn}(${args})\n\t\tfmt.Println("R${i}", ${out})\n\t}`,
      java: `        { var v = Lib.${t.fn}(${args}); System.out.println("R${i} " + ${out}); }`,
      csharp: `        { var v = Lib.${t.fn}(${args}); System.Console.WriteLine("R${i} " + ${out}); }`,
      cpp: `    { auto v = ${t.fn}(${args}); std::cout << "R${i} " << ${out} << "\\n"; }`,
    };
    return call[lang];
  });
  const body = lines.join('\n');
  switch (lang) {
    case 'python':
      return `import mod\n\ndef fu(v):\n    return str(v) if type(v) is int and 0 <= v <= 0xFFFFFFFF else repr(v)\n\ndef fb(v):\n    return 'true' if v is True else 'false' if v is False else repr(v)\n\n${body}\nprint("DONE")\n`;
    case 'go':
      return `package main\n\nimport "fmt"\n\nfunc main() {\n${body}\n\tfmt.Println("DONE")\n}\n`;
    case 'java':
      return `public final class Driver {\n    public static void main(String[] args) {\n${body}\n        System.out.println("DONE");\n    }\n}\n`;
    case 'csharp':
      return `\npublic static class Driver\n{\n    public static void Main()\n    {\n${body}\n        System.Console.WriteLine("DONE");\n    }\n}\n`;
    case 'cpp':
      return `\n#include <iostream>\n#include <string>\nint main() {\n${body}\n    std::cout << "DONE\\n";\n    return 0;\n}\n`;
  }
}

/** Builds and runs; returns the driver's stdout or a failure line prefixed `<tool>:`. */
async function buildAndRun(
  lang: BaseLang,
  dir: string,
  source: string,
  drv: string,
): Promise<{ stdout: string } | { error: string }> {
  const fail = (label: string, r: { stdout: string; stderr: string }): { error: string } => ({
    // The random temp directory name varies per run and is noise in a recorded result.
    error: `${label}: ${(r.stderr || r.stdout).replace(/\/a0-[A-Za-z0-9]{6}\//g, '/a0-tmp/').slice(0, 500)}`,
  });
  switch (lang) {
    case 'python': {
      const py = tool('python3', 'A0_PYTHON3');
      await writeFile(join(dir, 'mod.py'), source, 'utf8');
      await writeFile(join(dir, 'driver.py'), drv, 'utf8');
      const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
      const check = runTool(py, ['-m', 'py_compile', join(dir, 'mod.py')], { cwd: dir, env });
      if (!check.ok) return fail('python3', check);
      const run = runTool(py, [join(dir, 'driver.py')], { cwd: dir, env, timeoutMs: RUN_MS });
      if (!run.ok) return fail('run', run);
      return { stdout: run.stdout };
    }
    case 'go': {
      const go = tool('go', 'A0_GO', ['/opt/homebrew/bin/go', '/usr/local/go/bin/go']);
      await writeFile(join(dir, 'lib.go'), source, 'utf8');
      await writeFile(join(dir, 'driver.go'), drv, 'utf8');
      const build = runTool(go, ['build', '-o', join(dir, 'prog'), 'lib.go', 'driver.go'], {
        cwd: dir,
        env: { ...process.env, GO111MODULE: 'off' },
        timeoutMs: BUILD_MS,
      });
      if (!build.ok) return fail('go', build);
      const run = runTool(join(dir, 'prog'), [], { cwd: dir, timeoutMs: RUN_MS });
      if (!run.ok) return fail('run', run);
      return { stdout: run.stdout };
    }
    case 'java': {
      const javac = findJavac().path;
      const java = findJava().path;
      if (javac === undefined || java === undefined) throw new Error('JDK not found (A0_JAVAC)');
      await writeFile(join(dir, 'Lib.java'), source, 'utf8');
      await writeFile(join(dir, 'Driver.java'), drv, 'utf8');
      const build = runTool(
        javac,
        ['-nowarn', '-d', join(dir, 'out'), join(dir, 'Lib.java'), join(dir, 'Driver.java')],
        { cwd: dir, timeoutMs: BUILD_MS },
      );
      if (!build.ok) return fail('javac', build);
      const run = runTool(java, ['-cp', join(dir, 'out'), 'Driver'], {
        cwd: dir,
        timeoutMs: RUN_MS,
      });
      if (!run.ok) return fail('run', run);
      return { stdout: run.stdout };
    }
    case 'csharp': {
      const dotnet = tool('dotnet', 'A0_DOTNET', [
        `${process.env.HOME ?? ''}/.dotnet/dotnet`,
        '/usr/local/share/dotnet/dotnet',
        '/opt/homebrew/bin/dotnet',
      ]);
      await writeFile(join(dir, 'Lib.cs'), `${source}${drv}`, 'utf8');
      await writeFile(
        join(dir, 'candidate.csproj'),
        '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <OutputType>Exe</OutputType>\n    <TargetFramework>net10.0</TargetFramework>\n    <Nullable>enable</Nullable>\n    <ImplicitUsings>disable</ImplicitUsings>\n    <NoWarn>$(NoWarn);CS8981</NoWarn>\n  </PropertyGroup>\n</Project>\n',
        'utf8',
      );
      const env = {
        ...process.env,
        DOTNET_CLI_TELEMETRY_OPTOUT: '1',
        DOTNET_NOLOGO: '1',
        DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
      };
      const build = runTool(
        dotnet,
        ['build', '-c', 'Release', '-o', join(dir, 'out'), '--nologo', '-v', 'q'],
        { cwd: dir, env, timeoutMs: BUILD_MS },
      );
      if (!build.ok) {
        const errors = build.stdout
          .split('\n')
          .filter((l) => l.includes('error'))
          .join('\n');
        return { error: `dotnet: ${(errors || build.stdout).slice(0, 500)}` };
      }
      const run = runTool(dotnet, [join(dir, 'out', 'candidate.dll')], {
        cwd: dir,
        env,
        timeoutMs: RUN_MS,
      });
      if (!run.ok) return fail('run', run);
      return { stdout: run.stdout };
    }
    case 'cpp': {
      const cxx = findClangPlusPlus().path;
      if (cxx === undefined) throw new Error('clang++ not found (A0_CLANGXX)');
      await writeFile(join(dir, 'candidate.cpp'), `${source}${drv}`, 'utf8');
      const build = runTool(
        cxx,
        ['-std=c++20', '-O1', '-w', '-o', join(dir, 'candidate'), join(dir, 'candidate.cpp')],
        { cwd: dir, timeoutMs: BUILD_MS },
      );
      if (!build.ok) return fail('clang++', build);
      const run = runTool(join(dir, 'candidate'), [], { cwd: dir, timeoutMs: RUN_MS });
      if (!run.ok) return fail('run', run);
      return { stdout: run.stdout };
    }
  }
}

/** Failure prefixes of a build step, for the harness's `compile` status class. */
export const LANG_COMPILE_PREFIX = new RegExp(
  `^(python3|go|javac|dotnet|clang\\+\\+|${SPEC_LANGS.map((l) => SPECS[l].compileLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}):`,
);

/**
 * Acceptance for one of the further languages: compile the candidate file, run the
 * generated driver, compare each printed result with the canonical expected value. The
 * A0 reference program supplies the value shapes (array vs record) of arguments/results.
 */
export async function acceptLang(
  lang: Lang,
  source: string,
  tests: readonly LangCase[],
  typed: TypedProgram,
): Promise<string[]> {
  const drv = isSpecLang(lang) ? SPECS[lang].driver(tests, typed) : driver(lang, tests, typed);
  return withTempDir(async (dir) => {
    await mkdir(dir, { recursive: true });
    const res = isSpecLang(lang)
      ? await SPECS[lang].buildAndRun(dir, source, drv)
      : await buildAndRun(lang, dir, source, drv);
    if ('error' in res) return [res.error];
    const got = new Map<number, string>();
    for (const line of res.stdout.split('\n')) {
      const m = /^R(\d+) (.*)$/.exec(line);
      if (m !== null) got.set(Number(m[1]), m[2] ?? '');
    }
    const fmt = (v: Value): string => canonical(v);
    const failures: string[] = [];
    tests.forEach((t, i) => {
      const g = got.get(i);
      const want = canonical(t.expected);
      if (g === undefined) failures.push(`${t.fn}: no result`);
      else if (g !== want)
        failures.push(`${t.fn}(${t.args.map(fmt).join(',')}) = ${g}, expected ${want}`);
    });
    if (!res.stdout.includes('DONE')) failures.push('program did not finish');
    return failures;
  });
}
