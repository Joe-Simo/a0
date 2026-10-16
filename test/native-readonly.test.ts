import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { compile } from '../src/backends.js';
import { parseAndValidate, run, type TypedProgram } from '../src/core.js';
import { findClang, runTool, withTempDir } from '../src/toolchain.js';
import { KERNELS } from '../tools/exec-bench-kernels.js';

const INPUTS = [
  [0, 0],
  [7, 13],
  [17, 3],
  [0xffffffff, 1],
  [1, 0xffffffff],
  [0x9e3779b9, 15],
];
const CLANG = findClang().path;
const X86_HOST = process.arch === 'x64' && ['linux', 'darwin'].includes(process.platform);

async function check(
  p: TypedProgram,
  target: 'c' | 'x86_64',
  names: readonly string[],
): Promise<void> {
  assert.ok(CLANG);
  const expected: string[] = [];
  const calls: string[] = [];
  for (const name of names) {
    const fn = p.byName.get(name);
    assert.ok(fn);
    for (const args of INPUTS) {
      expected.push(String(run(fn, args)));
      calls.push(`printf("%u\\n", a0_${name}(${args.map((x) => `${x}u`).join(', ')}));`);
    }
  }
  const driver = `#include <stdint.h>\n#include <stdio.h>\n${names.map((n) => `extern uint32_t a0_${n}(uint32_t, uint32_t);`).join('\n')}\nint main(void) {\n${calls.join('\n')}\nreturn 0;\n}\n`;
  for (const optimize of [false, true]) {
    await withTempDir(async (dir) => {
      const file = target === 'c' ? 'module.c' : 'module.s';
      await writeFile(join(dir, file), compile(p, target, { optimize }).text);
      await writeFile(join(dir, 'driver.c'), driver);
      const built = runTool(
        CLANG,
        [
          '-O2',
          '-fsanitize=undefined',
          '-fno-sanitize-recover=all',
          file,
          'driver.c',
          '-o',
          'driver',
        ],
        { cwd: dir },
      );
      assert.ok(built.ok, built.stderr);
      const got = runTool(join(dir, 'driver'), [], { cwd: dir });
      assert.ok(got.ok, got.stderr);
      assert.deepEqual(got.stdout.trim().split('\n'), expected, `${target}; optimize=${optimize}`);
    });
  }
}

function loopProgram(
  type: string,
  create: string,
  read: string,
  update: string,
  original: string,
): TypedProgram {
  return parseAndValidate(`fn pred u32 u32 ${type} -> bool
${read}
${update.replaceAll('VALUE', '0')}
c add v b
d lt p0 c
ret d
end
fn step u32 u32 ${type} -> u32
${read}
${update.replaceAll('VALUE', 'p0')}
c add v b
ret c
end
fn probe u32 u32 -> u32
${create}
b loop pred step 16 0 a
${original}
d add b c
ret d
end
`);
}

const LOOP_CASES = [
  [
    'small array',
    'u32x8',
    'a arr p0 p1 3 4 5 6 7 8',
    'v get p2 p1',
    'a set p2 p1 VALUE\nb get a p1',
    'c get a 0',
  ],
  [
    'large array',
    'u32x1025',
    `a arr p0 p1 ${Array(1023).fill('0').join(' ')}`,
    'v get p2 p1',
    'a set p2 p1 VALUE\nb get a p1',
    'c get a 0',
  ],
  ['record', '(u32,u32)', 'a rec p0 p1', 'v at p2 0', 'a put p2 0 VALUE\nb at a 0', 'c at a 0'],
  [
    'nested record',
    '(u32x8,u32)',
    'r arr p0 p1 3 4 5 6 7 8\na rec r p1',
    'r at p2 0\nv get r p1',
    's set r p1 VALUE\na put p2 0 s\nt at a 0\nb get t p1',
    'r2 at a 0\nc get r2 0',
  ],
] as const;

