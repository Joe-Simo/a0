import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { compile } from '../src/backends.js';
import {
  A0Error,
  formatDiagnostic,
  formatTrap,
  makeIo,
  parseAndValidate,
  run,
} from '../src/core.js';
import { parallelC } from '../src/parallel.js';
import { findClang, runTool, withTempDir } from '../src/toolchain.js';
import type { Case } from '../tools/corpus.js';
import { checkNative } from '../tools/verify.js';
import {
  IO_EXTRA_CASES,
  OWNED_EXTRA_CASES,
  parallelExtrasProgram,
  RETURN_EXTRA_CASES,
  repeatedExtrasProgram,
  SNAPSHOT_EXTRA,
  STRICT_EXTRA_CASES,
} from './fixtures/c-iteration-extras-programs.js';

const INPUTS = [
  [0, 0],
  [7, 13],
  [17, 3],
  [0xffffffff, 1],
  [1, 0xffffffff],
  [0x9e3779b9, 15],
];
const CLANG = findClang();
const SKIP = CLANG.path === undefined ? 'clang not found' : false;

async function check(source: string, names: readonly string[], t: TestContext): Promise<void> {
  const p = parseAndValidate(source);
  const cases: Case[] = [];
  for (const name of names) {
    const fn = p.byName.get(name);
    assert.ok(fn);
    for (const args of INPUTS) {
      try {
        cases.push({ functionName: name, args, expected: run(fn, args) });
      } catch (e) {
        assert.ok(e instanceof A0Error && e.trap !== undefined);
        cases.push({ functionName: name, args, expected: 0, expectedTrap: formatTrap(e.trap) });
      }
    }
  }
  for (const optimize of [false, true]) {
    const report = await checkNative(
      p,
      cases,
      CLANG,
      false,
      'C iteration extras',
      compile(p, 'c', { optimize }).text,
    );
    if (report.status === 'blocked') {
      t.skip(report.detail);
      return;
    }
    assert.equal(report.status, 'passed', JSON.stringify(report));
    assert.equal(report.cases, cases.length);
  }
}

for (const [name, source] of OWNED_EXTRA_CASES)
  test(`C aggregate iteration extras: ${name}`, async (t) => check(source, ['probe'], t));

for (const [name, source] of RETURN_EXTRA_CASES)
  test(`C borrowed iteration results preserve extras: ${name}`, async (t) =>
    check(source, ['probe'], t));

test('C iteration state keeps an identical extra snapshot across writes', async (t) => {
  await check(SNAPSHOT_EXTRA, ['probe'], t);
});

test('C repeated extras keep local updates separate, including zero trips and state aliases', async (t) => {
  await check(repeatedExtrasProgram(), ['probe0', 'probe17'], t);
});

for (const [name, source] of STRICT_EXTRA_CASES)
  test(`C aggregate iteration extras preserve strict traps: ${name}`, async (t) =>
    check(source, ['probe'], t));

const PUBLIC = `fn public u32x8 u32 u32x8 -> u32x8
old get p2 p1
local set p2 p1 p1
v get local p1
n add old v
r set p0 p1 n
ret r
end
`;

