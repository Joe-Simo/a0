/**
 * PHP: u32 values are 64-bit ints masked with & 0xFFFFFFFF after every operation that can
 * leave the range; products go through mul32 (defined once in the file prelude), because a
 * product of two u32 values can exceed PHP_INT_MAX and silently become a float. Records and
 * u32x4 arrays are PHP arrays. Checked with php -l, run with php.
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

const M = '0xFFFFFFFF';

/** One prelude line (starts with `<?php`, so it never matches `head`); namespace Lib lets filler names such as count shadow PHP builtins. */
const PRELUDE = `<?php declare(strict_types=1); namespace Lib; function mul32(int $a, int $b): int { return ((((($a >> 16) * $b) & 0xFFFF) << 16) + ($a & 0xFFFF) * $b) & ${M}; }\n`;

function literal(v: Value, t: Type | undefined): string {
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return String(v);
  const fields = recordFields(t);
  return `[${Array.from(v as ArrayLike<Value>, (x, i) => literal(x, fields[i])).join(', ')}]`;
}

function render(expr: string, t: Type | undefined): string {
  if (t === 'bool') return `fb(${expr})`;
  const fields = recordFields(t);
  if (fields.length > 0)
    return `'[' . ${fields.map((ft, i) => render(`${expr}[${i}]`, ft)).join(" . ',' . ")} . ']'`;
  return `fu(${expr})`;
}

function driver(tests: readonly LangCase[], typed: Parameters<LangSpec['driver']>[1]): string {
  const body = tests
    .map((t, i) => {
      const { params, result } = signature(typed, t.fn);
      const args = t.args.map((a, k) => literal(a, params[k])).join(', ');
      return `$v = ${t.fn}(${args});\necho 'R${i} ' . ${render('$v', result)} . "\\n";`;
    })
    .join('\n');
  return `<?php\ndeclare(strict_types=1);\nnamespace Lib;\n\nrequire __DIR__ . '/mod.php';\n\nfunction fu(mixed $v): string\n{\n  return is_int($v) && $v >= 0 && $v <= ${M} ? (string) $v : var_export($v, true);\n}\n\nfunction fb(mixed $v): string\n{\n  return $v === true ? 'true' : ($v === false ? 'false' : var_export($v, true));\n}\n\n${body}\necho "DONE\\n";\n`;
}

