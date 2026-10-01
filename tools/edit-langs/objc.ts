/**
 * Objective-C: u32 values are uint32_t (wrapping, unsigned compares); u32x4 arrays are
 * `const uint32_t *`, records are NSArray<NSNumber *> *. Functions are class methods of a
 * class `Lib`; the candidate is compiled with clang -c, separately from the driver.
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

const CLANG_PATHS = ['/usr/bin/clang'];

function literal(v: Value, t: Type | undefined): string {
  if (typeof v === 'number') return `${v}u`;
  if (typeof v === 'boolean') return String(v);
  const items = Array.from(v as ArrayLike<Value>, (x) => literal(x, undefined)).join(', ');
  return recordFields(t).length > 0 ? `@[${items}]` : `(const uint32_t[]){${items}}`;
}

function ctype(t: Type | undefined): string {
  if (t === 'bool') return 'bool';
  if (t === undefined || typeof t === 'string') return 'uint32_t';
  return t.kind === 'rec' ? 'NSArray<NSNumber *> *' : 'const uint32_t *';
}

function print(expr: string, i: number, t: Type | undefined): string {
  if (t === 'bool') return `printf("R${i} %s\\n", ${expr} ? "true" : "false");`;
  const fields = recordFields(t);
  if (fields.length > 0) {
    const fmt = fields.map(() => '%u').join(',');
    const vals = fields.map((_, k) => `[${expr}[${k}] unsignedIntValue]`).join(', ');
    return `printf("R${i} [${fmt}]\\n", ${vals});`;
  }
  return `printf("R${i} %u\\n", ${expr});`;
}

function selector(fn: string, parts: readonly string[]): string {
  return parts.map((p, k) => (k === 0 ? `${fn}:${p}` : ` :${p}`)).join('');
}

function driver(tests: readonly LangCase[], typed: Parameters<LangSpec['driver']>[1]): string {
  const decls = [...new Set(tests.map((t) => t.fn))].map((fn) => {
    const { params, result } = signature(typed, fn);
    const ps = params.map((p, k) => `(${ctype(p)})p${k}`);
    return `+ (${ctype(result)})${selector(fn, ps)};`;
  });
  const body = tests
    .map((t, i) => {
      const { params, result } = signature(typed, t.fn);
      const args = t.args.map((a, k) => literal(a, params[k]));
      return `    ${ctype(result)} v${i} = [Lib ${selector(t.fn, args)}];\n    ${print(`v${i}`, i, result)}`;
    })
    .join('\n');
  return `#import <Foundation/Foundation.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
@interface Lib : NSObject
${decls.join('\n')}
@end
int main(void) {
  @autoreleasepool {
${body}
    printf("DONE\\n");
  }
  return 0;
}
`;
}

const B: LangSpec['b'] = {
  'b-fits-inclusive': {
    source: '+ (bool)fits:(uint32_t)a :(uint32_t)b {\n    return a < b;\n}\n',
    reference: '+ (bool)fits:(uint32_t)a :(uint32_t)b {\n    return a <= b;\n}\n',
  },
  'b-sumfrom-eight': {
    source:
      '+ (uint32_t)sumfrom:(uint32_t)x {\n    uint32_t s = x;\n    for (uint32_t i = 0; i < 5; i++) {\n        s = s + i;\n    }\n    return s;\n}\n',
    reference:
      '+ (uint32_t)sumfrom:(uint32_t)x {\n    uint32_t s = x;\n    for (uint32_t i = 0; i < 8; i++) {\n        s = s + i;\n    }\n    return s;\n}\n',
  },
  'b-rot8-constant': {
    source: '+ (uint32_t)rot8:(uint32_t)x {\n    return (x << 8) | (x >> 23);\n}\n',
    reference: '+ (uint32_t)rot8:(uint32_t)x {\n    return (x << 8) | (x >> 24);\n}\n',
  },
  'b-onlyone-xor': {
    source: '+ (bool)onlyone:(bool)a :(bool)b {\n    return a || b;\n}\n',
    reference: '+ (bool)onlyone:(bool)a :(bool)b {\n    return a != b;\n}\n',
  },
  'b-avgfloor-nowrap': {
    source: '+ (uint32_t)avgfloor:(uint32_t)a :(uint32_t)b {\n    return (a + b) >> 1;\n}\n',
    reference:
      '+ (uint32_t)avgfloor:(uint32_t)a :(uint32_t)b {\n    return (a & b) + ((a ^ b) >> 1);\n}\n',
  },
  'b-sumsq-array': {
    source:
      '+ (uint32_t)sumsq:(const uint32_t *)a {\n    uint32_t s = 0;\n    for (int i = 0; i < 4; i++) {\n        s += a[i];\n    }\n    return s;\n}\n',
    reference:
      '+ (uint32_t)sumsq:(const uint32_t *)a {\n    uint32_t s = 0;\n    for (int i = 0; i < 4; i++) {\n        s += a[i] * a[i];\n    }\n    return s;\n}\n',
  },
  'b-inrange-inclusive': {
    source:
      '+ (bool)inrange:(uint32_t)x :(uint32_t)lo :(uint32_t)hi {\n    return x > lo && x < hi;\n}\n',
    reference:
      '+ (bool)inrange:(uint32_t)x :(uint32_t)lo :(uint32_t)hi {\n    return x >= lo && x <= hi;\n}\n',
  },
  'b-bounds-largest': {
    source:
      '+ (NSArray<NSNumber *> *)bounds:(const uint32_t *)a {\n    uint32_t lo = 4294967295u;\n    uint32_t hi = 0;\n    for (int i = 0; i < 4; i++) {\n        uint32_t x = a[i];\n        if (x < lo) lo = x;\n        if (x < hi) hi = x;\n    }\n    return @[@(lo), @(hi)];\n}\n',
    reference:
      '+ (NSArray<NSNumber *> *)bounds:(const uint32_t *)a {\n    uint32_t lo = 4294967295u;\n    uint32_t hi = 0;\n    for (int i = 0; i < 4; i++) {\n        uint32_t x = a[i];\n        if (x < lo) lo = x;\n        if (x > hi) hi = x;\n    }\n    return @[@(lo), @(hi)];\n}\n',
  },
  'b-checksum-poly': {
    source:
      '+ (uint32_t)checksum:(const uint32_t *)a {\n    uint32_t h = 0;\n    for (int i = 0; i < 4; i++) {\n        h = h ^ a[i];\n    }\n    return h;\n}\n',
    reference:
      '+ (uint32_t)checksum:(const uint32_t *)a {\n    uint32_t h = 7;\n    for (int i = 0; i < 4; i++) {\n        h = h * 31u + a[i];\n    }\n    return h;\n}\n',
  },
  'b-norm2-dot': {
    source:
      '+ (uint32_t)dot:(const uint32_t *)a :(const uint32_t *)b {\n    uint32_t s = 0;\n    for (int i = 0; i < 4; i++) {\n        s += a[i] * b[i];\n    }\n    return s;\n}\n',
    reference:
      '+ (uint32_t)dot:(const uint32_t *)a :(const uint32_t *)b {\n    uint32_t s = 0;\n    for (int i = 0; i < 4; i++) {\n        s += a[i] * b[i];\n    }\n    return s;\n}\n+ (uint32_t)norm2:(const uint32_t *)a {\n    return [self dot:a :a];\n}\n',
  },
  'b-pctof-limit': {
    source:
      '+ (uint32_t)limit:(uint32_t)x :(uint32_t)lo :(uint32_t)hi {\n    uint32_t b = x < lo ? lo : x;\n    return b > hi ? hi : b;\n}\n',
    reference:
      '+ (uint32_t)limit:(uint32_t)x :(uint32_t)lo :(uint32_t)hi {\n    uint32_t b = x < lo ? lo : x;\n    return b > hi ? hi : b;\n}\n+ (uint32_t)pctof:(uint32_t)part :(uint32_t)whole {\n    uint32_t n = part * 100u;\n    uint32_t q = whole == 0 ? 4294967295u : n / whole;\n    return [self limit:q :0 :100];\n}\n',
  },
  'b-hamming-popcnt': {
    source:
      '+ (uint32_t)popcnt:(uint32_t)x {\n    uint32_t s = 0;\n    for (uint32_t i = 0; i < 32; i++) {\n        s += (x >> i) & 1u;\n    }\n    return s;\n}\n',
    reference:
      '+ (uint32_t)popcnt:(uint32_t)x {\n    uint32_t s = 0;\n    for (uint32_t i = 0; i < 32; i++) {\n        s += (x >> i) & 1u;\n    }\n    return s;\n}\n+ (uint32_t)hamming:(uint32_t)a :(uint32_t)b {\n    return [self popcnt:a ^ b];\n}\n',
  },
};

export const OBJC: LangSpec = {
  semantics:
    'Integers are uint32_t (unsigned 32-bit; +, -, * wrap modulo 2^32, comparisons are unsigned, shift counts must stay below 32), booleans are bool, u32x4 arrays are `const uint32_t *` and records are `NSArray<NSNumber *> *` (@[@(lo), @(hi)]). Division by zero gives 4294967295 and remainder by zero gives the dividend (guard it explicitly). Functions are class methods of a class Lib with unlabeled extra selector parts (`+ (uint32_t)f:(uint32_t)a :(uint32_t)b`), calling each other with [self f:x :y]; the file is compiled with clang -c separately from a driver and linked with Foundation.',
  head: /^\+ \([A-Za-z0-9_ *<>]+\)([a-z_][A-Za-z0-9_]*)[: ]/,
  file: (body) =>
    `#import <Foundation/Foundation.h>\n#include <stdbool.h>\n#include <stdint.h>\n@interface Lib : NSObject\n@end\n@implementation Lib\n${body}@end\n`,
  b: B,
  driver,
  compileLabel: 'clang',
  async buildAndRun(dir, source, drv) {
    const clang = tool('clang', 'A0_CLANG', CLANG_PATHS);
    await writeFile(join(dir, 'lib.m'), source, 'utf8');
    await writeFile(join(dir, 'driver.m'), drv, 'utf8');
    const lib = runTool(
      clang,
      ['-fobjc-arc', '-O0', '-w', '-c', join(dir, 'lib.m'), '-o', join(dir, 'lib.o')],
      { cwd: dir, timeoutMs: BUILD_MS },
    );
    if (!lib.ok) return failure('clang', lib);
    const main = runTool(
      clang,
      ['-fobjc-arc', '-O0', '-w', '-c', join(dir, 'driver.m'), '-o', join(dir, 'driver.o')],
      { cwd: dir, timeoutMs: BUILD_MS },
    );
    if (!main.ok) return failure('clang', main);
    const link = runTool(
      clang,
      [
        '-framework',
        'Foundation',
        '-o',
        join(dir, 'prog'),
        join(dir, 'lib.o'),
        join(dir, 'driver.o'),
      ],
      { cwd: dir, timeoutMs: BUILD_MS },
    );
    if (!link.ok) return failure('clang', link);
    const run = runTool(join(dir, 'prog'), [], { cwd: dir, timeoutMs: RUN_MS });
    if (!run.ok) return failure('run', run);
    return { stdout: run.stdout };
  },
};