test('C public aggregate entries retain by-value ABI and preserve both caller arguments', {
  skip: SKIP,
}, async () => {
  assert.ok(CLANG.path);
  const p = parseAndValidate(PUBLIC),
    fn = p.byName.get('public');
  assert.ok(fn);
  const before = INPUTS.map(([a, b]) => [a as number, b as number, 3, 4, 5, 6, 7, 8]);
  const expected = INPUTS.map(([, index], i) => {
    const a = before[i] as number[];
    return `${(run(fn, [a, index as number, a]) as number[]).join(',')}|${a.join(',')}`;
  });
  const driver = `#include <stdio.h>
#include "module.c"
int main(void) {
  a0t_a8_u (*entry)(a0t_a8_u, uint32_t, a0t_a8_u) = a0_public;
${INPUTS.map(
  (
    [, index],
    i,
  ) => `  { a0t_a8_u a = { .e = { ${(before[i] as number[]).map((v) => `${v}u`).join(', ')} } };
  a0t_a8_u r = entry(a, ${index}u, a);
  for (uint32_t j=0;j<8;j++) printf("%s%u",j?",":"",r.e[j]);
  printf("|"); for (uint32_t j=0;j<8;j++) printf("%s%u",j?",":"",a.e[j]); printf("\\n"); }`,
).join('\n')}
  return 0;
}
`;
  for (const optimize of [false, true])
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'module.c'), compile(p, 'c', { optimize }).text);
      await writeFile(join(dir, 'driver.c'), driver);
      const built = runTool(
        CLANG.path as string,
        [
          '-O2',
          '-std=c11',
          '-Werror=incompatible-function-pointer-types',
          '-fsanitize=undefined',
          '-fno-sanitize-recover=all',
          'driver.c',
          '-o',
          'driver',
        ],
        { cwd: dir },
      );
      assert.ok(built.ok, built.stderr);
      const actual = runTool(join(dir, 'driver'), [], { cwd: dir });
      assert.ok(actual.ok, actual.stderr);
      assert.deepEqual(actual.stdout.trim().split('\n'), expected, `optimize=${optimize}`);
    });
});

// checkNative compares a trapping call's diagnostic alone. This small recovery driver also
// observes IO already performed before a trap, so moving a read/write cannot silently pass.
for (const strict of [false, true])
  test(`C aggregate iteration extras preserve IO effects${strict ? ' and strict exhaustion' : ''}`, {
    skip: SKIP,
  }, async () => {
    assert.ok(CLANG.path);
    const lengths = [0, 1, 2, 8, 9, 17];
    for (const [name, source] of IO_EXTRA_CASES) {
      const p = parseAndValidate(`${strict ? 'profile strict\n' : ''}${source}`),
        fn = p.byName.get('probe');
      assert.ok(fn);
      const observations = INPUTS.map(([value], i) => {
        const input = Array.from(
          { length: lengths[i] as number },
          (_, j) => Math.imul(j + 1, 0x9e3779b9) >>> 0,
        );
        const io = makeIo(input);
        let result: string;
        try {
          result = `value: ${run(fn, [value as number, io])}`;
        } catch (e) {
          assert.ok(e instanceof A0Error && e.trap !== undefined);
          result = `trap: ${formatDiagnostic(e)}`;
        }
        return {
          value: value as number,
          input,
          expected: [result, `io: ${io.position}|${io.output.join(',')}`],
        };
      });
      for (const optimize of [false, true])
        await withTempDir(async (dir) => {
          const hooks = `#include <stdio.h>
#include <stdlib.h>
#include <setjmp.h>
static jmp_buf probe_jmp;
static const char *probe_trap;
#define A0_TRAP_EMIT(line) (probe_trap=(line))
#define A0_TRAP_EXIT() longjmp(probe_jmp,1)
`;
          const dispatch = observations
            .map(
              (
                { value, input },
                i,
              ) => `case ${i}: { io.ninput=${input.length}u;${input.map((v, j) => `io.input[${j}]=${v}u;`).join('')}
if (setjmp(probe_jmp)==0) printf("value: %u\\n", a0_probe(${value}u,&io)); else printf("trap: %s\\n",probe_trap); break; }`,
            )
            .join('\n');
          const driver = `int main(int argc,char **argv) { if(argc!=2) return 2; static a0_io io;
switch(atoi(argv[1])) { ${dispatch} }
printf("io: %u|",io.position);for(uint32_t i=0;i<io.noutput;i++)printf("%s%u",i?",":"",io.output[i]);printf("\\n");return 0; }
`;
          await writeFile(
            join(dir, 'driver.c'),
            hooks +
              compile(p, 'c', { optimize, ioInputCapacity: 32, ioOutputCapacity: 32 }).text +
              '\n' +
              driver,
          );
          const built = runTool(
            CLANG.path as string,
            [
              '-O2',
              '-std=c11',
              '-fsanitize=undefined',
              '-fno-sanitize-recover=all',
              'driver.c',
              '-o',
              'driver',
            ],
            { cwd: dir },
          );
          assert.ok(built.ok, built.stderr);
          for (const [i, observation] of observations.entries()) {
            const actual = runTool(join(dir, 'driver'), [String(i)], { cwd: dir });
            assert.ok(actual.ok, actual.stderr);
            assert.deepEqual(
              actual.stdout.trim().split('\n'),
              observation.expected,
              `${name}; optimize=${optimize}; input=${observation.input.length}`,
            );
          }
        });
    }
  });