const B: LangSpec['b'] = {
  'b-fits-inclusive': {
    source: `function fits(int $a, int $b): bool\n{\n  return $a < $b;\n}\n`,
    reference: `function fits(int $a, int $b): bool\n{\n  return $a <= $b;\n}\n`,
  },
  'b-sumfrom-eight': {
    source: `function sumfrom(int $x): int\n{\n  $s = $x;\n  for ($i = 0; $i < 5; $i++) {\n    $s = ($s + $i) & ${M};\n  }\n  return $s;\n}\n`,
    reference: `function sumfrom(int $x): int\n{\n  $s = $x;\n  for ($i = 0; $i < 8; $i++) {\n    $s = ($s + $i) & ${M};\n  }\n  return $s;\n}\n`,
  },
  'b-rot8-constant': {
    source: `function rot8(int $x): int\n{\n  return (($x << 8) | ($x >> 23)) & ${M};\n}\n`,
    reference: `function rot8(int $x): int\n{\n  return (($x << 8) | ($x >> 24)) & ${M};\n}\n`,
  },
  'b-onlyone-xor': {
    source: `function onlyone(bool $a, bool $b): bool\n{\n  return $a || $b;\n}\n`,
    reference: `function onlyone(bool $a, bool $b): bool\n{\n  return $a !== $b;\n}\n`,
  },
  'b-avgfloor-nowrap': {
    source: `function avgfloor(int $a, int $b): int\n{\n  return (($a + $b) & ${M}) >> 1;\n}\n`,
    reference: `function avgfloor(int $a, int $b): int\n{\n  return ($a & $b) + (($a ^ $b) >> 1);\n}\n`,
  },
  'b-sumsq-array': {
    source: `function sumsq(array $a): int\n{\n  $s = 0;\n  for ($i = 0; $i < 4; $i++) {\n    $s = ($s + $a[$i]) & ${M};\n  }\n  return $s;\n}\n`,
    reference: `function sumsq(array $a): int\n{\n  $s = 0;\n  for ($i = 0; $i < 4; $i++) {\n    $s = ($s + mul32($a[$i], $a[$i])) & ${M};\n  }\n  return $s;\n}\n`,
  },
  'b-inrange-inclusive': {
    source: `function inrange(int $x, int $lo, int $hi): bool\n{\n  return $x > $lo && $x < $hi;\n}\n`,
    reference: `function inrange(int $x, int $lo, int $hi): bool\n{\n  return $x >= $lo && $x <= $hi;\n}\n`,
  },
  'b-bounds-largest': {
    source: `function bounds(array $a): array\n{\n  $lo = ${M};\n  $hi = 0;\n  for ($i = 0; $i < 4; $i++) {\n    $x = $a[$i];\n    if ($x < $lo) {\n      $lo = $x;\n    }\n    if ($x < $hi) {\n      $hi = $x;\n    }\n  }\n  return [$lo, $hi];\n}\n`,
    reference: `function bounds(array $a): array\n{\n  $lo = ${M};\n  $hi = 0;\n  for ($i = 0; $i < 4; $i++) {\n    $x = $a[$i];\n    if ($x < $lo) {\n      $lo = $x;\n    }\n    if ($x > $hi) {\n      $hi = $x;\n    }\n  }\n  return [$lo, $hi];\n}\n`,
  },
  'b-checksum-poly': {
    source: `function checksum(array $a): int\n{\n  $h = 0;\n  for ($i = 0; $i < 4; $i++) {\n    $h ^= $a[$i];\n  }\n  return $h;\n}\n`,
    reference: `function checksum(array $a): int\n{\n  $h = 7;\n  for ($i = 0; $i < 4; $i++) {\n    $h = (mul32($h, 31) + $a[$i]) & ${M};\n  }\n  return $h;\n}\n`,
  },
  'b-norm2-dot': {
    source: `function dot(array $a, array $b): int\n{\n  $s = 0;\n  for ($i = 0; $i < 4; $i++) {\n    $s = ($s + mul32($a[$i], $b[$i])) & ${M};\n  }\n  return $s;\n}\n`,
    reference: `function dot(array $a, array $b): int\n{\n  $s = 0;\n  for ($i = 0; $i < 4; $i++) {\n    $s = ($s + mul32($a[$i], $b[$i])) & ${M};\n  }\n  return $s;\n}\nfunction norm2(array $a): int\n{\n  return dot($a, $a);\n}\n`,
  },
  'b-pctof-limit': {
    source: `function limit(int $x, int $lo, int $hi): int\n{\n  $b = $x < $lo ? $lo : $x;\n  return $b > $hi ? $hi : $b;\n}\n`,
    reference: `function limit(int $x, int $lo, int $hi): int\n{\n  $b = $x < $lo ? $lo : $x;\n  return $b > $hi ? $hi : $b;\n}\nfunction pctof(int $part, int $whole): int\n{\n  $n = mul32($part, 100);\n  $q = $whole === 0 ? ${M} : intdiv($n, $whole);\n  return limit($q, 0, 100);\n}\n`,
  },
  'b-hamming-popcnt': {
    source: `function popcnt(int $x): int\n{\n  $s = 0;\n  for ($i = 0; $i < 32; $i++) {\n    $s = ($s + (($x >> $i) & 1)) & ${M};\n  }\n  return $s;\n}\n`,
    reference: `function popcnt(int $x): int\n{\n  $s = 0;\n  for ($i = 0; $i < 32; $i++) {\n    $s = ($s + (($x >> $i) & 1)) & ${M};\n  }\n  return $s;\n}\nfunction hamming(int $a, int $b): int\n{\n  return popcnt($a ^ $b);\n}\n`,
  },
};

