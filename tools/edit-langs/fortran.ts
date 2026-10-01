/**
 * Fortran: u32 values are integer(int64) kept in 0..4294967295 by masking with
 * iand(..., m32) after every operation that can leave the range; products go through the
 * exact helper mul32 (a u32 times a u32 can exceed the signed 64-bit range). Records are
 * integer(int64) arrays of length 2 and u32x4 values are integer(int64) arrays of length 4.
 * The candidate is module lib in mod.f90, compiled with gfortran separately from the driver.
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
  onPath,
  RUN_MS,
  recordFields,
  signature,
  tool,
} from './spec.js';

const M = 'm32';

function literal(v: Value): string {
  if (typeof v === 'boolean') return v ? '.true.' : '.false.';
  if (typeof v === 'number') return `${v}_int64`;
  return `[${Array.from(v as ArrayLike<Value>, literal).join(', ')}]`;
}

function line(i: number, expr: string, t: Type | undefined): string {
  if (t === 'bool') return `write (*, '(A)') 'R${i} ' // trim(merge('true ', 'false', ${expr}))`;
  const isArray = t !== undefined && typeof t !== 'string' && t.kind === 'arr';
  const n = isArray ? 4 : recordFields(t).length;
  if (n === 0) return `write (*, '(A, I0)') 'R${i} ', ${expr}`;
  const items = Array.from({ length: n }, (_, j) => `v(${j + 1})`).join(", ',', ");
  const fmt = `A${', I0, A'.repeat(n)}`;
  return `v(1:${n}) = ${expr}\n  write (*, '(${fmt})') 'R${i} [', ${items}, ']'`;
}

function driver(tests: readonly LangCase[], typed: Parameters<LangSpec['driver']>[1]): string {
  const body = tests
    .map((t, i) => {
      const { result } = signature(typed, t.fn);
      return `  ${line(i, `${t.fn}(${t.args.map(literal).join(', ')})`, result)}`;
    })
    .join('\n');
  return `program driver
  use iso_fortran_env, only: int64
  use lib
  implicit none
  integer(int64) :: v(16)
  v = 0
${body}
  write (*, '(A)') 'DONE'
end program
`;
}

const B: LangSpec['b'] = {
  'b-fits-inclusive': {
    source:
      'function fits(a, b) result(r)\n  integer(int64), intent(in) :: a, b\n  logical :: r\n  r = a < b\nend function fits\n',
    reference:
      'function fits(a, b) result(r)\n  integer(int64), intent(in) :: a, b\n  logical :: r\n  r = a <= b\nend function fits\n',
  },
  'b-sumfrom-eight': {
    source: `function sumfrom(x) result(r)\n  integer(int64), intent(in) :: x\n  integer(int64) :: r, s, i\n  s = x\n  do i = 0, 4\n    s = iand(s + i, ${M})\n  end do\n  r = s\nend function sumfrom\n`,
    reference: `function sumfrom(x) result(r)\n  integer(int64), intent(in) :: x\n  integer(int64) :: r, s, i\n  s = x\n  do i = 0, 7\n    s = iand(s + i, ${M})\n  end do\n  r = s\nend function sumfrom\n`,
  },
  'b-rot8-constant': {
    source: `function rot8(x) result(r)\n  integer(int64), intent(in) :: x\n  integer(int64) :: r\n  r = iand(ior(ishft(x, 8), ishft(x, -23)), ${M})\nend function rot8\n`,
    reference: `function rot8(x) result(r)\n  integer(int64), intent(in) :: x\n  integer(int64) :: r\n  r = iand(ior(ishft(x, 8), ishft(x, -24)), ${M})\nend function rot8\n`,
  },
  'b-onlyone-xor': {
    source:
      'function onlyone(a, b) result(r)\n  logical, intent(in) :: a, b\n  logical :: r\n  r = a .or. b\nend function onlyone\n',
    reference:
      'function onlyone(a, b) result(r)\n  logical, intent(in) :: a, b\n  logical :: r\n  r = a .neqv. b\nend function onlyone\n',
  },
  'b-avgfloor-nowrap': {
    source: `function avgfloor(a, b) result(r)\n  integer(int64), intent(in) :: a, b\n  integer(int64) :: r\n  r = ishft(iand(a + b, ${M}), -1)\nend function avgfloor\n`,
    reference:
      'function avgfloor(a, b) result(r)\n  integer(int64), intent(in) :: a, b\n  integer(int64) :: r\n  r = iand(a, b) + ishft(ieor(a, b), -1)\nend function avgfloor\n',
  },
  'b-sumsq-array': {
    source: `function sumsq(a) result(r)\n  integer(int64), intent(in) :: a(4)\n  integer(int64) :: r, s\n  integer :: i\n  s = 0\n  do i = 1, 4\n    s = iand(s + a(i), ${M})\n  end do\n  r = s\nend function sumsq\n`,
    reference: `function sumsq(a) result(r)\n  integer(int64), intent(in) :: a(4)\n  integer(int64) :: r, s\n  integer :: i\n  s = 0\n  do i = 1, 4\n    s = iand(s + mul32(a(i), a(i)), ${M})\n  end do\n  r = s\nend function sumsq\n`,
  },
  'b-inrange-inclusive': {
    source:
      'function inrange(x, lo, hi) result(r)\n  integer(int64), intent(in) :: x, lo, hi\n  logical :: r\n  r = x > lo .and. x < hi\nend function inrange\n',
    reference:
      'function inrange(x, lo, hi) result(r)\n  integer(int64), intent(in) :: x, lo, hi\n  logical :: r\n  r = x >= lo .and. x <= hi\nend function inrange\n',
  },
  'b-bounds-largest': {
    source: `function bounds(a) result(r)\n  integer(int64), intent(in) :: a(4)\n  integer(int64) :: r(2), lo, hi, x\n  integer :: i\n  lo = ${M}\n  hi = 0\n  do i = 1, 4\n    x = a(i)\n    if (x < lo) lo = x\n    if (x < hi) hi = x\n  end do\n  r = [lo, hi]\nend function bounds\n`,
    reference: `function bounds(a) result(r)\n  integer(int64), intent(in) :: a(4)\n  integer(int64) :: r(2), lo, hi, x\n  integer :: i\n  lo = ${M}\n  hi = 0\n  do i = 1, 4\n    x = a(i)\n    if (x < lo) lo = x\n    if (x > hi) hi = x\n  end do\n  r = [lo, hi]\nend function bounds\n`,
  },
  'b-checksum-poly': {
    source:
      'function checksum(a) result(r)\n  integer(int64), intent(in) :: a(4)\n  integer(int64) :: r, h\n  integer :: i\n  h = 0\n  do i = 1, 4\n    h = ieor(h, a(i))\n  end do\n  r = h\nend function checksum\n',
    reference: `function checksum(a) result(r)\n  integer(int64), intent(in) :: a(4)\n  integer(int64) :: r, h\n  integer :: i\n  h = 7\n  do i = 1, 4\n    h = iand(mul32(h, 31_int64) + a(i), ${M})\n  end do\n  r = h\nend function checksum\n`,
  },
  'b-norm2-dot': {
    source: `function dot(a, b) result(r)\n  integer(int64), intent(in) :: a(4), b(4)\n  integer(int64) :: r, s\n  integer :: i\n  s = 0\n  do i = 1, 4\n    s = iand(s + mul32(a(i), b(i)), ${M})\n  end do\n  r = s\nend function dot\n`,
    reference: `function dot(a, b) result(r)\n  integer(int64), intent(in) :: a(4), b(4)\n  integer(int64) :: r, s\n  integer :: i\n  s = 0\n  do i = 1, 4\n    s = iand(s + mul32(a(i), b(i)), ${M})\n  end do\n  r = s\nend function dot\nfunction norm2(a) result(r)\n  integer(int64), intent(in) :: a(4)\n  integer(int64) :: r\n  r = dot(a, a)\nend function norm2\n`,
  },
  'b-pctof-limit': {
    source:
      'function limit(x, lo, hi) result(r)\n  integer(int64), intent(in) :: x, lo, hi\n  integer(int64) :: r, b\n  if (x < lo) then\n    b = lo\n  else\n    b = x\n  end if\n  if (b > hi) then\n    r = hi\n  else\n    r = b\n  end if\nend function limit\n',
    reference: `function limit(x, lo, hi) result(r)\n  integer(int64), intent(in) :: x, lo, hi\n  integer(int64) :: r, b\n  if (x < lo) then\n    b = lo\n  else\n    b = x\n  end if\n  if (b > hi) then\n    r = hi\n  else\n    r = b\n  end if\nend function limit\nfunction pctof(part, whole) result(r)\n  integer(int64), intent(in) :: part, whole\n  integer(int64) :: r, n, q\n  n = mul32(part, 100_int64)\n  if (whole == 0) then\n    q = ${M}\n  else\n    q = n / whole\n  end if\n  r = limit(q, 0_int64, 100_int64)\nend function pctof\n`,
  },
  'b-hamming-popcnt': {
    source: `function popcnt(x) result(r)\n  integer(int64), intent(in) :: x\n  integer(int64) :: r, s\n  integer :: i\n  s = 0\n  do i = 0, 31\n    s = iand(s + iand(ishft(x, -i), 1_int64), ${M})\n  end do\n  r = s\nend function popcnt\n`,
    reference: `function popcnt(x) result(r)\n  integer(int64), intent(in) :: x\n  integer(int64) :: r, s\n  integer :: i\n  s = 0\n  do i = 0, 31\n    s = iand(s + iand(ishft(x, -i), 1_int64), ${M})\n  end do\n  r = s\nend function popcnt\nfunction hamming(a, b) result(r)\n  integer(int64), intent(in) :: a, b\n  integer(int64) :: r\n  r = popcnt(ieor(a, b))\nend function hamming\n`,
  },
};

const MODULE_HEAD = `module lib
  use iso_fortran_env, only: int64
  implicit none
  integer(int64), parameter :: m32 = 4294967295_int64
contains
  function mul32(a, b) result(r)
    integer(int64), intent(in) :: a, b
    integer(int64) :: r
    r = iand(a * iand(b, 65535_int64) + ishft(iand(a * ishft(b, -16), 65535_int64), 16), m32)
  end function mul32
`;

export const FORTRAN: LangSpec = {
  semantics:
    'Integers are unsigned 32-bit values held in integer(int64) and kept in 0..4294967295: mask every arithmetic result with iand(x, m32) (m32 = 4294967295_int64), and use mul32(a, b) for an exact wrapped u32 product; mask shift counts to 5 bits; comparisons are unsigned; booleans are logical; records are integer(int64) arrays of length 2 and u32x4 values are integer(int64) arrays of length 4 (a(1)..a(4)). Division by zero gives 4294967295; remainder by zero gives the dividend. The functions live in module lib (file mod.f90, built with gfortran -c mod.f90).',
  head: /^function ([a-z_][A-Za-z0-9_]*)\(/,
  file: (body) => `${MODULE_HEAD}${body}end module lib\n`,
  b: B,
  driver,
  compileLabel: 'gfortran',
  async buildAndRun(dir, source, drv) {
    const gfortran = tool('gfortran', 'A0_GFORTRAN', ['/opt/homebrew/bin/gfortran']);
    const xcrun = onPath('xcrun');
    const sdk =
      xcrun === undefined
        ? ''
        : runTool(xcrun, ['--show-sdk-path'], { timeoutMs: 30_000 }).stdout.trim();
    const lib = sdk.length > 0 ? [`-L${sdk}/usr/lib`] : [];
    await writeFile(join(dir, 'mod.f90'), source, 'utf8');
    await writeFile(join(dir, 'driver.f90'), drv, 'utf8');
    const opts = { cwd: dir, timeoutMs: BUILD_MS };
    const mod = runTool(gfortran, ['-w', '-O0', '-c', 'mod.f90', '-o', 'mod.o'], opts);
    if (!mod.ok) return failure('gfortran', mod);
    const build = runTool(
      gfortran,
      ['-w', '-O0', ...lib, 'driver.f90', 'mod.o', '-o', 'prog'],
      opts,
    );
    if (!build.ok) return failure('gfortran', build);
    const run = runTool(join(dir, 'prog'), [], { cwd: dir, timeoutMs: RUN_MS });
    if (!run.ok) return failure('run', run);
    return { stdout: run.stdout };
  },
};