test('C forced parallel map uses borrowed repeated extras and preserves state snapshots', {
  skip: SKIP,
}, async () => {
  assert.ok(CLANG.path);
  for (const count of [0, 128, 'n'] as const) {
    const p = parseAndValidate(parallelExtrasProgram(count)),
      fn = p.byName.get('probe');
    assert.ok(fn);
    const expected = INPUTS.map((args) => String(run(fn, args)));
    const driver = `#include "module.c"\n#include <stdio.h>\nint main(void) { ${INPUTS.map((args) => `printf("%u\\n",a0_probe(${args.map((v) => `${v}u`).join(',')}));`).join('')} ${count === 128 ? 'if (a0par_threads() > 1u && (a0par_pool.helpers == 0u || a0par_pool.parts < 2u || atomic_load_explicit(&a0par_pool.gen, memory_order_acquire) == 0u || atomic_load_explicit(&a0par_pool.pending, memory_order_acquire) != 0u)) return 2;' : ''} return 0; }\n`;
    for (const optimize of [false, true])
      await withTempDir(async (dir) => {
        const cParallel = parallelC({ mode: 'auto', force: true });
        assert.ok(cParallel);
        const text = compile(p, 'c', { optimize, cParallel }).text;
        // Coverage guard: a silent serial fallback would miss the worker's changed callback ABI.
        if (count !== 0) assert.ok(text.includes('a0pw_probe_r('));
        // The 128-trip case must actually dispatch multiple completed worker chunks.
        // Short loops otherwise run serially even when A0_THREADS requests four threads.
        await writeFile(join(dir, 'module.c'), text);
        await writeFile(join(dir, 'driver.c'), driver);
        const built = runTool(
          CLANG.path as string,
          [
            '-O2',
            '-std=c11',
            '-pthread',
            '-fsanitize=undefined',
            '-fno-sanitize-recover=all',
            'driver.c',
            '-o',
            'driver',
          ],
          { cwd: dir },
        );
        assert.ok(built.ok, built.stderr);
        for (const threads of [1, 4]) {
          const actual = runTool(join(dir, 'driver'), [], {
            cwd: dir,
            env: { ...process.env, A0_THREADS: String(threads) },
          });
          assert.ok(actual.ok, actual.stderr);
          assert.deepEqual(
            actual.stdout.trim().split('\n'),
            expected,
            `count=${count}; optimize=${optimize}; threads=${threads}`,
          );
        }
      });
  }
});

// One copy-cost regression guard: value-only semantic tests also pass the old compiler,
// which snapshots a 4096-byte array at every aggregate iteration callback.
test('C callbacks borrow the boundary array while public callbacks keep the value ABI', async (t) => {
  const clang = findClang();
  if (clang.path === undefined) {
    t.skip('clang not found');
    return;
  }
  const [, source] = OWNED_EXTRA_CASES[0];
  const p = parseAndValidate(source);
  const driver = `#include "module.c"
int main(void) {
  void (*owned)(a0t_r2_a8_u_u *, uint32_t, const a0t_a1024_u *) = a0o_step;
  bool (*predicate)(const a0t_r2_a8_u_u *, uint32_t, const a0t_a1024_u *) = a0r_pred;
  a0t_r2_a8_u_u (*publicEntry)(a0t_r2_a8_u_u, uint32_t, a0t_a1024_u) = a0_step;
  (void)owned; (void)predicate; (void)publicEntry;
  return 0;
}
`;
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'module.c'), compile(p, 'c', { optimize: false }).text);
    await writeFile(join(dir, 'driver.c'), driver);
    const built = runTool(
      clang.path as string,
      ['-std=c11', '-fsyntax-only', '-Werror=incompatible-function-pointer-types', 'driver.c'],
      { cwd: dir },
    );
    assert.ok(built.ok, built.stderr);
  });
});