const fn = (name: string, params: string, ret: string, lines: readonly string[]): string =>
  `function ${name}(${params}): ${ret}\n{\n${lines.map((l) => `  ${l}`).join('\n')}\n}\n`;

const ret = (name: string, params: string, r: string, e: string): string =>
  fn(name, params, r, [`return ${e};`]);

const loop = (n: string, stmt: string): readonly string[] => [
  `for ($i = 0; $i < ${n}; $i++) {`,
  `  ${stmt}`,
  '}',
];

const FILLER = [
  ret('affine', 'int $x, int $scale, int $offset', 'int', `(mul32($x, $scale) + $offset) & ${M}`),
  ret('clamp', 'int $x, int $hi', 'int', '$hi < $x ? $hi : $x'),
  ret('rotl', 'int $x, int $n', 'int', `(($x << ($n & 31)) | ($x << ((32 - $n) & 31))) & ${M}`),
  ret('sq', 'int $x', 'int', 'mul32($x, $x)'),
  ret('quad', 'int $x', 'int', 'sq($x)'),
  ret('absdiff', 'int $a, int $b', 'int', `($a - $b) & ${M}`),
  ret('combine4', 'int $a, int $b, int $c, int $d', 'int', `($a + $b + $c + $d) & ${M}`),
  ret('min2', 'int $a, int $b', 'int', '$b < $a ? $b : $a'),
  fn('sumto', 'int $n', 'int', ['$s = 0;', ...loop('$n', `$s = ($s + $i) & ${M};`), 'return $s;']),
  fn('countup', 'int $limit, int $cap', 'int', [
    '$s = 0;',
    'for ($i = 0; $i < $cap; $i++) {',
    '  if (!($s < $limit)) {',
    '    break;',
    '  }',
    `  $s = ($s + 1) & ${M};`,
    '}',
    'return $s;',
  ]),
  ret('pick', 'array $r', 'int', '$r[0]'),
  ret('byte1', 'int $x', 'int', '($x >> 8) & 0xFF'),
  ret('sadd', 'int $a, int $b', 'int', `($a + $b) & ${M}`),
  ret('is_even', 'int $x', 'bool', '($x & 1) === 0'),
  ret('addi', 'int $acc, int $i', 'int', `($acc + $i) & ${M}`),
  ret('inc', 'int $s, int $i, int $limit', 'int', `($s + 1) & ${M}`),
  ret('below', 'int $s, int $i, int $limit', 'bool', '$s < $limit'),
  ret('addel', 'int $acc, int $i, array $a', 'int', `($acc + $a[$i % 4]) & ${M}`),
  fn('minmax', 'array $acc, int $i, array $a', 'array', [
    '[$lo, $hi] = $acc;',
    '$x = $a[$i % 4];',
    '$nlo = $x < $lo ? $x : $lo;',
    '$nhi = $x < $hi ? $x : $hi;',
    'return [$nlo, $nhi];',
  ]),
  ret('mixel', 'int $acc, int $i, array $a', 'int', '$acc ^ $a[$i % 4]'),
  ret(
    'dstep',
    'int $acc, int $i, array $a, array $b',
    'int',
    `($acc + mul32($a[$i % 4], $b[$i % 4])) & ${M}`,
  ),
  ret('pstep', 'int $acc, int $i, int $x', 'int', `($acc + (($x >> ($i & 31)) & 1)) & ${M}`),
  fn('nb', 'array $grid, int $r, int $c', 'int', [
    '$row = $grid[$r % 32];',
    'return ($row >> ($c & 31)) & 1;',
  ]),
  fn('count', 'array $grid, int $r, int $c', 'int', [
    `$ru = ($r - 1) & ${M};`,
    `$rd = ($r + 1) & ${M};`,
    `$cl = ($c - 1) & ${M};`,
    `$cr = ($c + 1) & ${M};`,
    '$s = nb($grid, $ru, $cl);',
    `$s = ($s + nb($grid, $ru, $c)) & ${M};`,
    `$s = ($s + nb($grid, $ru, $cr)) & ${M};`,
    `$s = ($s + nb($grid, $r, $cl)) & ${M};`,
    `$s = ($s + nb($grid, $r, $cr)) & ${M};`,
    `$s = ($s + nb($grid, $rd, $cl)) & ${M};`,
    `$s = ($s + nb($grid, $rd, $c)) & ${M};`,
    `$s = ($s + nb($grid, $rd, $cr)) & ${M};`,
    'return $s;',
  ]),
  ret('bitstep', 'int $acc, int $i, int $x', 'int', `($acc + (($x >> ($i & 31)) & 1)) & ${M}`),
  fn('popcount', 'int $x', 'int', [
    '$n = 0;',
    ...loop('32', '$n = bitstep($n, $i, $x);'),
    'return $n;',
  ]),
  ret('rowpop', 'int $acc, int $i, array $grid', 'int', `($acc + popcount($grid[$i % 32])) & ${M}`),
  fn('population', 'array $grid', 'int', [
    '$n = 0;',
    ...loop('32', '$n = rowpop($n, $i, $grid);'),
    'return $n;',
  ]),
].join('');

