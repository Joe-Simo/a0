import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseAndValidate, type TypedProgram } from '../src/core.js';
import { formatTrap, type Trap } from '../src/diagnostics.js';
import { findClang, runTool } from '../src/toolchain.js';
import { nativeTrapHostC } from '../src/trap-host.js';

const clang = findClang();
const skip = clang.path === undefined ? 'clang is unavailable' : false;
interface RecordCase {
  readonly count: number;
  readonly kind: 'bounds' | 'divzero';
  readonly marks: readonly (readonly [number, number])[];
}
const names = Array.from(
  { length: 1024 },
  (_, i) => `f${String(i).padStart(4, '0')}${'x'.repeat(59)}`,
);
const node = 'iteration';
const program = parseAndValidate(
  `profile strict\n${names.map((name) => `fn ${name} u32 u32 -> u32\n${node} div p0 p1\nret ${node}\nend\n`).join('')}`,
);
const records: readonly RecordCase[] = [
  { count: 0, kind: 'bounds', marks: [] },
  { count: 1, kind: 'divzero', marks: [] },
  { count: 2, kind: 'bounds', marks: [[0, 0]] },
  {
    count: 3,
    kind: 'divzero',
    marks: [
      [0, 7],
      [1, 4294967295],
    ],
  },
  { count: 20, kind: 'bounds', marks: [] },
  { count: 2, kind: 'divzero', marks: [[1, 1]] },
  {
    count: 1024,
    kind: 'divzero',
    marks: [
      [0, 4294967295],
      [1022, 0],
    ],
  },
  { count: 1, kind: 'bounds', marks: [] },
  { count: 20, kind: 'divzero', marks: [[19, 4294967295]] },
];
function expected(record: RecordCase): string {
  const chain = names.slice(0, record.count),
    marked = record.marks.at(-1);
  const trap: Trap = {
    kind: record.kind,
    fn: chain.at(-1) ?? '-',
    at: marked === undefined ? null : `${chain[marked[0]]}.${node}`,
    trip: marked?.[1] ?? null,
    chain,
  };
  return formatTrap(trap);
}
function source(bound?: TypedProgram): string {
  const data = records
    .map((record) => `{ ${record.count}u, ${JSON.stringify(record.kind)} }`)
    .join(',\n');
  const marks = records
    .flatMap((record, i) =>
      record.marks.map(
        ([frame, trip]) =>
          `if (i == ${i}u) { A0_frames[${frame}].node = ${JSON.stringify(node)}; A0_frames[${frame}].trip = ${trip}u; }`,
      ),
    )
    .join('\n');
  return `#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <setjmp.h>
static jmp_buf recovery;
static const char *emitted;
static unsigned emits, exits;
#define A0_TRAP_EMIT(line) do { emitted = (line); emits++; } while (0)
#define A0_TRAP_EXIT() do { exits++; longjmp(recovery, 1); } while (0)
${nativeTrapHostC(bound)}
_Static_assert(offsetof(struct A0_frame, node) == sizeof(void *), "node ABI");
_Static_assert(offsetof(struct A0_frame, trip) == 2u * sizeof(void *), "trip ABI");
_Static_assert(sizeof(struct A0_frame) == (sizeof(void *) == 8u ? 24u : 12u), "frame ABI");
struct A0_frame A0_frames[${names.length}];
const struct A0_frame *A0_trap_end;
const char *A0_trap_kind;
static const char *const names[] = { ${names.map((name) => JSON.stringify(name)).join(',')} };
static const struct { size_t count; const char *kind; } cases[] = { ${data} };
int main(void) {
  for (size_t i = 0; i < sizeof cases / sizeof cases[0]; i++) {
    for (size_t k = 0; k < sizeof A0_frames / sizeof A0_frames[0]; k++) {
      A0_frames[k].fn = names[k]; A0_frames[k].node = 0; A0_frames[k].trip = 0;
    }
    ${marks}
    A0_trap_end = A0_frames + cases[i].count; A0_trap_kind = cases[i].kind;
    if (setjmp(recovery) == 0) { A0_trap(); return 10; }
    if (emits != i + 1u || exits != i + 1u || emitted != a0_trapbuf) return 11;
    if (puts(a0_trapbuf) < 0) return 12;
  }
  return 0;
}
`;
}
async function buildAndRun(dir: string, name: string, text: string, level: string) {
  assert.ok(clang.path);
  const file = join(dir, `${name}.c`),
    exe = join(dir, name);
  await writeFile(file, text);
  const built = runTool(
    clang.path,
    [
      '-std=c11',
      level,
      '-Wall',
      '-Wextra',
      '-Werror',
      '-fsanitize=address,undefined',
      '-fno-sanitize-recover=all',
      file,
      '-o',
      exe,
    ],
    { timeoutMs: 60_000 },
  );
  assert.ok(built.ok, built.stderr);
  return runTool(exe, [], { timeoutMs: 30_000 });
}

test('direct-native corrected trap host retains complete text and longjmp-visible storage in growable and allocator-free modes', {
  skip,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'a0-native-trap-host-'));
  try {
    const lines = records.map(expected);
    assert.ok(lines[4] !== undefined && lines[4].length > 1024);
    assert.ok(lines[6] !== undefined && lines[6].length > 65536);
    for (const mode of ['growable', 'program-bound'] as const) {
      const text = source(mode === 'growable' ? undefined : program);
      if (mode === 'program-bound') assert.doesNotMatch(text, /\b(?:realloc|malloc|free)\s*\(/);
      for (const level of ['-O0', '-O2']) {
        const ran = await buildAndRun(dir, `${mode}-${level.slice(1)}`, text, level);
        assert.ok(ran.ok, ran.stderr);
        assert.equal(ran.stderr, '');
        assert.equal(ran.stdout, `${lines.join('\n')}\n`);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('direct-native corrected trap host default emits the exact line and exits3', {
  skip,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'a0-native-trap-host-default-'));
  try {
    const text = `#include <stdint.h>\n#include <stdio.h>\n#include <stdlib.h>\n${nativeTrapHostC()}\nstruct A0_frame A0_frames[2] = {{"top","iteration",4294967295u},{"step",0,0}};\nconst struct A0_frame *A0_trap_end = A0_frames+2;\nconst char *A0_trap_kind = "bounds";\nint main(void) { A0_trap(); return 0; }\n`;
    const ran = await buildAndRun(dir, 'default', text, '-O2');
    assert.equal(ran.status, 3, ran.stderr);
    assert.equal(ran.stdout, '');
    assert.equal(
      ran.stderr,
      `${formatTrap({ kind: 'bounds', fn: 'step', at: 'top.iteration', trip: 4294967295, chain: ['top', 'step'] })}\n`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