test('C scalar loops borrow aggregate extras in both predicate and body', () => {
  const [, type, create, read, update, original] = LOOP_CASES[0];
  const p = loopProgram(type, create, read, update, original);
  const text = compile(p, 'c', { optimize: false }).text;
  assert.match(text, /if \(!a0v_pred\(n_b, i, &n_a\)\) break;/);
  assert.match(text, /n_b = a0v_step\(n_b, i, &n_a\)/);
  assert.match(text, /uint32_t a0_step\(uint32_t p0, uint32_t p1, a0t_a8_u p2\)/);
});

for (const [name, type, create, read, update, original] of LOOP_CASES) {
  test(`C loop views preserve locally updated extras: ${name}`, {
    skip: CLANG === undefined ? 'clang not found' : false,
  }, async () => {
    await check(loopProgram(type, create, read, update, original), 'c', ['probe']);
  });
}

test('C loop views support boolean state and result', {
  skip: CLANG === undefined ? 'clang not found' : false,
}, async () => {
  const p = parseAndValidate(`fn pred bool u32 u32x8 -> bool
b lt p1 6
ret b
end
fn step bool u32 u32x8 -> bool
v get p2 p1
a set p2 p1 0
b get a p1
c add v b
d ne c 0
e xor p0 d
ret e
end
fn probe u32 u32 -> u32
a arr p0 p1 3 4 5 6 7 8
b loop pred step 16 false a
c select b p0 p1
d get a 0
r add c d
ret r
end
`);
  await check(p, 'c', ['probe']);
});

const HELPERS = `fn peek u32x8 u32 -> u32
v get p0 p1
ret v
end
fn sum u32 u32 u32x8 -> u32
v get p2 p1
s add p0 v
ret s
end
fn more u32 u32 u32x8 -> bool
v get p2 p1
b le p0 v
ret b
end
fn copy u32x8 -> u32x8
ret p0
end
fn copyrec (u32,u32) -> (u32,u32)
ret p0
end
fn step u32x8 u32 u32x8 -> u32x8
i add p1 7
v get p2 i
w add v 1
n set p0 p1 w
ret n
end
`;
const ARRAY = 'a arr p0 p1 3 4 5 6 7 8\n';
const UPDATE = 'b set a p1 p0\nx get b p1\nr add v x\nret r';
const BODIES = [
  `${ARRAY}v call peek a p1\n${UPDATE}`,
  `${ARRAY}v fold sum 16 0 a\n${UPDATE}`,
  `${ARRAY}v loop more sum 16 0 a\n${UPDATE}`,
  `${ARRAY}old call copy a\nb set a 0 p1\nx get old 0\ny get b 0\nr add x y\nret r`,
  'a rec p0 p1\nold call copyrec a\nb put a 0 p1\nx at old 0\ny at b 0\nr add x y\nret r',
  `${ARRAY}v call peek a 0\nb set a 0 p1\nx get a 0\ny get b 0\ns add v x\nr add s y\nret r`,
  `${ARRAY}b fold step 9 a a\nx get b 0\ny get b 1\nr add x y\nret r`,
];

test('x86 completed scalar reads permit hash updates without table copies', () => {
  const kernel = KERNELS.find((k) => k.name === 'hash1k');
  assert.ok(kernel);
  const text = compile(parseAndValidate(kernel.a0), 'x86_64', { x86Platform: 'linux' }).text;
  const body = /a0_hash1k:[\s\S]*?\n\tret\n/.exec(text)?.[0];
  assert.ok(body);
  assert.doesNotMatch(body, /\tcall \.La0copy/);
});

test('x86 ownership preserves independent aliases, later reads and state as an extra', {
  skip: !X86_HOST ? 'needs x86-64 Linux or macOS' : CLANG === undefined ? 'clang not found' : false,
}, async () => {
  const names = BODIES.map((_, i) => `probe${i}`);
  const source =
    HELPERS + BODIES.map((body, i) => `fn ${names[i]} u32 u32 -> u32\n${body}\nend\n`).join('');
  await check(parseAndValidate(source), 'x86_64', names);
});