function fillerText(f: FillerFunction): string {
  const s = f.spec;
  switch (s.template) {
    case 'lin':
      return ret(f.name, 'int $x', 'int', `(mul32($x, ${s.m}) + ${s.c}) & ${M}`);
    case 'xs':
      return ret(f.name, 'int $x', 'int', `$x ^ ($x >> ${s.s})`);
    case 'cap':
      return ret(f.name, 'int $x', 'int', `$x < ${s.c} ? $x : ${s.c}`);
    case 'pair':
      return ret(f.name, 'int $a, int $b', 'int', `(($a + $b) & ${M}) ^ ${s.c}`);
    case 'sum':
      return ret(f.name, 'int $x', 'int', `(${s.g}($x) + ${s.h}($x)) & ${M}`);
    case 'mixin':
      return ret(f.name, 'int $a, int $b', 'int', `${s.g}($a) ^ $b`);
  }
}

export const PHP: LangSpec = {
  semantics: `Integers are unsigned 32-bit values held in 64-bit PHP ints: mask every add and subtract result with & ${M}, and write every multiplication as mul32($a, $b) (defined on the first line of the file, which is in namespace Lib; mul32 returns the product mod 2^32), since a plain * of two u32 values can exceed PHP_INT_MAX and become a float; mask shift counts to 5 bits (& 31); comparisons are unsigned; divide with intdiv. Division by zero gives 4294967295; remainder by zero gives the dividend. Records and u32x4 values are arrays. The file uses declare(strict_types=1), must pass php -l, and is run with php.`,
  head: /^function ([a-z_][A-Za-z0-9_]*)\(/,
  file: (body) => `${PRELUDE}\n${body}`,
  b: B,
  filler: FILLER,
  fillerText,
  driver,
  compileLabel: 'php',
  async buildAndRun(dir, source, drv) {
    const php = tool('php', 'A0_PHP', ['/opt/homebrew/bin/php', '/usr/local/bin/php']);
    await writeFile(join(dir, 'mod.php'), source, 'utf8');
    await writeFile(join(dir, 'driver.php'), drv, 'utf8');
    const check = runTool(php, ['-l', join(dir, 'mod.php')], { cwd: dir, timeoutMs: BUILD_MS });
    if (!check.ok) return failure('php', check);
    const run = runTool(php, [join(dir, 'driver.php')], { cwd: dir, timeoutMs: RUN_MS });
    if (!run.ok) return failure('run', run);
    return { stdout: run.stdout };
  },
};
